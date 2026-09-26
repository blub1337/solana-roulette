/**
 * Operator transaction builder (DEVNET ONLY).
 *
 * Signs lifecycle txs with the server-side operator keypair. The PROGRAM
 * enforces all rules; the operator can only trigger create/lock/settle/pay/
 * cancel. The fee wallet is validated against config on every settle/pay.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_SLOT_HASHES_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import {
  getGlobalConfigPda,
  getRoundPda,
  getEscrowPda,
  getParticipantPda,
  fetchRoundAccount,
  fetchParticipantsForRound,
  decodeGlobalConfig,
  type GlobalConfigData,
} from "@solana-roulette/verification";
import { loadOperatorKeypair } from "./keypair.js";
import { TIER_COUNT } from "@solana-roulette/types";

interface FeeWalletSource {
  platformFeeWallet?: string;
  treasuryPubkey?: string;
}

/** Platform fee wallet (public key only). Prefers PLATFORM_FEE_WALLET,
 *  falls back to TREASURY_PUBKEY. Fail-safe when missing/invalid. */
export function platformFeeWallet(cfg: FeeWalletSource): PublicKey | null {
  const raw = cfg.platformFeeWallet ?? cfg.treasuryPubkey;
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    return null;
  }
}

/** Throws when the fee wallet is missing/invalid — settlement must stop. */
export function requireFeeWallet(cfg: FeeWalletSource): PublicKey {
  const pk = platformFeeWallet(cfg);
  if (!pk) {
    throw new Error(
      "PLATFORM_FEE_WALLET missing or invalid — refusing any settlement. " +
        "Expected the configured public fee wallet (see docs/PAYMENTS.md)."
    );
  }
  return pk;
}

export async function fetchOnChainConfig(
  connection: Connection,
  programId: PublicKey
): Promise<GlobalConfigData | null> {
  const [configPda] = getGlobalConfigPda(programId);
  const info = await connection.getAccountInfo(configPda);
  if (!info?.data) return null;
  return decodeGlobalConfig(info.data);
}

export interface LifecycleTxArgs {
  connection: Connection;
  programId: PublicKey;
  cfg: {
    network: string;
    mainnetEnabled: boolean;
    operatorKeypairJson?: string;
    platformFeeWallet?: string;
    treasuryPubkey?: string;
    maxRoundSizeLamports: bigint;
  };
  action: "create" | "lock" | "settle" | "pay" | "cancel";
  roundId?: bigint;
  tier?: number;
}

export interface LifecycleTxResult {
  signature: string;
  roundId: bigint;
  winner?: string;
  payoutLamports?: string;
  feeLamports?: string;
}

