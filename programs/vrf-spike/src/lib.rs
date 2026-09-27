//! THROWAWAY MagicBlock SolanaVrf feasibility spike.
//!
//! This program exists to answer ONE question with real evidence: can
//! anchor-lang 0.30.1 (the version the money-moving roulette program is pinned
//! to) integrate MagicBlock SolanaVrf, and does a REAL devnet request get
//! fulfilled with a program-verified result?
//!
//! It is deliberately standalone: it has its own program id, its own keypair,
//! its own state accounts and it is not referenced by roulette. Nothing here
//! may be merged into `programs/roulette` without the Option A architecture
//! being agreed first.
//!
//! Two callback authentication paths are exercised so the report can state
//! which one works and what each costs:
//!   * SCOPED  — `#[vrf]` / `#[vrf_callback]`: the VRF program signs the
//!               callback with PDA(["identity", THIS_PROGRAM], vrf_program),
//!               a per-consumer identity. Current recommended default.
//!   * LEGACY  — explicit `invoke_signed` + `#[account(address =
//!               VRF_PROGRAM_IDENTITY)]`: one global identity shared by every
//!               consumer. Deprecated upstream, kept here to measure it.
//!
//! The callback is written so it CANNOT fail: it only bumps a counter and
//! stores bytes. A callback that can fail is a liveness bug, because the
//! oracle's fulfillment transaction would fail and the request would be lost.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::consts::{scoped_vrf_identity, IDENTITY, VRF_PROGRAM_IDENTITY};
use ephemeral_rollups_sdk::vrf::instructions::{
    create_request_randomness_ix, create_request_scoped_randomness_ix, RequestRandomnessParams,
};
use ephemeral_rollups_sdk::vrf::rnd::random_u8_with_range;
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;

// Replaced by the CI workflow with the id derived from the throwaway deploy
// keypair. Kept as a valid base58 literal so the program always compiles.
declare_id!("8612E91CEV3iUtcMics7KA4fA4626qZmQQACNx71Lfy9");

pub const STATE_SCOPED_SEED: &[u8] = b"state_s";
pub const STATE_LEGACY_SEED: &[u8] = b"state_l";

/// 8 disc + 4 request_count + 4 fulfill_count + 1 client_seed + 1 roll
/// + 1 fulfilled + 32 randomness + 1 bump
pub const STATE_SPACE: usize = 8 + 4 + 4 + 1 + 1 + 1 + 32 + 1; // 52

