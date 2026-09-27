// Inspect the layout of magicblock-labs/ephemeral-vrf at tag v0.2.3 so the git
// dependency can be written correctly (workspace member path + package name).
const UA = { "User-Agent": "solana-roulette-vrf-spike/0.1", Accept: "application/vnd.github+json" };

async function j(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

const ref = process.argv[2] || "v0.2.3";
const repo = "magicblock-labs/ephemeral-vrf";

const tree = await j(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`);
console.log(`=== ${repo} @ ${ref}: Cargo.toml files`);
for (const e of tree.tree) {
  if (e.path.endsWith("Cargo.toml")) console.log(`  ${e.path}`);
}
console.log(`\n=== src/lib.rs candidates`);
for (const e of tree.tree) {
  if (e.path.endsWith("src/lib.rs")) console.log(`  ${e.path}`);
}
