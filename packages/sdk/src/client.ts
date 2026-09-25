/**
 * Typed client over the roulette program: enforces the mainnet gate before any
 * instruction is built, reads on-chain accounts, and builds deposit
 * transactions for the user's wallet to sign. The client NEVER signs.
 */
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { assertNetworkAllowed, type AppConfig } from "@solana-roulette/config";
import {
  decodeRound,
  decodeGlobalConfig,
  decodeParticipant,
  PARTICIPANT_SPACE,
  type RoundData,
  type GlobalConfigData,
  type ParticipantData,
} from "@solana-roulette/verification";
import { configPda, roundPda } from "./pda.js";
import { depositIx } from "./instructions.js";

export interface ClientOptions {
  connection?: Connection;
  rpcUrl?: string;
  programId?: string;
}

export class RouletteClient {
  readonly connection: Connection;
  readonly programId: PublicKey;
  readonly config: AppConfig;
  readonly configPda: PublicKey;

  constructor(opts: ClientOptions = {}) {
    // AppConfig for the current environment (mainnet gate state included).
    // resolveConfig throws MainnetDisabledError when mainnet is not unlocked.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveConfig } = require("@solana-roulette/config") as typeof import("@solana-roulette/config");
    this.config = resolveConfig();
    this.connection =
      opts.connection ?? new Connection(opts.rpcUrl ?? this.config.rpcUrl, "confirmed");
    this.programId = new PublicKey(opts.programId ?? this.config.programId);
    this.configPda = configPda(this.programId);
  }

  /** Mainnet gate — called before EVERY instruction-building path. */
  assertNetworkAllowed(): void {
    assertNetworkAllowed(this.config.network);
  }

  async getRound(roundId: bigint): Promise<RoundData | null> {
    const acc = await this.connection.getAccountInfo(roundPda(this.programId, roundId));
    return acc ? decodeRound(acc.data) : null;
  }

  async getConfigAccount(): Promise<GlobalConfigData | null> {
    const acc = await this.connection.getAccountInfo(this.configPda);
    return acc ? decodeGlobalConfig(acc.data) : null;
  }

  async getParticipants(roundId: bigint): Promise<ParticipantData[]> {
    const roundKey = roundPda(this.programId, roundId);
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { dataSize: PARTICIPANT_SPACE },
        { memcmp: { offset: 8, bytes: roundKey.toBase58() } },
      ],
    });
    return accounts
      .map((a) => decodeParticipant(a.account.data))
      .sort((a, b) => a.index - b.index);
  }

  /**
   * Builds a deposit transaction for the caller's wallet to sign. Validates
   * round status, min/max deposit and the round cap against on-chain state.
   */
  async buildDepositTx(args: {
    depositor: PublicKey;
    roundId: bigint;
    amountLamports: bigint;
    blockhash?: { blockhash: string; lastValidBlockHeight: number };
  }): Promise<Transaction> {
    this.assertNetworkAllowed();
    const round = await this.getRound(args.roundId);
    if (!round) throw new Error(`Round ${args.roundId} not found on chain`);

    // OPEN accepts deposits; FULL still accepts while pot < cap (enforced below)
    if (round.status !== "OPEN" && round.status !== "FULL") {
      throw new Error(`Round ${args.roundId} is not accepting deposits (status=${round.status})`);
    }
    const amount = args.amountLamports;
    if (amount < this.config.minDepositLamports) throw new Error("Deposit below min_deposit");
    if (amount > this.config.maxDepositLamports) throw new Error("Deposit above max_deposit");
    const cap = await this.roundCap(round.id);
    if (round.pot + amount > cap) {
      throw new Error(`Deposit would exceed round cap (${cap} lamports)`);
    }

    const ix = depositIx(this.programId, args.depositor, args.roundId, amount);
    const { blockhash, lastValidBlockHeight } =
      args.blockhash ?? (await this.connection.getLatestBlockhash("confirmed"));
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = args.depositor;
    return tx;
  }

  /** Round cap from the on-chain GlobalConfig (falls back to env value). */
  async roundCap(roundId: bigint): Promise<bigint> {
    const cfg = await this.getConfigAccount();
    return cfg?.maxRoundSize ?? this.config.maxRoundSizeLamports;
  }
}
