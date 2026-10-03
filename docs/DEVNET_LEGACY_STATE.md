# Devnet round state (documentation only — do not "fix" it)

This records the devnet rounds that still hold a pot, so the next person does
not mistake them for a live bug, and so nobody spends a day "recovering" funds
that are not recoverable by design.

**Nothing in this document is acted on by the product.** There is no refund,
drain, migration or recovery path for these balances — see
[Why nothing moves](#why-nothing-moves).

Most of these are pre-C1 leftovers, but **not all of them** — rounds 24 and 25
were created by the *current* program and stalled. That distinction matters, so
it is measured and spelled out below rather than assumed.

## How to re-measure

Every number below is measured read-only from devnet. Reproduce with:

```bash
node scripts/inspect-devnet.mjs                  # program, config, operator, treasury
npx tsx scripts/measure-devnet-rounds.mts        # every round: status, pot, escrow
npx tsx scripts/measure-devnet-round-history.mts # when each escrow was first funded
```

Do not trust a remembered number. Round/escrow state moves every time a test
wallet deposits.

## The pre-C1 / post-C1 boundary

The C1 fix is a **newly deployed program binary**, not a Git commit — the chain
has no build history. The boundary is therefore a slot, not a commit hash:

| | Slot |
|---|---|
| current program `ProgramData` created (C1 binary live) | `504558584` |

A round is **pre-C1** if its escrow first received lamports at a slot *before*
`504558584`, and **post-C1** at or after it. `measure-devnet-round-history.mts`
reads that slot directly from the escrow's earliest funding transaction, so the
split below is measured, not assumed.

Measured against the current counter of 66:

| Round | First funded | Era | Status | Pot | Participants |
|---|---|---|---|---|---|
| 1 | `504401432` | pre-C1 | `COMPLETED` | 1.0 SOL | 2 |
| 6 | `504408010` | pre-C1 | `RANDOMNESS_PENDING` | 1.0 SOL | 3 |
| 7 | `504412558` | pre-C1 | `COMPLETED` | 1.0 SOL | 3 |
| 13 | `504432912` | pre-C1 | `COMPLETED` | 1.0 SOL | 3 |
| 21 | `504558769` | **post-C1** | `OPEN` | 0.4 SOL | 1 |
| 24 | `504558944` | **post-C1** | `RANDOMNESS_PENDING` | 1.0 SOL | 3 |
| 25 | `504559764` | **post-C1** | `RANDOMNESS_PENDING` | 1.0 SOL | 3 |
| 26 | `504560650` | post-C1 | `COMPLETED` | 1.0 SOL | 3 |
| 27 | `504561449` | post-C1 | `COMPLETED` | 1.0 SOL | 3 |
| 28 | `504562267` | post-C1 | `COMPLETED` | 1.0 SOL | 3 |
| 58 | `504749163` | post-C1 | `OPEN` | 0.05 SOL | 1 |
| 66 | `504818696` | post-C1 | `OPEN` | 0.20 SOL | 4 |

### Correction: rounds 24 and 25 are NOT pre-C1

An earlier revision of this document labelled 24 and 25 "stranded pre-C1". That
was wrong. Both escrows were funded at slots `504558944` / `504559764`, which is
*after* the C1 binary went live at `504558584`, so they were created by the
current program. They are **post-C1 rounds that stalled**, and they are the
evidence for the real open problem below — not legacy dust to be cleaned up.

The only genuinely pre-C1 round still holding a pot is **6**.

## Measured state

Every live escrow holds exactly `pot + 650240` (rent), and every `COMPLETED`
round's escrow holds exactly `650240` — so **no funds are missing and no escrow
is over-funded**. Verified across all 66 rounds.

An escrow balance of `650240` (rent only) is the healthy settled state: the rent
left behind after `pay_winners` moved the pot out. Total still escrowed in
non-empty non-terminal rounds at the time of writing: **3.65 SOL** across rounds
6, 21, 24, 25, 58 and 66. Every one of those escrows holds exactly `pot + rent`.

## The real open problem (post-C1, not legacy)

Rounds 24 and 25 are post-C1 rounds sitting in `RANDOMNESS_PENDING` with a full
1.0 SOL pot each. They were locked by the current program and then never
settled. The driver does not revisit them: `advanceTierLane` works on
`store.currentRoundIdByTier[t]` and never walks backwards, so a round that is not
the head of its lane is invisible to settlement by design.

This matters more than the devnet dust. A mainnet round that stalls this way
would hold real funds in an escrow the product will not drain. See
[Scope](#scope).

### Resolved: the driver now sweeps stalled rounds (2026-10-03)

`apps/api/src/settlement.ts` gained `sweepStalledRounds`, which `runOnce` calls
out on a throttled interval. It scans a bounded window of ids below the newest
round, skips lane heads (the head loop owns those), and finishes every
remaining `RANDOMNESS_PENDING` round through the SAME path as a head —
`settle_round` once the reveal slot is reached, then `pay_winners` — but
**without** opening a new round for the lane (the lane already points past the
orphan). It never calls `cancel_round`.

This is option 2 from [Scope](#scope) below: the permissionless settle/pay pair
walks stuck rounds, not just lane heads, so a vanished operator cannot strand
them either. Live ledger rounds 24/25 remain as-is (devnet test wallets, no
recovery tool — see [Why nothing moves](#why-nothing-moves)); the point is that
the *mechanism* now exists.

**Residual limitation.** `settle_round` reads the reveal slot's hash from the
`SlotHashes` sysvar, which retains only a bounded recency window. A round that
has sat in `RANDOMNESS_PENDING` longer than that window is no longer settleable,
and the program forbids `cancel_round` from `RANDOMNESS_PENDING` — so such a
round cannot be cleared without a program change. For live operation this is
irrelevant (the sweep runs every `STALLED_SWEEP_MS`, default 60 s), but it is
the reason a pre-existing, long-stalled round is still not recoverable.

## Why nothing moves

1. **The driver does not revisit them.** `advanceTierLane` works on
   `store.currentRoundIdByTier[t]` and never walks backwards. A round that is
   not the head of its lane is invisible to settlement by design.
2. **The participants are devnet test wallets.** A refund would need the
   participant set for that round, which is not represented in any table this
   deployment can still read.
3. **Devnet SOL is not recoverable anyway.** It is faucet money with no value;
   the only cost of leaving it is escrow rent, which the program already holds.
4. **A recovery path is a new attack surface.** Anything that can move escrowed
   lamports out of a round is a privileged instruction. Adding one to clean up
   test dust would put real mainnet funds behind the same code path. The
   product deliberately has no such instruction.

`scripts/devnet-finish-stranded-rounds.ts` exists as a one-off operator tool.
It is not wired into the API, the driver or any build script, and it must stay
that way unless someone makes a deliberate, reviewed decision to change it.

## Scope

Rounds 24 and 25 already prove this failure mode happens with the **current**
program, not only with legacy state. A mainnet round that stalls in
`RANDOMNESS_PENDING` would hold real funds in an escrow the product will not
drain — that is the serious problem, and it is not hypothetical.

Before mainnet, decide explicitly how a stalled round is finished:

- operator timeout then `cancel_round` (operator-only, allowed from
  `Open|Full` — note it is **not** allowed from `RANDOMNESS_PENDING`, so a
  timeout alone does not clear a stalled round), **or**
- anyone calling the permissionless `settle_round` / `pay_winners` pair. Both
  instructions are already permissionless on-chain, so this needs no new
  program authority — only a driver that walks stuck rounds, not just lane heads.

**Decision (2026-10-03):** option 2 is implemented — `sweepStalledRounds` in
`apps/api/src/settlement.ts` drives non-head `RANDOMNESS_PENDING` rounds through
the permissionless `settle_round` / `pay_winners` pair. The decision is recorded
in [DEPLOYMENT.md](./DEPLOYMENT.md) §9. This document remains the record of the
residual on-chain limitation (a round stalled past the `SlotHashes` retention
window cannot be settled or cancelled without a program change).
