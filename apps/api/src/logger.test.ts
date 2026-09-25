/**
 * Transaction logging.
 *
 * The security requirement under test: transaction logs must be greppable
 * (one JSON line per event) AND must never contain key material — neither a
 * private key, a seed phrase nor an RPC URL credential.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { redact, safeEndpoint, txLog, isSecretField } from "./logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("secret redaction", () => {
  it("flags every secret-ish field name", () => {
    for (const key of ["secretKey", "privateKey", "private_key", "mnemonic", "seed", "keypair", "OPERATOR_KEYPAIR", "apiKey", "password"]) {
      expect(isSecretField(key)).toBe(true);
    }
  });

  it("keeps public transaction fields readable", () => {
    for (const key of ["wallet", "amountLamports", "signature", "network", "recipient", "status"]) {
      expect(isSecretField(key)).toBe(false);
    }
  });

  it("replaces secret values wherever they are nested", () => {
    const out = redact("root", {
      wallet: "JA15sbRRSJbFBZaYPuHCeBdKeVrVV8f1zQtifa3RVxsn",
      amountLamports: 1_000_000n,
      operator: { secretKey: [1, 2, 3], address: "JA15" },
      note: "mnemonic: olive tiger ...",
    }) as Record<string, unknown>;
    expect(out.wallet).toBe("JA15sbRRSJbFBZaYPuHCeBdKeVrVV8f1zQtifa3RVxsn");
    expect(out.amountLamports).toBe("1000000");
    const operator = out.operator as Record<string, unknown>;
    expect(operator.secretKey).toBe("[redacted]");
    expect(operator.address).toBe("JA15");
    // Key material embedded in free text is scrubbed too.
    expect(out.note).toBe("mnemonic: [redacted]");
    // ...and a raw 64-byte key array pasted into an error message.
    const array = redact("root", {
      error: `bad key [${Array.from({ length: 64 }, (_, i) => i).join(",")}]`,
    }) as Record<string, unknown>;
    expect(array.error).toBe("bad key [redacted]");
  });

  it("keeps transaction signatures readable (they share the base58 shape)", () => {
    const sig = "5".repeat(64);
    const out = redact("root", { signature: sig, wallet: "JA15", feeWallet: "6B9MX" }) as Record<string, unknown>;
    expect(out.signature).toBe(sig);
    expect(out.wallet).toBe("JA15");
  });
});

describe("RPC endpoint logging", () => {
  it("strips query credentials", () => {
    expect(safeEndpoint("https://rpc.example.com/v1/abc?api-key=SECRET123")).toBe(
      "https://rpc.example.com/v1/abc"
    );
  });

  it("masks a provider key embedded in the path", () => {
    const out = safeEndpoint("https://mainnet.helius-rpc.com/?api-key=9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c");
    expect(out).not.toContain("9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c");
  });

  it("never throws on garbage input", () => {
    expect(safeEndpoint(undefined)).toBe("unknown");
    expect(safeEndpoint("not a url")).toBe("invalid-url");
  });
});

describe("log lines", () => {
  it("emits exactly one JSON line with the transaction context", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    txLog.info("deposit.confirmed", {
      wallet: "JA15sbRRSJbFBZaYPuHCeBdKeVrVV8f1zQtifa3RVxsn",
      amountLamports: "100000000",
      network: "devnet",
      recipient: "4Zx2cvqL8xwGV4Y5hcEXysbJCmyiYDRBgBHdidWWvkMp",
      signature: "5".repeat(64),
      status: "CONFIRMED",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(line.event).toBe("deposit.confirmed");
    expect(line.level).toBe("info");
    expect(line.network).toBe("devnet");
    expect(line.wallet).toBe("JA15sbRRSJbFBZaYPuHCeBdKeVrVV8f1zQtifa3RVxsn");
    expect(line.signature).toBe("5".repeat(64));
  });

  it("redacts a key that a caller passes by accident", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    txLog.error("payout.send_failed", { secretKey: "5x2m...", error: "boom" });
    const line = spy.mock.calls[0]![0] as string;
    expect(line).toContain("[redacted]");
    expect(line).not.toContain("5x2m");
  });
});
