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
