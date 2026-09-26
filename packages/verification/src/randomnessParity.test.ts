/**
 * Three-way parity: RUST PROGRAM == NODE SERVER == BROWSER.
 *
 * The Rust side (programs/roulette/src/winner.rs::derive_randomness) cannot run
 * in this repo's vitest run, so it is pinned by SHARED FIXTURE VECTORS:
 * `fixtures/randomness-parity.json` carries an `on-chain` vector read straight
 * off the devnet RPC from a Round account AFTER the deployed program's
 * `settle_round` ran, plus synthetic edge cases. The Anchor test
 * `programs/roulette/tests/randomness_parity.rs` reads the SAME file, so the
 * two implementations cannot drift without one side failing.
 *
 * The on-chain vector is what makes this meaningful: it pins both TypeScript
 * twins to what the DEPLOYED PROGRAM actually computed, not merely to the
 * documented formula.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { deriveRandomness as deriveNode } from "./winner.js";
import { deriveRandomness as deriveBrowser } from "./winner.browser.js";

interface Vector {
  label: string;
  source: "on-chain" | "synthetic";
  roundId: number | string;
  revealInputHex: string;
  randomnessHex: string;
}

/**
 * The fixture lives as JSON so the Rust test can `include_str!` it. Resolve it
 * by candidate path rather than `import.meta` (not permitted under this
 * package's CommonJS tsconfig) or `__dirname` (absent under vitest's ESM).
 */
function loadFixture(): { formula: string; vectors: Vector[] } {
  const candidates = [
    "packages/verification/src/fixtures/randomness-parity.json", // vitest: repo-root cwd
    "src/fixtures/randomness-parity.json", // run from inside the package
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`parity fixture not found; looked in: ${candidates.join(", ")}`);
}

const fixture = loadFixture();

const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, "hex"));

describe("entropy derivation parity (Rust program == Node == browser)", () => {
  it("ships a fixture with an on-chain vector pinned to the deployed program", () => {
    const onChain = fixture.vectors.filter((v) => v.source === "on-chain");
    expect(onChain.length).toBeGreaterThanOrEqual(1);
    for (const v of onChain) {
      expect(v.revealInputHex).toMatch(/^[0-9a-f]{64}$/);
      expect(v.randomnessHex).toMatch(/^[0-9a-f]{64}$/);
      // Never all-zero: a zero input would make the assertion vacuous.
      expect(v.revealInputHex).not.toBe("0".repeat(64));
    }
  });

  it.each(fixture.vectors.map((v) => [v.label, v] as const))(
    "node twin matches the fixture — %s",
    (_label, v) => {
      const got = Buffer.from(deriveNode(fromHex(v.revealInputHex), BigInt(v.roundId))).toString("hex");
      expect(got).toBe(v.randomnessHex);
    }
  );

  it.each(fixture.vectors.map((v) => [v.label, v] as const))(
    "browser twin matches the fixture — %s",
    async (_label, v) => {
      const got = Buffer.from(await deriveBrowser(fromHex(v.revealInputHex), BigInt(v.roundId))).toString("hex");
      expect(got).toBe(v.randomnessHex);
    }
  );

  it.each(fixture.vectors.map((v) => [v.label, v] as const))(
    "node and browser twins are byte-identical — %s",
    async (_label, v) => {
      const a = deriveNode(fromHex(v.revealInputHex), BigInt(v.roundId));
      const b = await deriveBrowser(fromHex(v.revealInputHex), BigInt(v.roundId));
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    }
  );

  it("round id is hashed little-endian, so byte-swapped ids must NOT collide", async () => {
    const input = new Uint8Array(32).fill(7);
    const le1 = Buffer.from(deriveNode(input, 1n)).toString("hex");
    const le256 = Buffer.from(deriveNode(input, 256n)).toString("hex");
    expect(le1).not.toBe(le256);
    // 1 LE = 01 00 …, 256 LE = 00 01 … — a big-endian impl would swap these.
    const swapped = Buffer.from(deriveNode(input, 0x0100n)).toString("hex");
    expect(swapped).toBe(le256);
  });
});
