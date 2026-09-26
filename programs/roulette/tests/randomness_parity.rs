//! Three-way parity: RUST PROGRAM == NODE SERVER == BROWSER.
//!
//! Reads the SAME fixture the TypeScript twins are pinned by
//! (`packages/verification/src/fixtures/randomness-parity.json`), so the two
//! implementations cannot drift without one side failing.
//!
//! The fixture's `on-chain` vector was read off the devnet RPC from a Round
//! account after the deployed program's `settle_round` ran — it pins this Rust
//! code to what the DEPLOYED PROGRAM actually computed.
//!
//!     cargo test --manifest-path programs/roulette/Cargo.toml --test randomness_parity

use roulette::winner::derive_randomness;

/// The shared parity fixture, embedded at compile time.
const FIXTURE: &str =
    include_str!("../../../packages/verification/src/fixtures/randomness-parity.json");

/// Extract `"<key>": <value>` at or after `*pos`, advancing `*pos` past the
/// value. A tiny scanner rather than a serde_json dependency: the fixture is a
/// flat array of objects with string and integer fields only.
///
/// This is positional rather than window-based on purpose — object widths vary
/// with the hex payloads, and a fixed byte window would silently truncate the
/// last field of a vector.
fn field_at(src: &str, pos: &mut usize, key: &str) -> String {
    let pat = format!("\"{}\"", key);
    let rel = src[*pos..]
        .find(&pat)
        .unwrap_or_else(|| panic!("fixture key {:?} not found at/after byte {}", key, *pos));
    let after = *pos + rel + pat.len();
    let rest = src[after..].trim_start();
    let rest = rest
        .strip_prefix(':')
        .unwrap_or_else(|| panic!("fixture key {:?} has no value", key))
        .trim_start();
    if let Some(stripped) = rest.strip_prefix('"') {
        let end = stripped.find('"').expect("unterminated string value");
        *pos = after + (rest.len() - stripped.len()) + end + 1;
        stripped[..end].to_string()
    } else {
        // Integer (may exceed u32 — keep every digit verbatim).
        let end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '-' || c == '.'))
            .unwrap_or(rest.len());
        *pos = after + end;
        rest[..end].to_string()
    }
}

fn hex_to_array(hex: &str) -> [u8; 32] {
    assert_eq!(hex.len(), 64, "expected a 32-byte hex string, got {}", hex);
    let bytes = hex.as_bytes();
    let mut out = [0u8; 32];
    for i in 0..32 {
        let s = std::str::from_utf8(&bytes[i * 2..i * 2 + 2]).expect("valid utf8 hex");
        out[i] = u8::from_str_radix(s, 16).expect("valid hex digit");
    }
    out
}

fn array_to_hex(a: &[u8; 32]) -> String {
    a.iter().map(|b| format!("{:02x}", b)).collect()
}

#[test]
fn derive_randomness_matches_shared_parity_fixture() {
    assert!(
        FIXTURE.contains("\"on-chain\""),
        "fixture must carry the vector captured from the deployed devnet program"
    );
    assert!(
        FIXTURE.contains("\"roulette:reveal\""),
        "fixture must document the derivation formula it pins"
    );

    let vectors_at = FIXTURE
        .find("\"vectors\"")
        .expect("fixture has a vectors array");
    let mut cursor = vectors_at;
    let mut checked = 0usize;
    let mut on_chain = 0usize;

    while let Some(rel) = FIXTURE[cursor..].find("\"label\"") {
        let mut pos = cursor + rel;
        let label = field_at(FIXTURE, &mut pos, "label");
        let source = field_at(FIXTURE, &mut pos, "source");
        let round_id: u64 = field_at(FIXTURE, &mut pos, "roundId")
            .parse()
            .unwrap_or_else(|_| panic!("{}: roundId does not fit in u64", label));
        let reveal_input = hex_to_array(&field_at(FIXTURE, &mut pos, "revealInputHex"));
        let expected = field_at(FIXTURE, &mut pos, "randomnessHex");

        // The exact production call — no reimplementation here.
        let got = derive_randomness(&reveal_input, round_id);

        assert_eq!(
            array_to_hex(&got),
            expected,
            "derive_randomness diverged from the shared fixture for vector: {}",
            label
        );
        if source == "on-chain" {
            // A zero input would make the assertion vacuous.
            assert_ne!(reveal_input, [0u8; 32], "{}: on-chain input is all zero", label);
            on_chain += 1;
        }
        checked += 1;
        cursor = pos;
    }

    assert!(checked >= 2, "expected several vectors, parsed {}", checked);
    assert_eq!(on_chain, 1, "expected exactly one on-chain (deployed-program) vector");
    println!(
        "checked {} vectors ({} pinned to the deployed devnet program)",
        checked, on_chain
    );
}

#[test]
fn round_id_is_hashed_little_endian() {
    let input = [7u8; 32];
    let le1 = derive_randomness(&input, 1);
    let le256 = derive_randomness(&input, 256);
    assert_ne!(le1, le256, "round id must not be truncated");
    // 256 LE == 0x0100 — what a little-endian read of 1 << 8 produces. A
    // big-endian implementation would fail this.
    assert_eq!(derive_randomness(&input, 0x0100), le256);
}
