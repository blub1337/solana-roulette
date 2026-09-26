# Solana Roulette — Randomness

## 1. Requirements

- Deterministic: same participants + same randomness value ⇒ same winner, always.
- Publicly verifiable from chain data alone (`packages/verification`).
- Unknowable before betting closes: no participant can compute the winner pre-lock.
- Pluggable: a real VRF oracle must be installable for mainnet without redesign.

## 2. DEVNET adapter (default): committed future blockhash

Flow:

1. `lock_round` records `lock_slot` (current slot) and commits
   `reveal_slot = lock_slot + REVEAL_OFFSET` (32 slots ≈ ~12s).
2. `settle_round` requires the **`SlotHashes` sysvar** and `current_slot >= reveal_slot`.
   The program verifies `reveal_slot`'s blockhash exists in the sysvar (within the
   150-slot hash retention window — 32 ≪ 150, safe).
3. Entropy (exactly what `winner.rs::derive_randomness` computes — 55 bytes hashed):
   ```
   randomness = SHA256( "roulette:reveal" ‖ round_id_le_u64 ‖ reveal_blockhash[32] )
   ticket     = u128::from_le_bytes(randomness[0..16]) % total_weight
   ```
   The TS twins in `packages/verification/src/winner.ts` /
   `winner.browser.ts` are byte-identical (locked down by
   `packages/verification/src/entropyParity.test.ts`).
4. Winner = participant whose cumulative-weight range contains `ticket`.

### Properties

| Property | Status |
|---|---|
| Deterministic | ✅ the slot hash is fixed once the slot is produced |
| Verifiable from the Round account | ✅ `reveal_input` is persisted by the program — see §2.2 |
| Verifiable from `getBlock()` | ❌ impossible by design: the sysvar holds bank hashes |
| Unknowable at lock | ✅ the future slot's hash cannot be predicted |
| Operator cannot choose winner | ⚠️ see risks |

### 2.2 The reveal input is persisted on-chain (RESOLVED)

**Root cause, measured on devnet.** The program reads the `SlotHashes` sysvar,
which stores per-slot **bank hashes**, not block hashes. A bank hash is a
PoH-frozen hash of bank state; it is NOT the `blockhash` field that
`getBlock(slot).blockhash` returns. So the value the program hashed could never
be reconstructed from public RPC data — `scripts/devnet-reveal-scan.ts` and
`scripts/devnet-randomness-diag.ts` brute-forced every `getBlock()` blockhash
for all slots in `reveal_slot ± 12` plus `previousBlockhash` variants across
two completed rounds and reproduced **0 / 2** on-chain values. The reveal slots
were real, produced slots (e.g. 504412659 → `5r8q5uxG2kXCfFzrLDpUYWfZBKibvgRqq7V89mtRCRTj`),
which rules out "the slot was skipped".

**Fix.** `Round` gained one appended field, `reveal_input: [u8; 32]`
(`ROUND_SPACE` 225 → 257, `REVEAL_INPUT_OFFSET = 225`). `settle_round` writes
the value it read from the sysvar, so it is produced by the program and is
never user- or API-supplied. The field is appended last so every pre-existing
field offset is unchanged, and 225-byte legacy rounds still decode (with a
zero input, which verification reports as "not recorded").

**Why this is sufficient.** The draw is a pure function of
`(round_id, reveal_input, participant weights)`, and all three are now on-chain.
A third party reads `reveal_input` from the Round account, re-runs SHA256,
recomputes the ticket and walks the cumulative weights — no trust in this
repo's backend, and no dependence on a node the verifier does not control.

**Verified on devnet** (round 13, settle
`3D659KgxjQuHFKeaTC4tUghRSZUTDvg1bxM2GSpN5B2cbTkftWU7SfyeTkpJrGZvUd8ECFdWg7272UpbbVLLHRr4`):

| | value |
|---|---|
| `reveal_input` (persisted) | `856135714db6b917cf0675ee5d3901dcfd06c8ddaec4aff0e2caa942e74a54ec` |
| recomputed `randomness` | `7421ca052a5547e1732ba6fe2d8f55a518b2d1a0fa3348ac7445cd126a533380` |
| on-chain `randomness` | `7421ca052a5547e1732ba6fe2d8f55a518b2d1a0fa3348ac7445cd126a533380` |
| recomputed ticket | `944829300` |
| on-chain ticket | `944829300` |
| `getBlock(reveal_slot).blockhash` | `GiwmWPKKQR5Su9srSGwUMJtZa2ZzLwgcQrtLjiJCeZaE` → does **not** reproduce (control) |

