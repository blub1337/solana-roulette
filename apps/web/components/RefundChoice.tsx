"use client";

/**
 * "Refund, or keep waiting?" — the player's choice on a stalled round.
 *
 * A quiet pool never reaches its cap, so the runtime ends the round after a
 * while (otherwise one entry per wallet per round would lock the lane forever).
 * It used to do that silently: the deposits simply vanished from the pool and
 * came back to the wallet. Now the round enters a decision window first and the
 * player is asked:
 *
 *   - "Keep waiting"  → the round is extended by another full timeout, so a
 *                        player who is still at the table is never refunded
 *                        out from under them.
 *   - "Refund now"    → the round is closed immediately and every participant
 *                        is refunded EXACTLY from escrow; the lane reopens.
 *
 * Both actions hit the API; the on-chain refund is the same `cancel_round` the
 * automatic timeout uses, so nothing here can move SOL anywhere except back to
 * the players.
 */
import { useCallback, useEffect, useState } from "react";
import type { RefundWindow } from "@solana-roulette/types";
import { API_BASE } from "../lib/apiBase";

const API = API_BASE;

function lamportsToSol(lamports: string | undefined | null): string {
  if (!lamports) return "0";
  return (Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * A locally ticking countdown so the number visibly moves between API polls.
 * Seeded from the server's `msRemaining` and re-seeded whenever that changes,
 * so the client can never drift away from the deadline the driver refunds on.
 */
function useCountdown(msRemaining: number, deadline: number | null): number {
  const [left, setLeft] = useState(msRemaining);
  useEffect(() => {
    setLeft(msRemaining);
  }, [msRemaining, deadline]);
  useEffect(() => {
    const t = setInterval(() => setLeft((v) => Math.max(0, v - 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return left;
}

export function RefundChoice({
  roundId,
  refundWindow,
  myStakeLamports,
  isParticipant,
  onResolved,
}: {
  roundId: string;
  refundWindow: RefundWindow | null | undefined;
  /** The connected wallet's stake in this round, if any. */
  myStakeLamports?: string | null;
  /** True when the connected wallet actually has an entry in this round. */
  isParticipant: boolean;
  /** Called after a refund/wait so the page can re-read the round. */
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState<"refund" | "wait" | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const left = useCountdown(refundWindow?.msRemaining ?? 0, refundWindow?.deadline ?? null);

  const act = useCallback(
    async (action: "refund" | "wait") => {
      setBusy(action);
      setMessage(null);
      try {
        const res = await fetch(`${API}/api/round/${roundId}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const json = (await res.json().catch(() => ({}))) as { detail?: string };
        if (!res.ok) {
          setMessage({
            kind: "err",
            text: json.detail ?? "That did not go through — the round is unchanged. Try again.",
          });
        } else {
          setMessage({
            kind: "ok",
            text:
              action === "refund"
                ? "Round closed — every deposit is on its way back to the wallets, and this pool is open again."
                : "Got it — the pool keeps waiting. It will ask again later.",
          });
        }
      } catch (e) {
        setMessage({
          kind: "err",
          text: e instanceof Error ? e.message : "Network error — nothing was changed.",
        });
      } finally {
        setBusy(null);
        onResolved();
      }
    },
    [roundId, onResolved]
  );

  if (!refundWindow?.active) return null;

  const urgent = left <= 20_000;

  return (
    <section
      className={`felt-card mt-6 border p-5 ${
        urgent ? "border-roulette-red/60" : "border-gold-500/40"
      }`}
      aria-live="polite"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg text-gold-300">
            {isParticipant ? "Do you want your SOL back?" : "This pool is deciding what to do"}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ivory/70">
            {isParticipant ? (
              <>
                This pool has not reached its cap, so the round is about to close on its own — your{" "}
                <strong className="text-gold-300">
                  {lamportsToSol(myStakeLamports)} ◎
                </strong>{" "}
                would be refunded automatically. You choose: take the exact refund right now, or
                keep waiting and stay in the round for the chance at the pot.
              </>
            ) : (
              <>
                Nobody has reached this pool&apos;s cap, so the round is about to close and refund
                everyone. If you have an entry here, this is your chance to decide.
              </>
            )}
          </p>
        </div>
        <div className="text-right">
          <div className="stat-label">Automatic refund in</div>
          <div
            className={`font-mono text-2xl ${urgent ? "text-roulette-red" : "text-gold-300"}`}
          >
            {mmss(left)}
          </div>
        </div>
      </div>

      {message && (
        <div className={message.kind === "ok" ? "banner-success mt-4" : "banner-error mt-4"}>
          <span>{message.text}</span>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          className="btn-gold"
          onClick={() => void act("refund")}
          disabled={busy !== null}
        >
          {busy === "refund"
            ? "Refunding…"
            : isParticipant
              ? `Refund my ${lamportsToSol(myStakeLamports)} ◎ now`
              : "Refund everyone now"}
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => void act("wait")}
          disabled={busy !== null}
        >
          {busy === "wait" ? "Extending…" : "No thanks — keep waiting"}
        </button>
      </div>

      <p className="mt-3 text-xs text-ivory/50">
        The refund is exact and on chain: every participant gets back precisely what they deposited,
        the platform keeps no fee on a cancelled round, and the pool reopens for a fresh round. If
        nobody chooses, the refund happens automatically when the timer hits zero.
      </p>
    </section>
  );
}