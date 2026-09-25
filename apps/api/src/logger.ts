/**
 * Structured transaction logging for deposits and payouts.
 *
 * Every line is single-line JSON so the preview/server log is greppable:
 *   {"ts":"…","level":"info","event":"deposit.confirmed","network":"devnet",…}
 *
 * SECURITY: secret-ish keys are redacted recursively and RPC URLs have their
 * credentials stripped. Private keys, seed phrases and keypairs must never
 * reach this module — call sites pass public data only (wallet addresses,
 * amounts, signatures, RPC responses, errors).
 */
import { logRing } from "./logBuffer.js";

const SECRET_KEY_RE =
  /(secret|private[_]?key|privkey|mnemonic|seed|keypair|password|passphrase|api[-_]?key|authorization|cookie)/i;

/**
 * Key material that leaked into free text (an error echoing a keypair, a
 * warning quoting the env value, …). Two precise shapes:
 *   - a JSON/CSV array of 32+ bytes  → a solana-keygen secret key
 *   - `secret: value`, `mnemonic = …` → a labelled secret
 * Signatures are deliberately NOT matched: they are 86-88 base58 chars, the
 * same shape as a base58 secret key, and they must stay readable.
 */
const KEY_ARRAY_RE = /\[\s*\d+\s*(?:,\s*\d+\s*){31,}\]/g;
const LABELLED_SECRET_RE =
  /((?:secret|private[\s_-]?key|privkey|mnemonic|seed[\s_-]?phrase|keypair|password|passphrase)[\s_-]*(?:key|phrase|words)?\s*[:=]\s*)([^\n;]*)/gi;

/** Scrub key material embedded in a string value. */
export function scrubString(value: string): string {
  return value.replace(KEY_ARRAY_RE, "[redacted]").replace(LABELLED_SECRET_RE, "$1[redacted]");
}

/** Field names that are safe and expected in a transaction log line. */
const ALLOWED_KEY_RE = /^[A-Za-z0-9_]{1,64}$/;

export function isSecretField(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export function redact(key: string, value: unknown, depth = 0): unknown {
  if (isSecretField(key)) return "[redacted]";
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(key, v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (!ALLOWED_KEY_RE.test(k)) continue;
      out[k] = redact(k, v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Strip credentials from an RPC URL before logging: https://host/v1/<key> and
 * ?api-key=… must never be written to a log file.
 */
export function safeEndpoint(url: string | undefined | null): string {
  if (!url) return "unknown";
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.search = "";
    const segs = u.pathname.split("/");
    // Provider keys live in the path (/v1/<key>) — keep the shape, drop the key.
    if (segs.length > 2 && segs[segs.length - 1]!.length > 24) segs[segs.length - 1] = "***";
    u.pathname = segs.join("/");
    return u.toString();
  } catch {
    return "invalid-url";
  }
}

export type LogLevel = "info" | "warn" | "error";

function emit(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_KEY_RE.test(k)) continue;
    line[k] = redact(k, v, 0);
  }
  // The admin console tails this buffer. It is fed AFTER redaction, so a
  // private key, seed phrase or RPC credential cannot reach a browser through
  // the admin API (docs/ADMIN.md §2).
  const { ts, event: evt, level: lvl, ...rest } = line as {
    ts: string;
    event: string;
    level: LogLevel;
  };
  try {
    logRing.push({ ts, level: lvl, event: evt, fields: rest });
  } catch {
    /* a broken log buffer must never break money handling */
  }
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export const txLog = {
  info: (event: string, fields: Record<string, unknown> = {}) => emit("info", event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => emit("warn", event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => emit("error", event, fields),
};

/** Public subset of the log record used by the API and the tests. */
export function logRecord(event: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: new Date().toISOString(), event, ...(redact("root", fields) as Record<string, unknown>) };
}
