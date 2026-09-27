// List tags/branches of the MagicBlock SDK repos so a pre-solana-program-3.0
// revision can be pinned directly (git deps are not subject to crates.io
// yanking, which is what blocks the otherwise-compatible 0.2.x line).
const UA = {
  "User-Agent": "solana-roulette-vrf-spike/0.1",
  Accept: "application/vnd.github+json",
};

for (const repo of ["magicblock-labs/ephemeral-vrf", "magicblock-labs/ephemeral-rollups-sdk"]) {
  const r = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=100`, { headers: UA });
  if (!r.ok) {
    console.log(`${repo}: HTTP ${r.status}`);
    continue;
  }
  const tags = await r.json();
  console.log(`\n=== ${repo} (${tags.length} tags)`);
  for (const t of tags.slice(0, 25)) console.log(`  ${t.name.padEnd(24)} ${t.commit.sha.slice(0, 12)}`);
}
