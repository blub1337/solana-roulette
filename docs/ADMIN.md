# Solana Roulette — Admin console

The operator console at **`/admin`**, backed by `/api/admin/*`. It exists so you
can see and steer the platform without ever touching a key.

Scope, on purpose:

| | |
|---|---|
| **Read** | devnet/mainnet status, RPC health, escrow + operator + fee addresses, live escrow balance, fee and pool caps, open/completed rounds, deposit & payout transactions, transaction log |
| **Write** | the **Deposits Active / Paused** switch · the on-chain **fee** (`set_fee`, operator-signed) · off-chain soft limits (per-user, per-pool stake caps and tighter deposit min/max) · a **fee-wallet withdrawal** (only when `FEE_WALLET_KEYPAIR` is set) |
| **Never** | upload/store/display a private key, seed phrase or `OPERATOR_KEYPAIR` · change the pool caps on chain or the network · pick a winner, force a payout, settle a round by hand |

Off-chain limits are a **soft cap**: the program has no per-user limit and no
instruction to change `max_deposit`/`tier_caps` (both are fixed at
`initialize_config`), so the console can only *tighten* the deposit window and
cap one wallet's stake per pool round in the API. It cannot widen either — an
off-chain override beyond the on-chain bounds is rejected. The fee is the one
lever that is genuinely on chain.

Settlement (round closing, winner selection, the 98 %/2 % split, payouts and
opening the next round) runs **automatically** in `apps/api/src/settlement.ts`.
The console never has to be open for the platform to work.

---

## 1. Access model

* One bearer token: `ADMIN_TOKEN`, a server-side environment secret.
* The browser keeps it in **`sessionStorage`** only (never `localStorage`, never
  a cookie, never a URL) and sends it as `x-admin-token` (or
  `Authorization: Bearer …`).
* Comparison is constant-time over a SHA-256 digest (`apps/api/src/adminAuth.ts`),
  so response time leaks nothing about the token.
* **Fail closed:** with no `ADMIN_TOKEN` every admin route answers
  `403 admin_not_configured`. There is no dev bypass and no read-only mode.
* 10 failed attempts per address per 5 minutes → `429`, then a cool-down.
* All admin responses are `Cache-Control: no-store`.

Generate a token:

```bash
openssl rand -hex 32      # 64 hex chars, plenty
```

## 2. Key handling — the hard rules

| Secret | Where it lives | Can the console see it? |
|---|---|---|
| `OPERATOR_KEYPAIR` | server env (Render → Environment) | **no** |
| `ADMIN_TOKEN` | server env + the operator's own `sessionStorage` | only what the operator typed |
| seed phrase | nowhere — never requested, never stored | **no** |
| escrow / operator / fee addresses | public keys, on chain | yes, read-only |

`OPERATOR_KEYPAIR` is read in exactly one place — `apps/api/src/keypair.ts` — and
turned into a `Keypair` inside `resolveCustody()`. `describeCustody()` is the only
shape that leaves that module and it contains public keys and booleans only. The
admin API is built on top of that function, so there is no code path from
`/api/admin/*` to key material.

The log tail the console displays is fed by `txLog` **after** redaction
(`apps/api/src/logger.ts`), and the buffer stores the redacted record only. The
test suite asserts that no admin response or log line contains the operator
secret, the admin token or any base58 secret key.

## 3. Endpoints

| Route | Purpose |
|---|---|
| `GET /api/admin/overview` | everything the dashboard needs in one call (system, custody, rules, counters) |
| `GET /api/admin/rounds` | open + completed rounds per lane, with pot/cap/winner/payout state |
| `GET /api/admin/rounds/:id` | one round with its participants and transactions |
| `GET /api/admin/transactions?kind=&status=&limit=` | the PENDING → CONFIRMED \| FAILED ledger |
| `GET /api/admin/logs?level=&limit=` | the redacted log ring buffer (500 entries, in-process) |
| `POST /api/admin/deposits` | `{ "paused": true \| false }` — the deposit kill switch |
| `GET /api/admin/settings` | off-chain soft limits + live on-chain bounds + fee-wallet balance + withdrawal key state |
| `PUT /api/admin/settings` | `{ userCapLamportsByTier?, minDepositLamports?, maxDepositLamports? }` — off-chain limits; may only tighten the on-chain window |
| `POST /api/admin/fee` | `{ "feeBps": 0..3000 }` — operator-signed `set_fee` (chain mode only; affects rounds locked AFTER the change) |
| `POST /api/admin/withdraw` | `{ "to": "<address>", "lamports": "<n>" }` — fee-wallet withdrawal (chain mode only; needs `FEE_WALLET_KEYPAIR`) |
| `GET /api/admin/ping` | authenticated liveness probe |

