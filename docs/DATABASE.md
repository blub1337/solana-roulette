# Solana Roulette — Database

PostgreSQL via **Prisma**. The DB is an **audit/index layer**, not the source of truth —
Solana chain state is authoritative. Rows are marked `verified` only after independent
RPC reconciliation.

## 1. Schema (Prisma)

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

model GlobalSettings {
  id             Int      @id @default(1)
  configPubkey   String   @unique
  operator       String
  treasury       String
  feeBps         Int
  maxRoundSize   BigInt
  minDeposit     BigInt
  maxDeposit     BigInt
  updatedAt      DateTime @updatedAt
}

model Round {
  id             BigInt   @id                       // on-chain round id
  status         String                                   // OPEN..COMPLETED|CANCELLED
  escrow         String
  pot            BigInt   @default(0)
  participantCount Int    @default(0)
  lockSlot       BigInt?
  revealSlot     BigInt?
  feeBps         Int?
  randomness     Bytes?
  winningTicket  BigInt?
  winner         String?
  feeLamports    BigInt?
  payoutLamports BigInt?
  settleSlot     BigInt?
  verified       Boolean  @default(false)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  entries        Entry[]
  transactions   TxRecord[]
  @@index([status])
}

model Entry {
  id           BigInt   @default(autoincrement()) @id
  roundId      BigInt
  wallet       String
  amount       BigInt
  weightStart  BigInt
  index        Int
  txSignature  String?  @unique
  verified     Boolean  @default(false)
  createdAt    DateTime @default(now())
  round        Round    @relation(fields: [roundId], references: [id])
  @@unique([roundId, wallet])
}

model TxRecord {
  id          BigInt   @default(autoincrement()) @id
  signature   String   @unique
  roundId     BigInt?
  kind        String   // deposit | lock | settle | cancel | create
  wallet      String?  // depositor when kind=deposit
  amount      BigInt?
  slot        BigInt?
  blockTime   DateTime?
  status      String   // pending | verified | failed
  error       String?
  createdAt   DateTime @default(now())
  round       Round?   @relation(fields: [roundId], references: [id])
}
```

## 2. Design rules

- **Money never lives in the DB.** Balances are derived from on-chain accounts; DB
  amounts are mirrors used for history/UI and are reconciled against RPC.
- `BigInt` for all lamport values (JS `bigint`, serialized as strings over REST).
- Idempotency: `Entry @@unique([roundId, wallet])`, `TxRecord.signature @unique`,
  settlement write-upsert keyed by round.
- Event log (SSE) is derived from DB change points + RPC reconciliation — never from
  client-submitted payloads.

## 3. Migrations

```bash
bunx prisma migrate dev     # local/dev
bunx prisma migrate deploy  # prod (hosting deploy runs this before starting)
```

## 4. Neon

Dev/prod both target Neon Postgres (`DATABASE_URL` with `?sslmode=require`).
Docker Compose ships a local Postgres for offline development.
