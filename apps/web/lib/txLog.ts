"use client";

/**
 * Client-side transaction logging.
 *
 * Every deposit/payout step is logged to the browser console as a single JSON
 * line, mirroring the server log: wallet, amount, network, recipient,
 * signature, RPC result, confirmation status and any error.
 *
 * SECURITY: only PUBLIC data is ever logged. No private key, no seed phrase,
 * no secret key array — the browser never has any.
 */
export type TxLevel = "info" | "warn" | "error";

const SAFE_KEY = /^[A-Za-z0-9_]{1,64}$/;

function emit(level: TxLevel, event: string, fields: Record<string, unknown>): void {
  const line: Record<string, unknown> = { ts: new Date().toISOString(), level, source: "browser", event };
  for (const [k, v] of Object.entries(fields)) {
    if (!SAFE_KEY.test(k)) continue;
    if (v === undefined) continue;
    line[k] = typeof v === "bigint" ? v.toString() : v;
  }
  const text = JSON.stringify(line);
  if (level === "error") console.error(`[tx] ${text}`);
  else if (level === "warn") console.warn(`[tx] ${text}`);
  else console.log(`[tx] ${text}`);
}

export const clientTxLog = {
  info: (event: string, fields: Record<string, unknown> = {}) => emit("info", event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => emit("warn", event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => emit("error", event, fields),
};
