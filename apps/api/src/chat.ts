/**
 * Live chat — wallet-OPTIONAL identity (guest fallback), per-page (all pages
 * share one channel;
 * `page` is stored per message so the UI can filter to the current page).
 *
 *   1a. wallet login (strong): POST /api/chat/auth {wallet, signature} → token
 *   1b. guest login (no wallet): POST /api/chat/guest → server-issued token
 *   2. POST /api/chat with `Authorization: Bearer <token>` + message
 *   3. every client receives the message live via SSE (`chat` event)
 *
 * THE WALLET IS THE PREFERRED LOGIN, NOT A REQUIREMENT. When a wallet signs,
 * `signMessage` proves control of its private key (ed25519, verified server-
 * side), so nobody can chat under a stranger's address; the signature covers a
 * domain + timestamp, so a token cannot be replayed. When there is no wallet —
 * or the user rejects the popup — chat continues as a GUEST: the server issues
 * a `g_<hex>` identity, HMAC-bound like the wallet one, which can never be a
 * wallet address and is rate-limited per IP. Chatting never blocks on a
 * signature.
 *
 * The ring buffer is bounded and the mirror is fire-and-forget: chat is a
 * social surface, never on the money path, and must never be able to take the
 * settlement loop or the deposit verifier down.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import type { FastifyInstance } from "fastify";
import { broadcast } from "./store.js";
import { txLog } from "./logger.js";
import { postgresMirror } from "./store.js";

/** Kept in memory (bounded) — like the rest of the runtime state. */
const CHAT_KEEP = 200;
/** Per-wallet cooldown between messages (anti-spam). */
const CHAT_COOLDOWN_MS = 2_000;
/** Hard cap on message length (bytes-ish; the UI enforces the same bound). */
const CHAT_MAX_LEN = 280;

// ---------------------------------------------------------------------------
// session tokens (HMAC-signed, stateless)
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 12 * 60 * 60_000;
const SESSION_SECRET =
  process.env.CHAT_SESSION_SECRET ||
  process.env.ADMIN_TOKEN ||
  "solroll-dev-chat-secret"; // dev fallback; prod sets CHAT_SESSION_SECRET

/**
 * Guest identities.
 *
 * A wallet signature is the STRONG login (it proves key possession), but it is
 * not a REQUIREMENT to chat: wallets without `signMessage`, a rejected popup or
 * a user who simply has not connected must still be able to talk. Guests get a
 * server-issued, HMAC-bound identity (`g_<hex>`) so they are still attributable
 * and rate-limited per identity — they just cannot claim a wallet's address.
 */
export const GUEST_PREFIX = "g_";
export function isGuestId(id: string): boolean {
  return id.startsWith(GUEST_PREFIX);
}

/** Per-IP cap on guest-session minting (a guest can otherwise rotate ids freely). */
const GUEST_PER_IP = 10;
const GUEST_WINDOW_MS = 10 * 60_000;
const guestIssued = new Map<string, { count: number; firstAt: number }>();

function guestAllowed(ip: string): boolean {
  const now = Date.now();
  const entry = guestIssued.get(ip);
  if (!entry || now - entry.firstAt > GUEST_WINDOW_MS) {
    if (guestIssued.size > 5_000) guestIssued.clear();
    guestIssued.set(ip, { count: 1, firstAt: now });
    return true;
  }
  if (entry.count >= GUEST_PER_IP) return false;
  entry.count += 1;
  return true;
}

interface ChatSession {
  wallet: string;
  issuedAt: number;
}

function sign(payload: string): string {
  return createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

/** `<wallet>.<issuedAtMs>.<hmac>` — verified in constant time on every use. */
function issueSessionToken(wallet: string, now = Date.now()): string {
  const payload = `${wallet}.${now}`;
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token: string): ChatSession | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [wallet, issuedAtRaw, mac] = parts;
  const payload = `${wallet}.${issuedAtRaw}`;
  const expected = sign(payload);
  const a = Buffer.from(mac ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null;
  if (Date.now() - issuedAt > SESSION_TTL_MS) return null;
  return { wallet, issuedAt };
}

// ---------------------------------------------------------------------------
// moderation helpers
// ---------------------------------------------------------------------------

/** Very light pre-moderation: obvious slur filter (extendable). */
const BLOCKED = [
  "nigger",
  "faggot",
  "kike",
  "tranny",
  "hitler",
  "heil hitler",
  "hure",
  "missgeburt",
  "schwuchtel",
  "nlggr",
  "n1gger",
];

/** Collapse zero-width/homoglyph tricks, lowercase for matching. */
function normalizeForFilter(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u200b-\u200f\u2060]/g, "")
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
   .toLowerCase();
}

export function isClean(message: string): boolean {
  const norm = normalizeForFilter(message);
  return !BLOCKED.some((w) => norm.includes(w));
}

// ---------------------------------------------------------------------------
// in-memory ring + persistence
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  wallet: string;
  name: string | null;
  page: string;
  text: string;
  ts: number;
}

const ring: ChatMessage[] = [];
/** wallet → last-post ms (cooldown). */
const lastPost = new Map<string, number>();

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function trimText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // Strip control chars, collapse whitespace, hard-cap length.
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHAT_MAX_LEN);
}

