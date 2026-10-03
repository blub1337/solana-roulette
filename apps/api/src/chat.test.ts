import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import { resetChatState, isClean, isGuestId } from "./chat.js";

/** Sign exactly like the browser wallet would. */
function signLoginMessage(wallet: Keypair, ts: number): Uint8Array {
  // Solana Keypair.secretKey is seed‖pub; ed25519 signs with the 32-byte seed.
  return ed25519.sign(new TextEncoder().encode(`SolRoll chat login\n${ts}`), wallet.secretKey.slice(0, 32));
}

const OPERATOR = Keypair.generate();
const OPERATOR_KEYPAIR_ENV = JSON.stringify([...OPERATOR.secretKey]);
const FEE_WALLET = Keypair.generate().publicKey;
const PROGRAM_ID = Keypair.generate().publicKey;
const connection = {
  getLatestBlockhash: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }),
} as unknown as Connection;

const ENV_KEYS = [
  "LEDGER_MODE",
  "PLATFORM_FEE_WALLET",
  "OPERATOR_KEYPAIR",
  "DATABASE_URL",
  "ADMIN_TOKEN",
  "DEPOSITS_PAUSED",
  "PREVIEW_UI_URL",
  "CHAT_SESSION_SECRET",
] as const;
let saved: Partial<Record<string, string | undefined>> = {};
let app: FastifyInstance;

beforeAll(async () => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.LEDGER_MODE = "local";
  process.env.PLATFORM_FEE_WALLET = FEE_WALLET.toBase58();
  process.env.TIER_CAPS_SOL = "1,10,100";
  process.env.OPERATOR_KEYPAIR = OPERATOR_KEYPAIR_ENV;
  process.env.CHAT_SESSION_SECRET = "test-secret";

  app = await buildServer({ connection, programId: PROGRAM_ID, backend: undefined });
  await app.ready();
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await app.close();
});

