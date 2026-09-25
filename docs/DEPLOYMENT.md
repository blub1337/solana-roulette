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
| `PLATFORM_FEE_WALLET` | Platform fee wallet (public address only; receives 7.5%) |
| `PLATFORM_FEE_BPS` | `750` (7.5%); also frozen on-chain at round lock |
| `POOL_TARGET_SOL` | Pool size (SOL) that triggers lock/settlement |
| `TREASURY_PUBKEY` | On-chain treasury written at `initialize_config` (fee recipient) |
| `ENABLE_MAINNET` | Must be literally `true` to unlock mainnet; never set in prod by default |

## 5. On-chain deploy (requires Rust/Anchor toolchain — CI or local)

```bash
anchor build                       # produces deployable .so
anchor deploy --provider.cluster devnet
anchor run seed-config             # initialize_config on devnet
```

Program deploy is **not** possible inside this sandbox (no Rust toolchain); CI
(`.github/workflows/ci.yml`) builds and tests the program on every push.

## 6. Docker

`docker-compose up` runs postgres + api + web. `docker/` has Dockerfiles for api & web.

## 7. Operator keypair (devnet only)

Generate once: `solana-keygen new -o operator-devnet.json --no-bip39-phrase`.
Export JSON array as `OPERATOR_KEYPAIR`. Airdrop devnet SOL for fees. Rotate by
re-initializing nothing — operator change is via program instruction `set_operator`.

## 8. Mainnet gate (deliberate, manual)

1. Complete `LEGAL_COMPLIANCE_CHECKLIST.md` (external review required).
2. External smart-contract audit.
3. Switch randomness to a real VRF (`docs/RANDOMNESS.md` §3).
4. Set `SOLANA_NETWORK=mainnet-beta` **and** `ENABLE_MAINNET=true` in the operator env
   only. Nothing in the UI can enable it.
