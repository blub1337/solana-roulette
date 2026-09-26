#!/usr/bin/env node
/**
 * set-render-operator-key-single.mjs — set ONLY OPERATOR_KEYPAIR on Render,
 * touching nothing else.
 *
 * Why this exists: Render's read endpoint may return variables whose value it
 * hides (synced/sealed variables). The full-replace endpoint
 * (PUT /v1/services/:id/env-vars) DELETES anything omitted, so the main
 * set-render-operator-key.mjs rightly refuses to run in that situation. This
 * script uses the single-variable endpoints instead, which cannot delete
 * anything:
 *
 *   POST  /v1/services/:serviceId/env-vars             — create (key absent)
 *   PATCH /v1/services/:serviceId/env-vars/:envVarId   — update (key present)
 *
 *   PUT /v1/services/:serviceId/env-vars/OPERATOR_KEYPAIR — add or update
 *       exactly one variable (per Render's public OpenAPI spec). This route
 *       cannot create, replace or delete any other variable.
 *
 * The secret is read from operator-devnet.key.json (mode 600, gitignored) —
 * the SAME key, never a newly generated one. It is never printed, echoed,
 * logged or accepted as an argument; output is additionally scrubbed of the
 * secret before anything is written to the terminal.
 *
 * Credentials (from the environment, never from arguments):
 *   RENDER_API_KEY     Render API key (secret)
 *   RENDER_SERVICE_ID  srv-… of the API service
 *
 *   RENDER_API_KEY=… RENDER_SERVICE_ID=srv-… \
 *     node scripts/set-render-operator-key-single.mjs
 *
 * Env changes are NOT live until you trigger "Save & Deploy" in Render.
 *
 * DEVNET ONLY. Use a different key for mainnet.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_FILE = process.env.OPERATOR_KEY_FILE?.trim() || join(REPO_ROOT, "operator-devnet.key.json");
const ENV_KEY = "OPERATOR_KEYPAIR";
const BASE = process.env.RENDER_API_BASE?.trim() || "https://api.render.com/v1";
/** Public guard: the script refuses to push anything but this wallet's key. */
const EXPECTED_ADDRESS =
  process.env.EXPECTED_OPERATOR_ADDRESS?.trim() || "FgEPpAmLLiod4RyBhUcLdvpzPGiBdotoEawyPqyftg1q";

