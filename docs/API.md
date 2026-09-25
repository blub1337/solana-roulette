# Solana Roulette — API

Base URL: `/api` (apps/api). All responses JSON, lamports as strings. Auth: none for
public reads; operator actions are performed server-side only.

## REST

| Method | Path | Description |
|---|---|---|
| GET | `/health` | `{ ok, network, mode, realFunds, backendReason, programId, platformFeeWallet, commit }` |
| GET | `/config` | Runtime config + `mode`, fee split, tier caps, treasury accrual |
| GET | `/pools` | All three lanes at once: pot, cap, fill %, players, round, last winner/payout |
| GET | `/round/current` | Current round + entries (`?tier=0\|1\|2` selects the pool lane) |
| GET | `/round/:id` | Any round + entries |
| GET | `/round/:id/entries` | Participant list with weights |
| GET | `/round/:id/verify` | **Independent** winner recomputation; returns `{ ok, mode, trace }` |
| GET | `/round/:id/transactions` | Verified tx history for the round |
| GET | `/history` | Completed rounds archive |
| POST | `/round/:id/deposit` | Devnet-ledger entry: `{ wallet, amountLamports, message, signature, nonce }`; verifies the wallet signature, then applies the program's rules |
| POST | `/transaction/verify` | Body `{ signature, kind }`; independently verifies an **on-chain** tx against RPC; writes `TxRecord` |
| GET | `/events` | **SSE** stream: `deposit`, `pot`, `participant`, `round_full`, `lock`, `randomness_arrived`, `winner`, `settlement`, `new_round` |

`mode` is `chain` (deployed program, real funds) or `local` (devnet ledger, no
lamports move). See [PAYMENTS.md](./PAYMENTS.md) §2.1. The UI renders it and
never presents a simulation as real money.

## POST /round/:id/deposit (devnet ledger only)

```http
POST /api/round/1/deposit
{
  "wallet": "<base58 pubkey>",
  "amountLamports": "250000000",
  "message": "roulette:deposit:1:250000000:<wallet>:<nonce>",
  "signature": "<base58 ed25519 signature of `message`>",
  "nonce": "<8-64 url-safe chars>"
}
```

1. `message` must equal the canonical string rebuilt from the other fields,
   otherwise `400 message_mismatch`.
2. The signature must verify against `wallet`, otherwise `401 invalid_signature`.
3. The runtime rules apply: `422 RoundOverCap` when the stake would exceed the
   pool cap (never truncated), `409 DuplicateDeposit` for a second entry,
   `422 DepositTooSmall` / `DepositTooLarge` outside the configured limits.
4. `409 onchain_deposit_required` when the deployed program is live — then the
   wallet signs a real `deposit` instruction instead.

## POST /transaction/verify (never trust the client)

The verifier independently:
1. Fetches the transaction + status from Solana RPC (`getTransaction`, confirmed).
2. Checks the tx succeeded (no errors) and is not already recorded (replay guard).
3. For `deposit` kind: locates the program transfer to the round escrow PDA, extracts
   the **actual lamports moved**, the **actual sender**, and validates the recipient is
   the current round's escrow.
4. Only then upserts `Entry`/`TxRecord` with `verified: true`.
5. Client-declared amount/wallet/status are ignored entirely.

## SSE events

```json
{ "type": "deposit", "roundId": "1", "wallet": "...", "amount": "100000000", "pot": "1050000000", "participantCount": 3 }
{ "type": "winner",  "roundId": "1", "winner": "...", "payoutLamports": "9250000000" }
```

Clients auto-reconnect (`EventSource` built-in). Sequence: on round full → `round_full`,
then `lock`, `randomness_arrived` (reveal slot reached), `winner` + `settlement`.

## Settlement driver (operator)

A loop inside apps/api advances each pool lane one state-machine step per tick:
`FULL` → `lock_round` (freezes `fee_bps`, commits the reveal slot); once
`slot >= reveal_slot` → `settle_round` (freezes randomness, winner, fee, payout);
then `pay_winners` (92.5% + 7.5%, flips to `COMPLETED`); then the next round is
created from the shared counter. The chain runtime requires `OPERATOR_KEYPAIR`.

## Idempotency

- POST /transaction/verify is safe to retry; duplicate signatures are 409 no-ops.
- Settlement upsert keyed by round id; on-chain settle itself is replay-proof.
