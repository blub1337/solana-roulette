/**
 * Wallet error vocabulary — unit tests.
 *
 * The patterns below are the shapes the wallet adapter stack actually throws
 * (`@solana/wallet-adapter-base` wraps every provider failure in
 * WalletSendTransactionError / WalletSignTransactionError with the provider
 * error as `cause`), plus the provider `cluster`/`chainId` shapes of Phantom,
 * Solflare and the MultiChain namespace spec.
 */
import { describe, it, expect } from "vitest";
import {
  classifyWalletError,
  walletErrorMessage,
  friendlyWalletError,
  detectWalletCluster,
  probeWalletClusterMismatch,
  reportWalletError,
  clearWalletError,
  getWalletError,
  subscribeWalletError,
  useWalletError as _useWalletError,
} from "./walletErrors.js";
void _useWalletError; // hook itself is exercised via the banner + manual flow

/** wallet-adapter-style: new Error with the provider error as cause. */
function wrapped(inner: unknown, name = "WalletSendTransactionError"): Error {
  const e = new Error(name, { cause: inner });
  e.name = name;
  return e;
}

describe("classifyWalletError", () => {
  it("classifies a code-4001 user rejection through the cause chain", () => {
    const inner = new Error("User rejected the request.");
    inner.name = "WalletSignTransactionError";
    (inner as { code?: number }).code = 4001;
    expect(classifyWalletError(wrapped(inner))).toBe("rejected_by_user");
  });

  it("classifies a plain user rejection without a code", () => {
    expect(classifyWalletError(new Error("User rejected the request."))).toBe("rejected_by_user");
    expect(classifyWalletError(new Error("WalletSignTransactionError: User denied transaction signature"))).toBe(
      "rejected_by_user"
    );
  });

  it("sees the real cause through the adapter wrapper (blockhash expiry)", () => {
    const rpc = new Error("Blockhash not found");
    rpc.name = "SendTransactionError";
    expect(classifyWalletError(wrapped(rpc))).toBe("blockhash_expired");
    expect(
      classifyWalletError(wrapped(new Error("Block height exceeded"), "WalletSendTransactionError"))
    ).toBe("blockhash_expired");
  });

  it("classifies insufficient balance from the System Program debit error", () => {
    expect(
      classifyWalletError(
        wrapped(new Error("failed to send transaction: Attempt to debit an account but found no record of prior credit."))
      )
    ).toBe("insufficient_devnet_balance");
  });

  it("classifies wallet-disconnected and not-installed failures", () => {
    expect(classifyWalletError(new Error("Wallet is disconnected"))).toBe("wallet_disconnected");
    expect(classifyWalletError(new Error("WalletNotConnectedError"))).toBe("wallet_disconnected");
    expect(classifyWalletError(new Error("Phantom is not registered as a wallet"))).toBe("wallet_not_found");
  });

  it("classifies RPC/network failures", () => {
    expect(classifyWalletError(new Error("fetch failed"))).toBe("rpc_unreachable");
    expect(classifyWalletError(new Error("Transaction failed with 429"))).toBe("rpc_unreachable");
  });

  it("maps unknown errors to unknown_error and handles non-errors", () => {
    expect(classifyWalletError(new Error("something exploded"))).toBe("unknown_error");
    expect(classifyWalletError("just a string")).toBe("unknown_error");
    expect(classifyWalletError(null)).toBe("unknown_error");
    expect(classifyWalletError(undefined)).toBe("unknown_error");
  });
});

describe("walletErrorMessage / friendlyWalletError", () => {
  it("maps every reason to an honest, actionable sentence", () => {
    for (const reason of [
      "rejected_by_user",
      "wrong_cluster",
      "blockhash_expired",
      "insufficient_devnet_balance",
      "wallet_disconnected",
      "wallet_not_found",
      "rpc_unreachable",
      "unknown_error",
    ] as const) {
      const msg = walletErrorMessage(reason);
      expect(msg.length).toBeGreaterThan(20);
      expect(msg).not.toMatch(/\bundefined\b/);
    }
  });

  it("tells the player to switch to Devnet for network problems", () => {
    expect(walletErrorMessage("wrong_cluster")).toMatch(/Devnet/);
    expect(walletErrorMessage("blockhash_expired")).toMatch(/Devnet/);
    expect(walletErrorMessage("insufficient_devnet_balance")).toMatch(/faucet/i);
  });

  it("friendlyWalletError classifies and formats in one step", () => {
    expect(friendlyWalletError(new Error("User rejected the request."))).toBe(
      walletErrorMessage("rejected_by_user")
    );
  });
});

describe("detectWalletCluster / probeWalletClusterMismatch", () => {
  it("reads the provider cluster of Phantom/Solflare-style providers", () => {
    expect(detectWalletCluster({ cluster: "mainnet-beta" })).toBe("mainnet-beta");
    expect(detectWalletCluster({ cluster: "devnet" })).toBe("devnet");
  });

  it("reads the MultiChain chainId and endpoint fallbacks", () => {
    expect(detectWalletCluster({ chainId: "solana:devnet" })).toBe("solana:devnet");
    expect(detectWalletCluster({ rpcUrl: "https://api.mainnet-beta.solana.com" })).toBe(
      "https://api.mainnet-beta.solana.com"
    );
  });

  it("returns null for providers that do not advertise a cluster", () => {
    expect(detectWalletCluster({})).toBeNull();
    expect(detectWalletCluster(null)).toBeNull();
    expect(detectWalletCluster("solana")).toBeNull();
  });

  it("flags a MAINNET wallet against the devnet app and accepts a devnet one", () => {
    expect(probeWalletClusterMismatch({ cluster: "mainnet-beta" }).mismatch).toBe(true);
    expect(probeWalletClusterMismatch({ cluster: "devnet" }).mismatch).toBe(false);
    expect(probeWalletClusterMismatch({ chainId: "solana:mainnet-beta" }).mismatch).toBe(true);
    expect(probeWalletClusterMismatch({ rpcUrl: "https://api.mainnet-beta.solana.com" }).mismatch).toBe(true);
  });

  it("never blocks a wallet that does not report its cluster (fail-open, verified server-side)", () => {
    expect(probeWalletClusterMismatch({}).mismatch).toBe(false);
    expect(probeWalletClusterMismatch({}).walletCluster).toBeNull();
  });
});

describe("global wallet error pubsub", () => {
  it("stores the latest adapter error for subscribers and clears it", () => {
    clearWalletError();
    reportWalletError(new Error("User rejected the request."));
    const state = getWalletError();
    expect(state).not.toBeNull();
    expect(state!.message).toBe(walletErrorMessage("rejected_by_user"));
    expect(typeof state!.at).toBe("number");

    // A newer error replaces the older one.
    reportWalletError(new Error("fetch failed"));
    expect(getWalletError()!.message).toBe(walletErrorMessage("rpc_unreachable"));

    clearWalletError();
    expect(getWalletError()).toBeNull();
  });

  it("notifies and releases subscribers on report/clear", () => {
    let notifications = 0;
    const unsub = subscribeWalletError(() => notifications++);
    reportWalletError(new Error("Wallet is disconnected"));
    clearWalletError();
    expect(notifications).toBe(2);
    unsub();
    reportWalletError(new Error("fetch failed"));
    expect(notifications).toBe(2); // unsubscribed
    clearWalletError();
  });

  it("stays importable from node (no window access at module scope)", () => {
    // Importing the module in the node test env is itself the assertion.
    expect(typeof reportWalletError).toBe("function");
  });
});
