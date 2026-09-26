# Solana Roulette — On-chain program (Anchor, Rust)

Real Anchor program source lives here. See `../../docs/SMART_CONTRACT.md` for the
full account model, instruction set, state machine, and error codes.

## Layout (when the Anchor toolchain is available)

```
programs/roulette/
├── Cargo.toml
├── Anchor.toml        (declare program id F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos)
├── Xargo.toml
└── src/
    ├── lib.rs         (declare_id!, instruction dispatch)
    ├── state.rs       (GlobalConfig, Round, Participant, RoundStatus, PDAs)
    ├── instructions/  (initialize_config, create_round, deposit, lock_round, settle_round, cancel_round)
    ├── errors.rs
    └── math.rs        (checked fee/payout math)
```

## Why source is not included in this repo snapshot

The Freebuff workspace has **no Rust/Anchor toolchain** (no cargo/solana-cli), so the
Rust crate cannot be compiled or tested here. To keep the repo green (tests, builds),
the program source ships as a follow-up once an Anchor-capable environment exists.

**Deposits are only enabled against a deployed program** (`CHAIN_MODE=onchain` +
`ROULETTE_PROGRAM_ID`). Until then the web app runs in `demo`/`offchain` mode with
real wallet UX and simulated escrow, clearly labeled in the UI, and the API refuses
financial settlement ops that require the program.

## Guaranteed invariants (mirror-enforced by packages/verification)

- pot ≤ pool cap; weights = lamports; cumulative ranges sum exactly to pot
- fee = pot × 750 / 10_000 (floor), payout = pot − fee — integer lamports only
- winner = unique participant whose [weight_start, weight_start + amount) contains
  ticket = SHA256(reveal_blockhash ‖ round_key)[0..8] mod total_weight
- COMPLETED/CANCELLED rounds are terminal; fee/payout snapshots frozen at lock
