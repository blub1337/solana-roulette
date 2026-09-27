#!/bin/sh
# Fetch the published (yanked) ephemeral-vrf-sdk 0.2.3 tarball and its yanked
# proc-macro dependency from crates.io's static storage and unpack both as
# local path dependencies.
#
# Why this exists: 0.2.3 is the only published MagicBlock VRF SDK line whose
# declared requirements coexist with anchor-lang 0.30.1, and cargo refuses to
# SELECT a yanked version — but it will happily build one that is already
# present as a path dependency. The tarball is still served after a yank, so the
# real, unmodified 0.2.3 code can still be compiled and measured.
#
# Provenance is the point: these are the exact bytes crates.io published for
# 0.2.3, not a re-implementation. `shasum -a 256` is printed so the artifact can
# be pinned by hash in any follow-up.
set -eu

VENDOR_DIR="${1:-/tmp/vendor}"
SDK_VER="0.2.3"
MACRO_VER="0.2.3"

mkdir -p "$VENDOR_DIR"

fetch() {
  crate="$1"
  ver="$2"
  file="$VENDOR_DIR/${crate}-${ver}.crate"
  url="https://static.crates.io/crates/${crate}/${crate}-${ver}.crate"
  echo "fetching ${crate} ${ver}"
  if [ ! -f "$file" ]; then
    curl -sSfL --retry 3 --retry-delay 2 "$url" -o "$file"
  fi
  echo "  sha256: $(shasum -a 256 "$file" | cut -d' ' -f1)"
  rm -rf "${VENDOR_DIR}/${crate}-${ver}"
  tar xzf "$file" -C "$VENDOR_DIR"
  test -f "${VENDOR_DIR}/${crate}-${ver}/Cargo.toml" || {
    echo "unpack failed for ${crate} ${ver}" >&2
    exit 1
  }
}

fetch ephemeral-vrf-sdk "$SDK_VER"
fetch ephemeral-vrf-sdk-vrf-macro "$MACRO_VER"

echo "vendored into ${VENDOR_DIR}:"
ls -d "${VENDOR_DIR}"/*/ | sed 's/^/  /'
echo
echo "declared requirements of the vendored SDK:"
grep -A2 -E '^\[(dependencies|dependencies\.)' "${VENDOR_DIR}/ephemeral-vrf-sdk-${SDK_VER}/Cargo.toml" | head -40
