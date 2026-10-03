/**
 * On-chain transaction inspection.
 *
 * The server NEVER trusts what a client says it did. Everything here reads
 * the transaction back from the cluster and reports what actually happened:
 * the fee payer, the real System transfers, the slot and the error field.
 */
import { PublicKey, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { getParticipantPda, getRoundPda, decodeParticipant, PARTICIPANT_SPACE } from "@solana-roulette/verification";
import { globalDiscriminator } from "@solana-roulette/sdk";
import { txLog } from "./logger.js";
export interface SystemTransfer {
  from: PublicKey;
  to: PublicKey;
  amount: bigint;
}

export const COMMITMENT = "confirmed" as const;

/** Fetch a confirmed transaction, or null when it is not on chain (yet). */
export async function fetchParsedTransaction(
  connection: Connection,
  signature: string
): Promise<ParsedTransactionWithMeta | null> {
  return connection.getParsedTransaction(signature, {
    commitment: COMMITMENT,
    maxSupportedTransactionVersion: 0,
  });
}

/**
 * Every SystemProgram transfer in the transaction, including CPI inner
 * instructions (a program paying out shows up there).
 */
export function extractSystemTransfers(tx: ParsedTransactionWithMeta): SystemTransfer[] {
  const out: SystemTransfer[] = [];
  const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey);

  const push = (ins: ParsedTransactionWithMeta["transaction"]["message"]["instructions"][number]) => {
    if (!("program" in ins) || ins.program !== "system") return;
    const parsed = ins.parsed as
      | { type?: string; info?: { source?: string; destination?: string; lamports?: number } }
      | undefined;
    if (parsed?.type !== "transfer" || !parsed.info) return;
    const from = accountKeys.find((k) => k.toBase58() === parsed.info?.source);
    const to = accountKeys.find((k) => k.toBase58() === parsed.info?.destination);
    if (from && to && typeof parsed.info.lamports === "number") {
      out.push({ from, to, amount: BigInt(parsed.info.lamports) });
    }
  };

  for (const ins of tx.transaction.message.instructions) push(ins);
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ins of inner.instructions) {
      if ("program" in ins && ins.program === "system") push(ins as never);
    }
  }
  return out;
}

export type TransferCheck =
  | { ok: true; transfer: SystemTransfer; slot: number; feePayer: string; logCount: number }
  | { ok: false; code: string; detail: string };

/**
 * Verify that `signature` is a CONFIRMED, error-free transaction that moved
 * exactly `amount` lamports from `from` to `to`, signed by `from`.
 */
