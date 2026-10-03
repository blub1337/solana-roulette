// TEMPORARY GitHub REST client. Token stays in memory; never printed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync } from "node:fs";
const run = promisify(execFile);

const OWNER = "blub1337";
const REPO = "solana-roulette";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const BRANCH = "main";

async function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const { stdout } = await run("gh", ["auth", "token"]);
  return stdout.trim();
}
const token = await getToken();
const H = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
};

async function call(path, init = {}) {
  const res = await fetch(`${API}${path}`, { headers: H, ...init });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch {}
  return { status: res.status, json, text };
}

const [,, cmd, ...args] = process.argv;

if (cmd === "setsecret") {
  // usage: setsecret NAME PATH raw|b64 — value read from file, never printed
  const [name, path, mode] = args;
  const raw = readFileSync(path);
  const value = mode === "b64" ? raw.toString("base64") : raw.toString("utf8").trim();
  const pkRes = await call(`/actions/secrets/public-key`);
  if (pkRes.status !== 200) { console.log("pubkey:", pkRes.status, JSON.stringify(pkRes.json).slice(0, 200)); process.exit(1); }
  const { key_id, key } = pkRes.json;
  const sb = (await import("tweetnacl-sealedbox-js")).default;
  const encrypted = Buffer.from(sb.seal(Buffer.from(value, "utf8"), Buffer.from(key, "base64"))).toString("base64");
  const put = await call(`/actions/secrets/${name}`, {
    method: "PUT",
    body: JSON.stringify({ encrypted_value: encrypted, key_id }),
  });
  console.log("secret", name, "set ->", put.status === 201 || put.status === 204 ? "ok" : put.status);
  process.exit(put.status === 201 || put.status === 204 ? 0 : 1);
}

if (cmd === "get") {
  const r = await call(`/contents/${args[0]}?ref=${BRANCH}`);
  console.log("get", args[0], "->", r.status);
  process.exit(r.status === 200 ? 0 : 1);
}

if (cmd === "put") {
  const [path, localFile, message] = args;
  const content = readFileSync(localFile).toString("base64");
  const cur = await call(`/contents/${path}?ref=${BRANCH}`);
  const body = {
    message,
    content,
    branch: BRANCH,
    ...(cur.status === 200 ? { sha: cur.json.sha } : {}),
  };
  const r = await call(`/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  console.log("put", path, "->", r.status, r.json?.commit?.sha?.slice(0, 10) ?? "");
  process.exit(r.status === 200 || r.status === 201 ? 0 : 1);
}

if (cmd === "dispatch") {
  const [workflow, ref] = args;
  const r = await call(`/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref }),
  });
  console.log("dispatch", workflow, "->", r.status === 204 ? "accepted" : r.status);
  process.exit(r.status === 204 ? 0 : 1);
}

if (cmd === "runs") {
  const r = await call(`/actions/runs?branch=${BRANCH}&per_page=5`);
  for (const run of r.json.workflow_runs ?? []) {
    console.log([run.id, run.name, run.status, run.conclusion, run.created_at].join(" | "));
  }
  process.exit(0);
}

if (cmd === "wait") {
  const id = args[0];
  for (let i = 0; i < 60; i++) {
    const r = await call(`/actions/runs/${id}`);
    const { status, conclusion } = r.json;
    console.log(`poll ${i}: ${status} ${conclusion ?? ""}`);
    if (status === "completed") process.exit(conclusion === "success" ? 0 : 1);
    await new Promise((res) => setTimeout(res, 20_000));
  }
  process.exit(2);
}

if (cmd === "logs") {
  const id = args[0];
  const res = await fetch(`${API}/actions/runs/${id}/logs`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  console.log("logs status:", res.status, res.headers.get("content-type"));
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync("/tmp/run-logs.zip", buf);
  console.log("saved /tmp/run-logs.zip", buf.length, "bytes");
  process.exit(res.ok ? 0 : 1);
}

console.log("unknown command", cmd);
process.exit(1);