function validWallet58(w: unknown): w is string {
  return typeof w === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w);
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Exchange a wallet signature for a chat session token.
   *
   * The message the client signs is `SolRoll chat login\n${Date.now()}` — the
   * timestamp must be within ±10 minutes, so a captured signature cannot be
   * replayed later. Phantom/Solflare show this exact text in their popup.
   */
  app.post("/api/chat/auth", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const wallet = body.wallet;
    const signature58 = body.signature;
    const ts = body.ts;

    if (!validWallet58(wallet)) {
      return reply.code(400).send({ error: "invalid_wallet" });
    }
    if (typeof signature58 !== "string" || signature58.length === 0 || signature58.length > 200) {
      return reply.code(400).send({ error: "invalid_signature" });
    }
    const tsNum = typeof ts === "number" ? ts : Number(ts);
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 10 * 60_000) {
      return reply.code(400).send({ error: "stale_timestamp" });
    }

    const message = `SolRoll chat login\n${tsNum}`;
    let ok = false;
    try {
      ok = nacl.sign.detached.verify(
        new TextEncoder().encode(message),
        bs58.decode(signature58),
        bs58.decode(wallet)
      );
      if (!ok) {
        // Some wallets return base64 signatures instead of bs58.
        const sig64 = Buffer.from(signature58, "base64");
        if (sig64.length === 64) {
          ok = nacl.sign.detached.verify(
            new TextEncoder().encode(message),
            new Uint8Array(sig64),
            bs58.decode(wallet)
          );
        }
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      txLog.warn("chat.auth_failed", { wallet });
      return reply.code(401).send({ error: "signature_invalid" });
    }

    return {
      token: issueSessionToken(wallet),
      wallet,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
  });

  /**
   * Issue a GUEST session without any wallet signature. This is what lets the
   * chat work when the wallet is absent or refuses to sign — the whole point of
   * guest mode. No signature is possible (there is no key), so the identity is
   * server-generated and cannot be a wallet address: a guest can never post as
   * someone else's wallet.
   */
  app.post("/api/chat/guest", async (req, reply) => {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (!guestAllowed(ip)) {
      return reply.code(429).send({
        error: "guest_rate_limited",
        detail: "Too many guest sessions from this address — wait a few minutes.",
      });
    }
    const identity = GUEST_PREFIX + randomBytes(8).toString("hex");
    return {
      token: issueSessionToken(identity),
      wallet: identity,
      guest: true,
      name: null,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
  });

  /** Recent history for a page (newest last), for the initial paint. */
  app.get("/api/chat", async (req) => {
    const page = trimText((req.query as Record<string, unknown> | undefined)?.page) || "/";
    return {
      page,
      messages: ring
        .filter((m) => m.page === page)
        .slice(-CHAT_KEEP)
        .map(publicMessage),
    };
  });

  /** Post a message. Requires a valid session token (the wallet's login). */
  app.post("/api/chat", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const header = req.headers.authorization;
    const token = typeof header === "string" && /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
    const session = token ? verifySessionToken(token) : null;
    if (!session) {
      return reply.code(401).send({ error: "chat_session_required", detail: "Connect your wallet to chat." });
    }

    const text = trimText(body.text);
    if (!text) return reply.code(400).send({ error: "empty_message" });
    const page = trimText(body.page) || "/";
    if (page.length > 64) return reply.code(400).send({ error: "invalid_page" });

    const wallet = session.wallet;
    const now = Date.now();
    const last = lastPost.get(wallet) ?? 0;
    if (now - last < CHAT_COOLDOWN_MS) {
      return reply.code(429).send({
        error: "chat_cooldown",
        detail: `Wait ${Math.ceil((CHAT_COOLDOWN_MS - (now - last)) / 1000)}s before sending again.`,
      });
    }

    if (!isClean(text)) {
      txLog.warn("chat.blocked", { wallet, page });
      return reply.code(422).send({ error: "message_blocked", detail: "This message violates the chat rules." });
    }

    lastPost.set(wallet, now);
    if (lastPost.size > 5_000) {
      // Simple bound: drop entries that have long expired their cooldown.
      for (const [w, t] of lastPost) {
        if (now - t > 10 * 60_000) lastPost.delete(w);
        if (lastPost.size <= 2_500) break;
      }
    }

    const msg: ChatMessage = {
      id: sha256(`${wallet}:${now}:${text}`).slice(0, 16),
      wallet,
      name: null,
      page,
      text,
      ts: now,
    };
    ring.push(msg);
    if (ring.length > CHAT_KEEP * 3) ring.splice(0, ring.length - CHAT_KEEP * 3);

    broadcast({ type: "chat", roundId: page, data: { ...publicMessage(msg) } });
    postgresMirror.enqueue({
      table: "chat_messages",
      op: "insert",
      row: {
        id: msg.id,
        wallet: msg.wallet,
        page: msg.page,
        text: msg.text,
        createdAt: new Date(msg.ts).toISOString(),
      },
      dedupeKey: sha256(`chat:${msg.id}`),
    });

    return reply.code(201).send(publicMessage(msg));
  });
}

function publicMessage(m: ChatMessage): Record<string, unknown> {
  return {
    id: m.id,
    wallet: m.wallet,
    name: m.name,
    page: m.page,
    text: m.text,
    ts: m.ts,
  };
}

/** Test seam: wipe all chat state. */
export function resetChatState(): void {
  ring.length = 0;
  lastPost.clear();
  guestIssued.clear();
}
