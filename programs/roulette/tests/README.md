# Program tests

Rust unit tests live alongside the source (`cargo test`):
- `src/winner.rs` is mirrored by `packages/verification/src/winner.ts` property tests.
- `tests/fixtures/winner-table.json` cross-checks known (participants, entropy) → winner pairs.

The full integration harness (`anchor test`) requires the Anchor toolchain and
runs `tests/roulette.ts` in the repo root `tests/` directory.
