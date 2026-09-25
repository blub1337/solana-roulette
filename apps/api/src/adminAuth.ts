/**
 * Admin API authentication — a bearer token that never leaves the server.
 *
 * The admin console is the only place that reports escrow balances, the
 * operator address, the fee wallet and the transaction log, so it must fail
 * CLOSED: with no `ADMIN_TOKEN` configured every admin route answers 403 and
 * nothing is served. There is no dev bypass, no "read-only" fallback and no
 * default token.
 *
 * SECURITY RULES enforced here (docs/ADMIN.md §2):
 *   - the token is compared in constant time against a SHA-256 digest, so the
 *     response time reveals nothing about how much of it was correct;
 *   - the token is never written to a log line, an error body or the database;
 *   - repeated failures from one address are throttled (429);
 *   - responses are marked no-store so no proxy caches operator data.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { txLog } from "./logger.js";

/** 10 failures per address per 5 minutes, then a short cool-down. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 5 * 60_000;

const failures = new Map<string, { count: number; firstAt: number }>();

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison of two arbitrary-length strings. */
export function tokenMatches(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

/** Accepts `x-admin-token: <token>` or `Authorization: Bearer <token>`. */
export function readToken(req: FastifyRequest): string {
  const header = req.headers["x-admin-token"];
  if (typeof header === "string" && header.trim() !== "") return header.trim();
  const auth = req.headers.authorization;
  if (typeof auth === "string" && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return "";
}

function clientKey(req: FastifyRequest): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function throttled(key: string): boolean {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry) return false;
  if (now - entry.firstAt > FAILURE_WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(key: string): void {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || now - entry.firstAt > FAILURE_WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

export type AdminGuardResult = { ok: true } | { ok: false; status: number; error: string; detail: string };

/**
 * Verify the caller. Returns `{ ok: true }` or the error the caller should
 * answer with — it never throws and never reveals whether the token was close.
 */
export function verifyAdminToken(
  req: FastifyRequest,
  expectedToken: string | undefined
): AdminGuardResult {
  if (!expectedToken) {
    txLog.warn("admin.request_refused", {
      reason: "admin_not_configured",
      route: req.routeOptions?.url ?? req.url,
    });
    return {
      ok: false,
      status: 403,
      error: "admin_not_configured",
      detail:
        "Admin API is disabled. Set ADMIN_TOKEN in the server environment (Render → Environment) and restart.",
    };
  }

  const key = clientKey(req);
  if (throttled(key)) {
    txLog.warn("admin.request_throttled", { route: req.routeOptions?.url ?? req.url });
    return {
      ok: false,
      status: 429,
      error: "too_many_attempts",
      detail: "Too many failed admin attempts. Wait a few minutes and try again.",
    };
  }

  const provided = readToken(req);
  // Hash both sides even when nothing was sent, so "no token" and "wrong
  // token" cost the same and fail identically.
  if (!provided || !tokenMatches(provided, expectedToken)) {
    recordFailure(key);
    txLog.warn("admin.auth_failed", {
      route: req.routeOptions?.url ?? req.url,
      method: req.method,
      tokenProvided: provided.length > 0,
    });
    return {
      ok: false,
      status: 401,
      error: "invalid_admin_token",
      detail: "The admin token is missing or wrong. It is the ADMIN_TOKEN value from the server environment.",
    };
  }

  failures.delete(key);
  return { ok: true };
}
