//! THROWAWAY MagicBlock SolanaVrf feasibility spike.
//!
//! Answers two questions with real evidence, on anchor-lang 0.30.1 — the
//! version the money-moving roulette program is pinned to:
//!   1. COMPATIBILITY — does the VRF SDK resolve and compile alongside
//!      anchor-lang 0.30.1 / solana-program 1.18.26?
//!   2. RUNTIME — does a REAL devnet request get fulfilled, and can the
//!      program itself verify and consume the delivered randomness?
//!
//! Standalone by construction: its own program id, its own keypair, its own
//! state account. Nothing here may be merged into `programs/roulette` without
//! the Option A architecture being agreed first.
//!
//! Two lanes, to measure the cost/latency trade-off that roulette would buy:
//!   * lane 0 REGULAR      — `create_request_regular_randomness_ix`
//!                           (discriminator 8, legacy global identity)
//!   * lane 1 HIGH_PRIORITY— `create_request_randomness_ix`
//!                           (discriminator 3, legacy global identity)
//!
//! Both request instructions go through the SDK's own `#[vrf]` macro, whose
//! generated `invoke_signed_vrf` supplies the account list and the identity
//! bump. The callback authenticates the VRF program the only way SDK 0.2.3
//! allows: an address-pinned `Signer` on `VRF_PROGRAM_IDENTITY`. Reaching the
//! callback body therefore PROVES the VRF program verified an RFC 9381 proof
//! on-chain and signed the CPI — the program never verifies a proof itself.
//!
//! The callback is written so it CANNOT fail: it bumps a counter and stores
//! bytes, nothing else. A callback that can fail is a liveness bug, because
//! the oracle's fulfillment transaction would revert and the request would
//! stay stuck in the queue.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use ephemeral_vrf_sdk::anchor::vrf;
use ephemeral_vrf_sdk::consts::{DEFAULT_QUEUE, VRF_PROGRAM_IDENTITY};
use ephemeral_vrf_sdk::instructions::{
    create_request_randomness_ix, create_request_regular_randomness_ix, RequestRandomnessParams,
};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;

// Replaced by the CI workflow with the id derived from the throwaway deploy
// keypair. Kept as a valid base58 literal so the program always compiles.
declare_id!("8612E91CEV3iUtcMics7KA4fA4626qZmQQACNx71Lfy9");

pub const STATE_SEED: &[u8] = b"state";

/// 8 disc + 4 request_count + 4 fulfill_count + 1 client_seed + 1 last_lane
/// + 1 roll + 1 fulfilled + 32 randomness + 1 bump
pub const STATE_SPACE: usize = 8 + 4 + 4 + 1 + 1 + 1 + 1 + 32 + 1; // 53

