import { describe, it, expect } from "vitest";
import { decodeRound, ROUND_SPACE, LEGACY_ROUND_SPACE, REVEAL_INPUT_OFFSET } from "./accounts.js";

/**
 * A minimal valid Round buffer: the 8-byte discriminator is opaque to the
 * decoder, and the status byte sits immediately after it (offset 8). Every
 * remaining field stays zero, which decodes to defaults.
 */
function roundBytes(size: number, statusByte = 0): Uint8Array {
  const b = new Uint8Array(size);
  b[8] = statusByte; // status = RoundStatus::Open
  return b;
}

describe("decodeRound legacy detection", () => {
  it("flags a pre-reveal_input account as legacy", () => {
    // Rounds created before reveal_input was appended are 225 bytes. The
    // deployed program CANNOT deserialize them (deposit/lock/settle all revert
    // with AccountDidNotDeserialize, error 3003), so callers must not treat
    // one as a usable current round.
    const r = decodeRound(roundBytes(LEGACY_ROUND_SPACE));
    expect(r.legacy).toBe(true);
    // Readable anyway, with an all-zero reveal_input so history still works.
    expect(r.status).toBe("OPEN");
    expect(r.revealInput).toEqual(new Uint8Array(32));
  });

  it("flags a current-layout account as not legacy", () => {
    const r = decodeRound(roundBytes(ROUND_SPACE));
    expect(r.legacy).toBe(false);
  });

  it("reads reveal_input from a current-layout account", () => {
    const b = roundBytes(ROUND_SPACE);
    b[REVEAL_INPUT_OFFSET] = 0x2a;
    expect(decodeRound(b).revealInput[0]).toBe(0x2a);
  });
});