export async function checkSystemTransfer(
  connection: Connection,
  args: {
    signature: string;
    from: PublicKey;
    to: PublicKey;
    amount: bigint;
  }
): Promise<TransferCheck> {
  const { signature, from, to, amount } = args;
  let tx: ParsedTransactionWithMeta | null;
  try {
    tx = await fetchParsedTransaction(connection, signature);
  } catch (err) {
    return { ok: false, code: "rpc_error", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!tx) {
    return { ok: false, code: "tx_not_found", detail: "not found on devnet RPC at confirmed commitment" };
  }
  if (tx.meta?.err) {
    return { ok: false, code: "tx_failed_on_chain", detail: JSON.stringify(tx.meta.err) };
  }

  const feePayer = tx.transaction.message.accountKeys[0]?.pubkey.toBase58() ?? "";
  if (!feePayer || feePayer !== from.toBase58()) {
    return {
      ok: false,
      code: "unexpected_fee_payer",
      detail: `fee payer ${feePayer || "?"} is not ${from.toBase58()}`,
    };
  }

  const transfers = extractSystemTransfers(tx);
  const match = transfers.find(
    (t) =>
      t.from.equals(from) && t.to.equals(to) && t.amount === amount
  );
  if (!match) {
    // Tolerate a slightly larger transfer (rent/tip dust) but never a smaller
    // one: the credited amount is always the transfer amount.
    const loose = transfers.find((t) => t.from.equals(from) && t.to.equals(to));
    if (loose && loose.amount >= amount) {
      return {
        ok: true,
        transfer: loose,
        slot: tx.slot,
        feePayer,
        logCount: tx.meta?.logMessages?.length ?? 0,
      };
    }
    return {
      ok: false,
      code: "no_matching_transfer",
      detail:
        `expected ${amount} lamports ${from.toBase58()} -> ${to.toBase58()}; ` +
        `on-chain transfers: ${describe(transfers)}`,
    };
  }
  return { ok: true, transfer: match, slot: tx.slot, feePayer, logCount: tx.meta?.logMessages?.length ?? 0 };
}

// ---------------------------------------------------------------------------
// Program payout verification (chain mode, settlement phase 2)
//
// In chain mode `pay_winners` moves the lamports PROGRAM-SIDE: the round
// escrow PDA pays `round.payout_lamports` to the frozen winner and
// `round.fee_lamports` to `config.treasury` (lib.rs pay_winners). The server
// only triggers that instruction, so the amounts the driver celebrates must
// be proven from the chain, not assumed from the send() success.
//
// Verification reads the transaction back and checks the BALANCE DELTAS of
// the three program-pinned accounts:
//
//   1. the tx is confirmed and error-free;
//   2. it invoked THIS program with the `pay_winners` discriminator;
//   3. winner account balance increased by EXACTLY `payoutLamports`;
//   4. treasury balance increased by EXACTLY `feeLamports`;
//   5. escrow balance decreased by EXACTLY their sum — no lamport can leave
//      the escrow unaccounted for, whether by transfer, rent change or any
//      other mechanism (balance deltas are stronger than transfer parsing).
//
// The fee payer is deliberately NOT pinned (unlike the deposit check):
// lock/settle/pay are permissionless by design, so any signer may have paid
// the transaction fee. Only the three program-pinned accounts matter.
//
// Degenerate case: if the frozen winner ever equalled the treasury, the two
// credits would merge into one balance and the exact-split check would fail.
// That configuration cannot occur through deposit/lock flows (the treasury is
// config-pinned, the winner is a participant), and a failure here is loud and
// retried rather than silently celebrated — the safe direction.
// ---------------------------------------------------------------------------

/** Anchor discriminator of the program's `pay_winners` instruction. */
const PAY_WINNERS_DISCRIMINATOR = globalDiscriminator("pay_winners");

export interface ProgramPayoutCheckArgs {
  signature: string;
  programId: PublicKey;
  /** The round escrow PDA that pays (balance must DROP by the exact sum). */
  escrow: PublicKey;
  /** Frozen winner from settle phase 1 (balance must RISE by payout). */
  winner: PublicKey;
  /** config.treasury / platform fee wallet (balance must RISE by fee). */
  treasury: PublicKey;
  /** Frozen `round.payout_lamports` from settle phase 1. */
  payoutLamports: bigint;
  /** Frozen `round.fee_lamports` from settle phase 1. */
  feeLamports: bigint;
}

export type ProgramPayoutCheck =
  | { ok: true; slot: number; feePayer: string; logCount: number; escrowDebit: bigint }
  | { ok: false; code: string; detail: string };

/**
 * Verify that `signature` is a confirmed, error-free invocation of the
 * roulette program's `pay_winners` instruction that moved EXACTLY the frozen
 * amounts: winner +payoutLamports, treasury +feeLamports, escrow −(sum).
 * Verified against account BALANCE DELTAS from the transaction metadata, so
 * every lamport leaving the escrow is accounted for.
 */
export async function checkProgramPayout(
  connection: Connection,
  args: ProgramPayoutCheckArgs
): Promise<ProgramPayoutCheck> {
  const { signature, programId, escrow, winner, treasury, payoutLamports, feeLamports } = args;

  let tx: ParsedTransactionWithMeta | null;
  try {
    tx = await fetchParsedTransaction(connection, signature);
  } catch (err) {
    return { ok: false, code: "rpc_error", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!tx) {
    return { ok: false, code: "tx_not_found", detail: "not found on devnet RPC at confirmed commitment" };
  }
  if (tx.meta?.err) {
    return { ok: false, code: "tx_failed_on_chain", detail: JSON.stringify(tx.meta.err) };
  }

  // The tx must actually invoke THIS program's pay_winners instruction.
  const invokedPayWinners = tx.transaction.message.instructions.some((ins) => {
    if (!("programId" in ins) || !("data" in ins)) return false;
    if (!ins.programId.equals(programId)) return false;
    const data = Buffer.from(bs58.decode(ins.data));
    return data.length >= 8 && data.subarray(0, 8).equals(PAY_WINNERS_DISCRIMINATOR);
  });
  if (!invokedPayWinners) {
    return {
      ok: false,
      code: "no_program_payout",
      detail: `transaction does not invoke ${programId.toBase58()} pay_winners`,
    };
  }

  // Balance-delta verification against the tx metadata.
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const indexOf = (pk: PublicKey): number | null => {
    const idx = keys.findIndex((k) => k.equals(pk));
    return idx === -1 ? null : idx;
  };
  const iEscrow = indexOf(escrow);
  const iWinner = indexOf(winner);
  const iTreasury = indexOf(treasury);
  if (iEscrow === null) {
    return { ok: false, code: "escrow_not_in_tx", detail: `escrow ${escrow.toBase58()} is not part of the transaction` };
  }
  if (iWinner === null) {
    return { ok: false, code: "winner_not_in_tx", detail: `winner ${winner.toBase58()} is not part of the transaction` };
  }
  if (iTreasury === null) {
    return { ok: false, code: "treasury_not_in_tx", detail: `treasury ${treasury.toBase58()} is not part of the transaction` };
  }

  const pre = tx.meta?.preBalances;
  const post = tx.meta?.postBalances;
  if (!pre || !post || pre.length !== post.length) {
    return { ok: false, code: "missing_balance_meta", detail: "transaction metadata is missing pre/postBalances" };
  }

  const escrowDebit = BigInt(pre[iEscrow]! - post[iEscrow]!);
  const winnerCredit = BigInt(post[iWinner]! - pre[iWinner]!);
  const treasuryCredit = BigInt(post[iTreasury]! - pre[iTreasury]!);

  if (winnerCredit !== payoutLamports) {
    return {
      ok: false,
      code: "winner_amount_mismatch",
      detail: `winner balance rose by ${winnerCredit}, frozen payout is exactly ${payoutLamports}`,
    };
  }
  if (treasuryCredit !== feeLamports) {
    return {
      ok: false,
      code: "treasury_amount_mismatch",
      detail: `treasury balance rose by ${treasuryCredit}, frozen fee is exactly ${feeLamports}`,
    };
  }
  if (escrowDebit !== payoutLamports + feeLamports) {
    return {
      ok: false,
      code: "escrow_outflow_mismatch",
      detail: `escrow balance dropped by ${escrowDebit}, expected exactly ${payoutLamports + feeLamports}`,
    };
  }

  return {
    ok: true,
    slot: tx.slot,
    feePayer: tx.transaction.message.accountKeys[0]?.pubkey.toBase58() ?? "",
    logCount: tx.meta?.logMessages?.length ?? 0,
    escrowDebit,
  };
}
export function describe(transfers: SystemTransfer[]): string {
  if (transfers.length === 0) return "none";
  return transfers.map((t) => `${t.amount} ${t.from.toBase58().slice(0, 6)}->${t.to.toBase58().slice(0, 6)}`).join(", ");
}
/** Log the RPC's view of a signature (never any key material). */
export function logRpcView(
  event: string,
  fields: { signature: string; network: string; ok: boolean; code?: string; slot?: number; detail?: string }
): void {
  const { ok, code, detail, ...rest } = fields;
  txLog[ok ? "info" : "warn"](event, {
    ...rest,
    rpcResult: ok ? "confirmed" : code,
    rpcDetail: ok ? undefined : detail,
  });
}

// ---------------------------------------------------------------------------
// Program deposit verification (chain mode)
//
// The web client now sends the program's `deposit` instruction directly (the
// instruction that creates the Participant PDA, advances round.pot and can
// flip the round to FULL). Verification therefore re-reads the transaction
// AND the resulting chain state:
//
//   1. the tx is confirmed, error-free and its fee payer is the depositor;
//   2. it invoked THIS program with the `deposit` discriminator;
//   3. it carried a System transfer of exactly `amount` from the depositor
//      into the round escrow (deposit() CPIs system_program::transfer);
//   4. the Participant PDA the instruction must have created actually exists,
//      is program-owned, and records round/wallet/amount correctly — the
//      strongest possible evidence that the program ran and mutated state.
//
// The pot is NEVER taken from the client; it is re-read from the Round PDA by
// the caller after this check passes.
// ---------------------------------------------------------------------------

/** Anchor discriminator of the program's `deposit` instruction (sha256("global:deposit")[0..8]). */
const DEPOSIT_DISCRIMINATOR = globalDiscriminator("deposit");

export interface ProgramDepositCheckArgs {
  signature: string;
  programId: PublicKey;
  roundId: bigint;
  /** The depositor (must be the tx fee payer and the instruction's signer). */
  wallet: PublicKey;
  /** The round escrow PDA the deposit must fund. */
  escrow: PublicKey;
  amount: bigint;
}

export type ProgramDepositCheck =
  | { ok: true; transfer: SystemTransfer; slot: number; feePayer: string; logCount: number }
  | { ok: false; code: string; detail: string };

/**
 * Verify that `signature` is a confirmed, error-free invocation of the
 * roulette program's `deposit` instruction by `wallet`, funding `escrow` with
 * exactly `amount` lamports and writing the Participant PDA on chain.
 */
export async function checkProgramDeposit(
  connection: Connection,
  args: ProgramDepositCheckArgs
): Promise<ProgramDepositCheck> {
  const { signature, programId, roundId, wallet, escrow, amount } = args;
  let tx: ParsedTransactionWithMeta | null;
  try {
    tx = await fetchParsedTransaction(connection, signature);
  } catch (err) {
    return { ok: false, code: "rpc_error", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!tx) {
    return { ok: false, code: "tx_not_found", detail: "not found on devnet RPC at confirmed commitment" };
  }
  if (tx.meta?.err) {
    return { ok: false, code: "tx_failed_on_chain", detail: JSON.stringify(tx.meta.err) };
  }

  const feePayer = tx.transaction.message.accountKeys[0]?.pubkey.toBase58() ?? "";
  if (!feePayer || feePayer !== wallet.toBase58()) {
    return {
      ok: false,
      code: "unexpected_fee_payer",
      detail: `fee payer ${feePayer || "?"} is not ${wallet.toBase58()}`,
    };
  }

  // The tx must actually invoke THIS program's deposit instruction. A raw
  // (unparsed) instruction carries its base58 data; a parsed one would not be
  // our program's call.
  const invokedProgramDeposit = tx.transaction.message.instructions.some((ins) => {
    if (!("programId" in ins) || !("data" in ins)) return false;
    if (!ins.programId.equals(programId)) return false;
    const data = Buffer.from(bs58.decode(ins.data));
    return data.length >= 8 && data.subarray(0, 8).equals(DEPOSIT_DISCRIMINATOR);
  });
  if (!invokedProgramDeposit) {
    return {
      ok: false,
      code: "no_program_deposit",
      detail: `transaction does not invoke ${programId.toBase58()} deposit`,
    };
  }

  // deposit() moves lamports via a system_program::transfer CPI into escrow.
  // (The tx is parsed, so the CPI surfaces as an inner system transfer.)
  const transfers = extractSystemTransfers(tx);
  const match = transfers.find(
    (t) => t.from.equals(wallet) && t.to.equals(escrow) && t.amount === amount
  );
  if (!match) {
    const loose = transfers.find((t) => t.from.equals(wallet) && t.to.equals(escrow));
    if (loose && loose.amount >= amount) {
      return {
        ok: true,
        transfer: loose,
        slot: tx.slot,
        feePayer,
        logCount: tx.meta?.logMessages?.length ?? 0,
      };
    }
    return {
      ok: false,
      code: "no_matching_transfer",
      detail:
        `expected deposit() CPI of ${amount} lamports ${wallet.toBase58()} -> ${escrow.toBase58()}; ` +
        `on-chain transfers: ${describe(transfers)}`,
    };
  }

  // The instruction must have written the Participant PDA. This is checked
  // against LIVE chain state, not the tx: the PDA exists only if the program
  // actually initialized it.
  const [participantPda] = getParticipantPda(programId, roundId, wallet);
  const participantInfo = await connection.getAccountInfo(participantPda);
  if (!participantInfo) {
    return {
      ok: false,
      code: "participant_missing",
      detail: `participant PDA ${participantPda.toBase58()} was not created by the deposit`,
    };
  }
  if (!participantInfo.owner.equals(programId)) {
    return {
      ok: false,
      code: "participant_wrong_owner",
      detail: `participant PDA ${participantPda.toBase58()} is owned by ${participantInfo.owner.toBase58()}`,
    };
  }
  if (participantInfo.data.length < PARTICIPANT_SPACE) {
    return {
      ok: false,
      code: "participant_wrong_size",
      detail: `participant PDA is ${participantInfo.data.length} bytes, expected >= ${PARTICIPANT_SPACE}`,
    };
  }
  const participant = decodeParticipant(participantInfo.data);
  if (!participant.round.equals(getRoundPda(programId, roundId)[0])) {
    return {
      ok: false,
      code: "participant_round_mismatch",
      detail: `participant PDA records round ${participant.round.toBase58()}`,
    };
  }
  if (!participant.wallet.equals(wallet)) {
    return {
      ok: false,
      code: "participant_wallet_mismatch",
      detail: `participant PDA records wallet ${participant.wallet.toBase58()}`,
    };
  }
  if (participant.amount !== amount) {
    return {
      ok: false,
      code: "participant_amount_mismatch",
      detail: `participant PDA records ${participant.amount} lamports, expected ${amount}`,
    };
  }

  return { ok: true, transfer: match, slot: tx.slot, feePayer, logCount: tx.meta?.logMessages?.length ?? 0 };
}
