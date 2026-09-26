# Solana Roulette — Randomness

## 1. Requirements

- Deterministic: same participants + same randomness value ⇒ same winner, always.
- Publicly verifiable from chain data alone (`packages/verification`).
- Unknowable before betting closes: no participant can compute the winner pre-lock.
- Pluggable: a real VRF oracle must be installable for mainnet without redesign.
  (`reveal_input` already carries the 32-byte pre-image, so a provider swap
  changes only how those bytes are obtained — see §3.)

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

- **Operator denial-of-service: RESOLVED (B2).** `lock_round`, `settle_round` and
  `pay_winners` are permissionless — see §2.3. The operator can no longer stall a
  payout. `cancel_round` remains operator-gated, but it grants no fund-holding
  power: a FULL round can always be settled and paid by anyone.
- **Operator grind/retry: REDUCED, not eliminated.** Permissionless `lock_round`
  means anyone (including a competitor) can lock the instant a round goes FULL,
  so the operator can no longer *choose* the reveal slot. They can still refuse
  to lock, and the underlying blockhash entropy is still validator-influenced.
  Only a real VRF removes this class of risk — §3.
- **Multi-block reorgs on devnet** are practically irrelevant at 32-slot offsets.

**This adapter is explicitly NOT production-safe and is labeled `devnet-only` in code.
The config surfaces this to the UI, which displays a persistent DEVNET banner.**

## 2.3 Settlement is permissionless (B2)

`lock_round`, `settle_round` and `pay_winners` are signed by an arbitrary
fee payer, **not** the configured operator. This is safe because every value
each instruction writes is a pure function of state the program validates
itself — the signer's identity cannot change the outcome:

| Instruction | What the caller cannot influence |
|---|---|
| `lock_round` | Everything written is read from the seed-validated `config` PDA (`reveal_offset`, `fee_bps`) or from `Clock::get()`. The only caller input is *when*, and letting anyone lock the moment a round goes FULL **removes** the operator's slot-picking discretion rather than granting one. |
| `settle_round` | Entropy comes from `slot_hashes`, address-pinned to the real sysvar. The winner comes from `pick_winner`, which rejects any participant list that is not the canonical index-ordered weight chain and requires `count == participant_count` — so entries cannot be substituted, reordered, truncated or padded. Fee and payout come from the **frozen** `fee_bps` / `pot`, and `treasury` must equal `config.treasury`. |
| `pay_winners` | `winner_account` must equal the `round.winner` frozen in phase 1, `treasury` must equal `config.treasury`, and both amounts are the frozen `payout_lamports` / `fee_lamports`. The caller supplies no amount and no recipient that is not already pinned on-chain. All three instructions are argument-free. |

`cancel_round` **deliberately stays operator-gated.** Refunds are exact, so it is
not a theft vector — but a permissionless cancel would let anyone front-run
settlement of a healthy FULL round, destroy the pot and kill the fee. Removing
that gate safely needs a timeout (refund only once the round is provably
unsettleable), which is a larger state change than B2 allows.

### 2.3.1 The sysvar pin is load-bearing

`SettleRound::slot_hashes` carries
`#[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]`.

This is not cosmetic. A bare `AccountInfo` is attacker-supplied and
`extract_slot_hash` parses whatever bytes it is handed. While `settle_round` was
operator-gated the hole was masked by trust in the operator; opening the gate
would have turned it into a **winner-picking bug** — a caller could pass a PDA
they own containing `(reveal_slot, hash_of_their_choosing)` and settle any round
to any winner. The pin is the reason permissionless settle is safe.

Guarded by `programs/roulette/tests/settlement_authority.rs` (CI-enforced) and
attempted live against devnet by
`scripts/devnet-permissionless-settle-e2e.ts`.

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

## 3. VRF provider assessment (mainnet path)

**Status: NOT INTEGRATED. The current entropy remains devnet-only and must not be
treated as production-grade.** This section records the provider survey so the
next task starts from facts rather than a shortlist.

The winner-selection math (`randomness % total_weight → cumulative ranges`) is
provider-agnostic: only entropy sourcing changes, and `packages/verification`
reads the round's `randomness` field, so verification code never needs to know
the provider. `reveal_input` (32 bytes) already holds exactly the pre-image a
VRF provider would need persisted, so **B1 verifiability survives a provider
swap** — the persisted entropy is just "32 bytes the program committed to
before the draw".

