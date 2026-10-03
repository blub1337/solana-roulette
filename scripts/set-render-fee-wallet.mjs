#!/usr/bin/env node
/**
 * set-render-fee-wallet.mjs — set the platform FEE WALLET on Render, touching
 * nothing else.
 *
 * Writes, via Render's SINGLE-VARIABLE route (which cannot create, replace or
 * delete any other variable):
 *
 *   FEE_WALLET_KEYPAIR  = fee-wallet-devnet.key.json  (the withdraw key)
 *   PLATFORM_FEE_WALLET = the same key's public address  (only with --public)
 *
 * The secret is read from the key file, never accepted as an argument, never
 * printed, and every Render response is scrubbed of it before it reaches the
 * terminal. The script refuses to push a key whose address is not the expected
 * fee wallet, so a wrong/old key file can never silently redirect funds.
 *
 * Credentials (environment only):
 *   RENDER_API_KEY     Render API key (secret)
 *   RENDER_SERVICE_ID  srv-… of the API service
 *
 *   RENDER_SERVICE_ID=srv-… node scripts/set-render-fee-wallet.mjs [--public]
 *
 * Env changes are NOT live until Render redeploys. This script never deploys.
 *
 * DEVNET ONLY.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_FILE = process.env.FEE_WALLET_KEY_FILE?.trim() || join(REPO_ROOT, "fee-wallet-devnet.key.json");
const KEY_ENV = "FEE_WALLET_KEYPAIR";
/** Public guard: the script refuses to push anything but this wallet's key. */
const EXPECTED_ADDRESS =
  process.env.EXPECTED_FEE_WALLET_ADDRESS?.trim() || "CVkVA46rL6CLBVqfPpJKGoHY3pi4tJQ12Yj2ardtGNc1";
const BASE = process.env.RENDER_API_BASE?.trim() || "https://api.render.com/v1";
const ALSO_SET_PUBLIC = process.argv.includes("--public");

const ok = (msg) => console.log(`  ✔ ${msg}`);
const info = (msg) => console.log(`    ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const die = (message, code = 1) => {
  console.error(`\n  ✖ ${message}\n`);
  process.exit(code);
};

function loadKey() {
  if (!existsSync(KEY_FILE)) die(`${KEY_FILE} not found. This script never generates keys.`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(KEY_FILE, "utf8"));
  } catch {
    die(`${KEY_FILE} is not valid JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) {
    die(`${KEY_FILE} must be a JSON array of 64 bytes (0..255).`);
  }
  const address = Keypair.fromSecretKey(Uint8Array.from(parsed)).publicKey.toBase58();
  if (address !== EXPECTED_ADDRESS) {
    die(`Address mismatch — refusing to continue.\n      expected: ${EXPECTED_ADDRESS}\n      in file:  ${address}`);
  }
  return { secret: JSON.stringify(parsed), address };
}

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
  return list.map((e) => e?.envVar ?? e);
};

async function render(path, init, apiKey, secret) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text: secret ? text.replaceAll(secret, "[redacted]") : text };
}

const { secret, address } = loadKey();
const apiKey = process.env.RENDER_API_KEY?.trim();
if (!apiKey) die("RENDER_API_KEY is not set — nothing was sent. Add it in Settings → Environment.");
const serviceId = process.env.RENDER_SERVICE_ID?.trim();
if (!serviceId) die("RENDER_SERVICE_ID is not set — nothing was sent.");

console.log("\n  DEVNET fee wallet");
info(`address      ${address}`);
info(`fingerprint  sha256:${fingerprint(secret)}  (safe to share)`);
info(`variables    ${KEY_ENV}${ALSO_SET_PUBLIC ? ` + PLATFORM_FEE_WALLET=${address}` : ""}`);

const first = await render(`/services/${serviceId}/env-vars`, {}, apiKey, secret);
if (!first.ok) die(`Render refused the read (HTTP ${first.status}). Nothing was sent.`);
const before = asList(first.text);
if (!before) die("Unexpected payload from Render — nothing was sent.");
const beforeKeys = before.map((e) => e.key);
ok(`${before.length} existing variable(s) read — none of them will be replaced or deleted`);

async function putVar(key, value, secretForScrub) {
  const res = await render(
    `/services/${serviceId}/env-vars/${key}`,
    { method: "PUT", body: JSON.stringify({ value }) },
    apiKey,
    secretForScrub
  );
  if (!res.ok) die(`Render rejected ${key} (HTTP ${res.status}) — no other variable was touched.\n      ${res.text.slice(0, 300)}`);
  ok(`${key} written (single-variable route)`);
}

await putVar(KEY_ENV, secret, secret);
if (ALSO_SET_PUBLIC) {
  // The address is public, but scrub the secret anyway (it is a superset string).
  await putVar("PLATFORM_FEE_WALLET", address, secret);
}

const second = await render(`/services/${serviceId}/env-vars`, {}, apiKey, secret);
if (!second.ok) die(`Could not verify (HTTP ${second.status}) — check the Render dashboard.`);
const after = asList(second.text);
if (!after) die("Could not parse the verification read — check the Render dashboard.");
const wanted = [KEY_ENV, ...(ALSO_SET_PUBLIC ? ["PLATFORM_FEE_WALLET"] : [])];
for (const key of wanted) {
  if (!after.some((e) => e?.key === key)) die(`${key} is NOT in Render's list after the write — check the dashboard.`);
}
const row = after.find((e) => e?.key === KEY_ENV);
const value = row?.value;
const readable = typeof value === "string" && (same(value, secret) || maybeSameKey(value, address));
if (!readable) {
  warn(`Render masks the stored value on read (${typeof value === "string" ? value.length : 0} chars) —`);
  info("the write was accepted (2xx) and comes from the verified local key file.");
  info(`confirm the fingerprint sha256:${fingerprint(secret)} in the dashboard.`);
}
const afterKeys = after.map((e) => e.key);
const missing = beforeKeys.filter((k) => !afterKeys.includes(k));
if (missing.length > 0) die(`UNEXPECTED: these variables disappeared: ${missing.join(", ")} — restore them in Render.`);

function maybeSameKey(v, addr) {
  try {
    const arr = JSON.parse(v);
    if (Array.isArray(arr) && arr.length === 64) return Keypair.fromSecretKey(Uint8Array.from(arr)).publicKey.toBase58() === addr;
  } catch {
    /* masked */
  }
  return false;
}

console.log("");
ok(`${wanted.join(" + ")} set on service ${serviceId}`);
ok(`no variable lost (${before.length} before, ${after.length} after)`);
info(`public address ${address}`);
warn("env changes are NOT live until Render redeploys — trigger a deploy (this script never deploys)");
console.log("");
void PublicKey;
