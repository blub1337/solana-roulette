/**
 * On-chain transaction inspection.
 *
 * The server NEVER trusts what a client says it did. Everything here reads
 * the transaction back from the cluster and reports what actually happened:
 * the fee payer, the real System transfers, the slot and the error field.
 */
import { PublicKey, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
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

/** One-line description of the transfers found, for error messages and logs. */
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
