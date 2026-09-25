/**
 * Runtime operator state: the deposit kill switch.
 *
 * The ONLY thing the admin console may change at runtime. It gates
 * `POST /api/round/:id/deposit/intent` — a paused switch refuses to open new
 * deposit intents while the chain, the settlement driver and the payout path
 * keep running unattended. Nothing here can move a lamport, pick a winner or
 * change a fee: those stay enforced by the program and by the env/on-chain
 * configuration (docs/ADMIN.md §3).
 *
 * Pausing is deliberately NOT a rollback:
 *   - deposits already in flight stay confirmable — their money is already on
 *     the chain and must never be stranded,
 *   - rounds that are full keep settling and paying winners,
 *   - the next round still opens automatically.
 *
 * Persistence: the flag is written through to the PostgreSQL audit mirror
 * (`admin_state`) so a restart or a redeploy cannot silently re-enable
 * deposits. Without `DATABASE_URL` it is in-memory only and falls back to the
 * `DEPOSITS_PAUSED` env default on boot.
 */
import { txLog } from "./logger.js";
import { postgresMirror } from "./store.js";

/** The API must boot even if Postgres is slow — the read is capped. */
const ADMIN_STATE_DB_TIMEOUT_MS = 3_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`admin state read timed out after ${ms}ms`)), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

export type DepositSwitch = "ACTIVE" | "PAUSED";

export interface DepositStateView {
  state: DepositSwitch;
  paused: boolean;
  /** Why deposits cannot be taken right now ("" when they can). */
  reason: string;
  updatedAt: string;
  updatedBy: string;
  /** true when the current value came back from the database, not the env. */
  restoredFromDatabase: boolean;
}

let state: DepositSwitch = "ACTIVE";
let updatedAt = new Date().toISOString();
let updatedBy = "boot";
let restored = false;

/** Seed the boot default from config (`DEPOSITS_PAUSED`). Idempotent. */
export function initAdminState(defaultPaused: boolean): void {
  state = defaultPaused ? "PAUSED" : "ACTIVE";
  updatedBy = "env:DEPOSITS_PAUSED";
}

export function depositsPaused(): boolean {
  return state === "PAUSED";
}

export function depositState(): DepositStateView {
  return {
    state,
    paused: state === "PAUSED",
    reason: state === "PAUSED" ? "paused by the operator from the admin console" : "",
    updatedAt,
    updatedBy,
    restoredFromDatabase: restored,
  };
}

/**
 * Flip the switch. Idempotent, and every change is written to the transaction
 * log (without the caller's token — the log must never contain it).
 */
export function setDepositsPaused(paused: boolean, actor = "admin"): DepositStateView {
  const next: DepositSwitch = paused ? "PAUSED" : "ACTIVE";
  if (next === state) return depositState();
  state = next;
  updatedAt = new Date().toISOString();
  updatedBy = actor;
  restored = false;
  txLog[paused ? "warn" : "info"](paused ? "admin.deposits_paused" : "admin.deposits_resumed", {
    actor,
    state,
    network: "devnet",
  });
  postgresMirror.upsertAdminState(state);
  return depositState();
}

/**
 * Restore the flag from the audit mirror at boot.
 *
 * Never throws and never blocks startup: a missing, slow or unreachable
 * database just means the env default stays in effect (the read is capped so a
 * hanging database cannot delay the API). The only state it may install is
 * PAUSED — an operator who paused deposits before a restart must not have that
 * silently undone by a database hiccup. If that matters, also set
 * `DEPOSITS_PAUSED=true` in the environment: the env default wins on failure.
 */
export async function hydrateAdminState(): Promise<DepositStateView> {
  try {
    const persisted = await withTimeout(postgresMirror.readAdminState(), ADMIN_STATE_DB_TIMEOUT_MS);
    if (persisted === "PAUSED" && state !== "PAUSED") {
      state = "PAUSED";
      updatedBy = "database";
      restored = true;
      updatedAt = new Date().toISOString();
      txLog.warn("admin.deposits_paused", { actor: "database", state, restored: true });
    } else if (persisted === "ACTIVE" && state === "PAUSED" && updatedBy === "env:DEPOSITS_PAUSED") {
      state = "ACTIVE";
      updatedBy = "database";
      restored = true;
      updatedAt = new Date().toISOString();
      txLog.info("admin.deposits_resumed", { actor: "database", state, restored: true });
    }
  } catch (err) {
    txLog.warn("admin.state_restore_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return depositState();
}

/** Test-only reset so one suite cannot leak a pause into the next. */
export function resetAdminStateForTests(): void {
  state = "ACTIVE";
  updatedBy = "test";
  updatedAt = new Date().toISOString();
  restored = false;
}
