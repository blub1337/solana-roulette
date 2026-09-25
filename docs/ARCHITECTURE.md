# Solana Roulette — Architecture

> DEVNET-first. Mainnet is hard-gated and requires explicit manual enablement after
> security, legal and compliance review (see `DEPLOYMENT.md` and `LEGAL_COMPLIANCE_CHECKLIST.md`).

## 1. High-level system

```
┌──────────────┐        ┌─────────────────────┐        ┌──────────────────────────┐
│  apps/web    │        │      apps/api       │        │   Solana DEVNET          │
│  Next.js     │◄──SSE──│  Node/TS REST + SSE │◄──RPC──│  programs/roulette       │
│  Wallet      │──REST─►│  Prisma + Postgres  │        │  (Anchor, lamports only) │
│  Adapter     │        │  Tx verifier        │        │  Round escrow PDA        │
└──────────────┘        └─────────┬───────────┘        └──────────────────────────┘
        │                         │                              ▲
        │  user signs tx          │  independent recompute       │  settlement tx signed
        ▼                         ▼  of winner from chain        │  by operator keypair
   User wallet              packages/verification        Operator server keypair
   (Browser)                (no trust in API)            (env: OPERATOR_KEYPAIR, devnet only)
```

Money never passes through a backend-controlled wallet balance. Every SOL movement is a
Solana instruction executed by the on-chain program:

```
User wallet ──deposit(SOL)──► Round escrow PDA (program-owned)
                                     │  settle (program computes winner + splits)
                     ┌───────────────┴───────────────┐
                     ▼                               ▼
                 Winner (92.5%)                 Treasury (7.5%)
```

## 2. Components

| Component | Path | Responsibility |
|---|---|---|
| On-chain program | `programs/roulette` | State machine, deposits, cap enforcement, fee math, winner selection, settlement. Anchor/Rust. |
| Web app | `apps/web` | Next.js App Router, Solana Wallet Adapter, deposit UX, roulette animation of the *already determined* winner. |
| API | `apps/api` | REST + SSE, independent transaction verification, DB persistence, settlement driver. |
| SDK | `packages/sdk` | Typed client: instruction builders, PDAs, account deserialization. |
| Config | `packages/config` | Network/limits/fees as env-driven constants. Mainnet hard gate lives here. |
| Types | `packages/types` | Shared domain types (round states, events, API DTOs). |
| Verification | `packages/verification` | Independent winner recomputation from on-chain data only. |
| Backend selection | `apps/api/src/backend.ts` | Chooses the runtime once at startup: the deployed program (`chain`) or the devnet ledger (`local`). Mainnet is chain-only. |
| Devnet ledger | `apps/api/src/localLedger.ts` | In-process mirror of the program's accounts, rules and arithmetic. No lamports move; devnet only. |
| Tests | `tests/` | Vitest unit + integration, Anchor test harness (Rust toolchain required). |

## 2.1 Runtime selection

```
                       resolveBackend()  (LEDGER_MODE, once per process)
                                   │
              program on RPC? ─────┴─────► yes ──► chain  (real funds)
              + OPERATOR_KEYPAIR?                │
                                   └─────────► no ───► local  (devnet ledger)
```

Both runtimes expose the same `ChainBackend` interface (read rounds/participants,
current slot, reveal entropy, lifecycle instructions, deposit), so the REST
routes, the settlement driver and the UI are identical in both modes. Only the
deposit path differs: the chain runtime has the player's wallet sign a real
`deposit` instruction, while the ledger accepts a wallet-signed, round-bound
message. `GET /api/health` reports `mode` and `realFunds`; the UI renders it so a
simulation is never presented as real money. See `PAYMENTS.md` §2.1.

## 3. On-chain data model (summary)

All balances are **lamports**. See `SMART_CONTRACT.md` for full layout.

- `GlobalConfig` — operator, treasury, fee_bps=750, max_round_size, min/max deposit.
- `Round` — state, pot, weight sum, fee/payout snapshot at lock, lock/reveal slots, randomness, winner.
- `Participant` PDA `(round, wallet)` — amount, cumulative weight start, creation index.
- Round escrow PDA — program-owned lamport vault for the round.

## 4. State machine

`OPEN → FULL → LOCKED → RANDOMNESS_PENDING → SETTLING → COMPLETED`, plus `CANCELLED` (refund path) from `OPEN|FULL|LOCKED`.

Invalid transitions revert on-chain (e.g. `COMPLETED → OPEN` is impossible).

## 5. Winner selection (deterministic, public)

1. At lock, the program stores `lock_slot` and `reveal_slot = lock_slot + REVEAL_OFFSET` (32).
2. At settlement the caller supplies the `SlotHashes` sysvar; the program reads the
   blockhash of `reveal_slot` and computes
   `randomness = sha256(reveal_blockhash ‖ round_key)`.
3. `ticket = randomness_u64 % total_weight` (u128 math); the participant whose
   cumulative lamport weight range contains `ticket` wins.
4. Anyone can recompute this from public chain data (`packages/verification`, `/api/round/:id/verify`).

Devnet trust assumptions and the VRF upgrade path: `RANDOMNESS.md`.

## 6. Off-chain services

- **API** persists rounds/entries/deposits, verifies every user-submitted transaction
  signature against Solana RPC (never trusts client-declared amounts or state),
  streams events over SSE, and drives the settlement flow as the operator.
- **Postgres** is an audit/index layer only. The chain is the source of truth; the API
  reconciles against RPC and marks rows `verified` only after on-chain confirmation.
- The **operator keypair** only ever signs: round creation/lock/settlement/cancel.
  It has no ability to move user funds outside program rules, and no winner override exists.

## 7. Mainnet gate

`packages/config` resolves `SOLANA_NETWORK`. If it is `mainnet-beta` and `ENABLE_MAINNET=true`
is not explicitly set, every transaction-building path (SDK + API + web) throws
`MAINNET_DISABLED` before any instruction is constructed. There is no UI affordance to
enable it — it must be set in the operator's environment deliberately.

## 8. Document index

`docs/INDEX.md` links every planning document.
