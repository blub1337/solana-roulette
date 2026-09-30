# Solana Roulette — Documentation Index

| Document | Purpose |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System overview, components, data flow |
| [SECURITY.md](./SECURITY.md) | Threat model, access control, guarantees |
| [RANDOMNESS.md](./RANDOMNESS.md) | Winner entropy: devnet blockhash scheme, ledger commit–reveal, VRF upgrade path |
| [SMART_CONTRACT.md](./SMART_CONTRACT.md) | On-chain accounts, instructions, state machine, errors, math |
| [DATABASE.md](./DATABASE.md) | Prisma schema, audit-layer rules |
| [API.md](./API.md) | REST + SSE reference |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Environments, env vars, hosting, on-chain deploy |
| [LEGAL_COMPLIANCE_CHECKLIST.md](./LEGAL_COMPLIANCE_CHECKLIST.md) | Mandatory gate before real money |
| [VERIFICATION.md](./VERIFICATION.md) | How to independently verify any round |
| [ROADMAP.md](./ROADMAP.md) | Phases and non-goals |
| [TESTING.md](./TESTING.md) | Test layers and commands |
| [PAYMENTS.md](./PAYMENTS.md) | Player wallet → escrow → settlement → fee wallet flow, the two runtimes (`chain`/`local`), idempotence, admin |
| [ADMIN.md](./ADMIN.md) | Operator console: token auth, key handling, endpoints, deposit kill switch, Render env vars |
| [DEVNET_LEGACY_STATE.md](./DEVNET_LEGACY_STATE.md) | Known devnet test leftovers (stranded rounds, escrow balances) — documentation only, no recovery path |

**Standing rules:** DEVNET-only by default; mainnet requires `ENABLE_MAINNET=true`
plus the legal checklist. Consult and update these docs before major changes.

**Two runtimes:** the deployed Anchor program (`mode: "chain"`, the only one that
can move real SOL) and an in-process devnet ledger that mirrors it
(`mode: "local"`, no lamports move, refused on mainnet). `LEDGER_MODE=auto`
picks automatically; `GET /api/health` always reports which is live and the UI
shows it.
