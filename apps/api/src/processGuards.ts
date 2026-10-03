/**
 * Last-resort process guards.
 *
 * The API must degrade, not die. Observed live: while the public devnet RPC was
 * rate-limiting us, @solana/web3.js's JSON-RPC client surfaced a
 * `429 Too Many Requests` through a callback that nothing awaited, Node turned
 * it into an unhandled rejection, and the whole API process died — the UI kept
 * serving on :3001 while the public port went dark ("connection refused").
 *
 * Every awaited path already catches its own RPC errors (deposits, settlement,
 * history); the guards are only for the fire-and-forget paths inside third-party
 * transports that no single call site owns. Logging loudly keeps the failure
 * visible; the settlement driver re-derives state from the chain on its next
 * tick, and the verify-first deposit/payout paths never credit or pay without
 * re-reading the chain, so continuing to listen is safe by construction.
 *
 * This mirrors the precedent in store.ts, where the postgres client's 'error'
 * event must be handled or Node kills the process on a dropped connection.
 *
 * Installed only by the real entrypoint (server.ts start()), never on import,
 * so the test runner keeps its own crash semantics.
 */

let installed = false;

/** Idempotent: repeated calls never stack duplicate handlers. */
export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason: unknown) => {
    console.error(
      "[process] unhandled rejection (process stays up):",
      reason instanceof Error ? reason.stack ?? reason.message : reason
    );
  });

  process.on("uncaughtException", (err: Error) => {
    console.error("[process] uncaught exception (process stays up):", err.stack ?? err.message);
  });
}