/// Lowercase hex without pulling another dependency: the spike must not perturb
/// the dependency graph it exists to measure.
fn to_hex(bytes: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for b in bytes.iter() {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// The exact shape of entropy use roulette needs: 16 bytes -> u128 -> modulo.
/// (roulette does `u128::from_le_bytes(randomness[0..16]) % total_weight`.)
fn ticket_u128(randomness: &[u8; 32], modulus: u128) -> u128 {
    // try_into on a 16-byte slice is infallible.
    u128::from_le_bytes(randomness[0..16].try_into().unwrap()) % modulus
}

#[account]
pub struct SpikeState {
    /// How many RequestRandomness calls this program has made.
    pub request_count: u32,
    /// How many times the callback has run.
    pub fulfill_count: u32,
    pub client_seed: u8,
    /// 0 = regular request, 1 = high priority.
    pub last_lane: u8,
    /// ticket % 6 + 1, i.e. a 1..=6 "roll" derived by the program itself.
    pub roll: u8,
    /// 0 until the callback lands, then 1 — the "it really was called" flag.
    pub fulfilled: u8,
    /// The exact 32 bytes the VRF program delivered. Written ONLY by the
    /// callback, so a value here proves a real fulfillment happened.
    pub randomness: [u8; 32],
    pub bump: u8,
}

#[program]
pub mod vrf_spike {
    use super::*;

    /// Creates the state account (idempotent).
    pub fn init(ctx: Context<InitCtx>) -> Result<()> {
        msg!("VrfSpikeInit program={}", ctx.program_id);
        Ok(())
    }

    /// Lane 0: REGULAR request (discriminator 8, ~0.0005 SOL).
    pub fn request_regular(ctx: Context<RequestCtx>, client_seed: u8) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.request_count = state
            .request_count
            .checked_add(1)
            .ok_or(SpikeError::Overflow)?;
        state.client_seed = client_seed;
        state.last_lane = 0;
        state.fulfilled = 0;

        // caller_seed binds the VRF output to an input committed BEFORE the
        // draw. Roulette would put (round_id, lock_slot) here.
        let ix = create_request_regular_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::ConsumeRandomness::DISCRIMINATOR.to_vec(),
            caller_seed: hash(&[client_seed, state.request_count.to_le_bytes()]).to_bytes(),
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: state.key(),
                is_signer: false,
                is_writable: true,
            }]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        msg!(
            "VrfSpikeRequest lane=regular seed={} req={} queue={}",
            client_seed,
            state.request_count,
            ctx.accounts.oracle_queue.key(),
        );
        Ok(())
    }

    /// Lane 1: HIGH PRIORITY request (discriminator 3, ~0.0008 SOL).
    pub fn request_high_priority(ctx: Context<RequestCtx>, client_seed: u8) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.request_count = state
            .request_count
            .checked_add(1)
            .ok_or(SpikeError::Overflow)?;
        state.client_seed = client_seed;
        state.last_lane = 1;
        state.fulfilled = 0;

        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::ConsumeRandomness::DISCRIMINATOR.to_vec(),
            caller_seed: hash(&[client_seed, state.request_count.to_le_bytes()]).to_bytes(),
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: state.key(),
                is_signer: false,
                is_writable: true,
            }]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        msg!(
            "VrfSpikeRequest lane=high_priority seed={} req={} queue={}",
            client_seed,
            state.request_count,
            ctx.accounts.oracle_queue.key(),
        );
        Ok(())
    }

    /// The VRF callback. `vrf_program_identity` is an address-pinned Signer:
    /// only the VRF program can produce that signature, and it only signs
    /// after verifying the proof on-chain.
    pub fn consume_randomness(ctx: Context<ConsumeCtx>, randomness: [u8; 32]) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.fulfill_count = state
            .fulfill_count
            .checked_add(1)
            .ok_or(SpikeError::Overflow)?;
        state.randomness = randomness;
        state.roll = (ticket_u128(&randomness, 6) + 1) as u8;
        state.fulfilled = 1;
        msg!(
            "VrfSpikeConsume signer={} fulfill={} lane={} roll={} randomness={}",
            ctx.accounts.vrf_program_identity.key(),
            state.fulfill_count,
            state.last_lane,
            state.roll,
            to_hex(&randomness),
        );
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitCtx<'info> {
    #[account(
        init_if_needed,
        payer = payer,
        space = STATE_SPACE,
        seeds = [STATE_SEED],
        bump
    )]
    pub state: Account<'info, SpikeState>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// `#[vrf]` APPENDS program_identity, vrf_program, slot_hashes, system_program
/// after the fields declared here, in that order. The client account order is
/// therefore: payer, oracle_queue, state, program_identity, vrf_program,
/// slot_hashes, system_program.
#[vrf]
#[derive(Accounts)]
pub struct RequestCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: oracle queue — the caller chooses the queue, so the SDK's macro
    /// requires it to be supplied rather than injected.
    #[account(mut, address = DEFAULT_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
    #[account(mut, seeds = [STATE_SEED], bump)]
    pub state: Account<'info, SpikeState>,
}

#[derive(Accounts)]
pub struct ConsumeCtx<'info> {
    /// Only the VRF program can sign for this PDA. Address-pinning it is the
    /// whole of "the program verifies the result": the proof itself is checked
    /// by the VRF program before it signs.
    #[account(address = VRF_PROGRAM_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut, seeds = [STATE_SEED], bump)]
    pub state: Account<'info, SpikeState>,
}

#[error_code]
pub enum SpikeError {
    #[msg("arithmetic overflow")]
    Overflow,
}
