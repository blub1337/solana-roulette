"use client";

import { useEffect, useRef } from "react";
import { API_BASE } from "../lib/apiBase";

const API = API_BASE; // production-safe API base (same-origin in dev)

export interface SseMessage {
  type: string;
  roundId?: string;
  data?: Record<string, unknown>;
  ts: number;
}

/**
 * Live round updates from the API's SSE stream (deposits, pot changes, lock,
 * winner, settlement, new round). `onEvent` fires on every message; the hooks
 * refetch so all state stays derived from the runtime, never from the event
 * payload itself. Polling stays in place as a fallback.
 */
export function useSse(onEvent: (ev: SseMessage) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const source = new EventSource(`${API}/api/events`);
    const forward = (ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(ev.data) as SseMessage;
        if (parsed && typeof parsed.type === "string") handler.current(parsed);
      } catch {
        /* ignore malformed frames */
      }
    };
    const types = [
      "deposit",
      "pot",
      "participant",
      "round_full",
      "lock",
      "randomness_arrived",
      "winner",
      "settlement",
      "new_round",
      "tx",
      "config",
      "chat",
    ];
    for (const t of types) source.addEventListener(t, forward as EventListener);
    return () => {
      for (const t of types) source.removeEventListener(t, forward as EventListener);
      source.close();
    };
  }, []);
}
