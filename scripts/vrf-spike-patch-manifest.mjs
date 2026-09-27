// Rewrites programs/vrf-spike/Cargo.toml so one committed manifest can build
// either VRF SDK line at a chosen anchor-lang version. Idempotent AND
// order-independent: it strips both SDK lines and re-inserts the selected one.
//
//   node scripts/vrf-spike-patch-manifest.mjs --line vrf     --anchor 0.30.1
//   node scripts/vrf-spike-patch-manifest.mjs --line vrf     --anchor 0.30.1 --sdk-source vendor
//   node scripts/vrf-spike-patch-manifest.mjs --line rollups --anchor 0.32.2
//
// --line vrf     : ephemeral-vrf-sdk 0.2.3 (the yanked release whose declared
//                  requirements — anchor-lang >=0.28.0, solana-program
//                  ">=1.18.26,<3" — are the only ones compatible with
//                  anchor-lang 0.30.1)
// --line rollups : ephemeral-rollups-sdk 0.17.3 (current, not yanked, but hard-
//                  requires solana-program 3.0.0)
//
// --sdk-source selects HOW the 0.2.3 line is obtained:
//   git    : `git = ".../ephemeral-vrf", tag = "v0.2.3"`. NOT equivalent to the
//            published crate: that tag's workspace already pins anchor-lang
//            1.2.0 / solana-program 2.3.0, so it drags a second Anchor into the
//            graph. Kept as a measured data point.
//   vendor : the actual published .crate tarball unpacked to a local path,
//            with its yanked proc-macro dependency patched to a local path too.
//            This is the only way to compile the real 0.2.3 code today, because
//            cargo refuses to SELECT a yanked version but happily builds one
//            that is already present as a path dependency.
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
const source = process.argv.includes("--vendor") ? "vendor" : arg("sdk-source", arg("source", "git")); // git | vendor
const VENDOR_DIR = arg("vendor-dir", "/tmp/vendor");
// The 0.2.x SDK declares `solana-program = ">=1.18.26, <3"`, so cargo picks
// the NEWEST version in range (2.x). Its code is written against the 1.18
// API, and the `anchor` feature re-exports anchor's Pubkey, so 1.18 + 2.x in
// one graph gives two distinct `Pubkey` types and 16 E0308s inside the SDK.
// Pinning solana-program to the version anchor-lang 0.30.1 actually uses
// unifies them.
const pin = arg("pin-solana", "none");

if (line !== "vrf" && line !== "rollups") {
  console.error(`unknown --line ${line} (expected vrf|rollups)`);
  process.exit(1);
}

const VRF_LINE_GIT =
  'ephemeral-vrf-sdk = { git = "https://github.com/magicblock-labs/ephemeral-vrf", tag = "v0.2.3", features = ["anchor"], optional = true }';
const VRF_LINE_VENDOR =
  `ephemeral-vrf-sdk = { path = "${VENDOR_DIR}/ephemeral-vrf-sdk-0.2.3", features = ["anchor"], optional = true }`;
const ROLLUPS_LINE =
  'ephemeral-rollups-sdk = { version = "=0.17.3", features = ["vrf", "anchor-compat"], optional = true }';

// The vendored SDK depends on a proc-macro crate that is yanked too, so it is
// patched to a local path as well.
const PATCH_BLOCK =
  `\n[patch.crates-io]\n` +
  `ephemeral-vrf-sdk-vrf-macro = { path = "${VENDOR_DIR}/ephemeral-vrf-sdk-vrf-macro-0.2.3" }\n`;

let src = fs.readFileSync(MANIFEST, "utf8");

// 1. Drop both SDK dependency lines and both feature entries (plus their
//    leading comment blocks) so the starting point is line-agnostic.
src = src
  .replace(/^ephemeral-vrf-sdk = .*\n/m, "")
  .replace(/^ephemeral-rollups-sdk = .*\n/m, "")
  .replace(/^\[patch\.crates-io\][\s\S]*$/m, "")
  // Remove the SDK feature entries and their comment runs. A comment run is
  // every consecutive non-blank line from `# VRF SDK line` up to the blank
  // line, so no variant can leave a duplicate key behind (a duplicate
  // [features] key is a hard TOML error, not a warning).
  .replace(/^# VRF SDK line[^\n]*(?:\n(?!\s*$)[^\n]*)*\n/gm, "")
  .replace(/^default = \[[^\]]*\]\n/m, "")
  .replace(/^sdk-vrf = \[[^\]]*\]\n/m, "")
  .replace(/^sdk-rollups = \[[^\]]*\]\n/m, "")
  .replace(/^# Both SDK lines are OPTIONAL[\s\S]*?\n\n/m, "")
  .replace(/^# NOTE: this manifest may contain[\s\S]*$/m, "");

// 2. anchor-lang is pinned EXACTLY: the SDK's `anchor-lang-compat` range
//    (>=0.28.0, <1.0.0) resolves to the NEWEST version in range, so the
//    consumer must name the same version for the two to unify into ONE
//    anchor_lang in the graph.
src = src.replace(
  /^anchor-lang = \{[^\n]*\}$/m,
  `anchor-lang = { version = "=${anchor}", features = ["init-if-needed"] }`,
);

// 3. Re-insert exactly the selected line, and enable it by default.
src = src.replace(/^solana-program = "=[^"]*"\n/m, "");
if (pin !== "none") {
  src = src.replace(
    /^(anchor-lang = \{[^\n]*\}\n)/m,
    `$1solana-program = "=${pin}"\n`,
  );
}
const enabled = line === "vrf" ? "sdk-vrf" : "sdk-rollups";
const featureBlock =
  line === "vrf"
    ? `# VRF SDK line: ephemeral-vrf-sdk 0.2.3.\n` +
      `# The only published line whose dependency graph coexists with anchor-lang\n` +
      `# 0.30.1 — but EVERY release in it (0.1.0 .. 0.2.3) is YANKED from crates.io,\n` +
      `# so it is consumed from its published tarball or its git tag, neither of\n` +
      `# which is subject to registry yanking.\n` +
      `sdk-vrf = ["dep:ephemeral-vrf-sdk"]\n`
    : `# VRF SDK line: ephemeral-rollups-sdk 0.17.3.\n` +
      `# Current and NOT yanked, but it hard-requires solana-program 3.0.0, which\n` +
      `# cannot be resolved alongside anchor-lang 0.30.1.\n` +
      `sdk-rollups = ["dep:ephemeral-rollups-sdk"]\n`;

// Insert the feature block immediately after [features] — position-based, so
// the result does not depend on what the previous run left behind.
src = src.replace(/^\[features\]\n/m, `[features]\n${featureBlock}default = ["${enabled}"]\n`);
// Dependency goes last in [dependencies].
const sdkLine =
  line === "rollups" ? ROLLUPS_LINE : source === "vendor" ? VRF_LINE_VENDOR : VRF_LINE_GIT;
src = src.replace(/^(anchor-lang = \{[^\n]*\}\n)/m, `$1${sdkLine}\n`);
if (line === "vrf" && source === "vendor") {
  src = src.replace(/\n*$/, "\n") + PATCH_BLOCK;
}

fs.writeFileSync(MANIFEST, src);

const report = src
  .split("\n")
  .filter((l) => /^(default|sdk-vrf|sdk-rollups|anchor-lang|ephemeral-\S+-sdk|solana-program)\s*=/.test(l))
  .join("\n");
console.log(`patched ${MANIFEST}: line=${line} source=${source} anchor=${anchor} pin-solana=${pin}`);
console.log(report);
