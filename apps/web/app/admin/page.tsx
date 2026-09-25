"use client";

/**
 * Admin console — the operator's view of the platform.
 *
 * What it shows: devnet/mainnet state, the RPC, the escrow / operator / fee
 * wallet addresses, the live escrow balance, the 7.5% fee and the three pool
 * caps, the deposit Active/Paused switch, open and completed rounds, the
 * deposit/payout transaction ledger and the transaction log.
 *
 * What it can NEVER do — by design, not by omission:
 *   - see, upload or download a private key, a seed phrase or OPERATOR_KEYPAIR
 *     (the API refuses to return them; only the PUBLIC operator address is
 *     exposed, and the token is kept in sessionStorage),
 *   - change the fee, the pool caps or the network — those come from the
 *     environment and the program,
 *   - pick a winner, force a payout or settle a round by hand. Settlement runs
 *     automatically; pausing deposits does not stop it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TIER_META } from "@solana-roulette/types";
import {
  AdminApiError,
  adminFetch,
  clearAdminToken,
  readAdminToken,
  storeAdminToken,
  type AdminLogEntry,
  type AdminOverview,
  type AdminRoundsResponse,
  type AdminTransactionsResponse,
  type AdminTxRow,
} from "../../lib/adminClient";

const REFRESH_MS = 10_000;

function sol(lamports: string | number | null | undefined, decimals = 4): string {
  if (lamports === null || lamports === undefined || lamports === "") return "—";
  const n = Number(lamports) / 1e9;
  if (!Number.isFinite(n)) return "—";
  return `${n.toLocaleString("en-US", { maximumFractionDigits: decimals })} ◎`;
}

function short(address: string | null | undefined): string {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—";
}

function time(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("en-GB", { hour12: false });
}

function Chip({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted"; children: React.ReactNode }) {
  const tones = {
    ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    warn: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    bad: "border-roulette-red/50 bg-roulette-red/10 text-roulette-red",
    muted: "border-white/10 bg-white/[0.04] text-ivory/60",
  } as const;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Public address with copy-to-clipboard and a devnet explorer link. */
