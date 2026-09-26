/**
 * List the "Deploy program to devnet" workflow runs on main, with the commit
 * each one built and its conclusion. The token is read from the environment and
 * never printed.
 *
 *   node scripts/gh-deploy-runs.mjs [limit]
 */
const OWNER = "blub1337";
const REPO = "solana-roulette";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const limit = Number(process.argv[2] || 40);

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

async function getToken() {
  if ((process.env.GITHUB_TOKEN || "").trim()) return process.env.GITHUB_TOKEN.trim();
  const { stdout } = await run("gh", ["auth", "token"]);
  return stdout.trim();
}
const token = await getToken();
if (!token) {
  console.error("no GitHub token available (set GITHUB_TOKEN or run `gh auth login`)");
  process.exit(1);
}
const H = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const res = await fetch(`${API}/actions/runs?branch=main&per_page=${limit}`, { headers: H });
if (!res.ok) {
  console.error(`GitHub returned HTTP ${res.status}`);
  process.exit(1);
}
const { workflow_runs: runs = [], total_count } = await res.json();
console.log(`total runs on main: ${total_count} (showing latest ${runs.length})\n`);

const deploys = runs.filter((r) => /deploy/i.test(r.name ?? ""));
console.log(`deploy runs: ${deploys.length}\n`);
for (const r of deploys) {
  console.log(
    [
      `id=${r.id}`,
      r.status,
      r.conclusion ?? "-",
      `sha=${(r.head_sha ?? "").slice(0, 10)}`,
      r.created_at,
      `event=${r.event}`,
    ].join("  ")
  );
}

if (!deploys.length) {
  console.log("\nno deploy runs — the deploy workflow has never been dispatched (or was never pushed)");
}
