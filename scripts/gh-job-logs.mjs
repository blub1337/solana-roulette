// Fetches a single job's log from the Actions API (works while the run is in
// progress, unlike the run-level archive). Token never printed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";

const run = promisify(execFile);
const OWNER = "blub1337";
const REPO = "solana-roulette";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

async function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const { stdout } = await run("gh", ["auth", "token"]);
  return stdout.trim();
}
const T = await token();
const H = { Authorization: `Bearer ${T}`, Accept: "application/vnd.github+json" };

const runId = process.argv[2];
const want = process.argv[3] ?? "";

const jobsRes = await (await fetch(`${API}/actions/runs/${runId}/jobs?per_page=100`, { headers: H })).json();
const jobs = jobsRes.jobs ?? [];
for (const j of jobs) {
  if (want && !j.name.includes(want)) continue;
  console.log(`\n########## job ${j.id}  ${j.name}  [${j.status}/${j.conclusion}]`);
  for (const s of j.steps ?? []) {
    console.log(`   [${s.conclusion ?? s.status}] ${s.number}. ${s.name}`);
  }
  const res = await fetch(`${API}/actions/jobs/${j.id}/logs`, { headers: H, redirect: "follow" });
  if (!res.ok) {
    console.log(`   (log fetch failed: ${res.status})`);
    continue;
  }
  const text = await res.text();
  writeFileSync(`/tmp/job-${j.id}.log`, text);
  console.log(`   log saved: /tmp/job-${j.id}.log (${text.length} bytes)`);
}
