// Which published ephemeral-vrf-sdk versions are actually selectable, and what
// do they demand of solana-program / anchor-lang? Yanked versions cannot be
// selected fresh by cargo (only via an existing lockfile), so this decides
// whether an anchor-0.30.1-compatible line exists at all.
const CRATE = process.argv[2] || "ephemeral-vrf-sdk";
const UA = { "User-Agent": "solana-roulette-vrf-spike/0.1 (devnet spike)" };

async function j(path) {
  const r = await fetch(`https://crates.io/api/v1/crates/${CRATE}${path}`, { headers: UA });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

const list = await j("");
console.log(`crate: ${CRATE}   max: ${list.crate.max_version}`);
console.log("ver      yanked  solana-program req                anchor-lang req");
for (const v of list.versions) {
  const deps = await j(`/${v.num}/dependencies`);
  const sp = deps.dependencies
    .filter((d) => d.crate_id === "solana-program")
    .map((d) => `${d.req}${d.optional ? "(opt)" : ""}`)
    .join(" + ");
  const al = deps.dependencies
    .filter((d) => d.crate_id === "anchor-lang")
    .map((d) => `${d.req}${d.optional ? "(opt)" : ""}`)
    .join(" + ");
  console.log(`${v.num.padEnd(8)} ${String(v.yanked).padEnd(7)} ${sp.padEnd(34)} ${al}`);
}