All of them require the token; `POST /api/admin/deposits` validates the body and
ignores every other field. The settings/fee/withdraw routes are described in
§7.

## 4. The deposit kill switch

Pausing **refuses new deposit intents** (`POST /api/round/:id/deposit/intent`
answers `503 deposits_paused`). It deliberately does not:

* cancel deposits that are already in flight — their lamports are on the chain
  and must never be stranded;
* stop the settlement driver — full rounds still lock, settle and pay;
* open or close a round.

The state is written through to the PostgreSQL audit mirror (`admin_state`) so a
restart or redeploy cannot silently re-enable deposits. If Postgres is
unreachable at boot, the `DEPOSITS_PAUSED` env value wins — set it to `true`
during an incident.

## 5. Environment variables (Render)

Set these on the **API** service (the one running `npm run dev:api` /
`npm run start -w apps/api`), under *Environment*:

| Variable | Secret? | Value | Notes |
|---|---|---|---|
| `ADMIN_TOKEN` | **yes** | `openssl rand -hex 32` | unlocks `/admin`; unset ⇒ the admin API is closed |
| `DEPOSITS_PAUSED` | no | `false` | boot default of the kill switch |
| `OPERATOR_KEYPAIR` | **yes** | JSON array of 64 numbers (see below) | DEVNET ONLY — signs payouts |
| `DEPOSIT_ESCROW_WALLET` | no | public address | must equal the operator address |
| `PLATFORM_FEE_WALLET` | no | public address | receives the 2 % |
| `PLATFORM_FEE_BPS` | no | `200` | 2 % |
| `TIER_CAPS_SOL` | no | `1,10,100` | the three pool caps |
| `MIN_DEPOSIT_LAMPORTS` / `MAX_DEPOSIT_LAMPORTS` | no | lamports | per-deposit limits (boot default; the console can tighten them off-chain) |
| `FEE_WALLET_KEYPAIR` | **yes** | JSON array of 64 numbers | the fee wallet's own keypair — enables `POST /api/admin/withdraw`. Unset ⇒ withdrawal stays disabled. DEVNET ONLY; must match `PLATFORM_FEE_WALLET` or the server refuses to send |
| `SOLANA_NETWORK` | no | `devnet` | mainnet needs `ENABLE_MAINNET=true` as well |
| `SOLANA_RPC_URL` | no | `https://api.devnet.solana.com` | |
| `DATABASE_URL` | **yes** | `postgres://…` | audit mirror; also persists the kill switch |
| `PORT` | no | `4000` | Render injects its own; keep it if self-hosting |

Generate the devnet operator key and escrow address (prints the values once, for
you to paste into Render — never commit them):

```bash
node scripts/generate-operator-keypair.mjs
# → OPERATOR_KEYPAIR=[…64 numbers…]
# → DEPOSIT_ESCROW_WALLET=<address>
# then fund that address with devnet SOL: https://faucet.solana.com
```

### 5.1 Moving the key into Render without ever showing it

`scripts/set-render-operator-key.mjs` reads `operator-devnet.key.json` (mode 600,
gitignored) and hands the value to your Render service. It never prints, echoes
or logs the secret, never accepts it as a command-line argument (arguments land in
shell history) and never asks for a seed phrase. A SHA-256 fingerprint is shown
instead, so you can prove *which* key was sent without disclosing it.

```bash
node scripts/set-render-operator-key.mjs --check   # validate only: address + fingerprint,
                                                    # nothing written, nothing sent
node scripts/set-render-operator-key.mjs           # verify, then push to Render
node scripts/set-render-operator-key.mjs --stage   # offline: stage .render-admin.env (0600)
```

