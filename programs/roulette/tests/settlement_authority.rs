//! B2 regression guard: settlement authority + the entropy-sysvar pin.
//!
//! `lock_round`, `settle_round` and `pay_winners` are PERMISSIONLESS — the
//! signer is only the transaction fee payer, because every value they write is
//! a pure function of state the program validates itself. `cancel_round` stays
//! operator-gated, otherwise anyone could front-run settlement of a healthy
//! FULL round and destroy the pot.
//!
//! `SettleRound::slot_hashes` is pinned to the real SlotHashes sysvar with an
//! `address =` constraint. That pin is load-bearing for permissionless settle:
//! a bare `AccountInfo` is attacker-supplied and `extract_slot_hash` parses
//! whatever bytes it is handed, so without the pin a permissionless caller
//! could pass a PDA they own containing `(reveal_slot, hash_of_their_choosing)`
//! and pick the winner. While settle was operator-gated the hole was masked by
//! trust in the operator; opening the gate turns it into a winner-picking bug.
//!
//! These are source-level invariants because the failure mode is "someone
//! re-adds a gate" or "someone loosens a constraint" — both are compile-safe
//! and would otherwise only be caught by an audit. The behavioural proof is
//! `scripts/devnet-permissionless-settle-e2e.ts`, which settles and pays a
//! real round using a wallet that is NOT the configured operator.
//!
//!     cargo test --manifest-path programs/roulette/Cargo.toml --test settlement_authority

use std::fs;

/// The `src` directory of this program, resolved from the test's manifest dir.
fn src_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn read_src(file: &str) -> String {
    let p = src_dir().join(file);
    fs::read_to_string(&p).unwrap_or_else(|e| panic!("cannot read {:?}: {}", p, e))
}

/// Body of a `#[derive(Accounts)]` struct, from its `pub struct Name<'info> {`
/// line to the line that closes it (first line whose trimmed form is `}`).
fn struct_body(state_rs: &str, name: &str) -> String {
    let header = format!("pub struct {}<'info> {{", name);
    let start = state_rs
        .find(&header)
        .unwrap_or_else(|| panic!("account struct {} not found in state.rs", name));
    let rest = &state_rs[start + header.len()..];
    let end = rest
        .find("\n}")
        .unwrap_or_else(|| panic!("end of account struct {} not found", name));
    rest[..end].to_string()
}

/// Body of a `pub fn name(...) -> Result<()>` handler, from its signature to
/// the first line that is exactly `}` at column 0. Taking the whole-file
/// remainder instead would let a check match a LATER function with the same
/// error code, which is precisely the mistake this guard exists to prevent.
fn fn_body(lib_rs: &str, name: &str) -> String {
    let sig = format!("pub fn {}", name);
    let start = lib_rs
        .find(&sig)
        .unwrap_or_else(|| panic!("handler {} not found in lib.rs", name));
    // The signature is either `pub fn f(...)` or `pub fn f<'info>(...)`, so the
    // next non-space char must be `(` or `<` — otherwise `f` would match `f2`.
    let after = &lib_rs[start + sig.len()..];
    let next = after
        .trim_start()
        .chars()
        .next()
        .expect("signature must be followed by a char");
    assert!(
        next == '(' || next == '<',
        "handler {} not found (next char {:?})",
        name,
        next
    );
    let rest = &lib_rs[start..];
    let end = rest
        .find("\n    }")
        .unwrap_or_else(|| panic!("end of handler {} not found", name));
    rest[..end].to_string()
}

// ---------------------------------------------------------------------------
// The permissionless trio
// ---------------------------------------------------------------------------

#[test]
fn lock_settle_and_pay_take_a_payable_not_an_operator() {
    let state = read_src("state.rs");
    for name in ["LockRound", "SettleRound", "PayWinners"] {
        let body = struct_body(&state, name);
        assert!(
            body.contains("pub payer: Signer<'info>"),
            "{} must take `payer: Signer`, not an operator-gated signer",
            name
        );
        assert!(
            !body.contains("pub operator:"),
            "{} must not have an `operator` field; that name re-introduces an \
             implicit authority gate",
            name
        );
    }
}

#[test]
fn permissionless_handlers_reject_no_one() {
    let lib = read_src("lib.rs");
    for name in ["lock_round", "settle_round", "pay_winners"] {
        let body = fn_body(&lib, name);
        assert!(
            !body.contains("InvalidOperator"),
            "{} still gates on the operator. It is permissionless: every value \
             it writes is a pure function of program-validated state, so a gate \
             only hands the operator a stall/censor point over user funds.",
            name
        );
        assert!(
            !body.contains("config.operator"),
            "{} must not read config.operator",
            name
        );
    }
}

// ---------------------------------------------------------------------------
// cancel_round keeps its gate
// ---------------------------------------------------------------------------