| Provider | Verdict | Why |
|---|---|---|
| **Switchboard VRF** | ❌ **DEAD — do not integrate** | Switchboard announced shutdown on 2026-09-19 and **ceased all operations on 2026-09-25** (yesterday), after a suspected key compromise on 2026-08-29. Its own integration guides are now marked "for historic educational purposes only". Its SDK also required `anchor-lang 0.32.1`, incompatible with this program. Any plan naming Switchboard is already stale. |
| **ORAO VRF** (`orao-solana-vrf-cb`) | ⚠️ **blocked by Anchor version** | Alive and well (v0.4.0, Jan 2026, callback-CPI model, ~0.001 SOL/request). But **every published version requires `anchor-lang >= 0.31`** (0.2.0→^0.31.0, 0.3.3→^0.31.1, 0.4.0→^0.32.1) and this program is on **0.30.1**. Integrating it forces a program-wide Anchor upgrade of a deployed, money-moving program. |
| **MagicBlock SolanaVrf** (`ephemeral-vrf-sdk` 0.3.0) | ✅ **best candidate — needs a scoped spike** | Alive, open source, audited (Zenith, 2025-08-06), RFC 9381 with on-chain Ristretto/Schnorr proof verification, and `anchor-lang >=0.28.0, <1.0.0` so it is version-compatible with 0.30.1. Its VRF program and `DEFAULT_QUEUE` were confirmed **live on devnet** during this assessment. Unverified: whether a funded oracle is actually fulfilling devnet requests, program size/compute impact, and the `anchor` vs `anchor-compat` feature choice. |

### 3.1 What a MagicBlock integration would require

The flow maps onto the desired state machine with no change to the escrow,
fee, tier or winner-selection logic:

```
OPEN → FULL → LOCKED → RANDOMNESS_REQUESTED   (lock_round: request_vrf CPI,
                                               record the request/queue state)
           → RANDOMNESS_VERIFIED              (callback invoked BY the VRF
                                               program after it verifies the
                                               proof on-chain; only the VRF
                                               program can produce the
                                               VRF_PROGRAM_IDENTITY signer)
           → WINNER DETERMINED                (same derive → ticket → cumulative
                                               walk as today)
           → PAYOUT → COMPLETED → NEXT ROUND  (pay_winners already permissionless)
```

- **Provider:** MagicBlock SolanaVrf, program `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`.
- **Accounts:** an `oracle_queue` pinned to `DEFAULT_QUEUE`
  (`Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh`, live on devnet) on the
  request; a `vrf_program_identity` (`Signer`, address-pinned) on the callback;
  the `Round` PDA passed as a writable remaining account.
- **Who pays:** the lock-time payer, per request, in SOL. Currently a fixed
  cost the platform absorbs; a per-round fee would change the 7.5% economics
  and is out of scope.
- **Callback/fulfillment:** the VRF program verifies the proof and CPIs the
  callback. The callback must be written so it can never fail (a failing
  callback is client misbehaviour, and the oracle eventually fulfils *without*
  calling back after `callback_deadline`).
- **How the program verifies the result:** it does not verify a proof itself —
  the VRF program does, and the callback's `VRF_PROGRAM_IDENTITY` signer check
  is what makes that trustworthy. This is a different trust model from
  Switchboard's in-program `get_value()`.
- **How the winner is derived:** unchanged. The 32 callback bytes replace the
  `SlotHashes` read.
- **How the result is persisted:** write the 32 VRF bytes to `round.reveal_input`
  at callback time (the field already exists and is already exposed by the API
  and `/api/round/:id/verify`), so independent verification keeps working.
- **How the API verifies it:** unchanged — it reads `reveal_input` and
  recomputes entropy → ticket → winner → fee → payout.

### 3.2 Open questions blocking that integration

1. Is a funded oracle fulfilling devnet requests in `DEFAULT_QUEUE` right now?
   A request that is never fulfilled cannot be demonstrated, and a mock is not
   acceptable.
2. Program size / compute budget impact of pulling in `ephemeral-vrf-sdk`.
3. Whether the `anchor` feature (→ `anchor-modern` → recent `anchor-lang`)
   or `anchor-compat` is required to stay on 0.30.1.
4. Callback CU: the existing `pick_winner` walks every participant, and a
   callback that can fail is a liveness bug.

None of these can be answered without a real build and a real devnet request,
which is a separate, explicitly-scoped task. Until then the honest position is:
**the operator dependency is removed (B2 partial), the entropy source is still
devnet-only, and Mainnet is blocked on a real VRF integration.**

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
