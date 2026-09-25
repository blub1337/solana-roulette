#!/usr/bin/env node
/**
 * set-render-operator-key.mjs — put the DEVNET operator key into Render
 * without ever showing it.
 *
 * Reads the secret from exactly one place on your machine:
 *
 *     operator-devnet.key.json     (mode 600, gitignored)
 *
 * and hands the value to your Render service. It NEVER prints, echoes or logs
 * the secret, never accepts it as a command-line argument (arguments end up in
 * your shell history) and never asks for a seed phrase or private key of any
 * kind. A SHA-256 fingerprint is printed instead, so you can prove *which* key
 * was sent without disclosing it.
 *
 *   node scripts/set-render-operator-key.mjs            # verify, then push to Render
 *   node scripts/set-render-operator-key.mjs --check    # verify only, write nothing
 *   node scripts/set-render-operator-key.mjs --stage    # offline: stage a 0600 .env line
 *
 * Credentials: RENDER_API_KEY and RENDER_SERVICE_ID. If they are not in the
 * environment and stdin is an interactive terminal, you are prompted for them
 * (the API key is read without echo). In a non-interactive shell it stops with
 * a clear message instead of hanging.
 *
 * SAFETY: Render's update endpoint REPLACES the service's whole variable list —
 * anything omitted is deleted. This script therefore reads the current list
 * first, merges, and refuses to send anything if a variable's value cannot be
 * read back (which would mean deleting it). After writing it re-reads the list
 * and verifies the value byte for byte.
 *
 * DEVNET ONLY. Use a different key for mainnet.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Where the secret is read from. The default is the file next to this script,
 * so the value never depends on the current working directory. Only the PATH
 * can be overridden — the secret itself is never taken from the environment or
 * a command-line argument.
 */
const KEY_FILE = process.env.OPERATOR_KEY_FILE?.trim() || join(REPO_ROOT, "operator-devnet.key.json");
const STAGED_FILE = process.env.OPERATOR_ENV_OUT?.trim() || join(REPO_ROOT, ".render-admin.env");
const ENV_KEY = "OPERATOR_KEYPAIR";

/** Public, non-secret settings the platform also needs. */
const PUBLIC_VARS = {
  DEPOSIT_ESCROW_WALLET: "", // filled with the operator address
  PLATFORM_FEE_WALLET: "6B9MXLX4tgbHB9eXheHqK6FmPXCwxYP7No51NqRQHAaR",
  PLATFORM_FEE_BPS: "750",
  TIER_CAPS_SOL: "1,10,100",
  DEPOSITS_PAUSED: "false",
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
};

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const mode = flags.has("--check") ? "check" : flags.has("--stage") ? "stage" : "push";