const ok = (msg) => console.log(`  ✔ ${msg}`);
const info = (msg) => console.log(`    ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const die = (message, code = 1) => {
  console.error(`\n  ✖ ${message}\n`);
  process.exit(code);
};

// ---------------------------------------------------------------------------
// key file — identical rules to set-render-operator-key.mjs
// ---------------------------------------------------------------------------

function loadKey() {
  if (!existsSync(KEY_FILE)) {
    die(`${KEY_FILE} not found. This script never generates keys.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(KEY_FILE, "utf8"));
  } catch {
    die(`${KEY_FILE} is not valid JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    die(`${KEY_FILE} must be a JSON array of 64 bytes.`);
  }
  if (!parsed.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) {
    die(`${KEY_FILE} contains values outside 0..255.`);
  }
  const address = Keypair.fromSecretKey(Uint8Array.from(parsed)).publicKey.toBase58();
  if (address !== EXPECTED_ADDRESS) {
    die(
      `Address mismatch — refusing to continue.\n` +
        `      expected: ${EXPECTED_ADDRESS}\n` +
        `      in file:  ${address}`
    );
  }
  return { secret: JSON.stringify(parsed), address };
}

/** Non-reversible fingerprint: proves which key was sent without disclosing it. */
const fingerprint = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const asList = (text) => {
  let json;
  try {
    json = text ? JSON.parse(text) : [];
  } catch {
    return null;
  }
  const list = Array.isArray(json) ? json : json?.envVars;
  if (!Array.isArray(list)) return null;
  // Render's list endpoints wrap each row as { envVar: { key, value }, cursor }.
  return list.map((e) => e?.envVar ?? e);
};

async function render(path, init, apiKey, secret) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  // Belt and braces: no error path may ever echo the secret.
  return { ok: res.ok, status: res.status, text: secret ? text.replaceAll(secret, "[redacted]") : text };
}

// ---------------------------------------------------------------------------

const { secret, address } = loadKey();

const apiKey = process.env.RENDER_API_KEY?.trim();
if (!apiKey) {
  die(
    "RENDER_API_KEY is not set — nothing was sent.\n" +
      "      Add it in Settings → Environment (workspace) or export it for this command.\n" +
      "      It is read from the environment only, never from arguments."
  );
}
const serviceId = process.env.RENDER_SERVICE_ID?.trim();
if (!serviceId) die("RENDER_SERVICE_ID is not set — nothing was sent.");

console.log("\n  DEVNET operator wallet");
info(`address      ${address}`);
info(`fingerprint  sha256:${fingerprint(secret)}  (safe to share — proves which key)`);
info(`mode         single-variable — existing variables are never sent anywhere`);

// 1) Read the current list. We need only keys and ids — values are ignored,
//    so opaque (hidden-value) variables are irrelevant to this flow.
const first = await render(`/services/${serviceId}/env-vars`, {}, apiKey, secret);
if (!first.ok) {
  die(
    `Render refused the read (HTTP ${first.status}). Nothing was sent.\n` +
      `      ${first.text.slice(0, 200)}`
  );
}
const before = asList(first.text);
if (!before) die("Unexpected payload from Render — nothing was sent.");
const beforeKeys = before.map((e) => e.key);
ok(`${before.length} existing variable(s) read — none of them will be replaced or deleted`);

const existingRow = before.find((e) => e?.key === ENV_KEY);

// 2) Create or update ONLY this variable via the keyed endpoint. The path
//    carries the variable name, so no other variable can be affected — and
//    unlike the collection PUT, nothing has to be sent back to Render.
const put = await render(`/services/${serviceId}/env-vars/${ENV_KEY}`, {
  method: "PUT",
  body: JSON.stringify({ value: secret }),
}, apiKey, secret);
if (!put.ok) {
  die(
    `Render rejected the single-variable write (HTTP ${put.status}).\n` +
      `      ${put.text.slice(0, 300)}\n` +
      "      No other variable was touched."
  );
}
ok(`${ENV_KEY} ${existingRow ? "updated in place" : "created"} (PUT on the single-variable route)`);

// 3) Verify. Render may hide secret values on read (the same reason this
//    service's other secret vars come back opaque), so:
//      a) single retrieve — if the value is readable, byte-compare it;
//      b) list read — the key must exist and no other key may have vanished.
/**
 * Classify a value Render returned — without ever printing it.
 * "match" = byte-identical (or the same 64 bytes in an equivalent
 * representation). "masked" = Render hides the value on read (returns a
 * placeholder). "mismatch" = genuinely different key material.
 */
const classify = (value) => {
  if (typeof value !== "string") return { kind: "absent" };
  if (same(value, secret)) return { kind: "match" };
  try {
    const arr = JSON.parse(value);
    if (Array.isArray(arr) && arr.length === 64 && arr.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) {
      const addr = Keypair.fromSecretKey(Uint8Array.from(arr)).publicKey.toBase58();
      return addr === address ? { kind: "match" } : { kind: "mismatch" };
    }
  } catch {
    /* not JSON — a masked placeholder */
  }
  return { kind: "masked", length: value.length };
};

let verdict = { kind: "absent" };
let maskedLen = null;
const single = await render(`/services/${serviceId}/env-vars/${ENV_KEY}`, {}, apiKey, secret);
if (single.ok) {
  let body = null;
  try { body = JSON.parse(single.text); } catch {}
  const value = body?.envVar?.value ?? body?.value;
  const c = classify(value);
  if (c.kind === "mismatch") die("Render holds a DIFFERENT key than the one sent — check the dashboard.");
  if (c.kind === "masked") { verdict = c; maskedLen = c.length; }
  else if (c.kind === "match") verdict = c;
}
const second = await render(`/services/${serviceId}/env-vars`, {}, apiKey, secret);
if (!second.ok) die(`Could not verify (HTTP ${second.status}) — check the Render dashboard.`);
const after = asList(second.text);
if (!after) die("Could not parse the verification read — check the Render dashboard.");
const row = after.find((e) => e?.key === ENV_KEY);
if (!row) die(`${ENV_KEY} is NOT in Render's list after the write — check the dashboard.`);
if (verdict.kind !== "match") {
  const c = classify(row.value);
  if (c.kind === "mismatch") die("Render holds a DIFFERENT key than the one sent — check the dashboard.");
  if (c.kind === "masked") { verdict = c; maskedLen = c.length; }
  else if (c.kind === "match") verdict = c;
}
const afterKeys = after.map((e) => e.key);
const missing = beforeKeys.filter((k) => !afterKeys.includes(k));
if (missing.length > 0) {
  die(`UNEXPECTED: these variables disappeared: ${missing.join(", ")} — restore them in Render.`);
}

console.log("");
ok(`${ENV_KEY} is set on service ${serviceId} (sha256:${fingerprint(secret)})`);
if (verdict.kind === "match") {
  ok("value re-read from Render and verified against the local key");
} else if (verdict.kind === "masked") {
  warn(`Render masks the stored value on read (read-back is ${maskedLen} chars, not key material) —`);
  info("a byte-compare via the API is therefore impossible. The write was");
  info("accepted (2xx) and the value PUT comes from the verified local key");
  info(`file (address ${address}). Confirm the fingerprint in the dashboard.`);
} else {
  die("Verification inconclusive — check the Render dashboard.");
}
info(`address            ${address}`);
info(`variables before   ${before.length}`);
info(`variables after    ${after.length}`);
info(`variables lost     none (${missing.length === 0 ? "verified" : "FAILED"})`);
warn("env changes are NOT live yet — trigger “Save & Deploy” in Render (this script never deploys)");
console.log("");
