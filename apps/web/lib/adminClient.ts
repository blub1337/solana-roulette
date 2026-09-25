/**
 * Admin API client.
 *
 * The admin token is a server secret the operator typed into the console. It
 * lives in `sessionStorage` only (never `localStorage`, never a cookie, never
 * in the URL) so it disappears when the tab closes, and it is sent in the
 * `x-admin-token` header on every admin request.
 *
 * It is never a Solana key: it grants read access to operational data and the
 * deposit kill switch, nothing else. There is no field anywhere in this app
 * that can store, display or transmit `OPERATOR_KEYPAIR` or a private key.
 */
const STORAGE_KEY = "solana-roulette.admin-token";

const API = process.env.NEXT_PUBLIC_API_URL ?? ""; // same-origin proxy

export class AdminApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "AdminApiError";
  }

  /** True when the server has no ADMIN_TOKEN configured at all. */
  get notConfigured(): boolean {
    return this.code === "admin_not_configured";
  }

  get unauthorized(): boolean {
    return this.status === 401;
  }
}

export function readAdminToken(): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(STORAGE_KEY) ?? "";
}

export function storeAdminToken(token: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(STORAGE_KEY, token);
}

export function clearAdminToken(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(STORAGE_KEY);
}

/** Authenticated admin request. Throws AdminApiError on any non-2xx. */
export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      "x-admin-token": readAdminToken(),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: { error?: string; detail?: string } = {};
  try {
    body = text ? (JSON.parse(text) as { error?: string; detail?: string }) : {};
  } catch {
    body = { error: "invalid_response", detail: text.slice(0, 200) };
  }
  if (!res.ok) {
    throw new AdminApiError(
      body.error ?? `http_${res.status}`,
      body.detail ?? `Admin request failed (${res.status})`,
      res.status
    );
  }
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// response shapes (mirrors apps/api/src/adminRoutes.ts)
// ---------------------------------------------------------------------------

export interface AdminOverview {
  generatedAt: string;
  system: {
    network: string;
    cluster: string;
    mainnetEnabled: boolean;
    devnetOnly: boolean;
    mainnetGate: string;
    programId: string;
    backendMode: "chain" | "local";
    backendReason: string;
    realFunds: boolean;
    rpc: { url: string; ok: boolean; slot: string | null; latencyMs: number | null; error: string | null };
  };
  custody: {
    escrow: string | null;
    feeWallet: string;
    payoutSigner: string | null;
    payoutSignerConfigured: boolean;
    custodyReady: boolean;
    custodyReason: string;
    escrowBalanceLamports: string;
    escrowExplorer: string | null;
  };
  deposits: {
    state: "ACTIVE" | "PAUSED";
    paused: boolean;
    reason: string;
    updatedAt: string;
    updatedBy: string;
    canAccept: boolean;
    blockedReason: string;
    custodyReady: boolean;
    custodyReason: string;
  };
  rules: {
    feeBps: number;
    feePercent: string;
    winnerShareBps: number;
    winnerSharePercent: string;
    minDepositLamports: string;
    maxDepositLamports: string;
    revealOffsetSlots: number;
    source: string;
    pools: Array<{ tier: number; label: string; emoji: string; capLamports: string; capSol: number }>;
  };
  fees: { wallet: string | null; accruedLamports: string };
  rounds: {
    openCount: number;
    completedCount: number;
    openPotLamports: string;
    settledFeeLamports: string;
    settledPayoutLamports: string;
    headsByTier: string[];
  };
  transactions: {
    deposits: Record<string, number>;
    payouts: Record<string, number>;
    total: number;
  };
  security: { adminTokenConfigured: boolean; secretsInThisResponse: boolean; note: string };
}

export interface AdminRoundRow {
  id: string;
  tier: number;
  status: string;
  potLamports: string;
  participantCount: number;
  capLamports: string;
  winner: string | null;
  payoutLamports: string;
  feeLamports: string;
  payoutConfirmed: boolean;
  escrow: string;
}

export interface AdminRoundsResponse {
  open: AdminRoundRow[];
  completed: AdminRoundRow[];
  summary: AdminOverview["rounds"];
}

export interface AdminTxRow {
  id: string;
  kind: "DEPOSIT" | "PAYOUT";
  status: "PENDING" | "CONFIRMED" | "FAILED" | null;
  roundId: string;
  tier: number;
  network: string;
  wallet: string;
  recipient: string;
  amountLamports: string | null;
  feeLamports: string | null;
  signature: string | null;
  explorer: string | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  confirmedAt: string | null;
}

export interface AdminTransactionsResponse {
  counts: AdminOverview["transactions"];
  transactions: AdminTxRow[];
}

export interface AdminLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  fields: Record<string, unknown>;
}
