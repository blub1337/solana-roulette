/**
 * DEVNET custody: the real on-chain side of the money flow.
 *
 * While the Anchor program is not deployed on devnet, the round escrow is a
 * plain devnet System account (`DEPOSIT_ESCROW_WALLET`, or the operator
 * wallet's own address). Players transfer real DEVNET SOL into it and the
 * server pays real DEVNET SOL back out of it. The chain is therefore always
 * the source of truth for both directions:
 *
 *   PLAYER WALLET ──sign──▶ SystemProgram.transfer ──▶ DEPOSIT ESCROW
 *   DEPOSIT ESCROW ──server sign──▶ SystemProgram.transfer ──▶ WINNER + FEE
 *
 * SECURITY: the payout signer is loaded from OPERATOR_KEYPAIR (an env secret)
 * and is NEVER serialized. `describeCustody()` is the only shape that leaves
 * this module and it contains public keys and booleans only.
 */
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import type { AppConfig } from "@solana-roulette/config";
import { loadOperatorKeypair } from "./keypair.js";
import { safeEndpoint, txLog } from "./logger.js";

/** Explorer links are ALWAYS devnet-cluster links. */
export const DEVNET_EXPLORER_TX = (signature: string): string =>
  `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
export const DEVNET_EXPLORER_ADDRESS = (address: string): string =>
  `https://explorer.solana.com/address/${address}?cluster=devnet`;
/** Official devnet faucet (web UI) — the in-app airdrop uses the RPC instead. */
export const DEVNET_FAUCET_URL = "https://faucet.solana.com";

/** lamports reserved for the fee payer's own rent/exec overhead. */
export const TX_FEE_BUFFER_LAMPORTS = 10_000n;

export class MainnetCustodyDisabledError extends Error {
  constructor() {
    super(
      "Custody is DEVNET ONLY: SolRoll refuses to move funds on mainnet-beta."
    );
    this.name = "MainnetCustodyDisabledError";
  }
}

export class CustodyNotReadyError extends Error {
  constructor(readonly reason: string) {
    super(`Solana custody is not ready: ${reason}`);
    this.name = "CustodyNotReadyError";
  }
}

export interface Custody {
  /** Always "devnet" — mainnet is refused at resolve time. */
  readonly network: "devnet";
  readonly cluster: "devnet";
  readonly rpcUrl: string;
  /** System account that receives player deposits. */
  readonly escrow: PublicKey | null;
  /** Receives the 2% platform fee of every settled round. */
  readonly feeWallet: PublicKey;
  /** Server-side payout signer. Secret: never serialized, never sent to a client. */
  readonly signer: Keypair | null;
  readonly signerAddress: string | null;
  /** True when deposits can be credited and payouts can be sent for real. */
  readonly ready: boolean;
  readonly reason: string;
}

export function resolveCustody(
  cfg: Pick<AppConfig, "network" | "rpcUrl" | "platformFeeWallet" | "treasuryPubkey" | "operatorKeypairJson" | "depositEscrowWallet">
): Custody {
  if (cfg.network !== "devnet") throw new MainnetCustodyDisabledError();

  const signer = loadOperatorKeypair(cfg.operatorKeypairJson);
  const feeWallet = toPublicKey(cfg.platformFeeWallet ?? cfg.treasuryPubkey);
  if (!feeWallet) throw new CustodyNotReadyError("PLATFORM_FEE_WALLET is missing or not a valid pubkey");

  // The escrow defaults to the operator wallet so that the SAME account
  // receives deposits and funds payouts. It is a plain System account: no PDA,
  // no program required.
  const escrow = toPublicKey(cfg.depositEscrowWallet) ?? signer?.publicKey ?? null;
  if (!escrow) {
    return {
      network: "devnet",
      cluster: "devnet",
      rpcUrl: cfg.rpcUrl,
      escrow: null,
      feeWallet,
      signer: null,
      signerAddress: null,
      ready: false,
      reason:
        "no deposit escrow: set DEPOSIT_ESCROW_WALLET (public address) or OPERATOR_KEYPAIR (server secret)",
    };
  }
  if (escrow.equals(feeWallet)) {
    return {
      network: "devnet",
      cluster: "devnet",
      rpcUrl: cfg.rpcUrl,
      escrow,
      feeWallet,
      signer,
      signerAddress: signer?.publicKey.toBase58() ?? null,
      ready: false,
      reason: "refusing to run: DEPOSIT_ESCROW_WALLET must not be the platform fee wallet",
    };
  }
  if (!signer) {
    return {
      network: "devnet",
      cluster: "devnet",
      rpcUrl: cfg.rpcUrl,
      escrow,
      feeWallet,
      signer: null,
      signerAddress: null,
      ready: false,
      reason: "no payout signer: set OPERATOR_KEYPAIR in the server environment (never in the browser)",
    };
  }
  // Deposits land in `escrow`, payouts are signed by `signer`. Two different
  // accounts would mean the pot sits in an address the platform cannot spend
  // and every winner is paid out of the operator's own balance — refuse it.
  if (!escrow.equals(signer.publicKey)) {
    return {
      network: "devnet",
      cluster: "devnet",
      rpcUrl: cfg.rpcUrl,
      escrow,
      feeWallet,
      signer,
      signerAddress: signer.publicKey.toBase58(),
      ready: false,
      reason:
        "DEPOSIT_ESCROW_WALLET must be the public address of OPERATOR_KEYPAIR " +
        "(deposits and payouts use the same devnet account)",
    };
  }

  const custody: Custody = {
    network: "devnet",
    cluster: "devnet",
    rpcUrl: cfg.rpcUrl,
    escrow,
    feeWallet,
    signer,
    signerAddress: signer.publicKey.toBase58(),
    ready: true,
    reason: "devnet escrow + server-side signer configured",
  };
  txLog.info("custody.ready", {
    network: custody.cluster,
    rpc: safeEndpoint(custody.rpcUrl),
    escrow: custody.escrow?.toBase58() ?? null,
    feeWallet: custody.feeWallet.toBase58(),
    signer: custody.signerAddress,
  });
  return custody;
}

