// Wallet-connection assessment for the SolRoll preview (mock wallet injection).
// Drives the REAL wallet-adapter UI (modal, Phantom/Solflare adapters, connect,
// post-connect pool page) with a Phantom-like provider injected before load.
import { chromium } from "playwright";

const BASE = process.env.ASSESS_BASE_URL ?? "http://127.0.0.1:3001";
const PUBKEY = "2h3gwYGLc6nxCnPdnNwgKvcnd66XuGzKEnfrxB7LEZsf"; // mock wallet pubkey

// web3.js PublicKey surface the wallet-adapter expects (toBytes etc.):
// embed the decoded 32 bytes so the mock PK behaves like a real PublicKey.
import { PublicKey } from "@solana/web3.js";
const PK_BYTES = [...new PublicKey(PUBKEY).toBytes()];

// The Phantom adapter reads `provider.publicKey` after calling connect(), so the
// mock must persist it on the target (not just resolve with it).
const mockPhantom = `
  (() => {
    const listeners = {};
    const BYTES = new Uint8Array(${JSON.stringify(PK_BYTES)});
    const PK = {
      toBytes: () => BYTES,
      toBase58: () => "${PUBKEY}",
      toString: () => "${PUBKEY}",
      toJSON: () => "${PUBKEY}",
    };
    const target = { isPhantom: true, publicKey: null, isConnected: false };
    const provider = new Proxy(target, {
      get(t, prop) {
        if (prop === "on") return (ev, cb) => { (listeners[ev] ||= []).push(cb); return () => {}; };
        if (prop === "connect") return async (_opts) => {
          window.__mockConnectCalls++;
          t.publicKey = PK; t.isConnected = true;
          (listeners["connect"] || []).forEach((cb) => cb(PK));
          return { publicKey: PK };
        };
        if (prop === "disconnect") return async () => { t.publicKey = null; t.isConnected = false; };
        if (prop === "signAndSendTransaction") return async () => ({ signature: "MOCKSIG" + "0".repeat(64) });
        if (prop === "signTransaction" || prop === "signAllTransactions") return async (x) => x;
        return t[prop];
      },
    });
    window.solana = provider;               // Phantom's injected global
    window.phantom = { solana: provider };  // modern Phantom shape
    window.isPhantomInstalled = true;       // legacy flag the adapter requires for Installed state
    window.__mockConnectCalls = 0;
    const origErr = console.error;
    console.error = (...a) => {
      (window.__errs ||= []).push(
        a
          .map((x) =>
            x instanceof Error
              ? x.name + ": " + x.message + " ||| stack: " + String(x.stack || "").slice(0, 200)
              : String(x)
          )
          .join(" | ")
      );
      origErr(...a);
    };
  })();
`;

const consoleLines = [];
const pageErrors = [];
const failedReqs = [];
const findings = [];

async function trackRequests(p) {
  p.on("response", (r) => {
    if (r.status() >= 400) failedReqs.push(`${r.status()} ${r.url().replace(BASE, "")}`);
  });
}

const browser = await chromium.launch();

// ---------- PASS A: clean browser, no mock — are hydration errors pre-existing? ----------
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await trackRequests(p);
  const cleanPageErrors = [];
  p.on("pageerror", (e) => cleanPageErrors.push(String(e).slice(0, 120)));
  await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3500);
  const homeHydration = cleanPageErrors.filter((e) => /hydration/i.test(e)).length;
  cleanPageErrors.length = 0;
  await p.goto(`${BASE}/pool/0`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(4000);
  const poolHydration = cleanPageErrors.filter((e) => /hydration/i.test(e)).length;
  const cleanBtn = (await p.locator(".wallet-adapter-button").count())
    ? (await p.locator(".wallet-adapter-button").first().innerText()).trim()
    : "(missing)";
  findings.push(`PASS A (no mock): hydration errors home=${homeHydration}, pool=${poolHydration}; pool wallet button="${cleanBtn.replace(/\s+/g, " ")}"`);
  await ctx.close();
}

// ---------- PASS B: mock Phantom — full connect flow ----------
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await trackRequests(p);
  p.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 220)}`));
  p.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

  await p.addInitScript(mockPhantom);
  await p.goto(`${BASE}/pool/0`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(4500);

  const btn = p.locator(".wallet-adapter-button").first();
  await btn.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  findings.push(`PASS B: initial button="${((await btn.count()) ? (await btn.innerText()).trim() : "(missing)").replace(/\s+/g, " ")}"`);

  await btn.click();
  await p.waitForTimeout(1000);
  const phantomItem = p.locator(".wallet-adapter-modal-list li:has-text('Phantom')").first();
  findings.push(`Modal open: ${(await p.locator(".wallet-adapter-modal").count()) > 0}; Phantom listed: ${(await phantomItem.count()) > 0}`);

  await phantomItem.click();
  await p.waitForTimeout(1500);
  const afterSelect = ((await btn.count()) ? (await btn.innerText()).trim() : "(missing)").replace(/\s+/g, " ");
  findings.push(`After selecting Phantom in modal: button="${afterSelect}" ("Connect" = wallet selected, awaiting connect click)`);

  // wallet-adapter UX: selecting the wallet closes the modal; the SECOND click
  // on the connection button is what initiates the actual connect.
  await btn.click();
  await p.waitForTimeout(3000);
  const after = ((await btn.count()) ? (await btn.innerText()).trim() : "(missing)").replace(/\s+/g, " ");
  const shortDots = `${PUBKEY.slice(0, 4)}..${PUBKEY.slice(-4)}`;
  const shortEllipsis = `${PUBKEY.slice(0, 4)}…${PUBKEY.slice(-4)}`;
  findings.push(`After connect click: button="${after}"; shows connected address: ${after.includes(shortDots) || after.includes(shortEllipsis)}`);
  findings.push(`Mock connect() invocations: ${await p.evaluate(() => window.__mockConnectCalls)}`);
  const errs = await p.evaluate(() => window.__errs ?? []).catch(() => []);
  findings.push(`Captured wallet errors: ${errs.length ? "\n    " + errs.slice(0, 3).join("\n    ") : "(none)"}`);

  // Post-connect state: what does the bet panel enable/show?
  await p.waitForTimeout(2500);
  const body = await p.locator("main").first().innerText().catch(() => "");
  const interesting = body.split("\n").map((s) => s.trim()).filter((s) =>
    /place your bet|connect your|deposit|join the|real funds|simul|not accepting|paused|closed|opening/i.test(s)
  );
  findings.push(`Post-connect page text (relevant lines): ${JSON.stringify(interesting.slice(0, 8))}`);

  await ctx.close();
}

console.log("=== FINDINGS ===");
findings.forEach((f) => console.log("• " + f));
console.log("=== FAILED REQUESTS (>=400) ===");
console.log(failedReqs.length ? [...new Set(failedReqs)].slice(0, 15).join("\n") : "(none)");
console.log("=== PAGE ERRORS (mock pass) ===");
const hydration = pageErrors.filter((e) => /hydration/i.test(e)).length;
console.log(`hydration errors: ${hydration}; other: ${pageErrors.length - hydration}`);
console.log(pageErrors.filter((e) => !/hydration/i.test(e)).slice(0, 8).join("\n") || "(no other page errors)");
console.log("=== WALLET/CONNECT CONSOLE (mock pass) ===");
const walletish = consoleLines.filter((l) => /wallet|phantom|solflare|connect|adaptor|adapter/i.test(l));
console.log(walletish.length ? [...new Set(walletish)].slice(0, 15).join("\n") : "(none)");

await browser.close();
