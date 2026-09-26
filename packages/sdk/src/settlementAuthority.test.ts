/**
 * B2: the settlement instructions are permissionless, and the client must
 * therefore build them correctly for an ARBITRARY signer.
 *
 * Two failure modes this guards, both of which are compile-safe and would
 * otherwise only surface on-chain:
 *
 * 1. Account-list drift. `settle_round` takes the SlotHashes sysvar at a fixed
 *    index. If the client and program disagree, settlement reverts for everyone
 *    — and now that anyone can settle, a mistake here is a public DoS on
 *    payouts rather than something only the operator could hit.
 * 2. Accidental re-privileging. If a builder starts pinning the payer to the
 *    configured operator, the operator stall point comes straight back.
 */
import { describe, expect, it } from "vitest";
import { PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import { SLOT_HASHES_SYSVAR, lockRoundIx, payWinnersIx, settleRoundIx } from "./instructions.js";
import { configPda, escrowPda, roundPda } from "./pda.js";

const PROGRAM = new PublicKey("F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos");
const ROUND_ID = 7n;
const TREASURY = new PublicKey("6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR");
const PAYER = new PublicKey("FgEPpAmLLiod4RyBhUcLdvpzPGiBdotoEawyPqyftg1q");
const WINNER = new PublicKey("8TiPL8yJkNzo6o7227fQjtwcbLbJFs6kLVpc1oqNRGyP");
const P1 = new PublicKey("2h3gwYGLc6nxCnPdnNwgKvcnd66XuGzKEnfrxB7LEZsf");
const P2 = new PublicKey("DPWfmGXh1kW3kCqoTQwufVXEw7L1esbRK9JE4y44Ww5L");

/** An arbitrary, unrelated wallet — stands in for "any third party". */
const STRANGER = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");

describe("permissionless settlement — account layout", () => {
  it("lock_round places payer last, as the only signer", () => {
    const ix = lockRoundIx(PROGRAM, PAYER, ROUND_ID);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      configPda(PROGRAM).toBase58(),
      roundPda(PROGRAM, ROUND_ID).toBase58(),
      escrowPda(PROGRAM, roundPda(PROGRAM, ROUND_ID)).toBase58(),
      PAYER.toBase58(),
    ]);
    expect(ix.keys.filter((k) => k.isSigner)).toHaveLength(1);
  });

  it("settle_round passes the REAL SlotHashes sysvar at index 5", () => {
    // This is the security-critical index. The program pins this slot to
    // `sysvar::slot_hashes::ID`; a forged account here would be a rejected tx
    // (and, before the pin, a winner-picking exploit).
    expect(SLOT_HASHES_SYSVAR.toBase58()).toBe(SYSVAR_SLOT_HASHES_PUBKEY.toBase58());

    const ix = settleRoundIx(PROGRAM, PAYER, ROUND_ID, TREASURY, [P1, P2]);
    expect(ix.keys[5]!.pubkey.toBase58()).toBe(SYSVAR_SLOT_HASHES_PUBKEY.toBase58());
    expect(ix.keys[6]!.pubkey.toBase58()).toBe(SystemProgram.programId.toBase58());
    // Participants trail, in index order, as read-only extras.
    expect(ix.keys.slice(7).map((k) => k.pubkey.toBase58())).toEqual([P1.toBase58(), P2.toBase58()]);
    expect(ix.keys.filter((k) => k.isSigner)).toHaveLength(1);
  });

  it("pay_winners sends the frozen winner and treasury, payer last", () => {
    const ix = payWinnersIx(PROGRAM, PAYER, ROUND_ID, WINNER, TREASURY);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      configPda(PROGRAM).toBase58(),
      roundPda(PROGRAM, ROUND_ID).toBase58(),
      escrowPda(PROGRAM, roundPda(PROGRAM, ROUND_ID)).toBase58(),
      WINNER.toBase58(),
      TREASURY.toBase58(),
      PAYER.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    expect(ix.keys.filter((k) => k.isSigner)).toHaveLength(1);
  });
});

describe("permissionless settlement — no operator privilege", () => {
  it("builds identical instructions for the operator and for a stranger", () => {
    // The operator is NOT special-cased anywhere in the encoding. If a future
    // edit starts treating the payer as privileged, these diverge and this
    // fails — which is exactly the regression that would restore the DoS.
    const byOperator = settleRoundIx(PROGRAM, PAYER, ROUND_ID, TREASURY, [P1, P2]);
    const byStranger = settleRoundIx(PROGRAM, STRANGER, ROUND_ID, TREASURY, [P1, P2]);

    expect(byOperator.keys.length).toBe(byStranger.keys.length);
    expect(byStranger.keys[4]!.pubkey.toBase58()).toBe(STRANGER.toBase58());
    // Everything except the payer slot is byte-identical.
    for (let i = 0; i < byOperator.keys.length; i++) {
      if (i === 4) continue;
      expect(byStranger.keys[i]!.pubkey.toBase58()).toBe(byOperator.keys[i]!.pubkey.toBase58());
      expect(byStranger.keys[i]!.isWritable).toBe(byOperator.keys[i]!.isWritable);
    }
    expect(Buffer.from(byStranger.data).toString("hex")).toBe(
      Buffer.from(byOperator.data).toString("hex")
    );
  });

  it("never embeds an authority or a payout amount in the instruction data", () => {
    // All three instructions are argument-free, so a third party cannot smuggle
    // a different winner, treasury or lamport amount in through the payload.
    for (const ix of [
      lockRoundIx(PROGRAM, STRANGER, ROUND_ID),
      settleRoundIx(PROGRAM, STRANGER, ROUND_ID, TREASURY, [P1]),
      payWinnersIx(PROGRAM, STRANGER, ROUND_ID, WINNER, TREASURY),
    ]) {
      // Anchor instruction discriminator only (8 bytes, no args).
      expect(ix.data.length).toBe(8);
    }
  });
});