function toPublicKey(raw: string | undefined | null): PublicKey | null {
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    return null;
  }
}

export function requireCustody(custody: Custody): Custody {
  if (!custody.ready || !custody.escrow) throw new CustodyNotReadyError(custody.reason);
  return custody;
}

/** Public, secret-free description for GET /api/config and the devnet badge. */
export function describeCustody(custody: Custody): Record<string, unknown> {
  return {
    network: custody.cluster,
    cluster: custody.cluster,
    rpcUrl: safeEndpoint(custody.rpcUrl),
    escrow: custody.escrow?.toBase58() ?? null,
    feeWallet: custody.feeWallet.toBase58(),
    payoutSignerConfigured: custody.signer !== null,
    /** Public address of the payout signer — never any key material. */
    payoutSigner: custody.signerAddress,
    custodyReady: custody.ready,
    custodyReason: custody.reason,
    explorerTxBase: "https://explorer.solana.com/tx/",
    explorerAddressBase: "https://explorer.solana.com/address/",
    faucetUrl: DEVNET_FAUCET_URL,
  };
}

/** Confirmed lamport balance of the deposit escrow (0 when not configured). */
export async function escrowBalanceLamports(
  connection: Connection,
  custody: Custody
): Promise<bigint> {
  if (!custody.escrow) return 0n;
  const lamports = await connection.getBalance(custody.escrow, "confirmed");
  return BigInt(lamports);
}

// ---------------------------------------------------------------------------
// devnet faucet (rate limited per wallet, devnet only)
// ---------------------------------------------------------------------------

const AIRDROP_LAMPORTS = 1_000_000_000n; // 1 devnet SOL
const AIRDROP_COOLDOWN_MS = 60_000;
const lastAirdrop = new Map<string, number>();

export interface AirdropResult {
  ok: boolean;
  signature?: string;
  error?: string;
}

/**
 * Request 1 devnet SOL for a wallet through the cluster faucet. The public
 * faucet is rate limited per IP, so failures are reported, never faked, and
 * the UI always offers the faucet website as the fallback.
 */
export async function requestDevnetAirdrop(
  connection: Connection,
  wallet: PublicKey
): Promise<AirdropResult> {
  const key = wallet.toBase58();
  const previous = lastAirdrop.get(key) ?? 0;
  const now = Date.now();
  if (now - previous < AIRDROP_COOLDOWN_MS) {
    return { ok: false, error: "airdrop rate limited: retry in a minute" };
  }
  lastAirdrop.set(key, now);
  try {
    const signature = await connection.requestAirdrop(wallet, Number(AIRDROP_LAMPORTS));
    txLog.info("airdrop.requested", {
      network: "devnet",
      wallet: key,
      lamports: AIRDROP_LAMPORTS.toString(),
      signature,
    });
    return { ok: true, signature };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    txLog.warn("airdrop.failed", { network: "devnet", wallet: key, error });
    return { ok: false, error };
  }
}
