# Solana Roulette — Testing

## Layers

| Layer | Tool | Location | Runs in this sandbox? |
|---|---|---|---|
| Pure-logic unit tests (winner selection, fee math, config gate) | Vitest | `packages/verification`, `packages/config`, `apps/api/src/**` | ✅ yes |
| Property-based winner determinism | Vitest (fast-check) | `packages/verification` | ✅ yes |
| API endpoint tests | Vitest + supertest | `apps/api` | ✅ yes (DB mocked/in-memory where needed) |
| Anchor program tests | `anchor test` (Rust + solana toolchain) | `programs/roulette/tests/` | ❌ needs toolchain; run in CI |
| E2E frontend | Playwright | `tests/e2e/` | ❌ needs browsers; scaffolded, run in CI |
| On-chain program unit tests | `cargo test` | `programs/roulette` | ❌ needs Rust; run in CI |

## Commands

```bash
npm test                # all Vitest suites
npm run test:watch      # watch mode
npm run e2e             # Playwright (CI / with browsers installed)
anchor test             # Anchor program tests (toolchain required)
```

## CI (`.github/workflows/ci.yml`)

1. `npm ci` → typecheck → Vitest suites.
2. Rust job: `anchor build` + `anchor test` (Anchor 0.30.1).
3. Playwright job with browser install (optional/manual).

## Manual wallet-connection test flow

The wallet layer has unit tests (`apps/web/lib/walletErrors.test.ts` — error
classification, friendly messages, cluster detection, the global error bus).
The full UX loop needs a real injected provider, so verify it manually
(Phantom or Solflare, browser on the preview URL):

1. **Connect.** Open `/pool/0`, click the wallet button, pick a wallet, connect.
   *Expect:* button shows the truncated address; no error banner.
2. **Reject a signature (failure feedback).** Connect, enter an amount, press
   Deposit, then REJECT the prompt inside the wallet.
   *Expect:* a red banner on the page: "The request was rejected in your
   wallet — nothing was sent…", plus the in-panel notice ending in
   "Nothing was credited." Console shows `deposit.failed` with
   `reason=rejected_by_user`. No entry appears in Entries.
3. **Wallet on the wrong cluster (pre-check).** Switch the wallet extension to
   Mainnet, then attempt a deposit.
   *Expect:* NO wallet prompt appears; the notice says the wallet is on a
   different network and to switch to Devnet
   (`deposit.wallet_cluster_mismatch` in the console). The old behaviour was a
   cryptic "Blockhash not found" RPC error after a real signature prompt.
4. **Unexpected disconnect.** Connect, then lock the wallet (or reload the
   extension from `chrome://extensions`).
   *Expect:* an amber "… disconnected." banner appears under the nav; the
   deposit button disables (wallet button shows "Connect" again).
5. **Insufficient funds.** Connect a fresh wallet with < the amount + fee.
   *Expect:* notice names the exact short amount and points at the faucet;
   `reason=insufficient_devnet_balance`.
6. **Happy path.** Request 1 devnet SOL from the banner faucet button, deposit
   0.1 SOL.
   *Expect:* "Signing…" on the button, then the confirmed notice with an
   Explorer link; the entry appears with correct odds.
