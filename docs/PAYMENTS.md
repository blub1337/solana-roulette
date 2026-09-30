# Payments & Financial Flow

How SOL moves. **The chain is the source of truth**; PostgreSQL is an audit
mirror. Nothing is ever credited because a database row or a frontend said so.

## 1. Money paths (the only ones)

```
PLAYER WALLET ──SystemProgram.transfer──► ROUND ESCROW (devnet custody account)
                                              │  payout transaction at settlement
                        ┌─────────────────────┴─────────────────────┐
                        ▼                                           ▼
        WINNER (98% = pot − fee)                    PLATFORM FEE WALLET (2%)
```

- Player deposits **never** touch the fee wallet.
- The fee wallet **only receives** the 2% commission.
- Fee math is integer-only: `fee = pot × fee_bps / 10_000` (floor),
  `payout = pot − fee`. Example: 10 SOL pot → 0.2 SOL fee → 9.8 SOL winner.
- The pot is **the sum of CONFIRMED deposits**. A PENDING or FAILED
  transaction contributes nothing, no matter what any client reports.

## 2. Transaction states

```
                ┌──────────────► CONFIRMED   (terminal)
   PENDING ─────┤
                └──────────────► FAILED      (terminal)
```

`PENDING → CONFIRMED | FAILED`. Both terminal states are final: a late
"failed" callback can never un-credit a confirmed deposit, and a confirmed
payout can never be re-sent. There is no "SUCCESS, then transfer" ordering —
the blockchain transaction always happens first, the record follows.

Implementation: `apps/api/src/txLedger.ts`. Every record carries

| Field | Purpose |
|---|---|
| `id` | uuid of the record |
| `idempotencyKey` | unique — `deposit:<round>:<wallet>`, `payout:<round>:<attempt>` |
| `signature` | unique — a signature may only ever belong to one record |
| `depositStatus` / `payoutStatus` | `PENDING` / `CONFIRMED` / `FAILED` |
| `depositAmountLamports` / `payoutAmountLamports` / `feeLamports` | exact integer amounts |
| `attempts`, `lastError`, `nextRetryAt` | retry accounting + backoff |

The same rows are mirrored into PostgreSQL (`chain_transactions`) with unique
indexes on `idempotency_key`, on each signature and on `(round_id, player_wallet)`
for deposits — so the database refuses double spending even across restarts.

## 3. Deposit flow (real devnet transfer)

```
1  POST /api/round/:id/deposit/intent   → server opens ONE PENDING record,
                                           returns the escrow address + amount
2  browser: assert devnet + balance, build SystemProgram.transfer
3  browser: wallet signs (normal prompt — never simulated)
4  browser: send to the devnet RPC, wait for `confirmed`
5  POST /api/round/:id/deposit/confirm   → server re-reads the transaction
6  server: CONFIRMED  → credit the round  (and only then)
```

Step 5 re-fetches the transaction from the cluster and requires **all** of:

- the transaction exists at `confirmed` commitment;
- `meta.err` is null;
- the fee payer is the player's wallet;
- a System transfer moved **exactly** the agreed lamports from that wallet to
  the round escrow.

If any check fails the record becomes `FAILED` and the round is untouched. If
the transaction is simply not visible yet the record stays `PENDING` (HTTP 202)
and the client polls. A rejected wallet signature calls
`POST /api/round/:id/deposit/cancel`, which also ends in `FAILED`.

**Reconciler** (`DEPOSIT_RECONCILE_MS`, default 15s): any deposit still
`PENDING` after 45s is re-verified against the chain; one that never reached
the chain is failed. A refresh, a double click or a retry therefore resumes the
same record instead of creating a second one.

## 4. Payout flow (real devnet transfer)

```
1  winner frozen by settle_round
2  pot := Σ CONFIRMED deposits for the round
3  fee := pot × 200 / 10_000        payout := pot − fee
4  escrow balance check — never broadcast what the pool cannot fund
5  build ONE transaction: fee → fee wallet, payout → winner
6  sign with the server-side operator key, send to devnet, wait for confirmed
7  re-read the transaction: both transfers, exact amounts, no extra outflow
8  CONFIRMED  → mark the round COMPLETED and open the next round
```

Any failure leaves the round `RANDOMNESS_PENDING` and the payout record
`FAILED` with a reason; the driver retries as a new attempt after a backoff
(15s → 30s → 60s … capped at 5 minutes). A round is **never** completed because
a database write succeeded.

## 5. Duplicate protection

| Risk | Guard |
|---|---|
| Double deposit (same wallet, same round) | `deposit:<round>:<wallet>` idempotency key + unique index `(round_id, player_wallet)` |
| Deposit replay after refresh | The intent endpoint resumes the existing `PENDING` record; a confirmed one returns `409 already_deposited` |
| Signature replay | A signature can be bound to exactly one record (`signature_reused`) |
| Double spending | Every `PENDING` record is re-verified against the chain before any retry; payouts verify the exact outflow (fee + payout) |
| Duplicate payout | `payout:<round>:<attempt>` key + `getConfirmedPayout` short-circuit; a confirmed payout returns `alreadyPaid` and sends nothing |
| Payout without confirmed deposits | `Σ CONFIRMED` must be > 0, otherwise the payout is refused and logged |
| Crediting a failed/rejected tx | Only a chain-verified, error-free transfer can move a record to `CONFIRMED` |

