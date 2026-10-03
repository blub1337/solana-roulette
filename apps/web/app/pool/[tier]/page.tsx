"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "../../providers";
import { RoundWheel } from "../../../components/RoundWheel";
import { PoolProgress } from "../../../components/PoolProgress";
import { StatusPill, TierBadge } from "../../../components/StatusPill";
import { ModeBanner } from "../../../components/ModeBanner";
import { DevnetBadge } from "../../../components/DevnetBadge";
import { BrandLogo, BRAND_NAME } from "../../../components/BrandLogo";
import { LiveChat } from "../../../components/LiveChat";
import { RefundChoice } from "../../../components/RefundChoice";
import { useRoundState } from "../../../hooks/useRoundState";
import { useDeposit } from "../../../hooks/useDeposit";
import { useRuntime } from "../../../hooks/useRuntime";
import { useFeeTerms } from "../../../hooks/useFeeTerms";
import { useSse } from "../../../hooks/useSse";
import { API_BASE } from "../../../lib/apiBase";
import { TIER_META, type Tier } from "@solana-roulette/types";

function lamportsToSol(lamports: string | undefined | null): string {
  if (!lamports) return "0";
  return (Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 3 });
}

const VALID_TIERS = [0, 1, 2];
const QUICK_AMOUNTS = ["0.05", "0.1", "0.25", "0.5"];

