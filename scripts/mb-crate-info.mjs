// Generic crate metadata fetch: node scripts/mb-crate-info.mjs <crate> [version]
// Prints versions, relevant deps and the feature table. No secrets involved.
const CRATE = process.argv[2] || "ephemeral-vrf-sdk";
const V = process.argv[3] || "";
const UA = { "User-Agent": "solana-roulette-vrf-spike/0.1 (devnet spike)" };

async function main() {
  const list = await (await fetch(`https://crates.io/api/v1/crates/${CRATE}`, { headers: UA })).json();
  if (!list.crate) throw new Error(`crate not found: ${CRATE}`);
  console.log(`crate: ${CRATE}`);
  console.log("max_version:", list.crate.max_version);
  console.log("all_versions:", list.versions.map((v) => v.num).slice(0, 10).join(", "));
  console.log("repo:", list.crate.repository);

  const target = V || list.crate.max_version;
  const deps = await (await fetch(`https://crates.io/api/v1/crates/${CRATE}/${target}/dependencies`, { headers: UA })).json();
  console.log(`\n--- deps of ${target} (filtered) ---`);
  for (const d of deps.dependencies) {
    if (/anchor|solana|curve|ristretto|vrf|borsh/i.test(d.crate_id)) {
      console.log(
        `${d.crate_id.padEnd(36)} ${String(d.req).padEnd(22)} ${d.kind}${d.optional ? " (optional)" : ""}`,
      );
    }
  }

  const ver = await (await fetch(`https://crates.io/api/v1/crates/${CRATE}/${target}`, { headers: UA })).json();
  console.log(`\n--- features of ${target} ---`);
  for (const [k, val] of Object.entries(ver.version.features)) {
    console.log(`${k}: ${JSON.stringify(val)}`);
  }
}

main().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
