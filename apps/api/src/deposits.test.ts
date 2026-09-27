/**
 * Real deposit flow: the pot may only grow from a CONFIRMED on-chain transfer.
 *
 * These tests drive the whole lifecycle against a fake RPC — intent, wallet
 * signature, server-side verification, crediting, rejection and reconciliation.
 */
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { resolveConfig } from "@solana-roulette/config";
import type { ChainBackend } from "./backend.js";
import type { RoundData, ParticipantData, GlobalConfigData } from "@solana-roulette/verification";
import { store } from "./store.js";
import { cancelDeposit, confirmDeposit, createDepositIntent, reconcilePendingDeposits } from "./deposits.js";
import { resolveCustody, type Custody } from "./custody.js";
import { depositMessage } from "@solana-roulette/types";

const ESCROW = new PublicKey("4Zx2cvqL8xwGV4Y5hcEXysbJCmyiYDRBgBHdidWWvkMp");
const FEE_WALLET = new PublicKey("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");
const PROGRAM_ID = new PublicKey("AAHBk1qbXCzsbiLe7TiXuZNTvNPVtovtC6NWk9tsi6EZ");

/** A keypair standing in for the player's wallet. */
function player(seed: number): Keypair {
  return Keypair.fromSeed(new Uint8Array(32).fill(seed));
}

/** Minimal parsed transaction: a real System transfer payer → escrow. */
function transferTx(opts: {
  from: PublicKey;
  to: PublicKey;
  lamports: bigint;
  err?: unknown;
}): ParsedTransactionWithMeta {
  const signature = "S".repeat(64);
  return {
    slot: 1,
    blockTime: Math.floor(Date.now() / 1000),
    signature,
    meta: { err: opts.err ?? null, fee: 5000, logMessages: [], innerInstructions: [] },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: opts.from, signer: true, writable: true },
          { pubkey: opts.to, signer: false, writable: true },
        ],
        instructions: [
          {
            program: "system",
            parsed: {
              type: "transfer",
              info: {
                source: opts.from.toBase58(),
                destination: opts.to.toBase58(),
                lamports: Number(opts.lamports),
              },
            },
          },
        ],
        recentBlockhash: "11111111111111111111111111111111",
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}

function makeRound(over: Partial<RoundData> = {}): RoundData {
  return {
    id: 11n,
    status: "OPEN",
    escrow: ESCROW,
    pot: 0n,
    totalWeight: 0n,
    participantCount: 0,
    lockSlot: 0n,
    revealSlot: 0n,
    feeBps: 750,
    randomness: new Uint8Array(32),
    winningTicket: 0n,
    winner: PublicKey.default,
    feeLamports: 0n,
    payoutLamports: 0n,
    payoutAccount: new Uint8Array(32),
    tier: 0,
    bump: 255,
    ...over,
  };
}

interface HarnessOptions {
  roundId: bigint;
  round?: Partial<RoundData>;
  /** What the devnet RPC returns for getParsedTransaction. */
  tx?: ParsedTransactionWithMeta | null;
  escrowBalance?: bigint;
}

