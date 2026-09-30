#!/usr/bin/env node
/**
 * set-render-fee.mjs — set PLATFORM_FEE_BPS on the Render API service.
 *
 * Uses a PER-VARIABLE update (PUT /services/:id/env-vars/:envVarId) so it can
 * never touch the other variables on the service: Render's list PUT endpoint
 * REPLACES the whole list, which would delete every secret whose value Render
 * does not echo back. This script reads the list only to find the variable's
 * id, updates exactly that one, then reads back and verifies. Values are never
 * printed.
 *
 *   RENDER_API_KEY=… node scripts/set-render-fee.mjs <service-id> <fee_bps>
 */
import { timingSafeEqual } from "node:crypto";

const base = process.env.RENDER_API_BASE?.trim() || "https://api.render.com/v1";
const apiKey = process.env.RENDER_API_KEY?.trim();
const [serviceId, feeBpsArg] = process.argv.slice(2);
const feeBps = String(Number(feeBpsArg ?? 200));
const KEY = "PLATFORM_FEE_BPS";

if (!apiKey) {
  console.error("RENDER_API_KEY missing (set it in the environment) — nothing sent.");
  process.exit(1);
}
if (!serviceId?.startsWith("srv-")) {
  console.error("usage: node scripts/set-render-fee.mjs <srv-…> <fee_bps>");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

async function call(path, init = {}) {
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : [];
  } catch {
    json = { message: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, json };
}

/** Render lists items as { envVar: { id, key, value } } (older shape: flat). */
const unwrap = (payload) =>
  (Array.isArray(payload) ? payload : payload.envVars ?? []).map((e) => e.envVar ?? e);

const current = await call(`/services/${serviceId}/env-vars`);
if (!current.ok) {
  console.error(`Render refused the read (HTTP ${current.status}) — nothing sent.`);
  process.exit(1);
}
const existing = unwrap(current.json);
const before = existing.find((e) => e.key === KEY)?.value;
if (before === undefined) {
  console.error(`${KEY} not found on the service — create it once in the dashboard first.`);
  process.exit(1);
}

// Per-variable PUT: Render addresses the variable by NAME, and it touches
// exactly that one — secrets on the service can never be lost (the list-PUT
// endpoint would REPLACE everything).
const put = await call(`/services/${serviceId}/env-vars/${KEY}`, {
  method: "PUT",
  body: JSON.stringify({ value: feeBps }),
});
if (!put.ok) {
  console.error(`Render rejected the update (HTTP ${put.status}) — nothing else touched.`);
  process.exit(1);
}

const verify = await call(`/services/${serviceId}/env-vars`);
const row = unwrap(verify.json).find((e) => e.key === KEY);
const newValue = row?.value;
const verified =
  typeof newValue === "string" &&
  newValue.length === feeBps.length &&
  timingSafeEqual(Buffer.from(newValue), Buffer.from(feeBps));

console.log(`service           ${serviceId}`);
console.log(`${KEY} previous ${before ?? "(unset)"}`);
console.log(`${KEY} now      ${newValue ?? "?"} ${verified ? "(verified)" : "(MISMATCH)"}`);
console.log(verified ? "\nOK — redeploy the service to apply." : "\nFAILED — check the Render dashboard.");
process.exit(verified ? 0 : 1);
