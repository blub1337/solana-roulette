# Solana Roulette — Deployment

## 1. Environments

| Env | Network | Notes |
|---|---|---|
| local | devnet (or `solana-test-validator` via Docker) | docker-compose |
| preview/hosted | **devnet** | Freebuff preview: web app + API |
| production | **devnet by default** | mainnet only after checklist below |

## 2. Repository layout & run commands

Monorepo (npm workspaces). Key commands:

```bash
npm install                 # all workspaces
npm run build -w packages/... && npm run build -w apps/api   # deps before web
npm run dev                 # concurrently web + api (docker-compose also available)
```

## 3. Freebuff hosting (this workspace)

- Install: `npm ci` (or default). Build: `npm run build` → produces `apps/web/.next`… 
  For static Vite-style hosting of the Next app in this sandbox, the preview runs
  `next dev`/`next start`; production build must exit cleanly after emitting.
- `freebuff-preview set-install "npm ci"`, `freebuff-preview set "npm run start:web" 3000`,
  `freebuff-preview set-build "npm run build"`.
- Production env vars are set via `freebuff-deploy env set` (separate from sandbox .env).

## 4. Required env vars

See `.env.example`. Critical ones:

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres (sslmode=require) |
| `SOLANA_RPC_URL` | Devnet RPC (use a paid RPC for prod-grade devnet) |
| `SOLANA_NETWORK` | `devnet` (mainnet-beta requires `ENABLE_MAINNET=true`) |
| `OPERATOR_KEYPAIR` | Devnet operator keypair JSON array (server-side only) |
| `ADMIN_TOKEN` | Bearer token for the operator console at `/admin`; unset ⇒ the admin API is closed (403) |
| `DEPOSITS_PAUSED` | Boot default of the deposit kill switch (`true` keeps deposits off across restarts) |
| `PLATFORM_FEE_WALLET` | Platform fee wallet (public address only; receives 2%) |
| `PLATFORM_FEE_BPS` | `200` (2%); also frozen on-chain at round lock |
| `POOL_TARGET_SOL` | Pool size (SOL) that triggers lock/settlement |
| `TREASURY_PUBKEY` | On-chain treasury written at `initialize_config` (fee recipient) |
| `ENABLE_MAINNET` | Must be literally `true` to unlock mainnet; never set in prod by default |

## 5. On-chain deploy / upgrade (SBF toolchain required)

Build (works in this workspace — solana-agave 4.x CLI + cargo-build-sbf):

```bash
cd programs/roulette
cargo build-sbf --sbf-out-dir ../../target/deploy   # -> target/deploy/roulette.so
```

Two deployment modes:

* **Fresh deploy** = new program address (orphans every existing PDA). Only for
  a clean start; the deterministic keypair flow lives in
  `.github/workflows/deploy-devnet.yml`. `declare_id!`, Anchor.toml and
  `ROULETTE_PROGRAM_ID` must all carry the same address.
* **In-place upgrade** (preferred) keeps the program address and all config /
  round / participant PDAs. Requires the wallet named as the program's upgrade
  authority (here: the operator keypair):

```bash
solana program deploy target/deploy/roulette.so \
  --url devnet --keypair operator-devnet.key.json \
  --upgrade-authority operator-devnet.key.json \
  --program-id F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos
```

### 5.1 Fee correction 750 → 200 bps (2026-09-30, done as an in-place upgrade)

The seed-time fee (750) could not be corrected before: `initialize_config` is
one-shot and the program had no fee-update instruction. Resolution:

1. Added `set_fee(fee_bps)` — operator-only (`signer == config.operator`),
   same `<= 3000` cap as init, effective from the NEXT round's fee snapshot
   (`create_round`/`lock_round` freeze it), never retroactive.
2. Upgraded the program in place (same address, PDAs intact).
3. `node scripts/set-fee-devnet.mjs 200` — sends the instruction and verifies
   `config.fee_bps` on-chain (tx `5Ptmfgz74Ak43mxibTrA8gVY9HrvW5DM3JgzBbsN945dWiUKKA8ksz3KeA19ptaeAvdE7maWzWQSVg52pDbpdeiu`).
4. End-to-end proof (round 81, real devnet SOL): deposits 400M+300M+300M →
   lock froze `fee_bps 200` → settle/paid **980,000,000** to the winner and
   **20,000,000** to the treasury (= exactly 2% of the 1 SOL pot); escrow
   drained to rent-exemption; status COMPLETED
   (pay tx `GbKR593P1U1KBt5k2bdpfjLwjPgbtXSVwebzdGkUwrvPCA2BxzyUKnFCD1pRjmSRWbrbT21dzvrgXQQyEwWynrB`).
5. Tooling: SDK `setFeeIx` (packages/sdk), `scripts/set-fee-devnet.mjs`,
   `scripts/set-render-fee.mjs` (per-variable Render env update; the list-PUT
   endpoint would REPLACE every variable and is therefore never used).

## 6. Docker

`docker-compose up` runs postgres + api + web. `docker/` has Dockerfiles for api & web.

## 7. Operator keypair (devnet only)

Generate once: `solana-keygen new -o operator-devnet.json --no-bip39-phrase`.
Export JSON array as `OPERATOR_KEYPAIR`. Airdrop devnet SOL for fees. Rotation
is NOT currently possible on-chain: the operator is stored in GlobalConfig and
no `set_operator` instruction exists — rotating would require another program
upgrade (or a config re-init on a fresh deploy).

## 8. Mainnet gate (deliberate, manual)

1. Complete `LEGAL_COMPLIANCE_CHECKLIST.md` (external review required).
2. External smart-contract audit.
3. Switch randomness to a real VRF (`docs/RANDOMNESS.md` §3).
4. Set `SOLANA_NETWORK=mainnet-beta` **and** `ENABLE_MAINNET=true` in the operator env
   only. Nothing in the UI can enable it.

## 9. Stalled-round recovery (decision, 2026-10-03)

A round that is locked and then overtaken by its lane — or orphaned across a
restart — used to sit in `RANDOMNESS_PENDING` forever, because the settlement
driver only ever advanced a lane's HEAD (`advanceTierLane`). On devnet this is
visible as rounds 24/25 (`DEVNET_LEGACY_STATE.md`).

**Decision:** the driver now finishes such rounds itself. `runOnce` calls
`sweepStalledRounds` (`apps/api/src/settlement.ts`) on a throttled interval
(`STALLED_SWEEP_MS`, default 60000; `0` disables). The sweep scans a bounded id
window (`STALLED_SWEEP_WINDOW`, default 200) below the newest round, skips lane
heads, and drives every remaining `RANDOMNESS_PENDING` round through the same
path as a head — permissionless `settle_round` then `pay_winners` — **without**
opening a new round for the lane and **without** ever calling `cancel_round`.

Why not `cancel_round`: the program allows cancel only from `OPEN|FULL` and it
is operator-gated, so a `RANDOMNESS_PENDING` round cannot be cancelled — but it
can always be settled and paid by anyone, which is exactly the property that
stops a vanished operator from stranding funds (see `RANDOMNESS.md` §2.3).

Residual limitation: `settle_round` needs the reveal slot's hash, which the
`SlotHashes` sysvar retains only within a bounded recency window. A round
stalled beyond that window is neither settleable nor cancellable without a
program change; the sweep logs it as `failed` and leaves it (it never guesses).
