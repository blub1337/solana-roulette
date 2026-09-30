"use client";

/**
 * REAL devnet deposits from the player's wallet.
 *
 * Two paths, chosen by the API's runtime mode (/api/health):
 *
 *  - "chain" (the deployed Anchor program): the player signs the PROGRAM's
 *    `deposit` instruction. The instruction itself moves the lamports into the
 *    round escrow PDA AND writes the Participant PDA, advancing round.pot and
 *    participant_count on chain — so a round can reach FULL from web deposits
 *    alone and every lamport stays reachable by pay_winners. The server then
 *    re-reads the transaction and the created Participant PDA from the chain
 *    before marking the entry credited (the client's word is never enough).
 *
 *  - "local" (in-memory ledger runtime): a plain SystemProgram.transfer into
 *    the custody escrow, verified server-side, credited by the ledger.
 *
 * Either way:
 *   1. assert the wallet is on Solana DEVNET (cluster + RPC endpoint)
 *   2. assert the wallet actually holds enough DEVNET SOL
 *   3. ask the API for a PENDING deposit intent (escrow address, amount)
 *   4. build the transaction, simulate it, sign it in the player's wallet
 *      (the normal wallet prompt — nothing is ever simulated for real)
 *   5. send it to the devnet RPC and wait for confirmation
 *   6. report the signature; the server re-reads the chain and only then
 *      credits the entry
 *
 * A rejected signature, a failed transaction or a timeout calls the cancel
 * endpoint, so the entry becomes FAILED and the pot is never credited.
 */
import { useCallback, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import type { Connection } from "@solana/web3.js";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { WalletFailureReason } from "../lib/walletErrors";
import {
  getEscrowPda,
  getGlobalConfigPda,
  getParticipantPda,
  getRoundPda,
} from "@solana-roulette/verification";
import { LAMPORTS_PER_SOL } from "@solana-roulette/types";
import { useRuntime } from "./useRuntime";
import { clientTxLog } from "../lib/txLog";
import { API_BASE } from "../lib/apiBase";
import {
  classifyWalletError,
  friendlyWalletError,
  probeWalletClusterMismatch,
  detectWalletCluster,
} from "../lib/walletErrors";

const API = API_BASE; // production-safe API base (same-origin in dev)
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Extra lamports kept for the fee payer so the transfer can never stall. */
const TX_FEE_BUFFER_LAMPORTS = 10_000n;
/**
 * Rent-exempt minimum for a 101-byte Participant PDA the program's deposit
 * instruction must create on first entry: (128 + 101) * 3480 lamports/byte/year
 * * 2 years = 1_593_840. Only needed on the program path.
 */
const PARTICIPANT_RENT_LAMPORTS = 1_593_840n;
const CONFIRMATION_ATTEMPTS = 20;

/** Fallback when the API has not answered yet; real value comes from /api/health. */
const FALLBACK_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_ROULETTE_PROGRAM_ID ??
    "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos"
);

/** Minimal base58 encoder (avoids pulling the ESM-only bs58 build into the client). */
function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58[digits[i]!];
  return out;
}

/**
 * Anchor discriminator in the BROWSER: sha256 via WebCrypto is async, so it is
 * awaited here; the 8-byte prefix of sha256("global:" + method) is identical
 * to the node:crypto implementation the operator uses.
 */
