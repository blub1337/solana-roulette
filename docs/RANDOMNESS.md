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
3. Entropy:
   ```
   randomness = SHA256( reveal_blockhash_bytes ‖ round_key_seed )
   ticket     = u64::from_le_bytes(randomness[0..8]) % total_weight
   ```
4. Winner = participant whose cumulative-weight range contains `ticket`.

### Properties

| Property | Status |
|---|---|
| Deterministic | ✅ blockhash is fixed once the slot is produced |
| Verifiable | ✅ anyone re-runs SHA256 over public data |
| Unknowable at lock | ✅ blockhash of a future slot cannot be predicted |
| Operator cannot choose winner | ⚠️ see risks |

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
`randomness` (or recompute from the recorded reveal blockhash) → compute ticket →
walk cumulative ranges → winner. The API endpoint `/api/round/:id/verify` runs this and
returns `ok: true/false` plus a full trace for public auditing.
