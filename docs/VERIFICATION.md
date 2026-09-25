# Solana Roulette — Verification Guide

How any third party can verify a round **without trusting the operator or the API**.

## 1. What is verifiable

- Every deposit: on-chain transfer into the round escrow PDA.
- The pot: escrow lamport balance (program-owned PDA, cannot be altered off-chain).
- The fee/payout split: frozen in the Round account at lock; executed on-chain.
- The winner: deterministic function of public data (blockhash + participant weights).
- The participant list: Participant PDAs readable by anyone.

## 2. Independent recomputation (packages/verification)

```ts
import { verifyRoundById } from "@solana-roulette/verification";

const result = await verifyRoundById(connection, roundId);
// result: { ok, round, trace: { randomnessHex, ticket, totalWeight, participants, winner } }
```

The package contains **zero** dependency on apps/api or app config — it reads:

- `Round` account (status, reveal_slot, randomness, fee/payout, winner)
- All `Participant` PDAs (amount, weight_start, index)
- The reveal slot's blockhash (for recomputation when randomness isn't yet stored)

and recomputes:

```
randomness = sha256(reveal_blockhash ‖ round_key)   (or Round.randomness)
ticket     = le_u64(randomness[0..8]) % total_weight
winner     = participant whose [weight_start, weight_start+amount) contains ticket
```

then compares against the on-chain recorded winner and the recorded fee/payout math.

## 3. Property tests (same file, run in CI)

- For random participant sets and random 32-byte entropy: `verifyWinner(participants, entropy)`
  is deterministic and total weights always sum to pot.
- Boundaries: ticket exactly at a boundary maps to the later participant's range.
- Monotonicity: increasing a participant's amount can only increase their win probability
  (sampled statistically).

## 4. API surface

- `GET /api/round/:id/verify` — runs §2 server-side and returns the trace.
- `GET /api/round/:id/transactions` — every signature with its RPC verification status.

## 5. Manual verification (no code)

1. `solana account <escrow>` → balance = pot.
2. Fetch Round account → check `fee_bps=750`, `payout=pot-fee`.
3. Get blockhash of `reveal_slot` (`solana block <slot>` / RPC), sha256 with round key,
   mod total weight → must equal the on-chain `winning_ticket` and map to `winner`.