async function anchorDiscriminator(name: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(`global:${name}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest).slice(0, 8);
}

export interface DepositArgs {
  roundId: string;
  amountSol: string;
  /** Pool lane (0=1 SOL, 1=10 SOL, 2=100 SOL) — routes the tx to that round. */
  tier: number;
}

export interface DepositResult {
  signature: string;
  explorer: string;
  amountLamports: string;
  status: "CONFIRMED" | "PENDING";
  /** "system" = plain devnet transfer, "program" = Anchor deposit instruction. */
  via: "system" | "program";
}

type SendTransaction = (tx: Transaction, conn: Connection, opts?: unknown) => Promise<string>;

interface DepositIntentResponse {
  depositId: string;
  escrow: string;
  amountLamports: string;
  roundId: string;
  tier: number;
  network: string;
  status: string;
  signature: string | null;
  resumed: boolean;
}

export class DepositRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = "DepositRejectedError";
  }
}

/**
 * A deposit failure that already carries a user-facing message. The pool page
 * renders `userMessage` verbatim; `reason` stays machine-readable for logs.
 */
export class WalletFriendlyError extends Error {
  constructor(
    readonly reason: WalletFailureReason | string,
    message: string
  ) {
    super(message);
    this.name = "WalletFriendlyError";
  }
}

export function useDeposit() {
  const { publicKey, sendTransaction, wallet } = useWallet();
  const { connection } = useConnection();
  const { runtime } = useRuntime();
  const [pending, setPending] = useState(false);

  const deposit = useCallback(
    async (args: DepositArgs): Promise<DepositResult> => {
      if (!publicKey) throw new Error("Wallet not connected");
      setPending(true);
      const wallet = publicKey.toBase58();
      const lamports = parseSol(args.amountSol);
      const network = "devnet";
      const started = Date.now();
      // The deployed Anchor program path: the deposit instruction advances the
      // on-chain round (pot, participant, FULL flip) in the SAME transaction.
      const programPath = runtime?.mode === "chain" && !!runtime?.programId;
      const programId = (() => {
        try {
          return runtime?.programId ? new PublicKey(runtime.programId) : FALLBACK_PROGRAM_ID;
        } catch {
          return FALLBACK_PROGRAM_ID;
        }
      })();

      clientTxLog.info("deposit.started", {
        wallet,
        network,
        amountLamports: lamports.toString(),
        amountSol: args.amountSol,
        roundId: args.roundId,
        tier: args.tier,
      });

      let intent: DepositIntentResponse | null = null;
      let signature: string | null = null;

      try {
        assertDevnet(connection);

        // 1b. refuse early when the WALLET is on a different cluster than the
        // app (classic case: Phantom left on Mainnet). Without this the first
        // symptom is a misleading "Blockhash not found" from the RPC; with it
        // the player gets told exactly what to switch before signing anything.
        // The adapter's injected provider: newer wallet-adapter typings expose
        // `wallet` as the wallet name (a string), so `adapter` is resolved
        // defensively — when absent the window-injected providers below are
        // what every browser wallet actually installs.
        const provider =
          (wallet as unknown as { adapter?: { _provider?: unknown } } | null | undefined)?.adapter?._provider ??
          (globalThis as { solana?: unknown; phantom?: { solana?: unknown } }).solana ??
          (globalThis as { phantom?: { solana?: unknown } }).phantom?.solana;
        const probe = probeWalletClusterMismatch(provider);
        const reportedCluster = detectWalletCluster(provider);
        if (probe.mismatch) {
          clientTxLog.warn("deposit.wallet_cluster_mismatch", {
            wallet,
            network,
            walletCluster: probe.walletCluster,
            appCluster: "devnet",
          });
          throw new WalletFriendlyError(
            "wrong_cluster",
            `Your wallet is on ${probe.walletCluster}, but this app only transacts on Devnet. Switch the network inside your wallet extension and try again.`
          );
        }
        if (reportedCluster) {
          clientTxLog.info("deposit.wallet_cluster", { wallet, network, cluster: reportedCluster });
        }

        // 2. balance check against the real devnet RPC
        const required = lamports + TX_FEE_BUFFER_LAMPORTS + (programPath ? PARTICIPANT_RENT_LAMPORTS : 0n);
        const balance = BigInt(await connection.getBalance(publicKey, "confirmed"));
        clientTxLog.info("deposit.balance", {
          wallet,
          network,
          balanceLamports: balance.toString(),
          requiredLamports: required.toString(),
          programPath,
        });
        if (balance < required) {
          throw new DepositRejectedError(
            `Not enough devnet SOL: wallet holds ${formatSol(balance)}, need ${formatSol(
              required
            )}. Use the devnet faucet below.`,
            "insufficient_devnet_balance"
          );
        }

        // 3. PENDING intent from the server (escrow address, amount, tier)
        intent = await createIntent({
          roundId: args.roundId,
          wallet,
          amountLamports: lamports,
        });
        if (intent.status === "CONFIRMED" && intent.signature) {
          clientTxLog.info("deposit.already_confirmed", {
            wallet,
            network,
            roundId: args.roundId,
            signature: intent.signature,
          });
          return {
            signature: intent.signature,
            explorer: `https://explorer.solana.com/tx/${intent.signature}?cluster=devnet`,
            amountLamports: intent.amountLamports,
            status: "CONFIRMED",
            via: programPath ? "program" : "system",
          };
        }

        // 4. build the transaction.
        //   chain mode → the program's `deposit` instruction: it CPIs the
        //     System Program to move lamports into escrow, creates the
        //     Participant PDA (init_if_needed), advances round.pot and flips
        //     the round FULL when the tier cap is hit — all atomically.
        //   local mode → a plain SystemProgram.transfer into the custody escrow.
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const amountForTx = BigInt(intent.amountLamports);
        const tx = new Transaction({
          feePayer: publicKey,
          blockhash,
          lastValidBlockHeight,
        });
        if (programPath) {
          const roundPda = getRoundPda(programId, BigInt(args.roundId))[0];
          const participantPda = getParticipantPda(programId, roundPda, publicKey)[0];
          const escrowPda = getEscrowPda(programId, roundPda)[0];
          const configPda = getGlobalConfigPda(programId)[0];
          const disc = await anchorDiscriminator("deposit");
          const amountLe = new Uint8Array(8);
          new DataView(amountLe.buffer).setBigUint64(0, amountForTx, true);
          tx.add(
            new TransactionInstruction({
              programId,
              keys: [
                { pubkey: configPda, isSigner: false, isWritable: false },
                { pubkey: roundPda, isSigner: false, isWritable: true },
                { pubkey: participantPda, isSigner: false, isWritable: true },
                { pubkey: escrowPda, isSigner: false, isWritable: true },
                { pubkey: publicKey, isSigner: true, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              ],
              data: Buffer.concat([Buffer.from(disc), Buffer.from(amountLe)]),
            })
          );
        } else {
          tx.add(
            SystemProgram.transfer({
              fromPubkey: publicKey,
              toPubkey: new PublicKey(intent.escrow),
              lamports: amountForTx,
            })
          );
        }
        const simulation = await connection.simulateTransaction(tx);
        clientTxLog.info("deposit.simulated", {
          wallet,
          network,
          recipient: intent.escrow,
          amountLamports: intent.amountLamports,
          via: programPath ? "program" : "system",
          rpcError: simulation.value.err ? JSON.stringify(simulation.value.err) : null,
          rpcLogs: simulation.value.logs?.slice(-6) ?? [],
        });
        if (simulation.value.err) {
          throw new DepositRejectedError(
            `Devnet simulation failed: ${JSON.stringify(simulation.value.err)}`,
            "simulation_failed"
          );
        }

        clientTxLog.info("deposit.awaiting_signature", {
          wallet,
          network,
          recipient: intent.escrow,
          amountLamports: intent.amountLamports,
          depositId: intent.depositId,
        });

        // 5. the player's wallet signs and the signed tx goes to devnet RPC
        signature = await (sendTransaction as SendTransaction)(tx, connection, {
          commitment: "confirmed",
          preflightCommitment: "confirmed",
        });
        clientTxLog.info("deposit.sent", {
          wallet,
          network,
          recipient: intent.escrow,
          amountLamports: intent.amountLamports,
          signature,
          explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
        });

        const confirmation = await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed"
        );
        clientTxLog.info("deposit.confirmed_locally", {
          wallet,
          network,
          signature,
          status: confirmation.value.err ? "failed" : "confirmed",
        });

        // 6. the server re-reads the chain before the round is credited
        const result = await confirmDeposit({
          roundId: args.roundId,
          depositId: intent.depositId,
          signature,
        });
        clientTxLog.info("deposit.verified_by_server", {
          wallet,
          network,
          signature,
          status: result.status,
          durationMs: Date.now() - started,
        });

        window.dispatchEvent(
          new CustomEvent("roulette:deposit", { detail: { tier: args.tier, roundId: args.roundId } })
        );

        return {
          signature,
          explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
          amountLamports: result.amountLamports,
          status: result.status === "CONFIRMED" ? "CONFIRMED" : "PENDING",
          via: programPath ? "program" : "system",
        };
      } catch (err) {
        // The reason feeds the server-side record; the message is what the
        // player sees. Raw wallet/RPC vocabulary ("Blockhash not found",
        // "Attempt to debit...", adapter wrapper names) is replaced by the
        // friendly mapping — EXCEPT for errors that already carry a curated
        // message (DepositRejectedError / WalletFriendlyError / intent+confirm
        // responses), which pass through untouched.
        const reason =
          err instanceof DepositRejectedError || err instanceof WalletFriendlyError
            ? err.reason
            : classifyWalletError(err);
        const userMessage =
          err instanceof DepositRejectedError || err instanceof WalletFriendlyError
            ? err.message
            : friendlyWalletError(err);
        clientTxLog.error("deposit.failed", {
          wallet,
          network,
          amountLamports: lamports.toString(),
          roundId: args.roundId,
          signature,
          depositId: intent?.depositId ?? null,
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
        // Never credit: mark the PENDING record FAILED when we can.
        if (intent && intent.status !== "CONFIRMED") {
          await cancelDeposit({
            roundId: args.roundId,
            depositId: intent.depositId,
            reason,
            signature,
          }).catch(() => undefined);
        }
        throw new WalletFriendlyError(reason, userMessage);
      } finally {
        setPending(false);
      }
    },
    [publicKey, connection, sendTransaction, runtime]
  );

  return { deposit, pending };
}