### 5.1 Known gap: refused deposits stay in the escrow

A transfer that really lands on chain is money, whatever the server thinks of it.
If a player sends the wrong amount, or signs with a wallet that is not the one in
the intent, the record goes to `FAILED` and the round is **not** credited — but
those lamports are physically in the escrow and nothing currently returns them.

The lifecycle test pins the honest balance
(`apps/api/src/roundLifecycle.test.ts`): the escrow holds the confirmed deposits
**plus** every refused-but-real transfer. The safe design is to add a refund
path — a `FAILED` deposit whose transfer is confirmed on chain and uncredited
becomes refundable, paid back to `wallet` from the escrow, with its own
idempotency key and its own `REFUND` state. It is not implemented yet; do not
assume the escrow balance equals the sum of credited entries.

## 6. Configuration

| Env var | Meaning |
|---|---|
| `PLATFORM_FEE_WALLET` | Public fee address (`6B9MX…HAaR`). Public key only, never a keypair. |
| `PLATFORM_FEE_BPS` | `200` (2%), frozen at round lock. |
| `OPERATOR_KEYPAIR` | **Server-side secret** that signs payouts. Never sent to the browser. |
| `DEPOSIT_ESCROW_WALLET` | Public address that receives deposits. Defaults to the operator address. **Must be the public address of `OPERATOR_KEYPAIR`** — the escrow is also the payout source, so a foreign address is refused (`custodyReady: false`). |
| `SOLANA_RPC_URL` | Devnet RPC. Default `https://api.devnet.solana.com`. |
| `DEPOSIT_RECONCILE_MS` | Reconciler interval (default 15000). |
| `ADMIN_TOKEN` | Bearer token for the operator console (`/admin`). Unset ⇒ `/api/admin/*` is closed. See `ADMIN.md`. |
| `DEPOSITS_PAUSED` | Boot default of the deposit kill switch; runtime state is persisted in `admin_state`. |

**Fail-safe:** without an escrow and a signer the API reports
`custodyReady: false` and **refuses deposits with 503** — it never simulates
them. Without a valid fee wallet the settlement driver disables the financial
loop entirely.

### Devnet setup that actually moves SOL

```bash
node scripts/generate-operator-keypair.mjs   # prints OPERATOR_KEYPAIR + its address
```

Then in **Settings → Environment** (server-side, never in the browser):

| Key | Value |
|---|---|
| `SOLANA_NETWORK` | `devnet` |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` |
| `OPERATOR_KEYPAIR` | the 64-byte JSON array the script printed |
| `DEPOSIT_ESCROW_WALLET` | the same script's address (operator pubkey) |
| `PLATFORM_FEE_WALLET` | your own devnet address (2% commission) |

`OPERATOR_KEYPAIR` accepts a JSON array **or** a base58 secret key
(`apps/api/src/keypair.ts`). Fund the escrow address with devnet SOL
(https://faucet.solana.com) — the pot pays the winner from that account, and
`sendPayout` refuses to broadcast while the escrow cannot cover `pot + 10_000`
lamports. `GET /api/custody` shows `custodyReady`, the escrow address and its
live on-chain balance.

## 7. Security of the payout key

- `OPERATOR_KEYPAIR` lives only in the server environment. The browser bundle
  contains no key material, no seed phrase and no secret key array.
- The only value that leaves the API is the signer's **public** address
  (`GET /api/config`, `GET /api/custody`).
- The signer can only move the pot it holds, to the winner and the fee wallet.
- Every log line is redacted (`apps/api/src/logger.ts`): secret-ish keys are
  replaced with `[redacted]` and RPC URLs lose their credentials.

## 8. Logging

Both sides emit single-line JSON with wallet, amount, network, recipient,
signature, RPC result, confirmation status and error:

```json
{"event":"deposit.confirmed","wallet":"…","amountLamports":"100000000",
 "recipient":"…","network":"devnet","signature":"…","explorer":"https://explorer.solana.com/tx/…?cluster=devnet","status":"CONFIRMED"}
{"event":"payout.confirmed","wallet":"…","feeLamports":"20000000",
 "feeWallet":"6B9MX…","signature":"…","status":"CONFIRMED"}
```

## 9. Runtimes (§2.1 of the architecture)

`mode: "chain"` (deployed Anchor program) and `mode: "local"` (in-process
devnet ledger that drives the rounds) differ only in **where the round logic
runs**. Custody is always real on devnet: in `chain` mode the program's
`pay_winners` moves the lamports, in `local` mode the server signs an equivalent
devnet transfer. Neither ever records a payment it has not verified.
