//! Winner selection: entropy derivation + cumulative-weight walk.
//! Mirrored exactly by packages/verification/src/winner.ts (property-tested).

use crate::errors::RouletteError;
use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

/// randomness = SHA256(b"roulette:reveal" ‖ round_id_le_u64 ‖ reveal_blockhash)
/// NOTE: order matches packages/verification deriveRandomness exactly.
pub fn derive_randomness(reveal_blockhash: &[u8; 32], round_id: u64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"roulette:reveal");
    hasher.update(round_id.to_le_bytes());
    hasher.update(reveal_blockhash);
    let out = hasher.finalize();
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&out);
    bytes
}

/// ticket = u128 from first 16 bytes (LE) of randomness, mod total_weight.
/// Using 16 bytes keeps the modulus effectively unbiased for a 10-SOL pot
/// (2^128 >> 10^10 lamports) while remaining u128-safe.
pub fn compute_ticket_u128(randomness: &[u8; 32], total_weight: u128) -> Result<u128> {
    if total_weight == 0 {
        return err!(RouletteError::InvalidParticipant);
    }
    let lo = u128::from_le_bytes(randomness[0..16].try_into().unwrap());
    Ok(lo % total_weight)
}

/// Walk Participant accounts (remaining_accounts, index order) until the
/// cumulative weight range contains the ticket. Validates ownership,
/// discriminator, round key, index order and the cumulative chain — any
/// deviation reverts (no hidden entries, no skipped weights).
pub fn pick_winner(
    participants: &[AccountInfo],
    round_key: Pubkey,
    ticket: u128,
    expected_count: u32,
) -> Result<Pubkey> {
    let mut cumulative: u128 = 0;
    let mut count: u32 = 0;

    for p in participants.iter() {
        let data = p.try_borrow_data()?;
        if data.len() < PARTICIPANT_SPACE {
            return err!(RouletteError::InvalidParticipant);
        }
        require!(p.owner == &crate::id(), RouletteError::InvalidParticipant);
        if data[0..8] != participant_discriminator() {
            return err!(RouletteError::InvalidParticipant);
        }
        let p_round = Pubkey::try_from(&data[8..40])?;
        require!(p_round == round_key, RouletteError::InvalidParticipant);
        let wallet = Pubkey::try_from(&data[40..72])?;
        let amount = u64::from_le_bytes(data[72..80].try_into().unwrap());
        let weight_start = u128::from_le_bytes(data[80..96].try_into().unwrap());
        let index = u32::from_le_bytes(data[96..100].try_into().unwrap());

        require!(index == count, RouletteError::InvalidParticipant);
        require!(weight_start == cumulative, RouletteError::InvalidParticipant);

        cumulative = cumulative
            .checked_add(amount as u128)
            .ok_or(RouletteError::ArithmeticOverflow)?;

        if ticket < cumulative {
            return Ok(wallet);
        }
        count = count.checked_add(1).ok_or(RouletteError::ArithmeticOverflow)?;
    }

    require!(count == expected_count, RouletteError::InvalidParticipant);
    err!(RouletteError::InvalidParticipant)
}

/// Anchor account discriminator: sha256("account:Participant")[0..8], cached.
fn participant_discriminator() -> [u8; 8] {
    use std::sync::OnceLock;
    static DISC: OnceLock<[u8; 8]> = OnceLock::new();
    *DISC.get_or_init(|| {
        let hash = Sha256::digest(b"account:Participant");
        let mut out = [0u8; 8];
        out.copy_from_slice(&hash[0..8]);
        out
    })
}

/// Extract the blockhash for `slot` from the SlotHashes sysvar data.
/// Layout: [len: u64][ (slot: u64, hash: [u8;32]) ... ] newest-first.
pub fn extract_slot_hash(slot_hashes: &AccountInfo, slot: u64) -> Result<[u8; 32]> {
    let data = slot_hashes.try_borrow_data()?;
    if data.len() < 8 {
        return err!(RouletteError::RevealBlockhashMissing);
    }
    let count = u64::from_le_bytes(data[0..8].try_into().unwrap()) as usize;
    let mut off = 8usize;
    for _ in 0..count {
        if off + 40 > data.len() {
            break;
        }
        let s = u64::from_le_bytes(data[off..off + 8].try_into().unwrap());
        if s == slot {
            let mut out = [0u8; 32];
            out.copy_from_slice(&data[off + 8..off + 40]);
            return Ok(out);
        }
        off += 40;
    }
    err!(RouletteError::RevealBlockhashMissing)
}
