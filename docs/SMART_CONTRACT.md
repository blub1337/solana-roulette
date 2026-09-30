# Solana Roulette — Smart Contract

`programs/roulette` — Anchor 0.30.1, Rust, lamports only, checked arithmetic everywhere.

## 1. Accounts (final model)

```rust
#[account]
pub struct GlobalConfig {
    pub operator: Pubkey,        // signs lifecycle txs (devnet server keypair)
    pub treasury: Pubkey,        // receives 2% fee
    pub fee_bps: u16,            // 200 (2%)
    pub max_round_size: u64,     // 10_000_000_000 lamports (10 SOL)
    pub min_deposit: u64,        // lamports
    pub max_deposit: u64,        // lamports
    pub reveal_offset: u64,      // 32 slots
    pub bump: u8,
}

#[account]
pub struct Round {
    pub id: u64,                 // monotonic
    pub status: RoundStatus,     // OPEN..COMPLETED | CANCELLED
    pub escrow: Pubkey,          // vault PDA holding the pot
    pub pot: u64,                // total lamports deposited
    pub total_weight: u128,      // == pot while weights = lamports
    pub participant_count: u32,
    // Frozen at lock:
    pub lock_slot: u64,
    pub reveal_slot: u64,
    pub fee_bps: u16,            // snapshot of config.fee_bps at lock
    // At settle:
    pub randomness: [u8; 32],
    pub winning_ticket: u128,
    pub winner: Pubkey,
    pub fee_lamports: u64,
    pub payout_lamports: u64,
    pub bump: u8,
}

#[account]
pub struct Participant {
    pub round: Pubkey,
    pub wallet: Pubkey,
    pub amount: u64,             // lamports == weight
    pub weight_start: u128,      // cumulative start of this participant's range
    pub index: u32,              // join order
    pub bump: u8,
}
```

- **Escrow** is a PDA with seeds `["escrow", round.key()]`, program-owned, no data account
  (lamport vault only). PDAs: `["config"]`, `["round", id]`, `["participant", round, wallet]`.
- Fee/payout snapshot at **lock** time into `Round` (fee cannot drift mid-round).
- Settlement results (winner, ticket, fee, payout) are persisted on `Round` — a complete
  audit record readable by anyone.

## 2. Instructions

| Instruction | Signer | Validation highlights |
|---|---|---|
| `initialize_config(operator, treasury, fee_bps, max_round_size, min_deposit, max_deposit)` | payer=deployer | fee_bps ≤ 3000; min ≤ max; not re-initializable |
| `set_fee(fee_bps)` | operator (config.operator) | Added by the in-place 2026-09 upgrade (fee correction 750→200): fee_bps ≤ 3000; takes effect from the next round's fee snapshot (create/lock) — never retroactively |
| `create_round()` | operator | Derives Round #id from config counter; status=OPEN |
| `deposit(amount)` | depositor | status==OPEN; min ≤ amount ≤ max; pot+amount ≤ max_round_size (else `RoundOverCap` — no truncation); lamports move wallet→escrow; Participant PDA created with cumulative weight_start |
| `lock_round()` | permissionless | status==FULL → RANDOMNESS_PENDING; freezes fee_bps, commits lock_slot/reveal_slot |
| `settle_round()` | permissionless | status==RANDOMNESS_PENDING; slot ≥ reveal_slot; SlotHashes sysvar (address-pinned) contains reveal blockhash; computes randomness, ticket, winner, fee and payout and freezes them (no lamports move) |
| `pay_winners()` | permissionless | status==RANDOMNESS_PENDING with a frozen winner; escrow pays 98% to the winner and 2% to the treasury atomically, then status=COMPLETED |
| `cancel_round()` | operator | From OPEN/FULL; refunds every participant's exact deposit from escrow; status=CANCELLED |

State machine transitions are exhaustive-matched; any other transition returns
`InvalidRoundStatus`. `COMPLETED`/`CANCELLED` are terminal — deposits and settles revert.

```text
OPEN ──deposit fills tier cap──► FULL ──lock_round──► RANDOMNESS_PENDING
                                                             │
                                        settle_round (phase 1: freeze outcome)
                                                             ▼
                                                    RANDOMNESS_PENDING
                                                             │
                                        pay_winners (phase 2: pay + terminal)
                                                             ▼
                                                          COMPLETED ──► next round
```

Settlement is deliberately split in two: phase 1 is replay-safe and moves nothing,
phase 2 is the only instruction that transfers lamports and the only one that can
make a round terminal. `settle_round` runs from `RANDOMNESS_PENDING` because
`lock_round` is what commits the reveal slot — requiring `FULL` there (an earlier
bug) made settlement unreachable.

## 3. Winner selection math

```text
weight_i        = amount_i (lamports)
weight_start_i  = Σ amounts of participants with smaller join index
ticket          = u64::from_le_bytes(sha256(reveal_blockhash ‖ round_key)[0..8]) % total_weight
winner          = the participant i where weight_start_i ≤ ticket < weight_start_i + amount_i
```

- u128 cumulative sums (10 SOL max round ⇒ no overflow risk, but still checked).
- Iterate participants by index until cumulative ≥ ticket — O(n), fine for devnet sizes.
- Determinism: verified by `packages/verification` property tests.

## 4. Error codes

`InvalidFeeBps`, `InvalidDepositLimits`, `ConfigAlreadyInitialized`, `InvalidOperator`,
`InvalidRoundStatus`, `RoundOverCap`, `DepositTooSmall`, `DepositTooLarge`,
`RoundNotFull`, `RevealSlotNotReached`, `RevealBlockhashMissing`, `ArithmeticOverflow`,
`InvalidParticipant`, `NothingToRefund`.

## 5. Lamport flows

- deposit: `system_program::transfer(wallet → escrow)` signed by wallet.
- settle: escrow PDA signs two transfers (escrow→winner 98%, escrow→treasury 2%);
  escrow seeds are re-derived in the instruction so the PDA is a valid signer.
- cancel: escrow signs per-participant refunds of exact deposited amounts.

## 6. Testing

- `tests/roulette.ts` (Anchor/Bankrun-style harness via `anchor test`, requires Rust).
- TypeScript property tests in `packages/verification` mirror the exact winner algorithm
  and cross-check the Rust math tables checked into `programs/roulette/tests/fixtures`.
- `apps/api/src/localLedger.test.ts` pins the same state machine, cap rules, fee split
  and commit–reveal boundary against the in-process devnet ledger, so the semantics
  the program must uphold are executable and reviewable today (see PAYMENTS.md §2).

## 7. Runtime modes

The program above is the only thing that can ever move real SOL. Until it is
deployed, `apps/api` can run an in-process ledger (`apps/api/src/localLedger.ts`)
that mirrors these accounts, seeds, rules and arithmetic exactly. It is selected
automatically, is reported in `GET /api/health` as `mode`, and is refused on
mainnet. See [PAYMENTS.md](./PAYMENTS.md) §2.
