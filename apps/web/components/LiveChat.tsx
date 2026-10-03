"use client";

/**
 * Always-visible live chat (NOT a popup).
 *
 * The wallet is optional: a signed wallet is the strong identity, otherwise the
 * chat runs as a guest (see useChat). The user picks the LOBBY themselves — the
 * channel a message is tagged with and shown in — and the choice is remembered
 * across pages.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../hooks/useChat";

/** Selectable lobby channels (the `page` tag the chat filters on). */
const LOBBIES = [
  { id: "/", label: "Lobby" },
  { id: "/pool/0", label: "🟢 1 SOL" },
  { id: "/pool/1", label: "🔵 10 SOL" },
  { id: "/pool/2", label: "🟣 100 SOL" },
] as const;

const LOBBY_KEY = "solroll:chat-lobby";

/** Shorten a wallet for display: 4 chars + … + 4. */
const short = (w: string) => (w.length > 12 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);
/** Guests have a server-issued identity (`g_…`) — label them, don't fake a wallet. */
const label = (w: string) => (w.startsWith("g_") ? "Guest" : short(w));

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function LiveChat({ defaultLobby = "/", className = "" }: { defaultLobby?: string; className?: string }) {
  const [lobby, setLobby] = useState(defaultLobby);
  const { messages, send, sending, error, authBusy, identity, isGuest, connected } = useChat(lobby);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const activeLabel = useMemo(() => LOBBIES.find((l) => l.id === lobby)?.label ?? "Lobby", [lobby]);

  // Restore the last chosen lobby after mount (localStorage is client-only, so
  // this runs in an effect to keep the server/client first render identical).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LOBBY_KEY);
      if (saved && LOBBIES.some((l) => l.id === saved)) setLobby(saved);
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LOBBY_KEY, lobby);
    } catch {
      /* ignore */
    }
  }, [lobby]);

  // Auto-scroll to the newest message.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length, lobby]);

  // Chat works without a wallet: guests get a server-issued identity, so the
  // input is never gated on a connection or a signature.
  const canSubmit = draft.trim().length > 0 && draft.length <= 280 && !sending;

  const submit = async () => {
    if (!canSubmit) return;
    const ok = await send(draft);
    if (ok) setDraft("");
  };

  return (
    <div
      className={`flex h-[30rem] flex-col overflow-hidden rounded-2xl border border-felt-600/70 bg-felt-950/95 shadow-gold-glow backdrop-blur ${className}`}
    >
      <header className="flex items-center justify-between gap-3 border-b border-felt-700/70 px-4 py-3">
        <div className="min-w-0">
          <h2 className="font-display text-sm text-gold-300">Live chat</h2>
          <p className="truncate text-[11px] text-ivory/50">{activeLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="chat-lobby">
            Lobby
          </label>
          <select
            id="chat-lobby"
            value={lobby}
            onChange={(e) => setLobby(e.target.value)}
            className="rounded-lg border border-felt-600 bg-felt-900/80 px-2 py-1 text-xs text-ivory/80 transition hover:border-gold-500/50 focus:border-gold-500/60 focus:outline-none"
          >
            {LOBBIES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-ivory/50">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            live
          </span>
        </div>
      </header>

      <div ref={listRef} className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="pt-8 text-center text-xs text-ivory/40">No messages yet — be the first to deal! 🎲</p>
        )}
        {messages.map((m) => {
          const mine = m.wallet === identity;
          return (
            <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
              <div className="flex items-baseline gap-2 text-[11px] text-ivory/50">
                <span className="font-mono text-gold-300/80">{label(m.wallet)}</span>
                <span>{timeLabel(m.ts)}</span>
              </div>
              <div
                className={`mt-0.5 max-w-[85%] rounded-xl px-3 py-1.5 text-sm leading-snug ${
                  mine ? "bg-gold-500/20 text-ivory" : "border border-felt-700 bg-felt-900/80 text-ivory/90"
                }`}
              >
                {m.text}
              </div>
            </div>
          );
        })}
      </div>

      {error && <p className="border-t border-felt-700/70 px-4 py-2 text-[11px] text-roulette-red">{error}</p>}

      <footer className="border-t border-felt-700/70 p-3">
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            maxLength={280}
            placeholder={authBusy ? "Connecting…" : "Message…"}
            className="min-w-0 flex-1 rounded-xl border border-felt-600 bg-felt-900/80 px-3 py-2 text-sm text-ivory placeholder:text-ivory/30 focus:border-gold-500/60 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="shrink-0 rounded-xl bg-gradient-to-b from-gold-400 to-gold-500 px-3 py-2 text-sm font-semibold text-felt-950 transition hover:from-gold-300 disabled:opacity-40"
          >
            {sending ? "…" : "Send"}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-ivory/45">
          {isGuest
            ? "You're chatting as a guest — connect your wallet to use your name."
            : connected
              ? "Chatting through your wallet."
              : "No wallet needed — you'll chat as a guest."}
        </p>
      </footer>
    </div>
  );
}