#[test]
fn cancel_round_stays_operator_gated() {
    let state = read_src("state.rs");
    let lib = read_src("lib.rs");
    let body = struct_body(&state, "CancelRound");
    assert!(
        body.contains("pub operator: Signer<'info>"),
        "CancelRound must keep an operator signer"
    );
    let handler = fn_body(&lib, "cancel_round");
    assert!(
        handler.contains("InvalidOperator") && handler.contains("config.operator"),
        "cancel_round must still verify operator == config.operator. Refunds are \
         exact so it is not a theft vector, but a permissionless cancel lets \
         anyone front-run settlement of a healthy FULL round and kill the pot."
    );
}

// ---------------------------------------------------------------------------
// cancel_round full-walk discipline (C1 follow-up)
// ---------------------------------------------------------------------------

/// Regression guard for the cancel refund loop: without a completeness check a
/// caller could pass one Participant TWICE (double refund — the account data
/// is never zeroed on cancel) or a partial/empty list (remaining deposits are
/// stranded behind status=Cancelled with pot=0). The loop must therefore walk
/// participants in index order (index == count), require the full participant
/// count, and require the refunded total to equal the pot — the same
/// discipline pick_winner applies to the settle walk.
#[test]
fn cancel_round_enforces_complete_unique_refund_walk() {
    let lib = read_src("lib.rs");
    let handler = fn_body(&lib, "cancel_round");

    // Position fidelity: a duplicate repeats its index, an omission leaves a
    // gap — both must fail.
    assert!(
        handler.contains("require!(index == count"),
        "cancel_round must reject out-of-order/duplicate participant entries \
         (index == count), exactly like pick_winner"
    );
    // Full coverage: every participant must be present.
    assert!(
        handler.contains("count == round.participant_count"),
        "cancel_round must require the walk to cover round.participant_count \
         participants — a partial list would strand the missing deposits \
         behind status=Cancelled with pot=0"
    );
    // Accounting tie: refunds must sum to exactly the pot.
    assert!(
        handler.contains("refunded == round.pot"),
        "cancel_round must require refunded == round.pot — otherwise a malformed \
         list could over- or under-refund relative to the recorded pot"
    );
    // Checked accumulation of the refunded total.
    assert!(
        handler.contains("refunded = refunded"),
        "cancel_round must accumulate the refunded total with checked_add"
    );
    // Identity checks from the C1 fix must still be in place.
    assert!(
        handler.contains("p.owner == &crate::id()")
            && handler.contains("participant_discriminator()"),
        "cancel_round must keep the owner + discriminator account-identity \
         checks on every participant account it refunds"
    );
}

// ---------------------------------------------------------------------------
// The entropy-sysvar pin (the security-critical one)
// ---------------------------------------------------------------------------

#[test]
fn settle_round_pins_slot_hashes_to_the_real_sysvar() {
    let state = read_src("state.rs");
    let body = struct_body(&state, "SettleRound");

    assert!(
        body.contains("pub slot_hashes: AccountInfo<'info>"),
        "SettleRound must still carry a slot_hashes field"
    );

    // The constraint must sit on THIS field, not merely appear in the struct.
    let field_at = body
        .find("pub slot_hashes:")
        .unwrap_or_else(|| panic!("slot_hashes field not found"));
    let attrs_before = &body[..field_at];
    let since_struct = attrs_before
        .rfind("pub escrow:")
        .expect("slot_hashes must come after escrow in SettleRound");
    let attrs = &attrs_before[since_struct..];

    assert!(
        attrs.contains("address ="),
        "SECURITY: SettleRound::slot_hashes has no `address =` constraint. A bare \
         AccountInfo is attacker-supplied, so once settle_round is permissionless a \
         caller could pass a PDA they own containing (reveal_slot, chosen hash) and \
         pick the winner. Pin it to anchor_lang::solana_program::sysvar::slot_hashes::ID."
    );
    assert!(
        attrs.contains("sysvar::slot_hashes::ID"),
        "SECURITY: the `address =` constraint on slot_hashes must name the real \
         SlotHashes sysvar id, not some other constant"
    );
}

#[test]
fn the_offchain_decoder_agrees_on_the_sysvar_id() {
    // The TS twins must pass the SAME sysvar the program now pins, otherwise a
    // settle built off-chain would be rejected on-chain (or, worse, a future
    // edit would make the client pass something else).
    let sdk = fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/sdk/src/instructions.ts"),
    )
    .expect("packages/sdk/src/instructions.ts must exist");
    assert!(
        sdk.contains("SLOT_HASHES_SYSVAR"),
        "the SDK settle builder must pass SLOT_HASHES_SYSVAR"
    );
    assert!(
        sdk.contains("SYSVAR_SLOT_HASHES_PUBKEY"),
        "SLOT_HASHES_SYSVAR must be the web3.js SYSVAR_SLOT_HASHES_PUBKEY, which is \
         SysvarS1otHashes111111111111111111111111111 — the same address the Rust \
         program pins"
    );
}