Credentials: `RENDER_API_KEY` and `RENDER_SERVICE_ID`. If they are missing and
stdin is an interactive terminal you are prompted (the API key is read without
echo); in a non-interactive shell the script stops with a clear message instead
of hanging.

**Why it is careful with Render's API:** Render's env-var endpoint *replaces the
service's entire variable list* — anything omitted is deleted. The script reads
the current list first, merges, and aborts without sending anything if a variable
cannot be read back (which would mean deleting it). After the write it re-reads
and compares the stored value byte for byte, then tells you to trigger
**Save & Deploy** (env changes are not live until a deploy runs).

`EXPECTED_OPERATOR_ADDRESS` is an optional guard: set it to the address you
already deployed and the script refuses to continue on a mismatch.

The public settings to set alongside it: `DEPOSIT_ESCROW_WALLET` (the operator
address), `PLATFORM_FEE_WALLET`, `PLATFORM_FEE_BPS=200`, `TIER_CAPS_SOL=1,10,100`,
`DEPOSITS_PAUSED=false`, `SOLANA_NETWORK=devnet`, `SOLANA_RPC_URL`. Add
`PUSH_PUBLIC_VARS=true` to have the script merge those in the same call.

Covered by `apps/api/test/renderEnvScript.test.ts` (fake Render API: exact value
written, pre-existing variables preserved, abort on unreadable values, no secret
in any output).

`OPERATOR_KEYPAIR` is a **JSON array of 64 integers** (the output of
`solana-keygen new`) or an 87/88-character **base58 secret key** — both are
accepted by `apps/api/src/keypair.ts`. The escrow must be the public address of
that same keypair: deposits and payouts use one devnet account
(`resolveCustody()` refuses anything else).

`OPERATOR_KEYPAIR` and `ADMIN_TOKEN` are different things. The token opens the
dashboard; the keypair moves devnet SOL. Never paste a keypair into the console
— it has no field for it.

## 6. Using it

1. Deploy with `ADMIN_TOKEN` + `OPERATOR_KEYPAIR` + `DEPOSIT_ESCROW_WALLET` set
   and the escrow funded with devnet SOL.
2. Open `/admin` and paste `ADMIN_TOKEN`.
3. Check **Wallets & escrow**: `custodyReady: true` and a non-zero balance
   before you tell anyone the platform takes deposits.
4. The console refreshes every 10 s; **Lock** clears the token from the tab.
5. **Operator settings** (below the deposit ledger) holds the adjustable levers:
   the on-chain **fee**, the off-chain **per-user pool caps** and **deposit
   min/max**, the **fee-wallet balance**, and the **withdrawal** form.

## 7. Operator settings & fee-wallet withdrawal

| Lever | Where it lives | Notes |
|---|---|---|
| Platform fee | **on chain** (`set_fee`) | operator-signed; `≤ 3000` bps; only rounds locked *after* the change use it — never retroactive |
| Max SOL per user per pool | **off chain** (API) | a per-lane soft cap on one wallet's stake per round; `0` disables it; cannot exceed the lane's on-chain pool cap |
| Deposit min / max | **off chain** (API) | may only *tighten* the on-chain window; clearing the field falls back to the on-chain value |
| Fee-wallet balance | read-only | live devnet balance of `PLATFORM_FEE_WALLET` |
| Withdraw fee wallet | on chain (System transfer) | needs `FEE_WALLET_KEYPAIR`; the server checks the key against `PLATFORM_FEE_WALLET` before sending, so it can never move the wrong account |

Off-chain settings persist in the audit mirror (`game_settings`) and are restored
at boot, so a restart or redeploy does not silently reset an operator's limits.

A withdrawal is a plain server-signed System transfer from the fee wallet to the
address you enter. The fee wallet is a different account from the operator, so
this is the only operation on the console that uses `FEE_WALLET_KEYPAIR` — the
key is read from the environment at send time and is never stored or displayed.
The server refuses a transfer larger than the wallet's balance minus a small
(~5000 lamport) transaction-fee buffer, and refuses outright if the key does not
match the configured fee wallet address. The console's **Max** button fills in
exactly that withdrawable amount, so a full drain is one click and still passes
the server's balance check.