/**
 * Devnet is the only supported cluster: refuse anything else.
 *
 * A `Connection` has no `cluster` property — the cluster IS the RPC endpoint
 * (see `app/providers.tsx`, which builds the connection from
 * `NEXT_PUBLIC_SOLANA_NETWORK`). So the network is derived from the endpoint:
 * a mainnet endpoint is always refused, a devnet endpoint is accepted, and a
 * custom provider URL that mentions neither is allowed with a warning. The
 * server independently re-checks the network and the transfer destination on
 * chain before a single entry is credited.
 */
export function assertDevnet(connection: Connection): void {
  const endpoint = String(connection.rpcEndpoint ?? "");
  if (endpoint === "") {
    throw new DepositRejectedError(
      "No RPC endpoint is configured, so the network cannot be verified. Refusing to build a transaction.",
      "wrong_network"
    );
  }
  if (/mainnet/i.test(endpoint)) {
    throw new DepositRejectedError(
      `This app is Solana DEVNET only (RPC points at "${endpoint}"). Switch your wallet to Devnet.`,
      "wrong_network"
    );
  }
  if (!/devnet/i.test(endpoint)) {
    clientTxLog.warn("deposit.unknown_cluster", { endpoint });
  }
}

function parseSol(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(trimmed)) {
    throw new Error("Amount must be a positive SOL value with up to 9 decimals");
  }
  const [whole, frac = ""] = trimmed.split(".");
  const frac9 = (frac + "000000000").slice(0, 9);
  const lamports = BigInt(whole) * LAMPORTS_PER_SOL + BigInt(frac9);
  if (lamports <= 0n) throw new Error("Amount must be positive");
  return lamports;
}

