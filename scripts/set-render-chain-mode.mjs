/**
 * Switch the Render API service to chain mode and point it at the deployed
 * program — then trigger a redeploy so the values go live.
 *
 *   node scripts/set-render-chain-mode.mjs [--no-deploy]
 *
 * Requires RENDER_API_KEY in the environment (never printed, never logged).
 * RENDER_SERVICE_ID defaults to the known API service id.
 *
 * Only NON-SECRET values are written, each via Render's keyed single-variable
 * route (PUT /services/:id/env-vars/:key) so no other variable can be touched:
 *   LEDGER_MODE=chain
 *   ROULETTE_PROGRAM_ID=<from env ROULETTE_PROGRAM_ID or --program-id=…>
 *
 * The operator keypair secret is NOT handled here — it is already set via the
 * same single-variable route by scripts/set-render-operator-key-single.mjs.
 *
 * Env changes only take effect on a new deploy, so unless --no-deploy is
 * passed the script POSTs /services/:id/deploys and waits for the deploy to
 * go live, then GETs /api/health to confirm mode:"chain".
 */
import { timingSafeEqual } from "node:crypto";

const ok = (msg) => console.log(`  ✔ ${msg}`);
const info = (msg) => console.log(`    ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const die = (message, code = 1) => {
  console.error(`\n  ✖ ${message}\n`);
  process.exit(code);
};

const BASE = process.env.RENDER_API_BASE?.trim() || "https://api.render.com/v1";
const SERVICE_ID = process.env.RENDER_SERVICE_ID?.trim() || "srv-darfjqt9fdbs739de5eg";
const HEALTH_URL = process.env.API_HEALTH_URL?.trim() || "https://solana-roulette-api-gd7k.onrender.com/api/health";

const PROGRAM_ID =
  process.env.ROULETTE_PROGRAM_ID?.trim() ||
  process.argv.find((a) => a.startsWith("--program-id="))?.split("=")[1];
const DO_DEPLOY = !process.argv.includes("--no-deploy");

const apiKey = process.env.RENDER_API_KEY?.trim();
if (!apiKey) {
  die("RENDER_API_KEY is not set — nothing was sent. Add it in Settings → Environment.");
}
if (!PROGRAM_ID || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(PROGRAM_ID)) {
  die("ROULETTE_PROGRAM_ID missing/invalid — pass a base58 program id.");
}

const render = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, json };
};

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

console.log(`\n  Render service ${SERVICE_ID}`);

// 0) Sanity: current var list (keys only) — must contain the operator key.
const before = await render(`/services/${SERVICE_ID}/env-vars`);
if (!before.ok) die(`Render refused the read (HTTP ${before.status}). Nothing was sent.`);
const keysBefore = (Array.isArray(before.json) ? before.json : before.json?.envVars ?? [])
  .map((e) => e?.envVar?.key ?? e?.key)
  .filter(Boolean);
ok(`${keysBefore.length} existing variable(s) — none will be replaced or deleted`);
if (!keysBefore.includes("OPERATOR_KEYPAIR")) {
  warn("OPERATOR_KEYPAIR is NOT set on this service — chain mode will fail to sign!");
  warn("Run scripts/set-render-operator-key-single.mjs first.");
}

// 1) Write the two public variables via the keyed routes.
for (const [key, value] of [
  ["LEDGER_MODE", "chain"],
  ["ROULETTE_PROGRAM_ID", PROGRAM_ID],
]) {
  const put = await render(`/services/${SERVICE_ID}/env-vars/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
  if (!put.ok) die(`Render rejected ${key} (HTTP ${put.status}). No other variable was touched.`);
  ok(`${key}=${key === "ROULETTE_PROGRAM_ID" ? PROGRAM_ID : value} written`);
}

// 2) Verify the list — keys present, nothing lost.
const after = await render(`/services/${SERVICE_ID}/env-vars`);
if (!after.ok) die(`Could not verify (HTTP ${after.status}). Check the Render dashboard.`);
const keysAfter = (Array.isArray(after.json) ? after.json : after.json?.envVars ?? [])
  .map((e) => e?.envVar?.key ?? e?.key)
  .filter(Boolean);
const missing = keysBefore.filter((k) => !keysAfter.includes(k));
if (missing.length) die(`UNEXPECTED: these variables disappeared: ${missing.join(", ")}`);
ok("verified: both keys present, no variable lost");

// 3) Trigger a deploy so the values go live.
if (DO_DEPLOY) {
  const dep = await render(`/services/${SERVICE_ID}/deploys`, { method: "POST", body: "{}" });
  if (!dep.ok) die(`Deploy trigger failed (HTTP ${dep.status}): ${JSON.stringify(dep.json).slice(0, 200)}`);
  const deployId = dep.json?.id;
  ok(`deploy triggered: ${deployId}`);
  info("waiting for the deploy to go live (polling every 10s, max 8 min)…");
  const deadline = Date.now() + 8 * 60_000;
  let state = "created";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    const st = await render(`/services/${SERVICE_ID}/deploys/${deployId}`);
    state = st.json?.status ?? "unknown";
    console.log(`    deploy status: ${state}`);
    if (state === "live") break;
    if (["deactivated", "build_failed", "canceled"].includes(state)) die(`deploy ended: ${state}`);
  }
  if (state !== "live") die("deploy did not go live within 8 minutes — check the Render dashboard");
  ok("deploy is live");
} else {
  warn("--no-deploy: values are staged but NOT live until the next deploy");
}

// 4) Confirm the API actually runs in chain mode.
console.log("");
const health = await fetch(HEALTH_URL, { headers: { Accept: "application/json" } });
if (!health.ok) die(`health check failed: HTTP ${health.status} at ${HEALTH_URL}`);
const h = await health.json();
info(`mode:        ${h.mode}`);
info(`realFunds:   ${h.realFunds}`);
info(`programId:   ${h.programId}`);
info(`custodyReady:${h.custody?.custodyReady}`);
if (h.mode === "chain" && h.programId === PROGRAM_ID) {
  ok(`API is running in CHAIN mode against ${PROGRAM_ID}`);
} else {
  die(`health shows mode=${h.mode} programId=${h.programId} — expected chain/${PROGRAM_ID}`);
}
console.log("");
