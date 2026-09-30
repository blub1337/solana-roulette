/**
 * PROVE that /api/history survives a real API restart in chain mode.
 *
 * This is the regression that motivated the fix: history used to be a
 * projection of an in-memory Map, so restarting the API emptied it. The
 * in-memory map cannot be inspected from outside the process, so the only
 * honest way to test a restart is to actually restart — this script spawns
 * the server twice as two separate OS processes and diffs what each one
 * reports.
 *
 * It runs the API READ-ONLY on purpose:
 *   LEDGER_MODE=chain  -> the real deployed program is the source of truth
 *   no OPERATOR_KEYPAIR-> the settlement driver cannot sign, so this script
 *                         can never create, lock, settle or pay a round
 *   DEPOSITS_PAUSED=true-> no deposit intent is ever opened
 *
 *   node scripts/verify-history-restart.mjs
 *
 * Exits 0 when the second process reports the same completed rounds as the
 * first, non-zero otherwise. Always kills its children.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PROGRAM = process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos";
const BASE_PORT = Number(process.env.VERIFY_PORT || 4180);
const BOOT_TIMEOUT_MS = 45_000;
const HTTP_TIMEOUT_MS = 90_000;

const childEnv = {
  ...process.env,
  LEDGER_MODE: "chain",
  ROULETTE_PROGRAM_ID: PROGRAM,
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  PLATFORM_FEE_WALLET: process.env.PLATFORM_FEE_WALLET || "6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR",
  // Explicitly empty: the driver must not be able to sign anything.
  OPERATOR_KEYPAIR: "",
  DEPOSIT_ESCROW_WALLET: "",
  DEPOSITS_PAUSED: "true",
  ADMIN_TOKEN: "",
  LOG_LEVEL: "warn",
};

const children = new Set();

function startApi(port, label) {
  // `npx tsx` spawns a child, so a signal to the npx pid alone leaves the real
  // server holding the port. Own the process group and signal the group.
  const child = spawn("npx", ["tsx", "apps/api/src/server.ts"], {
    cwd: process.cwd(),
    env: { ...childEnv, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.add(child);
  const log = [];
  child.stdout.on("data", (d) => log.push(`[${label} out] ${d}`));
  child.stderr.on("data", (d) => log.push(`[${label} err] ${d}`));
  return { child, log, label };
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

async function stopApi({ child, log, label }) {
  if (child.exitCode !== null) return;
  killGroup(child, "SIGTERM");
  const exited = await Promise.race([
    new Promise((r) => child.once("exit", () => r(true))),
    sleep(8_000).then(() => false),
  ]);
  if (!exited) {
    killGroup(child, "SIGKILL");
    await sleep(1_000);
  }
  children.delete(child);
  if (child.exitCode !== null && child.exitCode !== 0) {
    console.error(`${label} exited ${child.exitCode}\n${log.join("")}`);
  }
  // Let the OS release the listening socket before the next boot.
  await sleep(750);
}

async function getJson(port, path, timeoutMs = HTTP_TIMEOUT_MS) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function waitReady(port, api, deadline) {
  while (Date.now() < deadline) {
    if (api.child.exitCode !== null) {
      throw new Error(`server exited early (${api.child.exitCode})\n${api.log.join("")}`);
    }
    try {
      const h = await getJson(port, "/api/health", 4_000);
      if (h.ok) return h;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`server not ready in ${BOOT_TIMEOUT_MS}ms\n${api.log.join("")}`);
}

/** The fields history must carry, compared across the restart. */
function fingerprint(rounds) {
  return rounds.map((r) => ({
    id: r.id,
    status: r.status,
    tier: r.tier,
    pot: r.pot,
    participantCount: r.participantCount,
    winner: r.winner,
    winningTicket: r.winningTicket,
    payoutLamports: r.payoutLamports,
    feeLamports: r.feeLamports,
    feeBps: r.feeBps,
    randomnessHex: r.randomnessHex,
    revealInputHex: r.revealInputHex,
    payoutTxSignature: r.payoutTxSignature,
    settlementVerified: r.settlementVerified,
  }));
}

const results = [];
let failed = false;

async function runBoot(port, label) {
  const api = startApi(port, label);
  try {
    const health = await waitReady(port, api, Date.now() + BOOT_TIMEOUT_MS);
    const history = await getJson(port, "/api/history");
    const pools = await getJson(port, "/api/pools");
    const round = await getJson(port, "/api/round/1");
    return { health, history, pools, round };
  } finally {
    await stopApi(api);
  }
}