function Address({
  label,
  value,
  href,
}: {
  label: string;
  value: string | null;
  href?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="stat-label">{label}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <code className="font-mono text-xs text-ivory/90">{value ?? "not configured"}</code>
        {value ? (
          <>
            <button
              type="button"
              className="rounded border border-felt-600 px-2 py-0.5 text-[11px] text-ivory/70 transition hover:border-gold-500 hover:text-gold-300"
              onClick={() => {
                void navigator.clipboard?.writeText(value);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "copied ✓" : "copy"}
            </button>
            {href && (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-gold-400 underline decoration-dotted hover:text-gold-300"
              >
                explorer ↗
              </a>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-felt-700/70 py-2 last:border-0">
      <span className="text-xs uppercase tracking-widest text-ivory/50">
        {label}
        {hint ? <span className="ml-2 normal-case tracking-normal text-ivory/30">{hint}</span> : null}
      </span>
      <span className="text-right text-sm text-ivory/90">{value}</span>
    </div>
  );
}

function Section({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="felt-card p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-gold-300">{title}</h2>
          {subtitle ? <p className="mt-1 text-xs text-ivory/50">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

function AdminLogin({ onAuthed }: { onAuthed: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      storeAdminToken(token.trim());
      try {
        await adminFetch<AdminOverview>("/api/admin/overview");
        onAuthed();
      } catch (err) {
        clearAdminToken();
        if (err instanceof AdminApiError) {
          setError(
            err.notConfigured
              ? "The admin API is disabled: set ADMIN_TOKEN in the server environment and restart the API."
              : err.unauthorized
                ? "Wrong token. It is the ADMIN_TOKEN value from your server environment (Render → Environment)."
                : err.message
          );
        } else {
          setError(err instanceof Error ? err.message : "API unreachable");
        }
      } finally {
        setBusy(false);
      }
    },
    [token, onAuthed]
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <div className="felt-card p-6">
        <div className="mb-1 flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-gold-400" aria-hidden />
          <h1 className="font-display text-2xl text-gold-400">Admin console</h1>
        </div>
        <p className="mb-5 text-sm text-ivory/60">
          Operator access. Enter the <code className="text-ivory/80">ADMIN_TOKEN</code> from your server
          environment. It is kept in this tab only (sessionStorage) and is never a Solana key.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ADMIN_TOKEN"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-xl border border-felt-600 bg-felt-950/60 px-4 py-3 font-mono text-sm text-ivory outline-none transition placeholder:text-ivory/30 focus:border-gold-500"
          />
          <button type="submit" disabled={busy || token.trim() === ""} className="btn-gold w-full">
            {busy ? "Checking…" : "Unlock console"}
          </button>
        </form>
        {error ? (
          <p className="mt-4 rounded-xl border border-roulette-red/60 bg-roulette-red/10 px-4 py-3 text-sm text-roulette-red">
            {error}
          </p>
        ) : null}
        <p className="mt-5 text-xs leading-relaxed text-ivory/40">
          Private keys, seed phrases and <code>OPERATOR_KEYPAIR</code> are never entered here. They stay
          in the server environment and this console can only ever display public addresses.
        </p>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// console
// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: string }) {
  const label: Record<string, string> = {
    OPEN: "accepting",
    FULL: "full",
    LOCKED: "locked",
    RANDOMNESS_PENDING: "choosing winner",
    SETTLING: "settling",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
  };
  return <span className="status-pill" data-status={status}>{label[status] ?? status}</span>;
}

function TxBadge({ status }: { status: AdminTxRow["status"] }) {
  const tone = status === "CONFIRMED" ? "ok" : status === "FAILED" ? "bad" : "warn";
  return <Chip tone={tone}>{status ?? "PENDING"}</Chip>;
}

export default function AdminPage() {
  const [authed, setAuthed] = useState(false);
  // No token on a fresh visit means there is nothing to validate, so the login
  // renders straight away (and server-side) instead of a loading flash.
  const [checking, setChecking] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [rounds, setRounds] = useState<AdminRoundsResponse | null>(null);
  const [txs, setTxs] = useState<AdminTransactionsResponse | null>(null);
  const [logs, setLogs] = useState<AdminLogEntry[]>([]);
  const [txFilter, setTxFilter] = useState<"ALL" | "DEPOSIT" | "PAYOUT" | "FAILED">("ALL");
  const [logLevel, setLogLevel] = useState<"info" | "warn" | "error">("info");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (readAdminToken() === "") return;
    try {
      const [o, r, t, l] = await Promise.all([
        adminFetch<AdminOverview>("/api/admin/overview"),
        adminFetch<AdminRoundsResponse>("/api/admin/rounds"),
        adminFetch<AdminTransactionsResponse>("/api/admin/transactions?limit=60"),
        adminFetch<{ entries: AdminLogEntry[] }>(`/api/admin/logs?level=${logLevel}&limit=60`),
      ]);
      if (!mounted.current) return;
      setOverview(o);
      setRounds(r);
      setTxs(t);
      setLogs(l.entries);
      setFatal(null);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof AdminApiError && (err.unauthorized || err.notConfigured)) {
        clearAdminToken();
        setAuthed(false);
        setFatal(err.message);
      } else {
        setFatal(err instanceof Error ? err.message : "API unreachable");
      }
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, [logLevel]);

  // Validate a token that is already in sessionStorage (page refresh).
  useEffect(() => {
    if (readAdminToken() === "") {
      setChecking(false);
      return;
    }
    setChecking(true);
    void (async () => {
      try {
        await adminFetch<AdminOverview>("/api/admin/overview");
        if (mounted.current) setAuthed(true);
      } catch {
        clearAdminToken();
        if (mounted.current) setAuthed(false);
      } finally {
        if (mounted.current) setChecking(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!authed) return;
    void load();
    if (!auto) return;
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [authed, auto, load]);

  const toggleDeposits = useCallback(
    async (paused: boolean) => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await adminFetch<{ deposits: { state: string } }>("/api/admin/deposits", {
          method: "POST",
          body: JSON.stringify({ paused }),
        });
        setNotice(
          paused
            ? "Deposits paused. Running rounds keep settling and winners keep getting paid."
            : "Deposits resumed. New entries are accepted again."
        );
        if (res.deposits.state) await load();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Could not change the deposit state");
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const signOut = useCallback(() => {
    clearAdminToken();
    setAuthed(false);
    setOverview(null);
    setRounds(null);
    setTxs(null);
    setLogs([]);
    setNotice(null);
  }, []);

  const filteredTxs = useMemo<AdminTxRow[]>(() => {
    const rows = txs?.transactions ?? [];
    if (txFilter === "ALL") return rows;
    if (txFilter === "FAILED") return rows.filter((t) => t.status === "FAILED");
    return rows.filter((t) => t.kind === txFilter);
  }, [txs, txFilter]);

  if (checking) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-10">
        <div className="skeleton h-8 w-64" />
        <div className="skeleton mt-4 h-40 w-full" />
      </main>
    );
  }

  if (!authed) {
    return (
      <>
        {fatal && !readAdminToken() ? null : null}
        <AdminLogin onAuthed={() => { setFatal(null); setAuthed(true); }} />
      </>
    );
  }

  const deposits = overview?.deposits;
  const paused = deposits?.paused ?? false;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-3xl text-gold-400">Admin console</h1>
            <Chip tone={overview?.system.devnetOnly ? "ok" : "bad"}>
              {overview?.system.network ?? "—"}
            </Chip>
            <Chip tone={overview?.system.mainnetEnabled ? "bad" : "muted"}>
              mainnet {overview?.system.mainnetEnabled ? "UNLOCKED" : "locked"}
            </Chip>
          </div>
          <p className="mt-1 text-sm text-ivory/60">
            Observability + the deposit kill switch. Settlement is automatic — there is no manual payout
            and no winner override.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-ivory/60">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
              className="h-3.5 w-3.5 accent-gold-500"
            />
            auto-refresh {REFRESH_MS / 1000}s
          </label>
          <button type="button" className="btn-ghost text-sm" onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" className="btn-ghost text-sm" onClick={signOut}>
            Lock
          </button>
        </div>
      </header>

      {fatal ? (
        <div className="banner-error">
          <span>⚠ {fatal}</span>
        </div>
      ) : null}
      {notice ? (
        <div className="banner-success">
          <span>{notice}</span>
        </div>
      ) : null}
      {!overview ? <div className="skeleton h-32 w-full" /> : null}

      {overview ? (
        <div className="space-y-6">
          {/* System */}
          <Section
            title="System & blockchain status"
            subtitle="Where the platform runs and whether the chain is reachable right now."
          >
            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <Row
                  label="Network"
                  value={
                    <span className="flex flex-wrap items-center justify-end gap-2">
                      {overview.system.network}
                      <Chip tone={overview.system.devnetOnly ? "ok" : "bad"}>
                        {overview.system.devnetOnly ? "devnet only" : "mainnet"}
                      </Chip>
                    </span>
                  }
                />
                <Row label="Mainnet gate" value={overview.system.mainnetGate} />
                <Row
                  label="Runtime"
                  value={
                    <span className="flex items-center justify-end gap-2">
                      {overview.system.backendMode}
                      <Chip tone={overview.system.realFunds ? "ok" : "warn"}>
                        {overview.system.realFunds ? "real devnet SOL" : "no real funds"}
                      </Chip>
                    </span>
                  }
                  hint={overview.system.backendReason}
                />
                <Row label="Program" value={<code className="font-mono text-xs">{overview.system.programId}</code>} />
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-center justify-between">
                  <span className="stat-label">RPC / cluster</span>
                  <Chip tone={overview.system.rpc.ok ? "ok" : "bad"}>
                    {overview.system.rpc.ok ? "reachable" : "unreachable"}
                  </Chip>
                </div>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-ivory/50">Endpoint</dt>
                    <dd className="truncate font-mono text-xs text-ivory/80">{overview.system.rpc.url}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ivory/50">Slot</dt>
                    <dd className="font-mono text-xs text-ivory/80">{overview.system.rpc.slot ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-ivory/50">Latency</dt>
                    <dd className="font-mono text-xs text-ivory/80">
                      {overview.system.rpc.latencyMs !== null ? `${overview.system.rpc.latencyMs} ms` : "—"}
                    </dd>
                  </div>
                  {overview.system.rpc.error ? (
                    <div className="pt-1 text-xs text-roulette-red">{overview.system.rpc.error}</div>
                  ) : null}
                </dl>
              </div>
            </div>
          </Section>

          {/* Custody */}
          <Section
            title="Wallets & escrow"
            subtitle="Public addresses only. The signing key stays in the server environment and is never sent to a browser."
          >
            <div className="grid gap-3 md:grid-cols-2">
              <Address
                label="DEPOSIT_ESCROW_WALLET (escrow / payout account)"
                value={overview.custody.escrow}
                href={overview.custody.escrowExplorer}
              />
              <Address
                label="Operator wallet (payout signer address)"
                value={overview.custody.payoutSigner}
                href={overview.custody.payoutSigner
                  ? `https://explorer.solana.com/address/${overview.custody.payoutSigner}?cluster=devnet`
                  : null}
              />
              <Address
                label="Fee wallet (7.5% treasury)"
                value={overview.custody.feeWallet}
                href={`https://explorer.solana.com/address/${overview.custody.feeWallet}?cluster=devnet`}
              />
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <div className="stat-label">Escrow balance (live on devnet)</div>
                <div className="mt-1 font-display text-2xl text-gold-300">
                  {sol(overview.custody.escrowBalanceLamports, 4)}
                </div>
                <div className="mt-1 font-mono text-[11px] text-ivory/40">
                  {overview.custody.escrowBalanceLamports} lamports
                </div>
              </div>
            </div>
            <div className="mt-4">
              <Row
                label="Custody"
                value={
                  <span className="flex flex-wrap items-center justify-end gap-2">
                    <Chip tone={overview.custody.custodyReady ? "ok" : "bad"}>
                      {overview.custody.custodyReady ? "ready" : "not ready"}
                    </Chip>
                    <span className="text-xs text-ivory/60">{overview.custody.custodyReason}</span>
                  </span>
                }
              />
            </div>
          </Section>

          {/* Rules */}
          <Section
            title="Game rules"
            subtitle={overview.rules.source}
          >
            <div className="grid gap-3 md:grid-cols-3">
              {overview.rules.pools.map((pool) => {
                const meta = TIER_META[pool.tier];
                return (
                  <div key={pool.tier} className="tier-card !p-5" data-tier={pool.tier}>
                    <div className="flex items-center justify-between">
                      <span className="font-display text-lg text-ivory">
                        {meta?.emoji} {meta?.shortLabel ?? `Pool ${pool.tier + 1}`}
                      </span>
                      <Chip tone="muted">lane {pool.tier}</Chip>
                    </div>
                    <div className="mt-3 font-display text-3xl text-gold-300">{pool.capSol} ◎</div>
                    <div className="text-xs uppercase tracking-widest text-ivory/50">max pot per round</div>
                    <div className="mt-2 font-mono text-[11px] text-ivory/40">{pool.capLamports} lamports</div>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 grid gap-x-8 md:grid-cols-2">
              <Row label="Operator fee" value={<span className="font-display text-gold-300">{overview.rules.feePercent} %</span>} hint={`${overview.rules.feeBps} bps`} />
              <Row label="Winner share" value={`${overview.rules.winnerSharePercent} %`} />
              <Row label="Min deposit" value={sol(overview.rules.minDepositLamports)} />
              <Row label="Max deposit" value={sol(overview.rules.maxDepositLamports)} />
              <Row label="Commission accrued" value={sol(overview.fees.accruedLamports)} />
              <Row label="Reveal offset" value={`${overview.rules.revealOffsetSlots} slots`} />
            </div>
          </Section>

          {/* Deposit control */}
          <Section
            title="Deposits"
            subtitle="The only switch this console can change. It never touches rounds, winners or payouts."
            actions={
              <Chip tone={paused ? "bad" : "ok"}>{deposits?.state ?? "—"}</Chip>
            }
          >
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => void toggleDeposits(!paused)}
                className={paused ? "btn-gold" : "btn-ghost"}
              >
                {busy ? "Working…" : paused ? "Resume deposits" : "Pause deposits"}
              </button>
              <span className="text-sm text-ivory/60">
                {paused
                  ? deposits?.reason
                  : deposits?.canAccept
                    ? "New deposits are accepted."
                    : deposits?.blockedReason}
              </span>
            </div>
            <div className="mt-4 grid gap-x-8 md:grid-cols-2">
              <Row label="Accepting deposits" value={deposits?.canAccept ? "yes" : "no"} />
              <Row label="Last change" value={`${time(deposits?.updatedAt)} · ${deposits?.updatedBy}`} />
            </div>
            <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-amber-200/80">
              Pausing only refuses NEW deposit intents. Transfers already in flight stay confirmable, full
              rounds still lock, winners are still chosen and paid, and the next round still opens — the
              platform keeps running by itself.
            </p>
          </Section>

          {/* Rounds */}
          <Section
            title="Rounds"
            subtitle={`${overview.rounds.openCount} open · ${overview.rounds.completedCount} completed · open pot ${sol(overview.rounds.openPotLamports)}`}
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="stat-label mb-2">Open</h3>
                <ul className="divide-y divide-felt-700">
                  {(rounds?.open ?? []).map((round) => (
                    <li key={`open-${round.id}`} className="py-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-gold-300">#{round.id}</span>
                        <span className="font-mono text-xs text-ivory/50">lane {round.tier}</span>
                        <StatusPill status={round.status} />
                        <span className="text-sm text-ivory/80">
                          {sol(round.potLamports)} / {sol(round.capLamports)}
                        </span>
                        <span className="text-xs text-ivory/50">{round.participantCount} players</span>
                      </div>
                    </li>
                  ))}
                  {(rounds?.open ?? []).length === 0 ? (
                    <li className="py-2.5 text-sm text-ivory/50">No open round.</li>
                  ) : null}
                </ul>
              </div>
              <div>
                <h3 className="stat-label mb-2">Completed</h3>
                <ul className="divide-y divide-felt-700">
                  {(rounds?.completed ?? []).slice(0, 12).map((round) => (
                    <li key={`done-${round.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                      <span className="text-gold-300">#{round.id}</span>
                      <span className="font-mono text-xs text-ivory/60">{short(round.winner)}</span>
                      <span className="text-ivory/70">{sol(round.payoutLamports)}</span>
                      <span className="text-xs text-ivory/50">fee {sol(round.feeLamports)}</span>
                      <Chip tone={round.payoutConfirmed ? "ok" : "warn"}>
                        {round.payoutConfirmed ? "paid" : "unpaid"}
                      </Chip>
                    </li>
                  ))}
                  {(rounds?.completed ?? []).length === 0 ? (
                    <li className="py-2.5 text-sm text-ivory/50">No settled round yet.</li>
                  ) : null}
                </ul>
                <div className="mt-3 text-xs text-ivory/50">
                  settled payouts {sol(overview.rounds.settledPayoutLamports)} · fees{" "}
                  {sol(overview.rounds.settledFeeLamports)}
                </div>
              </div>
            </div>
          </Section>

          {/* Transactions */}
          <Section
            title="Deposit & payout transactions"
            subtitle="PENDING → CONFIRMED | FAILED. The chain decides; a database row never does."
            actions={
              <div className="flex flex-wrap gap-1.5">
                {(["ALL", "DEPOSIT", "PAYOUT", "FAILED"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setTxFilter(f)}
                    className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider transition ${
                      txFilter === f
                        ? "border-gold-500 text-gold-300"
                        : "border-felt-600 text-ivory/50 hover:text-ivory/80"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            }
          >
            <div className="mb-3 flex flex-wrap gap-2">
              <Chip tone="muted">deposits {JSON.stringify(txs?.counts.deposits ?? {})}</Chip>
              <Chip tone="muted">payouts {JSON.stringify(txs?.counts.payouts ?? {})}</Chip>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-widest text-ivory/50">
                    <th className="py-2 pr-3">Kind</th>
                    <th className="py-2 pr-3">State</th>
                    <th className="py-2 pr-3">Round</th>
                    <th className="py-2 pr-3">Wallet</th>
                    <th className="py-2 pr-3">Amount</th>
                    <th className="py-2 pr-3">Fee</th>
                    <th className="py-2 pr-3">Transaction</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-felt-700/80">
                  {filteredTxs.map((tx) => (
                    <tr key={tx.id}>
                      <td className="py-2.5 pr-3 text-xs uppercase text-ivory/60">{tx.kind}</td>
                      <td className="py-2.5 pr-3">
                        <TxBadge status={tx.status} />
                      </td>
                      <td className="py-2.5 pr-3 text-gold-300">#{tx.roundId}</td>
                      <td className="py-2.5 pr-3 font-mono text-xs text-ivory/70">{short(tx.wallet)}</td>
                      <td className="py-2.5 pr-3 text-gold-300">{sol(tx.amountLamports)}</td>
                      <td className="py-2.5 pr-3 text-xs text-ivory/50">
                        {tx.feeLamports && tx.feeLamports !== "0" ? sol(tx.feeLamports) : "—"}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-[11px]">
                        {tx.signature ? (
                          <a
                            href={tx.explorer ?? "#"}
                            target="_blank"
                            rel="noreferrer"
                            className="text-ivory/70 underline decoration-dotted hover:text-gold-300"
                          >
                            {tx.signature.slice(0, 12)}… ↗
                          </a>
                        ) : (
                          <span className="italic text-ivory/30">not submitted</span>
                        )}
                        {tx.error ? (
                          <div className="max-w-xs truncate text-[11px] text-roulette-red/90" title={tx.error}>
                            {tx.error}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {filteredTxs.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-3 text-ivory/50">
                        No transactions recorded in this process yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Logs */}
          <Section
            title="Transaction & error log"
            subtitle="The same redacted lines the server writes. Secrets are stripped before they are stored."
            actions={
              <div className="flex flex-wrap gap-1.5">
                {(["info", "warn", "error"] as const).map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => setLogLevel(lvl)}
                    className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider transition ${
                      logLevel === lvl
                        ? "border-gold-500 text-gold-300"
                        : "border-felt-600 text-ivory/50 hover:text-ivory/80"
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            }
          >
            <ul className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
              {logs.map((entry, i) => (
                <li
                  key={`${entry.ts}-${i}`}
                  className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 font-mono text-[11px] leading-relaxed"
                >
                  <span className="text-ivory/40">{time(entry.ts)} </span>
                  <span
                    className={
                      entry.level === "error"
                        ? "text-roulette-red"
                        : entry.level === "warn"
                          ? "text-amber-300"
                          : "text-ivory/60"
                    }
                  >
                    {entry.level.toUpperCase().padEnd(5)}
                  </span>{" "}
                  <span className="text-gold-300">{entry.event}</span>
                  {Object.keys(entry.fields).length > 0 ? (
                    <span className="text-ivory/45"> {JSON.stringify(entry.fields)}</span>
                  ) : null}
                </li>
              ))}
              {logs.length === 0 ? <li className="text-sm text-ivory/50">No log entries buffered.</li> : null}
            </ul>
          </Section>

          <Section title="Security" subtitle="What this console can and cannot reach.">
            <div className="grid gap-x-8 md:grid-cols-2">
              <Row label="Admin token" value={overview.security.adminTokenConfigured ? "configured" : "missing"} />
              <Row
                label="Secrets in this response"
                value={overview.security.secretsInThisResponse ? "yes (bug!)" : "none"}
              />
              <Row label="Key material in browser" value="never" />
              <Row label="Settlement" value="automatic — no manual action" />
            </div>
            <p className="mt-4 text-xs leading-relaxed text-ivory/50">{overview.security.note}</p>
          </Section>
        </div>
      ) : null}

      <footer className="mt-10 border-t border-felt-700 pt-6 text-center text-xs text-ivory/40">
        Deposits, round closing, winner selection, the 7.5% fee and payouts run automatically. This console
        observes them and can switch deposits off — nothing else.
      </footer>
    </main>
  );
}