export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

async function apiPost(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function createIntent(args: {
  roundId: string;
  wallet: string;
  amountLamports: bigint;
}): Promise<DepositIntentResponse> {
  const { status, json } = await apiPost(`/api/round/${args.roundId}/deposit/intent`, {
    wallet: args.wallet,
    amountLamports: args.amountLamports.toString(),
  });
  if (status !== 200) {
    const detail = typeof json.detail === "string" ? json.detail : "deposit intent rejected";
    throw new DepositRejectedError(`${String(json.error ?? "deposit_failed")}: ${detail}`, String(json.error ?? "intent_failed"));
  }
  return json as unknown as DepositIntentResponse;
}

interface ConfirmResponse {
  status: "CONFIRMED" | "PENDING";
  amountLamports: string;
}

/** Poll the server until it has decided CONFIRMED or FAILED. */
async function confirmDeposit(args: {
  roundId: string;
  depositId: string;
  signature: string;
}): Promise<ConfirmResponse> {
  for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt++) {
    const { status, json } = await apiPost(`/api/round/${args.roundId}/deposit/confirm`, {
      depositId: args.depositId,
      signature: args.signature,
      roundId: args.roundId,
    });
    if (status === 200) {
      return {
        status: "CONFIRMED",
        amountLamports: String(json.amountLamports ?? "0"),
      };
    }
    if (status === 202) {
      await sleep(1_500);
      continue;
    }
    const detail = typeof json.detail === "string" ? json.detail : "transaction could not be verified on devnet";
    throw new DepositRejectedError(`${String(json.error ?? "deposit_failed")}: ${detail}`, "onchain_verification_failed");
  }
  throw new DepositRejectedError(
    "The transaction was submitted but devnet has not confirmed it yet. It will be reconciled automatically — refresh in a moment.",
    "confirmation_timeout"
  );
}

async function cancelDeposit(args: {
  roundId: string;
  depositId: string;
  reason: string;
  signature: string | null;
}): Promise<void> {
  await apiPost(`/api/round/${args.roundId}/deposit/cancel`, {
    depositId: args.depositId,
    reason: args.reason,
    signature: args.signature,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The Anchor program deposit instruction builder — the same ix the live
 * deposit path uses in "chain" mode (see `deposit()` above). Exposed for
 * tests and tooling: the player signs a real `deposit` instruction and the
 * same /deposit/confirm verification credits the entry.
 */
export async function buildProgramDepositInstruction(args: {
  roundId: string;
  lamports: bigint;
  wallet: PublicKey;
  programId?: PublicKey;
}): Promise<TransactionInstruction> {
  const programId = args.programId ?? FALLBACK_PROGRAM_ID;
  const round = BigInt(args.roundId);
  const [roundPda] = getRoundPda(programId, round);
  const [escrowPda] = getEscrowPda(programId, round);
  const [configPda] = getGlobalConfigPda(programId);
  const [participantPda] = getParticipantPda(programId, roundPda, args.wallet);

  const disc = await anchorDiscriminator("deposit");
  const amountLe = new Uint8Array(8);
  new DataView(amountLe.buffer).setBigUint64(0, args.lamports, true);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: roundPda, isSigner: false, isWritable: true },
      { pubkey: participantPda, isSigner: false, isWritable: true },
      { pubkey: escrowPda, isSigner: false, isWritable: true },
      { pubkey: args.wallet, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from(disc), Buffer.from(amountLe)]),
  });
}
