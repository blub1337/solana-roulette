"use client";

/**
 * Live chat hook — the wallet is OPTIONAL.
 *
 * Preferred identity (strong): a connected, `signMessage`-capable wallet signs
 * "SolRoll chat login\n<ts>" once → POST /api/chat/auth → a 12h session token.
 *
 * Fallback (guest): no wallet, a wallet without `signMessage`, or a REJECTED
 * popup → POST /api/chat/guest → a server-issued guest token. Chatting must
 * never depend on a wallet signature, so a rejection here is not an error: we
 * simply continue as a guest and say so in the UI.
 *
 * Incoming messages arrive live over the existing SSE stream (`chat` event)
 * and merge with the page's history snapshot.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "../app/providers";
import { API_BASE } from "../lib/apiBase";
import { useSse, type SseMessage } from "./useSse";
import type { MessageSignerWalletAdapterProps } from "@solana/wallet-adapter-base";

export interface ChatMsg {
  id: string;
  wallet: string;
  name: string | null;
  page: string;
  text: string;
  ts: number;
}

/** One cached session: the token plus the identity it was issued for. */
interface ChatSession {
  token: string;
  identity: string;
}

const SESSION_KEY = "solroll:chat-session";

export const isGuestIdentity = (id: string | null | undefined): boolean =>
  typeof id === "string" && id.startsWith("g_");

function bs58Encode(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let out = "";
  let num = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  while (num > 0n) {
    out = ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

function loadSession(): ChatSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChatSession>;
    if (typeof parsed?.token === "string" && typeof parsed?.identity === "string") {
      return { token: parsed.token, identity: parsed.identity };
    }
  } catch {
    /* storage unavailable or corrupt — treat as no session */
  }
  return null;
}

function saveSession(session: ChatSession | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** Strong path: prove key possession. Returns null on any rejection/error. */
async function walletAuth(
  wallet: string,
  signMessage: NonNullable<MessageSignerWalletAdapterProps["signMessage"]>
): Promise<ChatSession | null> {
  const ts = Date.now();
  const message = new TextEncoder().encode(`SolRoll chat login\n${ts}`);
  let signature: string;
  try {
    const sig: Uint8Array = await signMessage(message);
    signature = bs58Encode(sig);
  } catch {
    return null; // user rejected in the wallet — caller falls back to guest
  }
  const res = await fetch(`${API_BASE}/api/chat/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet, signature, ts }),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { token?: string } | null;
  return data?.token ? { token: data.token, identity: wallet } : null;
}

/** Guest path: server issues an identity + token, no signature involved. */
async function guestAuth(): Promise<ChatSession | null> {
  const res = await fetch(`${API_BASE}/api/chat/guest`, { method: "POST" });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { token?: string; wallet?: string } | null;
  return data?.token && data?.wallet ? { token: data.token, identity: data.wallet } : null;
}

export function useChat(page: string) {
  const { publicKey, signMessage, connected } = useWallet();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [identity, setIdentity] = useState<string | null>(null);
  const sessionRef = useRef<ChatSession | null>(null);
  const wallet58 = publicKey?.toBase58() ?? null;

  // ---- load history for this page ------------------------------------------
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/chat?page=${encodeURIComponent(page)}`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d: { messages?: ChatMsg[] }) => {
        if (alive && Array.isArray(d.messages)) setMessages(d.messages);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [page]);

  // ---- restore a cached session so the UI knows who we are before sending ---
  useEffect(() => {
    const cached = loadSession();
    if (cached) {
      sessionRef.current = cached;
      setIdentity(cached.identity);
    }
  }, []);

  // ---- live updates over SSE ------------------------------------------------
  const onEvent = useCallback(
    (ev: SseMessage) => {
      if (ev.type !== "chat") return;
      const msg = ev.data as unknown as ChatMsg;
      if (!msg || typeof msg.id !== "string") return;
      if (ev.roundId && ev.roundId !== page) return;
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg].slice(-200)));
    },
    [page]
  );
  useSse(onEvent);

  const establishing = useRef<Promise<ChatSession | null> | null>(null);

  const ensureSession = useCallback(async (): Promise<string | null> => {
    const walletConnected = Boolean(connected && wallet58 && signMessage);
    const desiredMode = walletConnected ? "wallet" : "guest";
    const cached = sessionRef.current ?? loadSession();
    if (cached) {
      const cachedMode = isGuestIdentity(cached.identity) ? "guest" : "wallet";
      const matches = cachedMode === desiredMode && (desiredMode === "guest" || cached.identity === wallet58);
      if (matches) {
        sessionRef.current = cached;
        setIdentity(cached.identity);
        return cached.token;
      }
    }
    // Collapse concurrent callers onto one establishment.
    if (establishing.current) return (await establishing.current)?.token ?? null;

    setAuthBusy(true);
    const run = (async (): Promise<ChatSession | null> => {
      if (walletConnected && wallet58 && signMessage) {
        const signed = await walletAuth(wallet58, signMessage);
        if (signed) return signed;
        // Rejected / unsupported → guest, never an error the user must clear.
      }
      return guestAuth();
    })();
    establishing.current = run;
    try {
      const fresh = await run;
      if (!fresh) {
        setError("Chat is unavailable right now. Please try again in a moment.");
        return null;
      }
      sessionRef.current = fresh;
      saveSession(fresh);
      setIdentity(fresh.identity);
      setError(null);
      return fresh.token;
    } finally {
      establishing.current = null;
      setAuthBusy(false);
    }
  }, [connected, wallet58, signMessage]);

  // ---- send -----------------------------------------------------------------
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed || trimmed.length > 280) return false;
      setSending(true);
      setError(null);
      try {
        let token = await ensureSession();
        // A stale/expired token: one clean re-auth, then send again.
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!token) return false;
          const res = await fetch(`${API_BASE}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ text: trimmed, page }),
          });
          if (res.status === 401 && attempt === 0) {
            saveSession(null);
            sessionRef.current = null;
            token = await ensureSession();
            continue;
          }
          if (res.status === 429) {
            const body = (await res.json().catch(() => ({}))) as { detail?: string };
            setError(body.detail ?? "A moment's pause, please.");
            return false;
          }
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            setError(body.error === "message_blocked" ? "Message blocked by the chat rules." : "Message could not be sent.");
            return false;
          }
          const msg = (await res.json()) as ChatMsg;
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg].slice(-200)));
          return true;
        }
        return false;
      } finally {
        setSending(false);
      }
    },
    [page, ensureSession]
  );

  // A wallet change invalidates a session that was bound to a different wallet.
  useEffect(() => {
    const cached = sessionRef.current ?? loadSession();
    if (cached && !isGuestIdentity(cached.identity) && cached.identity !== wallet58) {
      saveSession(null);
      sessionRef.current = null;
      setIdentity(null);
    }
  }, [wallet58]);

  return {
    messages,
    send,
    sending,
    error,
    authBusy,
    identity,
    isGuest: isGuestIdentity(identity),
    wallet58,
    connected,
  };
}
