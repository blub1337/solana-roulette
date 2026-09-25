# Solana Roulette — Security

Threat model: adversarial users (frontend tampering, replay, griefing), adversarial
backend compromise, and an untrusted-but-observable operator. Devnet only by default.

## 1. Money-flow guarantees

- User funds move **only** via program instructions into the round escrow PDA.
- The escrow PDA is a program-derived address — **no private key exists for it**.
- Payouts are executed by program CPI-less lamport transfers validated on-chain:
  `winner_amount = pot - fee`, `fee_amount = pot * fee_bps / 10_000` (floor), with
  checked arithmetic (`checked_add / checked_mul / checked_div`) everywhere.
- The frontend can never decide winner, payout, fee, participant balance, or pot.
- No admin instruction can move escrow funds to an arbitrary account or override a winner.

## 2. Access control

| Instruction | Required signer | Notes |
|---|---|---|
| `initialize_config` | deployer | Once. Sets operator, treasury, limits. |
| `set_operator` / `set_treasury` | current operator | Two-step pattern deferred; devnet only. |
| `create_round` | operator | Bounded by `max_round_size`. |
| `deposit` | depositor | Signs and funds; program verifies `depositor.key == entry.wallet`. |
| `lock_round` | operator | Only when `status == FULL`. |
| `settle_round` | operator | Only when `status == RANDOMNESS_PENDING` and reveal slot reached. |
| `cancel_round` | operator | Refunds every participant deterministically. |

The operator keypair is a **server-side devnet keypair** loaded from env. It can never
sign a withdrawal of user deposits outside program rules; settlement destinations are
computed by the program from immutable round data.

## 3. Account validation (every instruction)

- All PDAs re-derived on-chain via `find_program_address` with canonical seeds
  (`b"config"`, `b"round"`, `b"participant"`, `b"escrow"`) — no client-supplied bump trust.
- Ownership checks: accounts must be owned by this program (`deps:account_info`),
  except wallets (system program) and `SlotHashes` (sysvar program) at settle.
- Discriminators + space checks; zero-init guards (fail if account already initialized).
- `Participant` uniqueness: PDA seeds `(round, wallet)` make duplicate entries impossible.

## 4. Replay & idempotence

- Settlement is idempotent at the instruction level: `settle_round` requires
  `status == RANDOMNESS_PENDING`; a replayed settle reverts (`InvalidRoundStatus`).
- The winner, fee, payout are written to `Round` in the same atomic transaction that
  flips status to `COMPLETED` — partial states cannot persist.
- API-side idempotency: unique DB constraints on `tx_signature` for deposits and on
  `round_id` for settlement rows.

## 5. Deposit edge cases

- Over-cap deposit is **rejected on-chain** (`RoundOverCap`) — never silently truncated.
- Under-min or over-max per-deposit rejected (`DepositTooSmall`, `DepositTooLarge`).
- Deposit into non-`OPEN` round rejected.
- All math `u128` internally, `u64` lamports at boundaries.

## 6. Randomness security

- Winner entropy derives from the **blockhash of a future slot committed at lock time**
  (`reveal_slot = lock_slot + 32`) — unknowable at lock, public after.
- **This is DEVNET-ONLY.** The operator can deny settlement (DoS) and can influence
  outcome by cancel/re-lock cycles. It is NOT production-safe. Details and the VRF
  upgrade path: `RANDOMNESS.md`.
- No `Math.random`, no backend-chosen winner, no admin-chosen winner anywhere in the codebase.

## 7. Backend compromise containment

If the API is fully compromised, the attacker can at worst: DoS (stop settling), mislabel
UI state, or spam deposits from their own funds. They **cannot** steal escrow, alter
weights, pick a winner, or change the fee — all enforced on-chain and independently
verifiable via `packages/verification` + `/api/round/:id/verify`.

## 8. Key handling

- No private key in frontend, source, DB, logs, or browser storage. Seed phrases are
  never requested from users (wallet adapter standard).
- `OPERATOR_KEYPAIR` (devnet only) is injected via env in the API container.
- Treasury is an on-chain pubkey, changeable only by the operator signer.

## 9. Frontend hardening

- Transaction building happens in the SDK; amounts displayed come from the verified API.
- The web app never executes "claim" flows client-side beyond what the program allows.
- All user-visible financial numbers re-derived from on-chain accounts fetched via RPC.

## 10. Audit checklist before any mainnet change

See `LEGAL_COMPLIANCE_CHECKLIST.md` and `ROADMAP.md` §Mainnet gate. Mainnet requires:
external audit, real VRF, license review, and explicit `ENABLE_MAINNET=true`.
