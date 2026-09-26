/**
 * Print the jobs and steps of a GitHub Actions run, with each step's
 * conclusion — used to find WHICH step failed in the devnet deploy workflow.
 *
 *   node scripts/gh-run-steps.mjs <run-id>
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

async function getToken() {
  if ((process.env.GITHUB_TOKEN || "").trim()) return process.env.GITHUB_TOKEN.trim();
  const { stdout } = await run("gh", ["auth", "token"]);
  return stdout.trim();
}
const token = await getToken();
const id = process.argv[2];
if (!id) {
  console.error("usage: node scripts/gh-run-steps.mjs <run-id>");
  process.exit(1);
}

const H = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const meta = await (
  await fetch(`https://api.github.com/repos/blub1337/solana-roulette/actions/runs/${id}`, { headers: H })
).json();
console.log(`run ${meta.id}  ${meta.name}  ${meta.status}/${meta.conclusion}`);
console.log(`sha  ${meta.head_sha}`);
console.log(`url  ${meta.html_url}\n`);

const jobsRes = await fetch(
  `https://api.github.com/repos/blub1337/solana-roulette/actions/runs/${id}/jobs`,
  { headers: H }
);
const { jobs = [] } = await jobsRes.json();

for (const job of jobs) {
  console.log(`JOB ${job.name}  ${job.status}/${job.conclusion}`);
  for (const s of job.steps ?? []) {
    const mark = s.conclusion === "success" ? "ok  " : s.conclusion === "skipped" ? "skip" : "FAIL";
    console.log(`  [${mark}] ${s.number}. ${s.name}`);
  }
  console.log("");
}
