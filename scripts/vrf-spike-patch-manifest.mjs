// Rewrites programs/vrf-spike/Cargo.toml so one committed manifest can build
// either VRF SDK line at a chosen anchor-lang version. Idempotent.
//
//   node scripts/vrf-spike-patch-manifest.mjs --line vrf    --anchor 0.30.1
//   node scripts/vrf-spike-patch-manifest.mjs --line rollups --anchor 0.32.2
//
// --line vrf     : ephemeral-vrf-sdk (git tag v0.2.3, the yanked-but-resolvable
//                  line) — enables the `sdk-vrf` crate feature.
// --line rollups : ephemeral-rollups-sdk 0.17.3 (current, not yanked, but
//                  hard-requires solana-program 3.0.0) — enables `sdk-rollups`.
//
// Only the selected line is enabled, so only that optional dependency enters
// the resolve graph. Enabling both would put solana-program 1.18 and 3.0 in one
// graph, which is the unresolvable combination this spike exists to document.
import fs from "node:fs";

const MANIFEST = "programs/vrf-spike/Cargo.toml";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const line = arg("line", "vrf");
const anchor = arg("anchor", "0.30.1");

if (line !== "vrf" && line !== "rollups") {
  console.error(`unknown --line ${line} (expected vrf|rollups)`);
  process.exit(1);
}

let src = fs.readFileSync(MANIFEST, "utf8");

// anchor-lang: exact version, because the SDK's `anchor-lang-compat` range
// (>=0.28.0, <1.0.0) resolves to the NEWEST version in range. Pinning the same
// version here is what makes the two unify into one anchor_lang in the graph.
src = src.replace(
  /^anchor-lang = \{[^\n]*\}$/m,
  `anchor-lang = { version = "=${anchor}", features = ["init-if-needed"] }`,
);

// Exactly one SDK feature is on, and it is the one selected.
const otherFeature = line === "vrf" ? "sdk-rollups" : "sdk-vrf";
src = src.replace(new RegExp(`^${otherFeature} = \\[[^\\]]*\\]$`, "m"), `${otherFeature} = []`);
src = src.replace(
  /^sdk-vrf = \[[^\]]*\]$/m,
  line === "vrf" ? 'sdk-vrf = ["dep:ephemeral-vrf-sdk"]' : 'sdk-vrf = []',
);
src = src.replace(
  /^sdk-rollups = \[[^\]]*\]$/m,
  line === "rollups" ? 'sdk-rollups = ["dep:ephemeral-rollups-sdk"]' : 'sdk-rollups = []',
);

// The spike program must actually be built with the chosen SDK feature.
const enabled = line === "vrf" ? "sdk-vrf" : "sdk-rollups";
src = src.replace(/^default = \[[^\]]*\]$/m, `default = ["${enabled}"]`);

fs.writeFileSync(MANIFEST, src);

const report = src
  .split("\n")
  .filter((l) => /^(default|sdk-vrf|sdk-rollups|anchor-lang|ephemeral-\S+-sdk)\s*=/.test(l))
  .join("\n");
console.log(`patched ${MANIFEST}: line=${line} anchor=${anchor}`);
console.log(report);