function harness(opts: HarnessOptions) {
  const round = makeRound({ id: opts.roundId, ...opts.round });
  const credited: Array<{ wallet: string; lamports: bigint }> = [];

  const backend: ChainBackend = {
    mode: "local",
    realFunds: false,
    async getRound() {
      return round;
    },
    async getParticipants(): Promise<ParticipantData[]> {
      return [];
    },
    async getGlobalConfig(): Promise<GlobalConfigData | null> {
      return null;
    },
    async getCurrentSlot() {
      return 1n;
    },
    async getRevealBlockhash() {
      return null;
    },
    async getHeadByTier() {
      return [round.id, 0n, 0n];
    },
    async runLifecycle() {
      return null;
    },
    async deposit(args) {
      // The runtime only ever sees a transfer the server verified on chain.
      credited.push({ wallet: args.wallet.toBase58(), lamports: args.lamports });
      round.pot += args.lamports;
      round.participantCount += 1;
      return { signature: "runtime", roundId: round.id };
    },
    treasuryAccrued() {
      return 0n;
    },
  };

  const connection = {
    getParsedTransaction: async () => (opts.tx === undefined ? null : opts.tx),
    getBalance: async () => Number(opts.escrowBalance ?? 0n),
    getSlot: async () => 1,
  } as unknown as Connection;

  const operator = Keypair.fromSeed(new Uint8Array(32).fill(3));
  const custody: Custody = {
    network: "devnet",
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    escrow: ESCROW,
    feeWallet: FEE_WALLET,
    signer: operator,
    signerAddress: operator.publicKey.toBase58(),
    ready: true,
    reason: "test",
  };

  const cfg = resolveConfig({ PLATFORM_FEE_WALLET: FEE_WALLET.toBase58() } as NodeJS.ProcessEnv);
  return { deps: { backend, connection, custody, cfg, programId: PROGRAM_ID }, credited, round };
}

/** The tx ledger is a process singleton keyed by (round, wallet): every case
 *  takes a fresh round id so cases can never collide. */
let caseCounter = 100;
function nextCase(): { roundId: bigint; seed: number } {
  caseCounter += 1;
  return { roundId: BigInt(caseCounter), seed: (caseCounter % 250) + 1 };
}

describe("deposit intent", () => {
  it("opens a PENDING record naming the devnet escrow", async () => {
    const { roundId, seed } = nextCase();
    const { deps } = harness({ roundId });
    const intent = await createDepositIntent(deps, {
      roundId,
      wallet: player(seed).publicKey,
      amountLamports: 100_000_000n,
    });
    expect(intent.status).toBe("PENDING");
    expect(intent.network).toBe("devnet");
    expect(intent.escrow).toBe(ESCROW.toBase58());
    expect(intent.amountLamports).toBe("100000000");
    expect(store.txs.get(intent.depositId)?.depositSignature).toBeNull();
  });

  it("resumes the same record when the page is refreshed mid-deposit", async () => {
    const { roundId, seed } = nextCase();
    const { deps } = harness({ roundId });
    const wallet = player(seed).publicKey;
    const a = await createDepositIntent(deps, { roundId, wallet, amountLamports: 100_000_000n });
    const b = await createDepositIntent(deps, { roundId, wallet, amountLamports: 100_000_000n });
    expect(b.resumed).toBe(true);
    expect(b.depositId).toBe(a.depositId);
  });

  it("refuses a second entry for a wallet that is already confirmed", async () => {
    const { roundId, seed } = nextCase();
    const wallet = player(seed);
    const { deps } = harness({ roundId, round: { participantCount: 1 } });
    const { tx } = store.txs.begin({
      kind: "DEPOSIT",
      idempotencyKey: `deposit:${roundId.toString()}:${wallet.publicKey.toBase58()}`,
      roundId: roundId.toString(),
      tier: 0,
      wallet: wallet.publicKey.toBase58(),
      recipient: ESCROW.toBase58(),
      network: "devnet",
      depositAmountLamports: "1000",
    });
    store.txs.settle(tx.id, "CONFIRMED", { signature: "c".repeat(64) });
    await expect(
      createDepositIntent(deps, { roundId, wallet: wallet.publicKey, amountLamports: 100_000_000n })
    ).rejects.toMatchObject({ code: "already_deposited" });
  });

  it("refuses amounts that would break the tier cap", async () => {
    const { roundId, seed } = nextCase();
    const { deps } = harness({ roundId, round: { pot: 950_000_000n } });
    await expect(
      createDepositIntent(deps, { roundId, wallet: player(seed).publicKey, amountLamports: 100_000_000n })
    ).rejects.toMatchObject({ code: "RoundOverCap" });
  });
});

