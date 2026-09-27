// Cancel a superseded workflow run (this spike's own runs only) and report state.
// Usage: node scripts/gh-cancel-run.mjs <runId> [--yes]
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const API = "https://api.github.com/repos/blub1337/solana-roulette";

async function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const { stdout } = await run("gh", ["auth", "token"]);
  return stdout.trim();
}
const H = {
  Authorization: `Bearer ${await token()}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-06",
};

const runId = process.argv[2];
const state = await (await fetch(`${API}/actions/runs/${runId}`, { headers: H })).json();
console.log(`run ${runId}: ${state.name} [${state.status}/${state.conclusion}]`);

if (state.status === "completed") {
  console.log("already finished — nothing to cancel");
  process.exit(0);
}
if (!process.argv.includes("--yes")) {
  console.log("re-run with --yes to cancel");
  process.exit(0);
}
const res = await fetch(`${API}/actions/runs/${runId}/cancel`, { method: "POST", headers: H });
console.log(`cancel -> ${res.status}`);