export default function PoolRoom() {
  const params = useParams<{ tier: string }>();
  const tierParam = Number(params?.tier ?? "0");
  const tier: Tier = VALID_TIERS.includes(tierParam) ? (tierParam as Tier) : 0;
  const meta = TIER_META[tier];

  const { connected, publicKey } = useWallet();
  const { round, entries, loading, error, refresh } = useRoundState(tier);
  const { deposit, pending } = useDeposit();
  const { runtime } = useRuntime();
  // The fee the runtime enforces, never a hardcoded percentage.
  const fee = useFeeTerms();

  const [amountSol, setAmountSol] = useState("0.1");
  const [notice, setNotice] = useState<{
    kind: "ok" | "err";
    text: string;
    explorer?: string;
  } | null>(null);

  // Any chain event for this lane re-reads the round from the API.
  const onEvent = useCallback(
    (ev: { roundId?: string }) => {
      if (ev.roundId && round && ev.roundId !== round.id) return;
      void refresh();
    },
    [refresh, round]
  );
  useSse(onEvent);

  const fillPercent = useMemo(() => {
    if (!round) return 0;
    const pot = Number(round.potLamports);
    const cap = Number(round.maxRoundSizeLamports) || 1;
    return Math.min(100, (pot / cap) * 100);
  }, [round]);

  const myEntry = useMemo(
    () => entries.find((e) => publicKey && e.wallet === publicKey.toBase58()),
    [entries, publicKey]
  );

  const odds = useMemo(() => {
    if (!myEntry || !round) return null;
    const total = Number(round.totalWeight);
    if (!total) return null;
    return ((Number(myEntry.amountLamports) / total) * 100).toFixed(2);
  }, [myEntry, round]);

  // The refund-or-wait decision window the runtime has armed for this round.
  const refundWindow = round?.refundWindow ?? null;

  const onDeposit = useCallback(async () => {
    if (!publicKey || !round) return;
    // Defence in depth: only ever deposit into the round THIS lane is showing.
    // (useRoundState already drops another lane's round on navigation, so a
    // pool switch can never build a transaction against the old round id.)
    if (round.tier !== tier) {
      setNotice({
        kind: "err",
        text: "This pool changed round while you were switching pools — reloading the current round. Please try again in a moment.",
      });
      void refresh();
      return;
    }
    setNotice(null);
    try {
      const result = await deposit({ roundId: round.id, amountSol, tier });
      setNotice({
        kind: "ok",
        text:
          result.status === "CONFIRMED"
            ? `Devnet transfer confirmed and entry credited: ${result.signature.slice(0, 12)}…`
            : `Devnet transaction submitted, waiting for confirmation: ${result.signature.slice(0, 12)}…`,
        explorer: result.explorer,
      });
      void refresh();
    } catch (e) {
      // The hook maps every failure to a player-facing sentence (wallet
      // rejections, wrong cluster, blockhash expiry, RPC trouble, program
      // reverts). Show it verbatim; the machine reason went to the tx log.
      const raw = e instanceof Error ? e.message : "Deposit failed";
      // `already_deposited` means the wallet is genuinely in THIS round already
      // (one entry per wallet per round). Never surface the raw error code:
      // explain the rule and how the lane reopens for the next round.
      setNotice({
        kind: "err",
        text: /already_deposited/i.test(raw)
          ? "You already have an entry in this round — one entry per wallet per round. Join again when this pool opens its next round; if a low-traffic round never fills you are asked whether to take your deposit back or keep waiting."
          : `${raw} Nothing was credited.`,
      });
      void refresh();
    }
  }, [publicKey, round, deposit, amountSol, tier, refresh]);

  const canDeposit = connected && round?.status === "OPEN" && !pending && runtime?.realFunds === true;
  const accepting = round?.status === "OPEN";
  const spinning = round?.status === "RANDOMNESS_PENDING" || round?.status === "FULL";

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <nav className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <Link href="/" aria-label="SolRoll home" className="shrink-0">
          <BrandLogo
            className="h-9 w-auto sm:h-10"
            fallbackClassName="text-lg sm:text-xl"
          />
        </Link>
        <WalletMultiButton />
      </nav>

      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/" className="text-sm text-ivory/50 hover:text-gold-300">
            ← All pools
          </Link>
          <div className="mt-2 flex items-center gap-3">
            <TierBadge tier={tier} size="lg" />
            {round && <StatusPill status={round.status} />}
          </div>
          <p className="mt-1 text-sm text-ivory/60">
            Round #{round?.id ?? "—"} · cap {meta.capSol} SOL · {fee ? fee.feePercent : "—"}%
            platform fee enforced by the runtime
          </p>
        </div>
      </header>

      <ModeBanner runtime={runtime} />
      <DevnetBadge />

      {error && (
        <div className="banner-error">
          <span>⚠ {error} — retrying automatically…</span>
        </div>
      )}

      {/*
       * The player's choice on a stalled round: take the exact refund now, or
       * keep waiting. Shown ABOVE the tables so it cannot be missed — it used
       * to be a silent refund that made the deposit disappear from the pool.
       */}
      <RefundChoice
        roundId={round?.id ?? ""}
        refundWindow={refundWindow}
        myStakeLamports={myEntry?.amountLamports ?? null}
        isParticipant={Boolean(myEntry)}
        onResolved={() => void refresh()}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Wheel + pot */}
        <section className="felt-card p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-xl text-gold-300">Live round</h2>
            <span className="text-xs uppercase tracking-widest text-ivory/40">
              {loading ? "loading…" : spinning ? "revealing…" : `reveal slot ${round?.revealSlot ?? "—"}`}
            </span>
          </div>
          <div className="mt-6">
            <RoundWheel
              tier={tier}
              entries={entries.map((e) => ({ id: e.wallet, weight: Number(e.amountLamports) }))}
              winner={round?.winner ?? null}
              spinning={spinning}
            />
          </div>
          <div className="mt-8">
            <PoolProgress
              tier={tier}
              potSol={lamportsToSol(round?.potLamports)}
              capSol={String(meta.capSol)}
              fillPercent={fillPercent}
              participantCount={round?.participantCount ?? 0}
            />
          </div>
          {round?.status === "COMPLETED" && (
            <div className="banner-success mt-6">
              <span>
                Winner{" "}
                <span className="font-mono">
                  {round.winner?.slice(0, 6)}…{round.winner?.slice(-4)}
                </span>{" "}
                · payout {lamportsToSol(round.payoutLamports)} ◎ · fee{" "}
                {lamportsToSol(round.feeLamports)} ◎
              </span>
            </div>
          )}
        </section>

        {/* Deposit + odds */}
        <section className="felt-card p-6">
          <h2 className="mb-4 font-display text-xl text-gold-300">Place your bet</h2>
          {notice && (
            <div className={notice.kind === "ok" ? "banner-success" : "banner-error"}>
              <span>
                {notice.text}{" "}
                {notice.explorer && (
                  <a
                    href={notice.explorer}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-dotted"
                  >
                    View on Solana Explorer (devnet) ↗
                  </a>
                )}
              </span>
            </div>
          )}
          {!loading && !round ? (
            <div className="banner-info">
              <span>
                The next round in this pool is being opened automatically. This page activates
                on its own as soon as deposits are accepted.
              </span>
            </div>
          ) : !connected ? (
            <p className="text-ivory/70">Connect your Solana wallet to join this round.</p>
          ) : round && !accepting ? (
            <div className="banner-info">
              <span>
                Round is <strong>{round.status}</strong> — deposits are closed.
                {spinning && " The winner is being determined…"}
              </span>
            </div>
          ) : myEntry ? (
            <div className="banner-info">
              <span>
                You already have an entry in round <strong>#{round?.id}</strong> (
                {lamportsToSol(myEntry.amountLamports)} ◎). One entry per wallet per round — you
                can join again when this pool opens its next round. If this round never reaches its
                cap the runtime asks you first: take your exact deposit back, or keep waiting.
              </span>
            </div>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                {QUICK_AMOUNTS.map((v) => (
                  <button
                    key={v}
                    onClick={() => setAmountSol(v)}
                    className="btn-ghost px-3 py-1.5 text-sm"
                    type="button"
                  >
                    {v} ◎
                  </button>
                ))}
              </div>
              <div className="mb-4 flex gap-2">
                <input
                  value={amountSol}
                  onChange={(e) => setAmountSol(e.target.value)}
                  inputMode="decimal"
                  className="w-full rounded-xl border border-felt-600 bg-felt-800 px-4 py-2.5 text-ivory outline-none focus:border-gold-500"
                  placeholder={`Amount in SOL (min ${(
                    Number(round?.minDepositLamports ?? 10_000_000) / 1e9
                  ).toFixed(2)})`}
                  aria-label="Deposit amount in SOL"
                />
                <button className="btn-gold" onClick={onDeposit} disabled={!canDeposit} type="button">
                  {pending ? "Signing…" : "Deposit"}
                </button>
              </div>
            </>
          )}

          <dl className="mt-6 grid grid-cols-2 gap-4 text-sm">
            <div className="panel p-4">
              <dt className="stat-label">Your entry</dt>
              <dd className="stat-value">
                {myEntry ? `${lamportsToSol(myEntry.amountLamports)} ◎` : "—"}
              </dd>
            </div>
            <div className="panel p-4">
              <dt className="stat-label">Your odds</dt>
              <dd className="stat-value">{odds ? `${odds}%` : "—"}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-ivory/50">
            Odds = your stake ÷ pot. Fixed the moment the pool closes.
          </p>
        </section>
      </div>

      {/* Entries */}
      <section className="felt-card mt-6 p-6">
        <h2 className="mb-4 font-display text-xl text-gold-300">
          Entries ({entries.length})
        </h2>
        {entries.length === 0 ? (
          <p className="text-sm text-ivory/60">No entries yet — be the first.</p>
        ) : (
          <ul className="divide-y divide-felt-700">
            {entries.map((e) => (
              <li key={e.wallet} className="flex items-center justify-between py-2.5 text-sm">
                <span className="font-mono text-ivory/80">
                  {e.wallet.slice(0, 6)}…{e.wallet.slice(-4)}
                  {publicKey && e.wallet === publicKey.toBase58() && (
                    <span className="ml-2 rounded bg-gold-500/20 px-1.5 py-0.5 text-[10px] uppercase text-gold-300">
                      you
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-4">
                  <span className="text-ivory/60">{lamportsToSol(e.amountLamports)} ◎</span>
                  <span className="rounded bg-felt-800 px-2 py-0.5 text-xs text-gold-300">
                    {round && round.totalWeight !== "0"
                      ? `${((Number(e.amountLamports) / Number(round.totalWeight)) * 100).toFixed(1)}%`
                      : "—"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {round && <VerifyPanel roundId={round.id} />}

      {/* Always-visible live chat, defaulting to this pool's lobby (never a popup). */}
      <div className="mt-6">
        <LiveChat defaultLobby={`/pool/${tier}`} />
      </div>

      <footer className="mt-10 border-t border-felt-700 pt-6 text-center text-xs text-ivory/40">
        <p>
          {BRAND_NAME} · DEVNET demonstration. No real-money wagering. The winner is determined by
          the runtime and is independently verifiable — see docs/VERIFICATION.md.
        </p>
        <a
          href="https://x.com/EpicMindFX"
          target="_blank"
          rel="noreferrer"
          aria-label="SolRoll on X (@EpicMindFX)"
          className="mt-3 inline-flex items-center gap-2 rounded-full border border-felt-600 bg-felt-900/70 px-3 py-1.5 text-xs text-ivory/70 transition hover:border-gold-500/60 hover:text-gold-300"
        >
          <span
            aria-hidden
            className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-gold-500/15 text-[11px] font-bold text-gold-300"
          >
            X
          </span>
          @EpicMindFX
        </a>
      </footer>
    </main>
  );
}

function VerifyPanel({ roundId }: { roundId: string }) {
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // Same base as every other browser fetch: production-safe, loopback-guarded.
  const API = API_BASE;

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/round/${roundId}/verify`);
      setResult(await res.json());
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : "verify failed" });
    } finally {
      setBusy(false);
    }
  }, [roundId, API]);

  const ok = (result as { ok?: boolean } | null)?.ok === true;

  return (
    <section className="felt-card mt-6 p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl text-gold-300">Independent verification</h2>
        <button className="btn-ghost text-sm" onClick={run} disabled={busy} type="button">
          {busy ? "Verifying…" : "Verify round"}
        </button>
      </div>
      <p className="mt-2 text-xs text-ivory/50">
        Recomputes the winner from the recorded randomness and the participant weights — no
        trust in this site required.
      </p>
      {result !== null && (
        <pre
          className={`mt-4 max-h-72 overflow-auto rounded-lg p-4 text-xs ${
            ok ? "bg-emerald-950/40 text-emerald-200" : "bg-felt-950 text-ivory/80"
          }`}
        >
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </section>
  );
}