describe("deposit confirmation (chain is the source of truth)", () => {
  it("credits the round only after a real confirmed transfer", async () => {
    const { roundId, seed } = nextCase();
    const amount = 250_000_000n;
    const signature = "s".repeat(64);
    const wallet = player(seed);
    const { deps, credited, round } = harness({
      roundId,
      tx: transferTx({ from: wallet.publicKey, to: ESCROW, lamports: amount }),
    });
    const intent = await createDepositIntent(deps, { roundId, wallet: wallet.publicKey, amountLamports: amount });
    const res = await confirmDeposit(deps, { depositId: intent.depositId, signature });
    expect(res.status).toBe(200);
    expect(res.body.credited).toBe(true);
    expect(credited).toEqual([{ wallet: wallet.publicKey.toBase58(), lamports: amount }]);
    expect(round.pot).toBe(amount);
    expect(store.txs.confirmedPotLamports(roundId)).toBe(amount);
    expect(String(res.body.explorer)).toContain("cluster=devnet");
  });

  it("does NOT credit a transaction that failed on chain", async () => {
    const { roundId, seed } = nextCase();
    const signature = "f".repeat(64);
    const wallet = player(seed);
    const { deps, credited } = harness({
      roundId,
      tx: transferTx({
        from: wallet.publicKey,
        to: ESCROW,
        lamports: 100_000_000n,
        err: { InstructionError: [0, "Custom"] },
      }),
    });
    const intent = await createDepositIntent(deps, { roundId, wallet: wallet.publicKey, amountLamports: 100_000_000n });
    const res = await confirmDeposit(deps, { depositId: intent.depositId, signature });
    expect(res.status).toBe(422);
    expect(res.body.credited).toBe(false);
    expect(credited).toEqual([]);
    expect(store.txs.get(intent.depositId)?.depositStatus).toBe("FAILED");
    expect(store.txs.confirmedPotLamports(roundId)).toBe(0n);
  });

  it("does NOT credit a transfer whose amount does not match the intent", async () => {
    const { roundId, seed } = nextCase();
    const signature = "m".repeat(64);
    const wallet = player(seed);
    const { deps, credited } = harness({
      // Player sent 1 lamport but the intent says 100_000_000.
      roundId,
      tx: transferTx({ from: wallet.publicKey, to: ESCROW, lamports: 1n }),
    });
    const intent = await createDepositIntent(deps, { roundId, wallet: wallet.publicKey, amountLamports: 100_000_000n });
    const res = await confirmDeposit(deps, { depositId: intent.depositId, signature });
    expect(res.status).toBe(422);
    expect(credited).toEqual([]);
  });

  it("does NOT credit a transfer sent from a different wallet", async () => {
    const { roundId, seed } = nextCase();
    const signature = "w".repeat(64);
    const { deps, credited } = harness({
      roundId,
      tx: transferTx({ from: player(seed + 100).publicKey, to: ESCROW, lamports: 100_000_000n }),
    });
    const intent = await createDepositIntent(deps, { roundId, wallet: player(seed).publicKey, amountLamports: 100_000_000n });
    const res = await confirmDeposit(deps, { depositId: intent.depositId, signature });
    expect(res.status).toBe(422);
    expect(credited).toEqual([]);
  });

  it("stays PENDING (202) while the transaction is not on chain yet", async () => {
    const { roundId, seed } = nextCase();
    const { deps, credited } = harness({ roundId, tx: null });
    const wallet = player(seed);
    const intent = await createDepositIntent(deps, { roundId, wallet: wallet.publicKey, amountLamports: 100_000_000n });
    const res = await confirmDeposit(deps, { depositId: intent.depositId, signature: "z".repeat(64) });
    expect(res.status).toBe(202);
    expect(credited).toEqual([]);
    expect(store.txs.get(intent.depositId)?.depositStatus).toBe("PENDING");
  });

  it("is idempotent: confirming the same signature twice credits once", async () => {
    const { roundId, seed } = nextCase();
    const amount = 50_000_000n;
    const signature = "i".repeat(64);
    const wallet = player(seed);
    const { deps, credited } = harness({
      roundId,
      tx: transferTx({ from: wallet.publicKey, to: ESCROW, lamports: amount }),
    });
    const intent = await createDepositIntent(deps, { roundId, wallet: wallet.publicKey, amountLamports: amount });
    await confirmDeposit(deps, { depositId: intent.depositId, signature });
    const again = await confirmDeposit(deps, { depositId: intent.depositId, signature });
    expect(again.status).toBe(200);
    expect(credited).toHaveLength(1);
  });
});

