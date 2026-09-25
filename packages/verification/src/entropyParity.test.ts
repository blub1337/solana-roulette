/**
 * Parity tests for the environment-specific entropy twins.
 *
 * The winnerCore split (winner.ts = node:crypto sync, winner.browser.ts =
 * WebCrypto async) is only sound if both deriveRandomness implementations
 * produce byte-identical output — and both must match the Rust program
 * (programs/roulette/src/winner.rs, derive_randomness). The WebCrypto path
 * runs under Node's global crypto (Node 18+).
 */
import { describe, it, expect } from "vitest";
import { deriveRandomness as deriveRandomnessNode } from "./winner.js";
import { deriveRandomness as deriveRandomnessBrowser } from "./winner.browser.js";

describe("deriveRandomness parity (node vs browser)", () => {
  it("produces byte-identical output across random inputs", async () => {
    for (let i = 0; i < 32; i++) {
      const blockhash = new Uint8Array(32);
      crypto.getRandomValues(blockhash);
      const roundId = BigInt(i + 1) * 7n + 3n;
      const node = deriveRandomnessNode(blockhash, roundId);
      const browser = await deriveRandomnessBrowser(blockhash, roundId);
      expect(node.length).toBe(32);
      expect(browser.length).toBe(32);
      expect(Buffer.from(node).equals(Buffer.from(browser))).toBe(true);
    }
  });

  it("matches the Rust program format: SHA256(b\"roulette:reveal\" ‖ round_id_le_u64 ‖ blockhash)", async () => {
    const blockhash = new Uint8Array(32).fill(0xab);
    const roundId = 42n;
    const out = await deriveRandomnessBrowser(blockhash, roundId);

    // Independent recomputation with node:crypto (byte-for-byte Rust layout:
    // 15-byte tag, 8-byte round_id LE, 32-byte blockhash).
    const { createHash } = await import("node:crypto");
    const idBuf = Buffer.alloc(8);
    idBuf.writeBigUInt64LE(roundId);
    const digest = createHash("sha256")
      .update(Buffer.from("roulette:reveal", "utf8"))
      .update(idBuf)
      .update(Buffer.from(blockhash))
      .digest();
    expect(Buffer.from(out).equals(digest)).toBe(true);
  });

  it("is deterministic for identical inputs (both twins)", async () => {
    const blockhash = new Uint8Array(32);
    crypto.getRandomValues(blockhash);
    const a = deriveRandomnessNode(blockhash, 7n);
    const b = deriveRandomnessNode(blockhash, 7n);
    const c = await deriveRandomnessBrowser(blockhash, 7n);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(true);
  });
});
