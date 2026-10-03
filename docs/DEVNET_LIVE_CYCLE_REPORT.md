# Live production cycle report — SolRoll on Render (devnet)

Observed behaviour of a complete roulette cycle driven against the **live
Render-deployed platform**, not a local mock. Reproduce with:

```bash
npx tsx scripts/devnet-live-cycle-e2e.ts deposit   # join the live round
npx tsx scripts/devnet-live-cycle-e2e.ts watch     # observe, verify, report
# or: npm run e2e:live-cycle -- deposit|watch
```

Raw evidence: `test-ledger/live-cycle-state.json` (no secrets — public keys,
transaction signatures and balances only).

## Environment

| | |
|---|---|
| Frontend | https://solana-roulette-web.onrender.com (Next.js, Render) |
| Backend | https://solana-roulette-api-gd7k.onrender.com (Fastify, `mode: chain`, `realFunds: true`) |
| Program | `F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos` (devnet) |
| Treasury / fee wallet | `CVkVA46rL6CLBVqfPpJKGoHY3pi4tJQ12Yj2ardtGNc1` |
| Round | **159**, tier 0 (1 SOL lane), cap `1_000_000_000` lamports |
| Fee | 200 bps (2 %), snapshotted at lock |

## 1. Wallet interaction

Browser wallet clicks cannot be automated headlessly, so the two participants
signed with real devnet keypairs using the **identical sign-and-send path the
wallet adapter performs**: the SDK builds the program `deposit` instruction and
the wallet signs the transaction. Everything downstream (API intent/confirm, the
on-chain program, the settlement driver, payout) is the live production stack.

- `T1` `2h3gwYGLc6nxCnPdnNwgKvcnd66XuGzKEnfrxB7LEZsf` — deposited **0.6 SOL**
- `T3` `8TiPL8yJkNzo6o7227fQjtwcbLbJFs6kLVpc1oqNRGyP` — deposited **0.4 SOL**

## 2. Deposit — through the live backend to the program escrow

Each deposit ran the production 3-step flow: `POST /api/round/159/deposit/intent`
→ real `deposit` program instruction → `POST /api/round/159/deposit/confirm`.
The live backend re-read the transaction from devnet and credited it only then.

| | T1 | T3 |
|---|---|---|
| intent | HTTP 200 | HTTP 200 |
| intent escrow == program escrow PDA | ✅ `8wNGw8F32DZPAVQzeN4XuejAZ8HUWskXYMwBwwz9cUUG` | ✅ |
| deposit tx | `2AnTNZ48SrdpbpQDa3aX7Gn3RZQUVSjXeNV7ctExPe2wD2fjs9hc2YjCjSfVeYNnSSBi52biiuLdbhYy3CgieJYb` | `4DRvvwziKBbDdL3ynAcKExZPTH3P6QyCqr4tD8A8mkyDQWm3ggG2v6eHAdgm17sn1VpxoosuUTi6L37wD4hYUYDD` |
| confirm | HTTP 200 `credited: true` | HTTP 200 `credited: true` |
| wallet balance | 0.9795 → 0.3783 SOL | 1.2515 → 0.8503 SOL |
| round pot after | `600_000_000` | `1_000_000_000` |

Round escrow went `650_240` (rent floor) → `1_000_650_240`; round flipped
`OPEN → FULL` exactly at the tier cap with 2 participants.

## 3. Round settlement — done by the deployed driver, not the test

The Render API's own settlement driver locked, settled and paid autonomously.
`lock_slot 507_142_811` → `reveal_slot 507_142_843` (offset 32).

- persisted entropy input (`reveal_input`): `1dc5fadbb30a8fa2d601b8a1d8a8c6947c941185b695fb7eb771e70b9ff6bd58`
- derived randomness: `1faf1304926cbec0ebab28658b0efcadc5ad12f331633154303e19cc62141e26`
- winning ticket: `104_094_495`

The winner was **recomputed independently** from the on-chain `reveal_input` and
the participant weights (`deriveRandomness → computeTicket → selectWinner`) and
matched the on-chain winner byte-for-byte.

## 4. Outcome — winner / loser / payout / commission

| | Result |
|---|---|
| Winner | **T1** `2h3gwYGLc6nxCnPdnNwgKvcnd66XuGzKEnfrxB7LEZsf` |
| Loser | **T3** `8TiPL8yJkNzo6o7227fQjtwcbLbJFs6kLVpc1oqNRGyP` |
| Pot | `1_000_000_000` |
| Payout (98 %) | `980_000_000` |
| Fee (2 %) | `20_000_000` |
| `payout + fee` | `1_000_000_000` = pot (nothing created or lost) |
| Winner balance | post-deposit `378_328_600` → `1_358_328_600` (**+980 000 000**) |
| Loser balance | post-deposit `850_326_720` → `850_326_720` (**+0**, loses only the stake) |
| Treasury | `CVkV…tGNc1` balance `20_000_000`; pay tx credited it exactly `+20 000 000` |
| pay_winners tx | `fC8FhQZNsveZMvKqB8tauywaqnWNdQ2RTyPFezSpheCzuVnCrSpDqtRecFnLbbia2nCHqrTVkQSvQiNPajofCn1` |
| Round escrow after pay | `650_240` lamports (rent floor), still owned by the program |

One pay attempt in the same slot was **rejected by the program** with custom
error `6015` (`PayoutNotReady`) — the round is paid exactly once; no double
payout occurred (winner delta == payout, escrow drained exactly).

## 5. Backend + frontend reflection

- `GET /api/round/159/verify` → `ok: true`, `computedWinner` == on-chain winner.
- `GET /api/history` → round 159 `COMPLETED`, winner/payout/fee as above,
  `settlementVerified: true`, `payoutTxSignature` = the pay tx.
- `GET /api/pools` (direct and via the live site) → tier-0 head advanced to a
  fresh round, `lastCompletedRoundId: 159`, `lastWinner`, `lastPayoutLamports:
  980000000`, `lastFeeLamports: 20000000`.

## Result

**16/16 verification checks passed** on the live platform (11/11 in the deposit
phase, 16/16 in the watch/verify phase after a harness type-fix). A full cycle —
wallet-signed deposits → capped round → driver lock/settle/pay → 98 %/2 % split →
winner/loser balances → API verify — was demonstrated end to end against the
deployed frontend, backend and on-chain program.

### Notes / limitations

- Live pools had no other players, so the round was filled by the two test
  wallets; a multi-player field exercises the same weight walk.
- Real devnet SOL moved (throwaway wallets). The browser wallet *click* itself
  is the only step not automated; the signing/transaction path is identical.