describe("rejected signatures and the reconciler", () => {
  it("a rejected wallet signature leaves the round untouched", async () => {
    const { roundId, seed } = nextCase();
    const { deps, credited } = harness({ roundId });
    const wallet = player(seed);
    const intent = await createDepositIntent(deps, { roundId, wallet: wallet.publicKey, amountLamports: 100_000_000n });
    const res = cancelDeposit(intent.depositId, "User rejected the request");
    expect(res.status).toBe(200);
    expect(store.txs.get(intent.depositId)?.depositStatus).toBe("FAILED");
    expect(credited).toEqual([]);
    expect(store.txs.confirmedPotLamports(roundId)).toBe(0n);
  });

  it("a stale PENDING deposit with no transaction is failed, never credited", async () => {
    const { roundId, seed } = nextCase();
    const { deps, credited } = harness({ roundId });
    const wallet = player(seed);
    const intent = await createDepositIntent(deps, { roundId, wallet: wallet.publicKey, amountLamports: 100_000_000n });
    await reconcilePendingDeposits(deps, 0);
    expect(store.txs.get(intent.depositId)?.depositStatus).toBe("FAILED");
    expect(credited).toEqual([]);
    expect(store.txs.confirmedPotLamports(roundId)).toBe(0n);
  });
});

describe("custody", () => {
  it("refuses mainnet outright", () => {
    expect(() =>
      resolveCustody({
        network: "mainnet-beta" as never,
        rpcUrl: "https://api.mainnet-beta.solana.com",
        platformFeeWallet: FEE_WALLET.toBase58(),
        operatorKeypairJson: null as never,
      })
    ).toThrow(/DEVNET ONLY/);
  });

  it("is not ready without an escrow and a signer", () => {
    const custody = resolveCustody({
      network: "devnet" as never,
      rpcUrl: "https://api.devnet.solana.com",
      platformFeeWallet: FEE_WALLET.toBase58(),
      operatorKeypairJson: null as never,
    });
    expect(custody.ready).toBe(false);
    expect(custody.reason).toMatch(/OPERATOR_KEYPAIR/);
  });

  it("uses the operator wallet as the default escrow", () => {
    const operator = Keypair.fromSeed(new Uint8Array(32).fill(5));
    const custody = resolveCustody({
      network: "devnet" as never,
      rpcUrl: "https://api.devnet.solana.com",
      platformFeeWallet: FEE_WALLET.toBase58(),
      operatorKeypairJson: JSON.stringify(Array.from(operator.secretKey)),
    });
    expect(custody.ready).toBe(true);
    expect(custody.escrow?.toBase58()).toBe(operator.publicKey.toBase58());
    expect(custody.signerAddress).toBe(operator.publicKey.toBase58());
  });

  it("accepts an explicit DEPOSIT_ESCROW_WALLET that IS the operator address", () => {
    const operator = Keypair.fromSeed(new Uint8Array(32).fill(5));
    const custody = resolveCustody({
      network: "devnet" as never,
      rpcUrl: "https://api.devnet.solana.com",
      platformFeeWallet: FEE_WALLET.toBase58(),
      operatorKeypairJson: JSON.stringify(Array.from(operator.secretKey)),
      depositEscrowWallet: operator.publicKey.toBase58(),
    });
    expect(custody.ready).toBe(true);
    expect(custody.escrow?.toBase58()).toBe(operator.publicKey.toBase58());
  });

  it("refuses an escrow the payout signer cannot spend from", () => {
    const operator = Keypair.fromSeed(new Uint8Array(32).fill(5));
    const stranger = Keypair.fromSeed(new Uint8Array(32).fill(6));
    const custody = resolveCustody({
      network: "devnet" as never,
      rpcUrl: "https://api.devnet.solana.com",
      platformFeeWallet: FEE_WALLET.toBase58(),
      operatorKeypairJson: JSON.stringify(Array.from(operator.secretKey)),
      depositEscrowWallet: stranger.publicKey.toBase58(),
    });
    expect(custody.ready).toBe(false);
    expect(custody.reason).toMatch(/DEPOSIT_ESCROW_WALLET must be the public address/);
    expect(custody.escrow?.toBase58()).toBe(stranger.publicKey.toBase58());
    expect(custody.signerAddress).toBe(operator.publicKey.toBase58());
  });
});

