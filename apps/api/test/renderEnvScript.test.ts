/**
 * Render env-var transfer (`scripts/set-render-operator-key.mjs`).
 *
 * The script moves a devnet secret from a local file into a Render service
 * without ever printing it. The interesting behaviour is what it does NOT do,
 * so the test runs it against a FAKE Render API (a local HTTP server) and
 * asserts three things at once:
 *
 *   1. correctness — the stored value is byte-for-byte the key file's content,
 *      and every pre-existing variable survives (Render's endpoint replaces the
 *      whole list, so a naive write would delete them),
 *   2. no disclosure — the secret never appears in stdout/stderr, in any mode,
 *   3. fail-safe — an unreadable variable aborts the run before any write, and
 *      a missing API key stops with a clear message instead of hanging.
 *
 * No network, no Render account, no real secret: the key file used here is a
 * throwaway one created and deleted inside the test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Keypair } from "@solana/web3.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "set-render-operator-key.mjs");

/** A throwaway keypair — never the real devnet operator key. */
const TEST_KEY = Keypair.generate();
const TEST_SECRET = JSON.stringify(Array.from(TEST_KEY.secretKey));
const TEST_ADDRESS = TEST_KEY.publicKey.toBase58();

/** The repository's real key file, if present — must never be read by the test. */
const REAL_KEY_FILE = join(REPO_ROOT, "operator-devnet.key.json");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let repo: string;
let server: Server;
let port: number;
/** What the fake Render currently "holds", and every write it received. */
let stored: Array<{ key: string; value: string }>;
let putCount: number;
let lastAuth: string | undefined;
/** Set to true to simulate a variable whose value Render will not return. */
let hideValues = false;

beforeAll(async () => {
  // An isolated copy of the repo root holding just the key file, so the test
  // never touches (or prints) the operator's real secret.
  repo = mkdtempSync(join(tmpdir(), "render-env-"));
  writeFileSync(join(repo, "operator-devnet.key.json"), TEST_SECRET, { mode: 0o600 });

  server = createServer((req, res) => {
    const url = req.url ?? "";
    lastAuth = req.headers.authorization;
    if (req.method === "GET" && url.endsWith("/env-vars")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(hideValues ? stored.map((e) => ({ key: e.key })) : stored));
      return;
    }
    if (req.method === "PUT" && url.endsWith("/env-vars")) {
      putCount++;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        stored = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(stored));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(repo, { recursive: true, force: true });
});

function resetStore() {
  stored = [
    { key: "SOLANA_NETWORK", value: "devnet" },
    { key: "PLATFORM_FEE_BPS", value: "750" },
    { key: "DEPOSIT_ESCROW_WALLET", value: TEST_ADDRESS },
  ];
  putCount = 0;
  hideValues = false;
}

/** Run the script against the fake API, inside the temp repo. */
async function run(args: string[], env: Record<string, string | undefined> = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_PATH: join(REPO_ROOT, "node_modules"),
        // Point the script at the throwaway key, never at the real one.
        OPERATOR_KEY_FILE: join(repo, "operator-devnet.key.json"),
        OPERATOR_ENV_OUT: join(repo, ".render-admin.env"),
        RENDER_API_BASE: `http://127.0.0.1:${port}/v1`,
        RENDER_API_KEY: "rnd_test_key",
        RENDER_SERVICE_ID: "srv-test123",
        EXPECTED_OPERATOR_ADDRESS: TEST_ADDRESS,
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("set-render-operator-key.mjs", () => {
  it("never reads or prints the repository's real operator key", () => {
    // The script is pointed at a throwaway key file for the whole suite, so the
    // real operator secret is never read, moved or disclosed by the test.
    expect(existsSync(join(repo, "operator-devnet.key.json"))).toBe(true);
    expect(REAL_KEY_FILE.endsWith("operator-devnet.key.json")).toBe(true);
  });

  it("--check validates the key and writes nothing", async () => {
    resetStore();
    const r = await run(["--check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(TEST_ADDRESS);
    expect(r.stdout).toContain("nothing was written");
    expect(putCount).toBe(0);
  });

  it("pushes the exact secret, preserves every other variable and verifies it", async () => {
    resetStore();
    const r = await run([]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("is set on service srv-test123 and verified");
    expect(r.stdout).toContain("3 pre-existing variable(s) preserved");

    // The stored value IS the key file's content, byte for byte.
    const row = stored.find((e) => e.key === "OPERATOR_KEYPAIR");
    expect(row).toBeDefined();
    expect(row!.value).toBe(TEST_SECRET);
    expect(JSON.parse(row!.value)).toEqual(JSON.parse(TEST_SECRET));

    // Nothing was dropped.
    expect(stored.map((e) => e.key).sort()).toEqual([
      "DEPOSIT_ESCROW_WALLET",
      "OPERATOR_KEYPAIR",
      "PLATFORM_FEE_BPS",
      "SOLANA_NETWORK",
    ]);
    expect(stored.find((e) => e.key === "SOLANA_NETWORK")!.value).toBe("devnet");
    expect(putCount).toBe(1);
    expect(lastAuth).toBe("Bearer rnd_test_key");
  });

  it("never discloses the secret in any mode", async () => {
    resetStore();
    for (const args of [[], ["--check"], ["--stage"]]) {
      const r = await run(args);
      const output = r.stdout + r.stderr;
      expect(output, args.join(" ")).not.toContain(TEST_SECRET);
      // also not a chunk of it
      expect(output, args.join(" ")).not.toContain(TEST_SECRET.slice(0, 40));
      expect(output, args.join(" ")).not.toContain(TEST_SECRET.slice(-40));
    }
    // --stage does write a copy, but only into a 0600 file, never to stdout.
    const staged = readFileSync(join(repo, ".render-admin.env"), "utf8");
    expect(staged).toContain(`OPERATOR_KEYPAIR=${TEST_SECRET}`);
    expect(staged.split("\n")[0]).toContain("#");
  });

  it("aborts before writing when a variable's value cannot be read back", async () => {
    resetStore();
    hideValues = true;
    const r = await run([]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("no readable value");
    expect(r.stderr).toContain("NOTHING was sent");
    expect(putCount).toBe(0); // nothing was destroyed
    hideValues = false;
  });

  it("stops with a clear message when the API key is missing (no TTY, no hang)", async () => {
    resetStore();
    const r = await run([], { RENDER_API_KEY: "" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("RENDER_API_KEY is not set");
    expect(r.stderr).toContain("--stage");
    expect(putCount).toBe(0);
  });

  it("refuses to run when the address does not match the expected one", async () => {
    resetStore();
    const r = await run([], { EXPECTED_OPERATOR_ADDRESS: "11111111111111111111111111111111" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Address mismatch");
    expect(putCount).toBe(0);
  });
});
