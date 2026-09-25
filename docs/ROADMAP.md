# Solana Roulette — Roadmap

## Phase 0 — Docs & design (DONE)
- All `docs/` written; mainnet hard-gated; randomness documented as devnet-only.

## Phase 1 — Monorepo & contracts (this build)
- [x] Workspace scaffolding, packages, apps
- [x] Anchor program source (buildable with Anchor 0.30.1 toolchain)
- [x] SDK instruction builders + PDAs
- [x] Independent verification package
- [x] API (REST + SSE + tx verifier + settlement driver)
- [x] Web app (wallet adapter, deposit flow, live round view, winner animation)
- [x] Vitest suites for logic packages; Anchor test scaffold
- [x] Payments architecture: fixed fee wallet, POOL_TARGET_SOL, two-phase
      settle, payout idempotence, read-only /admin (docs/PAYMENTS.md)

## Phase 2 — Hardening (next)
- [ ] `anchor test` green on localnet (Rust toolchain CI job)
- [ ] Fuzz participant-weight boundaries (already property-tested in TS; port to Rust tests)
- [ ] Rate limiting + IP throttling on API
- [ ] Multi-round history pagination & indexer daemon
- [ ] Switchboard VRF adapter implementation behind the provider trait

## Phase 3 — Pre-mainnet
- [ ] External audit + remediation
- [ ] Multisig (Squads) for operator & treasury
- [ ] Legal/compliance checklist signed off (`LEGAL_COMPLIANCE_CHECKLIST.md`)
- [ ] Load testing settlement path; RPC redundancy

## Phase 4 — Mainnet (gated)
- [ ] `ENABLE_MAINNET=true` only after Phase 3 complete + counsel sign-off
- [ ] Real-money pilot with low `max_round_size`
- [ ] Insurance/treasury-reserve policy decision

## Deliberate non-goals (now)
- SPL token bets (lamports only by design)
- Off-chain credit, or any "instant withdraw" outside program settlement
- Admin winner override (never)