describe("canonical deposit message (unchanged contract)", () => {
  it("binds round, amount, wallet and nonce", () => {
    const msg = depositMessage({
      roundId: 3n,
      amountLamports: "1000",
      wallet: "11111111111111111111111111111112",
      nonce: "abc12345",
    });
    expect(msg).toContain("roulette:deposit:3:1000");
    expect(msg).toContain("11111111111111111111111111111112");
  });
});

// ---------------------------------------------------------------------------
// Program deposit path (chain mode): the client signs the program's `deposit`
// instruction, which moves lamports AND writes the Participant PDA. The
// server verifies the instruction, the escrow CPI and the resulting PDA.
// ---------------------------------------------------------------------------

import { TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { depositIx } from "@solana-roulette/sdk";
import { getParticipantPda, getRoundPda, getEscrowPda, PARTICIPANT_SPACE } from "@solana-roulette/verification";
import { checkProgramDeposit } from "./onchain.js";

/** Encode a Participant PDA the way the program writes it. */
function encodeParticipant(p: {
  round: PublicKey;
  wallet: PublicKey;
  amount: bigint;
  weightStart: bigint;
  index: number;
  bump: number;
}): Uint8Array {
  const buf = Buffer.alloc(PARTICIPANT_SPACE);
  buf.set(p.round.toBuffer(), 8);
  buf.set(p.wallet.toBuffer(), 40);
  buf.writeBigUInt64LE(p.amount, 72);
  buf.writeBigUInt64LE(p.weightStart & 0xffffffffffffffffn, 80);
  // weight_start is u128; low 8 bytes suffice for test values
  buf.writeUInt32LE(p.index, 96);
  buf.writeUInt8(p.bump, 100);
  return buf;
}

/**
 * A fake parsed tx that looks like a program `deposit` invocation: the
 * roulette program instruction (raw, base58 data) plus the escrow CPI it
 * performed, and the fee payer is the depositor.
 */
function programDepositTx(opts: {
  from: PublicKey;
  escrow: PublicKey;
  programId: PublicKey;
  lamports: bigint;
  err?: unknown;
  includeInstruction?: boolean;
}): ParsedTransactionWithMeta {
  const signature = "S".repeat(64);
  const ixData = depositIx(opts.programId, opts.from, 1n, opts.lamports);
  const base58 = require("bs58").default ?? require("bs58");
  const instructions: ParsedTransactionWithMeta["transaction"]["message"]["instructions"] = [];
  if (opts.includeInstruction !== false) {
    instructions.push({
      programId: ixData.programId,
      accounts: ixData.keys.map((k) => k.pubkey),
      data: base58.encode(ixData.data),
    } as never);
  }
  instructions.push({
    program: "system",
    parsed: {
      type: "transfer",
      info: {
        source: opts.from.toBase58(),
        destination: opts.escrow.toBase58(),
        lamports: Number(opts.lamports),
      },
    },
  } as never);
  return {
    slot: 1,
    blockTime: Math.floor(Date.now() / 1000),
    signature,
    meta: { err: opts.err ?? null, fee: 5000, logMessages: [], innerInstructions: [] },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: opts.from, signer: true, writable: true },
          { pubkey: opts.escrow, signer: false, writable: true },
          { pubkey: opts.programId, signer: false, writable: false },
        ],
        instructions,
        recentBlockhash: "11111111111111111111111111111111",
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe("program deposit verification (chain mode)", () => {
  const roundId = 900n;
  const player = Keypair.fromSeed(new Uint8Array(32).fill(77)).publicKey;
  const [roundPda] = getRoundPda(PROGRAM_ID, roundId);
  const escrow = getEscrowPda(PROGRAM_ID, roundPda)[0];
  const participantPda = getParticipantPda(PROGRAM_ID, roundPda, player)[0];

  function programHarness(opts: {
    round?: Partial<RoundData>;
    tx?: ParsedTransactionWithMeta | null;
    participant?: Uint8Array | null;
  }) {
    const round = makeRound({ id: roundId, ...opts.round });
    const backend: ChainBackend = {
      mode: "chain",
      realFunds: true,
      async getRound() {
        return round;
      },
      async getParticipants(): Promise<ParticipantData[]> {
        return [];
      },
      async getGlobalConfig(): Promise<GlobalConfigData | null> {
        return null;
      },
      async getCurrentSlot() {
        return 1n;
      },
      async getRevealBlockhash() {
        return null;
      },
      async getHeadByTier() {
        return [roundId, 0n, 0n];
      },
      async runLifecycle() {
        return null;
      },
      // In chain mode the program already credited the round; this must
      // NOT be called.
      async deposit() {
        throw new Error("backend.deposit must not be called in chain mode");
      },
      treasuryAccrued() {
        return 0n;
      },
    };
    const connection = {
      getParsedTransaction: async () => (opts.tx === undefined ? null : opts.tx),
      getAccountInfo: async () =>
        opts.participant === null
          ? null
          : {
              owner: PROGRAM_ID,
              data: opts.participant!,
              executable: false,
              lamports: 1_600_000,
              rentEpoch: 0n,
            },
      getBalance: async () => 0,
      getSlot: async () => 1,
    } as unknown as Connection;
    const operator = Keypair.fromSeed(new Uint8Array(32).fill(9));
    const custody: Custody = {
      network: "devnet",
      cluster: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      escrow,
      feeWallet: FEE_WALLET,
      signer: operator,
      signerAddress: operator.publicKey.toBase58(),
      ready: true,
      reason: "test",
    };
    const cfg = resolveConfig({ PLATFORM_FEE_WALLET: FEE_WALLET.toBase58() } as NodeJS.ProcessEnv);
    return { deps: { backend, connection, custody, cfg, programId: PROGRAM_ID }, round };
  }

  it("credits a real program deposit: instruction + escrow CPI + Participant PDA all match", async () => {
    const amount = 250_000_000n;
    const tx = programDepositTx({ from: player, escrow, programId: PROGRAM_ID, lamports: amount });
    const participant = encodeParticipant({
      round: roundPda,
      wallet: player,
      amount,
      weightStart: 0n,
      index: 3,
      bump: 250,
    });
    const h = programHarness({ tx, participant, round: { pot: 250_000_000n, participantCount: 4 } });
    const intent = await createDepositIntent(h.deps, { roundId, wallet: player, amountLamports: amount });
    const res = await confirmDeposit(h.deps, { depositId: intent.depositId, signature: "S".repeat(64) });
    expect(res.status).toBe(200);
    expect(res.body.credited).toBe(true);
    expect(h.round.pot).toBe(250_000_000n); // re-read from chain, untouched locally
  });

  it("does NOT credit a plain System transfer with no program instruction", async () => {
    const amount = 250_000_000n;
    const tx = programDepositTx({
      from: player,
      escrow,
      programId: PROGRAM_ID,
      lamports: amount,
      includeInstruction: false,
    });
    const participant = encodeParticipant({
      round: roundPda,
      wallet: player,
      amount,
      weightStart: 0n,
      index: 0,
      bump: 250,
    });
    const h = programHarness({ tx, participant });
    const intent = await createDepositIntent(h.deps, { roundId: 901n, wallet: player, amountLamports: amount });
    const res = await confirmDeposit(h.deps, { depositId: intent.depositId, signature: "S".repeat(64) });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("no_program_deposit");
  });

  it("does NOT credit when the Participant PDA was not created", async () => {
    const amount = 250_000_000n;
    const escrow902 = getEscrowPda(PROGRAM_ID, 902n)[0];
    const tx = programDepositTx({ from: player, escrow: escrow902, programId: PROGRAM_ID, lamports: amount });
    const h = programHarness({ tx, participant: null });
    const intent = await createDepositIntent(h.deps, { roundId: 902n, wallet: player, amountLamports: amount });
    const res = await confirmDeposit(h.deps, { depositId: intent.depositId, signature: "S".repeat(64) });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("participant_missing");
  });

  it("does NOT credit when the Participant PDA records a different amount", async () => {
    const amount = 250_000_000n;
    const escrow903 = getEscrowPda(PROGRAM_ID, 903n)[0];
    const roundPda903 = getRoundPda(PROGRAM_ID, 903n)[0];
    const tx = programDepositTx({ from: player, escrow: escrow903, programId: PROGRAM_ID, lamports: amount });
    const participant = encodeParticipant({
      round: roundPda903,
      wallet: player,
      amount: 100_000_000n,
      weightStart: 0n,
      index: 0,
      bump: 250,
    });
    const h = programHarness({ tx, participant });
    const intent = await createDepositIntent(h.deps, { roundId: 903n, wallet: player, amountLamports: amount });
    const res = await confirmDeposit(h.deps, { depositId: intent.depositId, signature: "S".repeat(64) });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("participant_amount_mismatch");
  });

  it("does NOT credit a program deposit funded from another wallet", async () => {
    const attacker = Keypair.fromSeed(new Uint8Array(32).fill(78)).publicKey;
    const amount = 250_000_000n;
    // Attacker pays into escrow, but the fee payer is the attacker, not our player.
    const tx = programDepositTx({ from: attacker, escrow, programId: PROGRAM_ID, lamports: amount });
    const h = programHarness({ tx, participant: encodeParticipant({ round: roundPda, wallet: player, amount, weightStart: 0n, index: 0, bump: 250 }) });
    const intent = await createDepositIntent(h.deps, { roundId: 904n, wallet: player, amountLamports: amount });
    const res = await confirmDeposit(h.deps, { depositId: intent.depositId, signature: "S".repeat(64) });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("unexpected_fee_payer");
  });

  it("checkProgramDeposit rejects a wrong discriminator", async () => {
    const amount = 250_000_000n;
    // lock_round ix instead of deposit
    const wrongIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [],
      data: Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]),
    });
    const base58 = (require("bs58").default ?? require("bs58")) as { encode: (b: Buffer) => string };
    const tx = programDepositTx({ from: player, escrow, programId: PROGRAM_ID, lamports: amount });
    (tx.transaction.message as unknown as { instructions: unknown[] }).instructions = [
      { programId: PROGRAM_ID, accounts: [], data: base58.encode(wrongIx.data) },
      {
        program: "system",
        parsed: { type: "transfer", info: { source: player.toBase58(), destination: escrow.toBase58(), lamports: Number(amount) } },
      },
    ];
    const conn = {
      getParsedTransaction: async () => tx,
      getAccountInfo: async () => null,
    } as unknown as Connection;
    const check = await checkProgramDeposit(conn, {
      signature: "S".repeat(64),
      programId: PROGRAM_ID,
      roundId,
      wallet: player,
      escrow,
      amount,
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe("no_program_deposit");
  });
});
