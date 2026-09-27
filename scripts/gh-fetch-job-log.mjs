// Fetch one job's log by job id and print a tail window. Used to inspect a
// specific failing step without dumping the whole (often 100 KB+) log.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";

const run = promisify(execFile);
const API = "https://api.github.com/repos/blub1337/solana-roulette";

async function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const { stdout } = await run("gh", ["auth", "token"]);
  return stdout.trim();
}
const H = { Authorization: `Bearer ${await token()}`, Accept: "application/vnd.github+json" };

const runId = process.argv[2];
const want = process.argv[3] ?? "";
const pattern = process.argv[4] ?? "";

const jobs = (await (await fetch(`${API}/actions/runs/${runId}/jobs?per_page=100`, { headers: H })).json()).jobs ?? [];
for (const j of jobs) {
  if (want && !j.name.includes(want)) continue;
  const res = await fetch(`${API}/actions/jobs/${j.id}/logs`, { headers: H, redirect: "follow" });
  if (!res.ok) {
    console.log(`job ${j.id} ${j.name}: logs unavailable (${res.status}) [${j.status}/${j.conclusion}]`);
    continue;
  }
  const text = await res.text();
  const file = `/tmp/job-${j.id}.log`;
  writeFileSync(file, text);
  console.log(`job ${j.id} ${j.name} [${j.status}/${j.conclusion}] -> ${file} (${text.length} bytes)`);
  if (pattern) {
    const lines = text.split("\n");
    const hits = lines
      .map((l, i) => [i, l])
      .filter(([, l]) => new RegExp(pattern).test(l));
    for (const [i] of hits.slice(0, 25)) {
      console.log(`  ${i + 1}: ${lines[i].slice(0, 300)}`);
    }
  }
}
