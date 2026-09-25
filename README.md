# Solana Roulette — DEVNET-first, provably fair, on-chain

A decentralized roulette on Solana: deposits go into a **program-owned escrow PDA**,
every participant's weight equals their deposit, and the winner is selected
**deterministically on-chain** from a committed future blockhash. The 92.5% / 7.5%
winner/treasury split is enforced by the program, not the frontend.

> **DEVNET ONLY by default.** Mainnet requires `SOLANA_NETWORK=mainnet-beta` **and**
> `ENABLE_MAINNET=true`, plus external audit and legal sign-off
> (see `docs/LEGAL_COMPLIANCE_CHECKLIST.md`). No real-money wagering.

## Quick start (dev)

```bash
npm install
npm test                 # Vitest: winner math, config gate, tx verifier
npm run dev:api          # Fastify REST+SSE on :4000 (in-memory store w/o DATABASE_URL)
npm run dev:web          # Next.js on :3000 (connect Phantom/Solflare on devnet)
```

Docker alternative:

```bash
cd docker && docker-compose up
```

## Repository layout

```
apps/
  web/            Next.js + Solana Wallet Adapter (deposit UX, live round, verify panel)
  api/            Fastify REST + SSE, independent tx verification, settlement driver
programs/
  roulette/       Anchor program (Rust): escrow, weighted entries, on-chain settlement
packages/
  sdk/            Typed instruction builders + client
  config/         Env-driven config + MAINNET hard gate
  types/          Shared domain types
  verification/   Pure winner math + independent round verification (auditable)
tests/            Playwright e2e (scaffolded)
docs/             12 planning docs — start at docs/INDEX.md
scripts/          keypair generation, config seeding
docker/           Dockerfiles + compose
```

## How a round works

Three **independent** pool lanes run in parallel — 1 SOL, 10 SOL and 100 SOL max
volume per round (`TIER_CAPS_SOL`, enforced on-chain, never in the frontend).

1. The operator service (`apps/api` settlement driver) opens a round in a lane.
2. Users `deposit` from their own wallets (Phantom/Solflare) — the program moves
   funds **into the round's escrow PDA** and records a `Participant` with
   cumulative weight. Deposits NEVER touch the fee wallet.
3. The instant the pot reaches the lane's cap the round closes (`FULL`) and the
   driver locks it (`reveal_slot = lock_slot + 32`, fee snapshot frozen).
4. After the reveal slot the program reads the **blockhash of the committed
   future slot** from the SlotHashes sysvar, derives
   `randomness = SHA256(b"roulette:reveal" ‖ round_id ‖ blockhash)`, computes
   `ticket = u128(randomness[0..16]) % total_weight`, and walks cumulative
   ranges to pick the winner (`settle_round`, winner + amounts frozen).
5. `pay_winners` pays 92.5% to the winner and 7.5% to the platform fee wallet
   **atomically**, then marks the round COMPLETED and the next round opens
   automatically. No admin action, no AI, no manual payout.
6. Anyone can re-verify the winner from public chain data
   (`GET /api/round/:id/verify`, `packages/verification`).

Trust notes for the devnet randomness scheme: `docs/RANDOMNESS.md` (explicitly NOT
production-safe; VRF upgrade path designed in).

## Two runtimes

`GET /api/health` reports which one is live:

| | `mode: "chain"` | `mode: "local"` |
|---|---|---|
| What | the deployed Anchor program | an in-process ledger mirroring it |
| Real SOL | **yes** | **no — nothing moves** |
| Deposits | wallet signs a `deposit` instruction | wallet signs a round-bound message |
| Mainnet | allowed (still gated) | **refused** |

`LEDGER_MODE=auto` (default) uses the program as soon as it is deployed on the
configured RPC **and** `OPERATOR_KEYPAIR` is set, and falls back to the devnet
ledger otherwise — no code change. The UI displays the active mode so a
simulation is never mistaken for real money. Details: `docs/PAYMENTS.md` §2.1.

## Verification (no trust in this repo's backend)

```bash
curl http://localhost:4000/api/round/1/verify | jq
# ok: true — winner recomputed from blockhash + participant weights matches chain
```

## Environment

Copy `env.example.txt` to your environment manager. Keys:
`LEDGER_MODE`, `SOLANA_NETWORK`, `SOLANA_RPC_URL`, `OPERATOR_KEYPAIR` (devnet only),
`PLATFORM_FEE_WALLET`, `PLATFORM_FEE_BPS`, `POOL_TARGET_SOL`, `TIER_CAPS_SOL`,
`ADMIN_TOKEN` (operator console at `/admin`; unset = console API closed),
`DEPOSITS_PAUSED`, `DATABASE_URL` (optional — audit mirror otherwise),
`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SOLANA_NETWORK`.

Payment flow, idempotence and fail-safes: `docs/PAYMENTS.md`.

Generate a devnet operator keypair:

```bash
node scripts/generate-operator-keypair.mjs   # prints JSON array; DEVNET ONLY
```

## Admin console

`/admin` (token: `ADMIN_TOKEN`) shows devnet/mainnet status, RPC health, the
escrow / operator / fee addresses, the live escrow balance, the 7.5% fee and the
1/10/100 SOL caps, open and completed rounds, the deposit & payout ledger and the
transaction log — plus one switch: **Deposits Active / Paused**.

It cannot store or display a private key, a seed phrase or `OPERATOR_KEYPAIR`,
cannot change fees/caps/network, and cannot settle anything by hand: the round
lifecycle stays fully automatic. `docs/ADMIN.md` has the full endpoint list and
the Render environment table.

## Tests

```bash
npm test            # unit + property tests (deterministic seeded PRNG)
anchor test         # program tests (requires Anchor toolchain; CI)
npm run e2e         # Playwright (requires browsers; CI)
```

## Docs

`docs/INDEX.md` → ARCHITECTURE, SECURITY, RANDOMNESS, SMART_CONTRACT, DATABASE, API,
DEPLOYMENT, LEGAL_COMPLIANCE_CHECKLIST, VERIFICATION, ROADMAP, TESTING.