const ok = (msg) => console.log(`  ✔ ${msg}`);
const info = (msg) => console.log(`    ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const step = (msg) => console.log(`\n▸ ${msg}`);

function die(message, code = 1) {
  console.error(`\n  ✖ ${message}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// key file
// ---------------------------------------------------------------------------

function loadKey() {
  if (!existsSync(KEY_FILE)) {
    die(`${KEY_FILE} not found. Create it first:\n      node scripts/generate-operator-keypair.mjs`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(KEY_FILE, "utf8"));
  } catch {
    die(`${KEY_FILE} is not valid JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    die(`${KEY_FILE} must be a JSON array of 64 bytes (found ${Array.isArray(parsed) ? parsed.length : "not an array"}).`);
  }
  if (!parsed.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) {
    die(`${KEY_FILE} contains values outside 0..255.`);
  }
  const address = Keypair.fromSecretKey(Uint8Array.from(parsed)).publicKey.toBase58();
  const expected = process.env.EXPECTED_OPERATOR_ADDRESS?.trim();
  if (expected && expected !== address) {
    die(
      `Address mismatch — refusing to continue.\n` +
        `      expected: ${expected}\n` +
        `      in file:  ${address}\n` +
        `      Set EXPECTED_OPERATOR_ADDRESS to the address you already deployed.`
    );
  }
  return { secret: JSON.stringify(parsed), address };
}

/** Non-reversible fingerprint: lets you verify a value without disclosing it. */
const fingerprint = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function printPublicInfo(address, secret) {
  console.log("\n  DEVNET operator wallet");
  info(`address      ${address}`);
  info(`key file     ${KEY_FILE === join(REPO_ROOT, "operator-devnet.key.json") ? "operator-devnet.key.json" : "custom path (OPERATOR_KEY_FILE)"} (mode 600, gitignored)`);
  info(`fingerprint  sha256:${fingerprint(secret)}  (safe to share — proves which key)`);
  info(`length       ${secret.length} chars — the secret itself is never printed`);
}

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

/** Read a line with the echo suppressed (API keys must not land on screen). */
function promptHidden(question) {
  if (!process.stdin.isTTY) {
    die(
      "RENDER_API_KEY is not set and stdin is not interactive, so it cannot be prompted for.\n" +
        "      Set it in the environment for this command, or use the offline mode:\n" +
        "        node scripts/set-render-operator-key.mjs --stage"
    );
  }
  const sink = new Writable({ write(_c, _e, cb) { cb(); } });
  const rl = createInterface({ input: process.stdin, output: sink, terminal: true });
  return new Promise((resolve) => {
    process.stdout.write(`  ${question} `);
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function promptPlain(question) {
  if (!process.stdin.isTTY) return Promise.resolve("");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resolveCredentials() {
  let apiKey = process.env.RENDER_API_KEY?.trim();
  let serviceId = process.env.RENDER_SERVICE_ID?.trim();
  const base = process.env.RENDER_API_BASE?.trim() || "https://api.render.com/v1";

  if (!apiKey) {
    warn("RENDER_API_KEY is not set.");
    console.log("      Create one in Render: Account Settings → API Keys.");
    apiKey = await promptHidden("Paste your Render API key (input hidden):");
  }
  if (!apiKey) die("No Render API key — nothing was sent.");

  if (!serviceId) {
    warn("RENDER_SERVICE_ID is not set.");
    console.log("      Find it in your service's Render URL or dashboard (looks like srv-…).");
    serviceId = await promptPlain("Paste the Service ID of your API service:");
  }
  if (!serviceId) die("No Render service ID — nothing was sent.");

  return { apiKey, serviceId, base };
}

// ---------------------------------------------------------------------------
// offline staging
// ---------------------------------------------------------------------------

function stage(secret, address) {
  const header = [
    "# Render env vars for the API service — Solana Roulette (DEVNET)",
    `# Escrow / operator / payout address: ${address}`,
    "#",
    "# Copy line 7 into Render: Service → Environment → Add from .env",
    "# (or paste the value straight into the OPERATOR_KEYPAIR field).",
    "# Delete this file once Render is configured.",
    "",
  ].join("\n");
  writeFileSync(STAGED_FILE, `${header}${ENV_KEY}=${secret}\n`, { mode: 0o600 });
  chmodSync(STAGED_FILE, 0o600);
  ok(`staged .render-admin.env (mode 600, gitignored) — ${ENV_KEY} is on line 7`);
  info("the value is not shown here, in the terminal or in this file's header");
  step("Also set these public values in Render:");
  for (const [k, v] of Object.entries(PUBLIC_VARS)) {
    console.log(`      ${k}=${k === "DEPOSIT_ESCROW_WALLET" ? address : v}`);
  }
  console.log("\n      ADMIN_TOKEN=<your own random value, e.g. openssl rand -hex 32>\n");
}

// ---------------------------------------------------------------------------
// Render API
// ---------------------------------------------------------------------------

async function renderFetch(base, apiKey, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, json };
}

const asList = (json) => (Array.isArray(json) ? json : (json?.envVars ?? []));

async function push(secret, address) {
  step("Resolving Render credentials");
  const { apiKey, serviceId, base } = await resolveCredentials();
  info(`service ${serviceId} · api ${base}`);

  step(`Reading the current environment variables of ${serviceId}`);
  const current = await renderFetch(base, apiKey, `/services/${serviceId}/env-vars`);
  if (!current.ok) {
    die(
      `Render refused the read (HTTP ${current.status}).\n` +
        `      Check the API key and the service ID. Nothing was sent.`
    );
  }
  const existing = asList(current.json);
  if (!Array.isArray(existing)) die("Unexpected payload from Render — nothing was sent.");
  ok(`${existing.length} existing variable(s) will be preserved`);

  // The replace endpoint deletes anything it does not receive. A variable whose
  // value we cannot read back would be lost, so stop instead of destroying it.
  const opaque = existing.filter((e) => typeof e?.value !== "string");
  if (opaque.length > 0) {
    die(
      `Render returned ${opaque.length} variable(s) with no readable value ` +
        `(${opaque.map((e) => e?.key ?? "?").join(", ")}).\n` +
        "      A full replace would delete them, so NOTHING was sent.\n" +
        "      Use the offline mode instead:  node scripts/set-render-operator-key.mjs --stage"
    );
  }

  const merged = existing.filter((e) => e.key !== ENV_KEY);
  merged.push({ key: ENV_KEY, value: secret });
  if (process.env.PUSH_PUBLIC_VARS === "true") {
    for (const [k, v] of Object.entries(PUBLIC_VARS)) {
      const value = k === "DEPOSIT_ESCROW_WALLET" ? address : v;
      const row = merged.find((e) => e.key === k);
      if (row) row.value = value;
      else merged.push({ key: k, value });
    }
    info("public variables merged as well (PUSH_PUBLIC_VARS=true)");
  }

  step(`Writing ${ENV_KEY} to service ${serviceId}`);
  const put = await renderFetch(base, apiKey, `/services/${serviceId}/env-vars`, {
    method: "PUT",
    body: JSON.stringify(merged),
  });
  if (!put.ok) {
    die(
      `Render rejected the update (HTTP ${put.status}): ${JSON.stringify(put.json).slice(0, 200)}\n` +
        "      The existing variables were left untouched."
    );
  }

  step("Verifying the value Render stored");
  const verify = await renderFetch(base, apiKey, `/services/${serviceId}/env-vars`);
  if (!verify.ok) die(`Could not verify (HTTP ${verify.status}). Check the Render dashboard.`);
  const row = asList(verify.json).find((e) => e?.key === ENV_KEY);
  if (!row || typeof row.value !== "string" || !same(row.value, secret)) {
    die("Render did not return the expected value — treat this as a failure and check the dashboard.");
  }

  console.log("");
  ok(`${ENV_KEY} is set on service ${serviceId} and verified (sha256:${fingerprint(secret)})`);
  info(`address  ${address}`);
  info(`${existing.length} pre-existing variable(s) preserved unchanged`);
  warn("env changes are NOT live yet — trigger “Save & Deploy” in Render");
  console.log("");
}

// ---------------------------------------------------------------------------

const { secret, address } = loadKey();
printPublicInfo(address, secret);

if (mode === "check") {
  console.log("\n  --check: nothing was written, nothing was sent.\n");
} else if (mode === "stage") {
  stage(secret, address);
} else {
  await push(secret, address);
}
