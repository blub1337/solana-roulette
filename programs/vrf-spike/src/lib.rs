//! THROWAWAY MagicBlock SolanaVrf feasibility spike.
//!
//! Answers, with real evidence, the two questions that decide whether MagicBlock
//! can become the production randomness layer for a program pinned to
//! anchor-lang 0.30.1:
//!   1. COMPATIBILITY — does any published VRF SDK line resolve and compile
//!      alongside anchor-lang 0.30.1?
//!   2. RUNTIME — does a REAL devnet request actually get fulfilled, and can
//!      the consuming program itself authenticate and store the result?
//!
//! Standalone by construction: own program id, own keypair, own state account.
//! Nothing here may be merged into `programs/roulette` without the architecture
//! being agreed first.
//!
//! ONE source file serves BOTH SDK lines so a single CI run measures both:
//!   * `sdk-vrf`      -> ephemeral-vrf-sdk 0.2.3 (git tag v0.2.3). Crate path
//!                       `ephemeral_vrf_sdk::…`. The only line whose dependency
//!                       graph coexists with anchor-lang 0.30.1, but every
//!                       release in it is YANKED from crates.io.
//!   * `sdk-rollups`  -> ephemeral-rollups-sdk 0.17.3. Crate path
//!                       `ephemeral_rollups_sdk::vrf::…`. Not yanked, but it
//!                       hard-requires solana-program 3.0.0.
//! The only shared API both expose is the instruction builder, the request
//! params, the account-meta type and the constants — so the request path here
//! is written by hand (no `#[vrf]` macro, no scoped identity) exactly as
//! upstream's own non-macro example does.
//!
//! Callback authentication is the address-pinned `VRF_PROGRAM_IDENTITY`
//! Signer, which is the pattern 0.2.3 supports and 0.17.3 still accepts
//! (deprecated in favour of a scoped per-program identity, which 0.2.3 lacks).
//! Reaching the callback body therefore PROVES the VRF program verified an
//! RFC 9381 proof on-chain and signed the CPI: the consumer never verifies a
//! proof itself.
//!
//! The callback cannot fail — it bumps a counter and stores bytes. A callback
//! that can fail is a liveness bug, because the oracle's fulfillment transaction
//! would revert and the request would stay stuck in the queue.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::solana_program::program::invoke_signed;

#[cfg(feature = "sdk-rollups")]
use ephemeral_rollups_sdk::{anchor::VrfProgram, vrf as vrf_sdk};
#[cfg(not(feature = "sdk-rollups"))]
use ephemeral_vrf_sdk as vrf_sdk;
#[cfg(not(feature = "sdk-rollups"))]
use ephemeral_vrf_sdk::anchor::VrfProgram;

// Replaced by the CI workflow with the id derived from the throwaway deploy
// keypair. Kept as a valid base58 literal so the program always compiles.
declare_id!("8612E91CEV3iUtcMics7KA4fA4626qZmQQACNx71Lfy9");

pub const STATE_SEED: &[u8] = b"state";
/// The VRF program derives its identity PDA with exactly this seed.
pub const IDENTITY_SEED: &[u8] = b"identity";

/// 8 disc + 4 request_count + 4 fulfill_count + 1 client_seed + 1 last_lane
/// + 1 roll + 1 fulfilled + 32 randomness + 1 bump
pub const STATE_SPACE: usize = 8 + 4 + 4 + 1 + 1 + 1 + 1 + 32 + 1; // 53

/// Lowercase hex without adding a dependency: the spike must not perturb the
/// dependency graph it exists to measure.
fn to_hex(bytes: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for b in bytes.iter() {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// The exact shape of entropy use roulette needs: first 16 bytes -> u128 ->
/// modulo (roulette does `u128::from_le_bytes(randomness[0..16]) % total_weight`).
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
    /// 0 = first lane, 1 = second lane.
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

    /// Requests randomness through a CPI into the MagicBlock VRF program.
    ///
    /// `lane` only labels the request in the logs/state; the two lanes are the
    /// same code path issued twice, which proves a second, independent request
    /// and fulfillment.
    pub fn request_randomness(ctx: Context<RequestCtx>, client_seed: u8, lane: u8) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.request_count = state
            .request_count
            .checked_add(1)
            .ok_or(SpikeError::Overflow)?;
        state.client_seed = client_seed;
        state.last_lane = lane;
        state.fulfilled = 0;

        // caller_seed binds the VRF output to an input committed BEFORE the
        // draw. Roulette would put (round_id, lock_slot) in here.
        let ix = vrf_sdk::instructions::create_request_randomness_ix(
            vrf_sdk::instructions::RequestRandomnessParams {
                payer: ctx.accounts.payer.key(),
                oracle_queue: ctx.accounts.oracle_queue.key(),
                callback_program_id: ID,
                callback_discriminator: instruction::ConsumeRandomness::DISCRIMINATOR.to_vec(),
                caller_seed: hash(&[client_seed, state.request_count.to_le_bytes()]).to_bytes(),
                accounts_metas: Some(vec![vrf_sdk::types::SerializableAccountMeta {
                    pubkey: state.key(),
                    is_signer: false,
                    is_writable: true,
                }]),
                ..Default::default()
            },
        );

        // The VRF program requires this program to sign for its own identity
        // PDA, which is what proves the request really came from the callback
        // program and not from a relayer.
        invoke_signed(
            &ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.program_identity.to_account_info(),
                ctx.accounts.oracle_queue.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.slot_hashes.to_account_info(),
            ],
            &[&[IDENTITY_SEED, &[ctx.bumps.program_identity]]],
        )?;
        msg!(
            "VrfSpikeRequest lane={} seed={} req={} queue={} disc={}",
            lane,
            client_seed,
            state.request_count,
            ctx.accounts.oracle_queue.key(),
            ix.data[0],
        );
        Ok(())
    }

    /// The VRF callback, invoked by the VRF program only.
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

/// Client account order: payer, program_identity, oracle_queue, state,
/// system_program, slot_hashes, vrf_program.
#[derive(Accounts)]
pub struct RequestCtx<'info> {
    /// Pays the transaction fee AND the VRF request fee (0.0005–0.0008 SOL).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: seeds validated against [b"identity"] of this program; signed
    /// for during the CPI so the VRF program knows who asked.
    #[account(seeds = [IDENTITY_SEED], bump)]
    pub program_identity: AccountInfo<'info>,
    /// CHECK: oracle queue — the request pays into this account and the
    /// fulfillment is drawn from it.
    #[account(mut, address = vrf_sdk::consts::DEFAULT_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
    #[account(mut, seeds = [STATE_SEED], bump)]
    pub state: Account<'info, SpikeState>,
    pub system_program: Program<'info, System>,
    /// CHECK: SlotHashes sysvar; the VRF program mixes its entry into the
    /// request id, so the address must be pinned.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: AccountInfo<'info>,
    /// CHECK: the VRF program itself; listed so it is in the transaction's
    /// account list for the CPI.
    pub vrf_program: Program<'info, VrfProgram>,
}

#[derive(Accounts)]
pub struct ConsumeCtx<'info> {
    /// Only the VRF program can sign for this address, and it only signs after
    /// verifying the proof on-chain. This pin IS the program's verification.
    #[account(address = vrf_sdk::consts::VRF_PROGRAM_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut, seeds = [STATE_SEED], bump)]
    pub state: Account<'info, SpikeState>,
}

#[error_code]
pub enum SpikeError {
    #[msg("arithmetic overflow")]
    Overflow,
}