Regression guard: `scripts/devnet-randomness-verify.ts <roundId>` re-checks all
of the above plus the payout transaction, and CI runs
`cargo test --test randomness_parity`, which pins the Rust program, the Node
twin and the browser twin to the same fixture — including the on-chain vector
above.

### Devnet-only trust assumptions (READ THIS)

- **Operator denial-of-service:** the operator signs settlement; refusing to settle
  stalls payout (funds remain locked in escrow; `cancel_round` refunds).
- **Operator grind/retry:** by cancelling and re-creating rounds, a malicious operator
  can search for favorable blockhash alignment. Mitigation on mainnet = real VRF.
- **Multi-block reorgs on devnet** are practically irrelevant at 32-slot offsets.

**This adapter is explicitly NOT production-safe and is labeled `devnet-only` in code.
The config surfaces this to the UI, which displays a persistent DEVNET banner.**

## 2.1 Devnet ledger adapter (runtime `mode: "local"`)

When the program is not deployed, `apps/api/src/localLedger.ts` plays the
SlotHashes role with a **virtual slot clock** (devnet-like cadence, 400 ms) and a
real commit–reveal:

1. `lock_round` samples a 32-byte secret and publishes only
   `commit = SHA256("roulette:local-commit" ‖ round_id_le ‖ secret)`. The
   commitment is stored on the round; the secret stays private.
2. Once the virtual clock passes `reveal_slot`, the secret is revealed and the
   "blockhash" of that slot is
   `SHA256("roulette:local-slot" ‖ round_id_le ‖ secret)`.
3. From there the pipeline is **the program's own code**:
   `deriveRandomness(blockhash, round_id)` → `computeTicket` → `selectWinner`.

Because the secret is not published until reveal, the outcome is genuinely
unknowable at lock time — the commit is verifiably bound to the round and the
revealed value is a pure function of the public inputs plus that secret.

| Property | Status |
|---|---|
| Deterministic | ✅ revealed value + weights are a pure function |
| Verifiable | ✅ `GET /api/round/:id/verify` recomputes from recorded randomness |
| Unknowable at lock | ✅ secret unpublished until the reveal slot |
| No `Math.random`, no admin choice | ✅ the operator cannot influence it |

Trust assumptions: the process holds the secret in memory, so a hostile host
could subvert it. That is acceptable for a devnet simulation and is another
reason the ledger is refused on mainnet. **It is not a substitute for a VRF.**

## 3. VRF interface (mainnet path)

```rust
pub trait RandomnessProvider {
    /// Commit at lock time; returns anything to store on the Round account.
    fn commit(ctx: &Context<...>) -> Result<RandomnessCommitment>;
    /// Reveal at settle; returns 32 bytes of entropy or errors if not ready.
    fn reveal(ctx: &Context<...>, commitment: &RandomnessCommitment) -> Result<[u8; 32]>;
}
```

Current implementation: `SlotHashProvider` (devnet-only). Planned mainnet implementations:

- **Switchboard VRF v2 / `RandomnessAccountData`** — cost per request, industry standard.
- **Chainlink VRF on Solana** (when available).
- **Orao VRF**.

The winner-selection math (`randomness % total_weight → cumulative ranges`) is identical
for every provider; only entropy sourcing changes. `packages/verification` reads the
round's `randomness` field, so verification code never needs to know the provider.

## 4. Why not commit-reveal by users?

Participants could withhold reveals to grief. Why not operator-supplied randomness?
Operator could pick winners. Future-blockhash is the strongest scheme deployable on
devnet without external oracles and with zero trust in the frontend/backend.

## 5. Verification

`packages/verification` recomputes: fetch `Round` + participants from RPC → take
`reveal_input` → re-derive entropy with `deriveRandomness` → assert it equals
the stored `randomness` → compute the ticket → walk cumulative ranges → winner →
recompute fee/payout. The API endpoint `/api/round/:id/verify` runs this and
returns `ok: true/false` plus a full trace for public auditing.

Rounds settled before the `reveal_input` field existed report
`entropySource: "recorded_randomness"` and deliberately FAIL the
`entropy_recomputed_from_persisted_input_matches_recorded` check, because their
entropy genuinely cannot be independently recomputed. Devnet only; not
reproducible retroactively.
