// Rewrites programs/vrf-spike/Cargo.toml so the compatibility matrix can be
// built from one committed source of truth. Idempotent.
//
//   node scripts/vrf-spike-patch-manifest.mjs --anchor 0.30.1 --pin-solana none
//   node scripts/vrf-spike-patch-manifest.mjs --anchor 0.30.1 --pin-solana 1.18.26
//   node scripts/vrf-spike-patch-manifest.mjs --anchor 0.31.1 --pin-solana none
//
// Why --pin-solana exists: ephemeral-rollups-sdk 0.17.3 declares a non-optional
// `solana-program =3.0.0` plus an optional `solana-program =">=1.16,<3"` under
// `backward-compat`. Anchor 0.30.1 needs solana-program 1.18. Without a pin,
// cargo is free to satisfy the compat range with a 2.x release, which would
// leave two different `AccountInfo` types in one program. The pin forces
// unification on the version Anchor actually uses.
import fs from "node:fs";

const MANIFEST = "programs/vrf-spike/Cargo.toml";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const anchor = arg("anchor", "0.30.1");
const pin = arg("pin-solana", "none");

let src = fs.readFileSync(MANIFEST, "utf8");

// anchor-lang line: keep the feature set, swap the version.
src = src.replace(/^anchor-lang = \{[^\n]*\}$/m, `anchor-lang = { version = "${anchor}", features = ["init-if-needed"] }`);

// solana-program pin: remove any previous pin, then re-add if asked for.
src = src.replace(/^solana-program = "[^"]*"\n/m, "");
if (pin !== "none") {
  src = src.replace(/^(anchor-lang = \{[^\n]*\}\n)/m, `$1solana-program = "=${pin}"\n`);
}

fs.writeFileSync(MANIFEST, src);

const deps = src
  .split("\n")
  .filter((l) => /^(anchor-lang|ephemeral-rollups-sdk|solana-program)\s*=/.test(l))
  .join("\n");
console.log(`patched ${MANIFEST}: anchor=${anchor} pin-solana=${pin}`);
console.log(deps);
