// Rewrites programs/vrf-spike/Cargo.toml so the compatibility matrix can be
// built from one committed source of truth. Idempotent.
//
//   node scripts/vrf-spike-patch-manifest.mjs --sdk 0.2.3  --anchor 0.30.1
//   node scripts/vrf-spike-patch-manifest.mjs --sdk 0.2.3  --anchor 0.31.1
//   node scripts/vrf-spike-patch-manifest.mjs --sdk 0.17.3 --anchor 0.30.1 --pin-solana none
//
// --sdk selects which published VRF SDK line is under test:
//   0.2.3  -> ephemeral-vrf-sdk, solana-program ">=1.18.26, <3" (resolvable
//             alongside anchor-lang 0.30.1)
//   0.17.3 -> ephemeral-rollups-sdk, hard solana-program 3.0.0 (unresolvable
//             alongside any 0.3x anchor; kept as evidence, not a candidate)
import fs from "node:fs";

const MANIFEST = "programs/vrf-spike/Cargo.toml";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sdk = arg("sdk", "0.2.3");
const anchor = arg("anchor", "0.30.1");
const pin = arg("pin-solana", "none");

const SDK_LINE =
  sdk === "0.17.3"
    ? 'ephemeral-rollups-sdk = { version = "=0.17.3", features = ["vrf", "anchor-compat"] }'
    : `ephemeral-vrf-sdk = { version = "=${sdk}", features = ["anchor"] }`;

let src = fs.readFileSync(MANIFEST, "utf8");

// Drop any previously injected SDK / pin lines, then re-insert the variant.
src = src.replace(/^(ephemeral-(vrf|rollups)-sdk|solana-program)\s*=.*\n/gm, "");
src = src.replace(
  /^anchor-lang = \{[^\n]*\}$/m,
  `anchor-lang = { version = "${anchor}", features = ["init-if-needed"] }`,
);
src = src.replace(/^ephemeral-(vrf|rollups)-sdk = .*$/m, "");
if (pin !== "none") {
  src = src.replace(/^(anchor-lang = \{[^\n]*\}\n)/m, `$1solana-program = "=${pin}"\n`);
}
src = src.replace(/^(anchor-lang = \{[^\n]*\}\n)/m, `$1${SDK_LINE}\n`);

fs.writeFileSync(MANIFEST, src);

const deps = src
  .split("\n")
  .filter((l) => /^(anchor-lang|ephemeral-\S+-sdk|solana-program)\s*=/.test(l))
  .join("\n");
console.log(`patched ${MANIFEST}: sdk=${sdk} anchor=${anchor} pin-solana=${pin}`);
console.log(deps);