/** Real ed25519 login flow: sign the exact auth message with a fresh wallet. */
async function makeSession(wallet: Keypair): Promise<string> {
  const ts = Date.now();
  const sig = signLoginMessage(wallet, ts);
  const res = await app.inject({
    method: "POST",
    url: "/api/chat/auth",
    payload: { wallet: wallet.publicKey.toBase58(), signature: bs58.encode(sig), ts },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { token: string }).token;
}

beforeEach(() => resetChatState());

describe("chat auth", () => {
  it("issues a session token for a valid wallet signature", async () => {
    const token = await makeSession(Keypair.generate());
    expect(token.split(".").length).toBe(3);
  });

  it("rejects a signature that does not match the wallet", async () => {
    const signer = Keypair.generate();
    const imposter = Keypair.generate();
    const ts = Date.now();
    const sig = signLoginMessage(signer, ts);
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/auth",
      payload: { wallet: imposter.publicKey.toBase58(), signature: bs58.encode(sig), ts },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a stale timestamp (replay window ±10min)", async () => {
    const wallet = Keypair.generate();
    const ts = Date.now() - 11 * 60_000;
    const sig = signLoginMessage(wallet, ts);
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/auth",
      payload: { wallet: wallet.publicKey.toBase58(), signature: bs58.encode(sig), ts },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed wallet", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat/auth",
      payload: { wallet: "not-a-wallet", signature: "x", ts: Date.now() },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("posting", () => {
  it("refuses to post without a session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { text: "hallo", page: "/" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("posts with a session and returns the public message", async () => {
    const wallet = Keypair.generate();
    const token = await makeSession(wallet);
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "gg wp", page: "/" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { wallet: string; text: string; page: string };
    expect(body.wallet).toBe(wallet.publicKey.toBase58());
    expect(body.text).toBe("gg wp");
    expect(body.page).toBe("/");
  });

  it("serves the message back via GET /api/chat?page=", async () => {
    const token = await makeSession(Keypair.generate());
    await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "pool talk", page: "/pool/0" },
    });
    const res = await app.inject({ method: "GET", url: "/api/chat?page=%2Fpool%2F0" });
    const body = res.json() as { page: string; messages: Array<{ text: string }> };
    expect(body.page).toBe("/pool/0");
    expect(body.messages.map((m) => m.text)).toContain("pool talk");
  });

  it("enforces the per-wallet cooldown", async () => {
    const token = await makeSession(Keypair.generate());
    const post = (text: string) =>
      app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { authorization: `Bearer ${token}` },
        payload: { text, page: "/" },
      });
    expect((await post("first")).statusCode).toBe(201);
    expect((await post("second")).statusCode).toBe(429);
  });

  it("blocks slurs and trims/whitespace-collapses long input", async () => {
    const token = await makeSession(Keypair.generate());
    const blocked = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "heil hitler", page: "/" },
    });
    expect(blocked.statusCode).toBe(422);

    // The failed attempt must not consume the cooldown for the next wallet —
    // use a fresh session here (same wallet would still be within cooldown is
    // fine, since the blocked attempt consumed one; new wallet is clean).
    const token2 = await makeSession(Keypair.generate());
    const messy = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${token2}` },
      payload: { text: "  a\t\nb   c  ", page: "/" },
    });
    expect(messy.statusCode).toBe(201);
    expect((messy.json() as { text: string }).text).toBe("a b c");
  });

  it("keeps per-page history separate", async () => {
    const token = await makeSession(Keypair.generate());
    await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "lobby msg", page: "/" },
    });
    const other = await app.inject({ method: "GET", url: "/api/chat?page=%2Fpool%2F2" });
    expect((other.json() as { messages: unknown[] }).messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Guest mode: a wallet signature is the STRONG login, never a REQUIREMENT.
// Wallets without signMessage — or a rejected popup — must still be able to
// chat, with a server-issued guest identity that can never be a wallet address.
// ---------------------------------------------------------------------------
describe("guest sessions (no wallet signature)", () => {
  async function guestSession(): Promise<{ token: string; wallet: string }> {
    const res = await app.inject({ method: "POST", url: "/api/chat/guest" });
    expect(res.statusCode).toBe(200);
    return res.json() as { token: string; wallet: string };
  }

  it("issues a signed guest token with a server-generated identity, no signature needed", async () => {
    const { token, wallet } = await guestSession();
    expect(token.split(".").length).toBe(3);
    expect(isGuestId(wallet)).toBe(true);
    expect(wallet).toMatch(/^g_[0-9a-f]{16}$/);
  });

  it("posts a message as a guest and reports the guest identity", async () => {
    const { token, wallet } = await guestSession();
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "gm from a guest", page: "/" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { wallet: string; text: string };
    expect(body.wallet).toBe(wallet);
    expect(isGuestId(body.wallet)).toBe(true);
    expect(body.text).toBe("gm from a guest");
  });

  it("enforces the cooldown per guest identity too", async () => {
    const { token } = await guestSession();
    const post = () =>
      app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { authorization: `Bearer ${token}` },
        payload: { text: "hi", page: "/" },
      });
    expect((await post()).statusCode).toBe(201);
    expect((await post()).statusCode).toBe(429);
  });

  it("caps guest-session minting per IP so ids cannot be rotated endlessly", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: "POST", url: "/api/chat/guest" });
      expect(res.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "POST", url: "/api/chat/guest" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ error: string }>().error).toBe("guest_rate_limited");
  });

  it("rejects a forged guest token (HMAC is required)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      headers: { authorization: "Bearer g_deadbeefdeadbeef.12345.notarealmac" },
      payload: { text: "spoof", page: "/" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("isClean (pre-moderation)", () => {
  it("flags blocked terms case-insensitively", () => {
    expect(isClean("HEIL HITLER")).toBe(false);
    expect(isClean("gute Runde")).toBe(true);
  });
});