export async function buildAndSendLifecycleTx(args: LifecycleTxArgs): Promise<LifecycleTxResult | null> {
  const { connection, programId, cfg, action } = args;
  const operator = loadOperatorKeypair(cfg.operatorKeypairJson);
  if (!operator) return null;
  if (cfg.network === "mainnet-beta" && !cfg.mainnetEnabled) return null;

  // Authoritative tier caps live ON CHAIN (GlobalConfig.tier_caps). When the
  // chain disagrees with env, adopt the chain's max cap for the coarse
  // maxRoundSizeLamports field so the tier math never underestimates a cap.
  const onChain = await fetchOnChainConfig(connection, programId);
  if (onChain && "tierCaps" in onChain && onChain.tierCaps) {
    const maxCap = onChain.tierCaps.reduce((m, c) => (c > m ? c : m), 0n);
    if (maxCap > cfg.maxRoundSizeLamports) {
      cfg.maxRoundSizeLamports = maxCap;
    }
  }

  const [configPda] = getGlobalConfigPda(programId);
  const tx = new Transaction();
  let targetRoundId = args.roundId ?? null;

  if (action === "create") {
    targetRoundId = args.roundId ?? (await nextRoundId(connection, programId));
    const [roundPda] = getRoundPda(programId, targetRoundId);
    const [escrowPda] = getEscrowPda(programId, targetRoundId);
    tx.add(
      new TransactionInstruction({
        programId,
        keys: [
          { pubkey: configPda, isSigner: false, isWritable: true },
          { pubkey: roundPda, isSigner: false, isWritable: true },
          { pubkey: escrowPda, isSigner: false, isWritable: true },
          { pubkey: operator.publicKey, isSigner: true, isWritable: true },
          { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: disc("create_round", u64le(targetRoundId), u8le(tierOf(args))),
      })
    );
  } else {
    const current = targetRoundId ?? (await findCurrentRoundId(connection, programId));
    if (current === null) return null;
    targetRoundId = current;
    const [roundPda] = getRoundPda(programId, current);
    const [escrowPda] = getEscrowPda(programId, current);

    if (action === "lock") {
      tx.add(
        new TransactionInstruction({
          programId,
          keys: [
            { pubkey: configPda, isSigner: false, isWritable: false },
            { pubkey: roundPda, isSigner: false, isWritable: true },
            { pubkey: escrowPda, isSigner: false, isWritable: false },
            { pubkey: operator.publicKey, isSigner: true, isWritable: true },
          ],
          data: disc("lock_round"),
        })
      );
    } else if (action === "settle") {
      const feeWallet = requireFeeWallet(cfg);
      const roundKey = roundPda;
      // remaining_accounts = Participant PDAs in index order — pick_winner
      // walks them exactly as recorded by deposit (winner.rs pick_winner).
      const participants = await fetchParticipantsForRound(connection, programId, roundKey);
      const participantPdas = participants
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((p) => getParticipantPda(programId, roundKey, p.wallet)[0]);
      tx.add(
        new TransactionInstruction({
          programId,
          keys: [
            { pubkey: configPda, isSigner: false, isWritable: false },
            { pubkey: roundPda, isSigner: false, isWritable: true },
            { pubkey: escrowPda, isSigner: false, isWritable: true },
            { pubkey: feeWallet, isSigner: false, isWritable: false },
            { pubkey: operator.publicKey, isSigner: true, isWritable: true },
            { pubkey: SLOT_HASHES, isSigner: false, isWritable: false },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            ...participantPdas.map((pk) => ({
              pubkey: pk,
              isSigner: false,
              isWritable: false,
            })),
          ],
          data: disc("settle_round"),
        })
      );
    } else if (action === "pay") {
      const feeWallet = requireFeeWallet(cfg);
      const round = await fetchRoundAccount(connection, programId, current);
      if (!round) return null;
      if (round.winner === undefined || round.winner.equals(PublicKey.default)) {
        throw new Error(`Round ${current} has no frozen winner; cannot pay`);
      }
      tx.add(
        new TransactionInstruction({
          programId,
          keys: [
            { pubkey: configPda, isSigner: false, isWritable: false },
            { pubkey: roundPda, isSigner: false, isWritable: true },
            { pubkey: escrowPda, isSigner: false, isWritable: true },
            { pubkey: round.winner, isSigner: false, isWritable: true },
            { pubkey: feeWallet, isSigner: false, isWritable: true },
            { pubkey: operator.publicKey, isSigner: true, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: disc("pay_winners"),
        })
      );
    } else {
      // cancel: fixed accounts first (operator signer, system program), then
      // remaining_accounts = (Participant_i, wallet_i) pairs — per lib.rs.
      const roundKey = roundPda;
      const participants = await fetchParticipantsForRound(connection, programId, roundKey);
      const remaining = participants
        .slice()
        .sort((a, b) => a.index - b.index)
        .flatMap((p) => [
          { pubkey: getParticipantPda(programId, roundKey, p.wallet)[0], isSigner: false, isWritable: false },
          { pubkey: p.wallet, isSigner: false, isWritable: true },
        ]);
      tx.add(
        new TransactionInstruction({
          programId,
          keys: [
            { pubkey: configPda, isSigner: false, isWritable: false },
            { pubkey: roundPda, isSigner: false, isWritable: true },
            { pubkey: escrowPda, isSigner: false, isWritable: true },
            { pubkey: operator.publicKey, isSigner: true, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            ...remaining,
          ],
          data: disc("cancel_round"),
        })
      );
    }
  }

  try {
    const sig = await sendAndConfirm(connection, tx, operator);
    const roundId = targetRoundId ?? 0n;
    let winner: string | undefined;
    let payoutLamports: string | undefined;
    let feeLamports: string | undefined;
    if (action === "pay" || action === "settle") {
      const r = await fetchRoundAccount(connection, programId, roundId);
      if (r?.winner && !r.winner.equals(PublicKey.default)) {
        winner = r.winner.toBase58();
        payoutLamports = r.payoutLamports.toString();
        feeLamports = r.feeLamports.toString();
      }
    }
    return { signature: sig, roundId, winner, payoutLamports, feeLamports };
  } catch (e) {
    console.warn(`[operator] ${action} failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const SYSTEM_PROGRAM_ID = SystemProgram.programId;
const SLOT_HASHES = SYSVAR_SLOT_HASHES_PUBKEY;

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function u8le(v: number): Buffer {
  return Buffer.from([v & 0xff]);
}

/** Pool lane for create_round (validated against the on-chain tier caps). */
function tierOf(args: { tier?: number }): number {
  const t = args.tier ?? 0;
  if (!Number.isInteger(t) || t < 0 || t >= TIER_COUNT) {
    throw new Error(`invalid pool tier ${t} (must be 0..${TIER_COUNT - 1})`);
  }
  return t;
}

/** Anchor discriminator: sha256("global:" + name)[0..8]. */
function disc(name: string, ...argBufs: Buffer[]): Buffer {
  return Buffer.concat([anchorDiscriminator(name), ...argBufs]);
}

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

async function sendAndConfirm(connection: Connection, tx: Transaction, operator: Keypair): Promise<string> {
  return sendAndConfirmTransaction(connection, tx, [operator]);
}

/** Current round = first id whose Round account exists and is non-terminal. */
export async function findCurrentRoundId(
  connection: Connection,
  programId: PublicKey,
  from = 1n
): Promise<bigint | null> {
  for (let id = from; id < from + 64n; id++) {
    const r = await fetchRoundAccount(connection, programId, id);
    if (r && r.status !== "COMPLETED" && r.status !== "CANCELLED") return id;
    if (!r && id > from) return id - 1n >= from ? id - 1n : null;
  }
  return null;
}

/** Next round id = counter + 1 read from the on-chain GlobalConfig. */
export async function nextRoundId(connection: Connection, programId: PublicKey): Promise<bigint> {
  const cfg = await fetchOnChainConfig(connection, programId);
  const counter = cfg?.roundCounter ?? 0n;
  return counter + 1n;
}