/// Lowercase hex, no extra dependency: the spike must not perturb the
/// dependency graph it is trying to measure.
fn to_hex(bytes: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for b in bytes.iter() {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

#[account]
pub struct SpikeState {
    /// How many RequestRandomness calls this lane has made.
    pub request_count: u32,
    /// How many times the callback has run for this lane.
    pub fulfill_count: u32,
    pub client_seed: u8,
    /// 1..=6 derived from the VRF bytes by the program itself.
    pub roll: u8,
    /// 0 until the callback lands, then 1 — the "it really was called" flag.
    pub fulfilled: u8,
    /// The exact 32 bytes the VRF program delivered. Written ONLY by the
    /// callback, so the presence of a value here proves a real fulfillment.
    pub randomness: [u8; 32],
    pub bump: u8,
}

#[program]
pub mod vrf_spike {
    use super::*;

    /// Creates both lane state accounts (idempotent).
    pub fn init(ctx: Context<InitCtx>) -> Result<()> {
        msg!("VrfSpikeInit program={}", ctx.program_id);
        Ok(())
    }

    /// Path A (recommended): `#[vrf]`-scoped request + `#[vrf_callback]`.
    pub fn request_scoped(ctx: Context<RequestScopedCtx>, client_seed: u8) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.request_count = state
            .request_count
            .checked_add(1)
            .ok_or(SpikeError::Overflow)?;
        state.client_seed = client_seed;

        // caller_seed binds the VRF output to an input committed BEFORE the
        // draw. Roulette would put (round_id, lock_slot) here.
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::ConsumeScoped::DISCRIMINATOR.to_vec(),
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
            "VrfSpikeRequest lane=scoped seed={} req={} identity={} queue={}",
            client_seed,
            state.request_count,
            scoped_vrf_identity(&ID),
            ctx.accounts.oracle_queue.key(),
        );
        Ok(())
    }

    /// Path B (deprecated upstream): global identity, explicit invoke_signed.
    #[allow(deprecated)]
    pub fn request_legacy(ctx: Context<RequestLegacyCtx>, client_seed: u8) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.request_count = state
            .request_count
            .checked_add(1)
            .ok_or(SpikeError::Overflow)?;
        state.client_seed = client_seed;

        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::ConsumeLegacy::DISCRIMINATOR.to_vec(),
            caller_seed: hash(&[client_seed, state.request_count.to_le_bytes()]).to_bytes(),
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: state.key(),
                is_signer: false,
                is_writable: true,
            }]),
            ..Default::default()
        });
        invoke_signed(
            &ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.program_identity.to_account_info(),
                ctx.accounts.oracle_queue.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.slot_hashes.to_account_info(),
            ],
            &[&[IDENTITY, &[ctx.bumps.program_identity]]],
        )?;
        msg!(
            "VrfSpikeRequest lane=legacy seed={} req={} global_identity={} queue={}",
            client_seed,
            state.request_count,
            VRF_PROGRAM_IDENTITY,
            ctx.accounts.oracle_queue.key(),
        );
        Ok(())
    }

    /// Scoped callback. `#[vrf_callback]` injects `vrf_program_identity:
    /// Signer` at account 0, address-pinned to this program's scoped identity.
    /// Reaching this body therefore PROVES the VRF program verified an
    /// RFC 9381 proof on-chain and signed the callback.
    pub fn consume_scoped(ctx: Context<ConsumeScopedCtx>, randomness: [u8; 32]) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.fulfill_count = state
            .fulfill_count
            .checked_add(1)
            .ok_or(SpikeError::Overflow)?;
        state.randomness = randomness;
        state.roll = random_u8_with_range(&randomness, 1, 6);
        state.fulfilled = 1;
        msg!(
            "VrfSpikeConsume lane=scoped signer={} fulfill={} roll={} randomness={}",
            ctx.accounts.vrf_program_identity.key(),
            state.fulfill_count,
            state.roll,
            to_hex(&randomness),
        );
        Ok(())
    }

    /// Legacy callback validating the single global identity signer.
    pub fn consume_legacy(ctx: Context<ConsumeLegacyCtx>, randomness: [u8; 32]) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.fulfill_count = state
            .fulfill_count
            .checked_add(1)
            .ok_or(SpikeError::Overflow)?;
        state.randomness = randomness;
        state.roll = random_u8_with_range(&randomness, 1, 6);
        state.fulfilled = 1;
        msg!(
            "VrfSpikeConsume lane=legacy signer={} fulfill={} roll={} randomness={}",
            ctx.accounts.vrf_program_identity.key(),
            state.fulfill_count,
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
        seeds = [STATE_SCOPED_SEED],
        bump
    )]
    pub state_scoped: Account<'info, SpikeState>,
    #[account(
        init_if_needed,
        payer = payer,
        space = STATE_SPACE,
        seeds = [STATE_LEGACY_SEED],
        bump
    )]
    pub state_legacy: Account<'info, SpikeState>,
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
pub struct RequestScopedCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: oracle queue — the caller chooses the queue, so the macro
    /// requires it to be supplied rather than injected.
    #[account(mut, address = ephemeral_rollups_sdk::vrf::consts::DEFAULT_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
    #[account(mut, seeds = [STATE_SCOPED_SEED], bump)]
    pub state: Account<'info, SpikeState>,
}

#[derive(Accounts)]
pub struct RequestLegacyCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: this program's own identity PDA, signed for during the CPI.
    #[account(seeds = [IDENTITY], bump)]
    pub program_identity: AccountInfo<'info>,
    /// CHECK: oracle queue
    #[account(mut, address = ephemeral_rollups_sdk::vrf::consts::DEFAULT_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
    #[account(mut, seeds = [STATE_LEGACY_SEED], bump)]
    pub state: Account<'info, SpikeState>,
    pub system_program: Program<'info, System>,
    /// CHECK: SlotHashes sysvar, required by the VRF program's request ix.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: AccountInfo<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct ConsumeScopedCtx<'info> {
    #[account(mut, seeds = [STATE_SCOPED_SEED], bump)]
    pub state: Account<'info, SpikeState>,
}

#[derive(Accounts)]
pub struct ConsumeLegacyCtx<'info> {
    #[account(address = VRF_PROGRAM_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut, seeds = [STATE_LEGACY_SEED], bump)]
    pub state: Account<'info, SpikeState>,
}

#[error_code]
pub enum SpikeError {
    #[msg("arithmetic overflow")]
    Overflow,
}