function assert(cond, message) {
  if (!cond) {
    failed = true;
    console.error(`  FAIL  ${message}`);
  } else {
    console.log(`  ok    ${message}`);
  }
}

try {
  console.log(`program ${PROGRAM}`);
  console.log(`mode    chain (read-only: no operator keypair, deposits paused)\n`);

  console.log("boot 1 — cold process");
  const first = await runBoot(BASE_PORT, "boot1");
  console.log(`  health  mode=${first.health.mode} realFunds=${first.health.realFunds}`);
  assert(first.health.mode === "chain", "boot 1 resolved the chain backend");
  const firstFp = fingerprint(first.history.rounds);
  console.log(`  history rounds=${first.history.rounds.length}`);
  assert(first.history.rounds.length > 0, "boot 1 reports completed rounds");

  console.log("\nrestarting the API as a new process…");
  await sleep(1_500);

  console.log("\nboot 2 — fresh process, empty in-memory store");
  const second = await runBoot(BASE_PORT + 1, "boot2");
  const secondFp = fingerprint(second.history.rounds);
  console.log(`  history rounds=${second.history.rounds.length}`);

  assert(second.history.rounds.length > 0, "history is NOT empty after a restart");

  if (JSON.stringify(firstFp) !== JSON.stringify(secondFp)) {
    const byId = new Map(firstFp.map((r) => [r.id, r]));
    for (const row of secondFp) {
      const before = byId.get(row.id);
      if (!before) {
        console.error(`  diff  round ${row.id} only in boot 2`);
        continue;
      }
      for (const key of Object.keys(row)) {
        if (JSON.stringify(before[key]) !== JSON.stringify(row[key])) {
          console.error(`  diff  round ${row.id} ${key}: ${JSON.stringify(before[key])} -> ${JSON.stringify(row[key])}`);
        }
      }
    }
  }
  assert(
    JSON.stringify(firstFp) === JSON.stringify(secondFp),
    "history is byte-identical across the restart"
  );

  const required = ["id", "status", "pot", "participantCount", "winner", "winningTicket", "payoutLamports", "feeLamports", "payoutTxSignature", "settlementVerified"];
  for (const r of second.history.rounds) {
    const missing = required.filter((k) => r[k] === undefined || r[k] === null);
    if (missing.length) {
      console.error(`  note   round ${r.id} has null: ${missing.join(", ")}`);
    }
  }
  const sample = second.history.rounds[0];
  if (sample) {
    console.log("\n  newest completed round after restart:");
    console.log(`    id                 ${sample.id}`);
    console.log(`    status             ${sample.status}`);
    console.log(`    pot                ${sample.pot}`);
    console.log(`    participants       ${sample.participantCount}`);
    console.log(`    winner             ${sample.winner}`);
    console.log(`    winning ticket     ${sample.winningTicket}`);
    console.log(`    payout / fee       ${sample.payoutLamports} / ${sample.feeLamports}`);
    console.log(`    randomness         ${(sample.randomnessHex || "").slice(0, 32)}…`);
    console.log(`    reveal input       ${(sample.revealInputHex || "none").slice(0, 32)}…`);
    console.log(`    payout tx          ${sample.payoutTxSignature || "none"} (${sample.payoutTxSource})`);
    console.log(`    settlementVerified ${sample.settlementVerified}`);
  }

  console.log("\nother endpoints after restart (served from the restarted process)");
  assert(second.pools.pools?.length === 3, "/api/pools returns the three lanes");
  assert(
    second.round?.round?.id === "1" && second.round.round.status === "COMPLETED",
    `/api/round/1 served from chain (status=${second.round?.round?.status})`
  );
  console.log(`  /api/pools  lanes=${second.pools.pools?.length ?? "?"}`);
  console.log(`  /api/round/1 id=${second.round?.round?.id} status=${second.round?.round?.status} pot=${second.round?.round?.potLamports}`);

  results.push({ rounds: second.history.rounds.length });
} catch (err) {
  failed = true;
  console.error("harness error:", err instanceof Error ? err.message : err);
} finally {
  for (const c of children) {
    killGroup(c, "SIGKILL");
  }
}

console.log(`\n${failed ? "RESULT: FAIL" : "RESULT: PASS"}`);
process.exit(failed ? 1 : 0);
