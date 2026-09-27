// Rewrites programs/vrf-spike/Cargo.toml so one committed manifest can build
// either VRF SDK line at a chosen anchor-lang version. Idempotent AND
// order-independent: it strips both SDK lines and re-inserts the selected one.
//
//   node scripts/vrf-spike-patch-manifest.mjs --line vrf     --anchor 0.30.1
//   node scripts/vrf-spike-patch-manifest.mjs --line rollups --anchor 0.32.2
//
// --line vrf     : ephemeral-vrf-sdk (git tag v0.2.3 — the yanked crates.io
//                  release, consumed from git, whose dependency graph is the
//                  only one that coexists with anchor-lang 0.30.1)
// --line rollups : ephemeral-rollups-sdk 0.17.3 (current, not yanked, but hard-
//                  requires solana-program 3.0.0)
//
// WHY THE OTHER LINE IS DELETED RATHER THAN JUST DISABLED:
// cargo-build-sbf shells out to `cargo metadata`, which resolves every
// DECLARED optional dependency regardless of which features are on. Leaving a
// disabled `ephemeral-rollups-sdk` in the manifest still drags solana-program
// 3.0 (and the zeroize conflict) into the resolve graph — measured, not
// assumed. So the manifest may only ever contain ONE SDK line.
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

const VRF_LINE =
  'ephemeral-vrf-sdk = { git = "https://github.com/magicblock-labs/ephemeral-vrf", tag = "v0.2.3", features = ["anchor"], optional = true }';
const ROLLUPS_LINE =
  'ephemeral-rollups-sdk = { version = "=0.17.3", features = ["vrf", "anchor-compat"], optional = true }';

let src = fs.readFileSync(MANIFEST, "utf8");

// 1. Drop both SDK dependency lines and both feature entries (plus their
//    leading comment blocks) so the starting point is line-agnostic.
src = src
  .replace(/^ephemeral-vrf-sdk = .*\n/m, "")
  .replace(/^ephemeral-rollups-sdk = .*\n/m, "")
  // Remove the SDK feature entries and their comment runs. A comment run is
  // every consecutive non-blank line from `# VRF SDK line` up to the blank
  // line, so no variant can leave a duplicate key behind (a duplicate
  // [features] key is a hard TOML error, not a warning).
  .replace(/^# VRF SDK line[^\n]*(?:\n(?!\s*$)[^\n]*)*\n/gm, "")
  .replace(/^sdk-vrf = \[[^\]]*\]\n/m, "")
  .replace(/^sdk-rollups = \[[^\]]*\]\n/m, "")
  .replace(/^# Both SDK lines are OPTIONAL[\s\S]*?\n\n/m, "");

// 2. anchor-lang is pinned EXACTLY: the SDK's `anchor-lang-compat` range
//    (>=0.28.0, <1.0.0) resolves to the NEWEST version in range, so the
//    consumer must name the same version for the two to unify into ONE
//    anchor_lang in the graph.
src = src.replace(
  /^anchor-lang = \{[^\n]*\}$/m,
  `anchor-lang = { version = "=${anchor}", features = ["init-if-needed"] }`,
);

// 3. Re-insert exactly the selected line, and enable it by default.
const enabled = line === "vrf" ? "sdk-vrf" : "sdk-rollups";
const featureBlock =
  line === "vrf"
    ? `# VRF SDK line: ephemeral-vrf-sdk v0.2.3 (git tag).\n` +
      `# The only published line whose dependency graph coexists with anchor-lang\n` +
      `# 0.30.1 — but EVERY release in it (0.1.0 .. 0.2.3) is YANKED from crates.io,\n` +
      `# so it is consumed from git, which is not subject to registry yanking.\n` +
      `sdk-vrf = ["dep:ephemeral-vrf-sdk"]\n`
    : `# VRF SDK line: ephemeral-rollups-sdk 0.17.3.\n` +
      `# Current and NOT yanked, but it hard-requires solana-program 3.0.0, which\n` +
      `# cannot be resolved alongside anchor-lang 0.30.1.\n` +
      `sdk-rollups = ["dep:ephemeral-rollups-sdk"]\n`;

src = src.replace(/^default = \[[^\]]*\]$/m, `default = ["${enabled}"]`);
// Feature entry goes first in [features] (order is irrelevant to cargo).
src = src.replace(/^default = \[[^\]]*\]$/m, (m) => `${featureBlock}${m}`);
// Dependency goes last in [dependencies].
src = src.replace(
  /^(anchor-lang = \{[^\n]*\}\n)/m,
  `$1${line === "vrf" ? VRF_LINE : ROLLUPS_LINE}\n`,
);

fs.writeFileSync(MANIFEST, src);

const report = src
  .split("\n")
  .filter((l) => /^(default|sdk-vrf|sdk-rollups|anchor-lang|ephemeral-\S+-sdk)\s*=/.test(l))
  .join("\n");
console.log(`patched ${MANIFEST}: line=${line} anchor=${anchor}`);
console.log(report);
