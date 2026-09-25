use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const ROUND_SEED: &[u8] = b"round";
pub const PARTICIPANT_SEED: &[u8] = b"participant";
pub const ESCROW_SEED: &[u8] = b"escrow";

/// Reveal offset in slots (~12s at ~400ms/slot). Committed at lock; 32 << 150-slot
/// SlotHashes retention window. Must stay well inside the retention window.
pub const REVEAL_OFFSET_SLOTS: u64 = 32;

/// Anchor space: 8 disc + 32 round + 32 wallet + 8 amount + 16 weight_start + 4 index + 1 bump
pub const PARTICIPANT_SPACE: usize = 101;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[repr(u8)]
pub enum RoundStatus {
    #[default]
    Open = 0,
    Full = 1,
    /// Kept for API/DTO compatibility; the chain jumps straight to
    /// RandomnessPending at lock (winner-frozen happen at settle phase 1).
    Locked = 2,
    /// Terminal pre-payout state: randomness + winner + amounts frozen on Round.
    RandomnessPending = 3,
    /// Kept for API/DTO compatibility only.
    Settling = 4,
    Completed = 5,
    Cancelled = 6,
}

#[account]
pub struct GlobalConfig {
    pub operator: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub max_round_size: u64,
    pub min_deposit: u64,
    pub max_deposit: u64,
    pub reveal_offset: u64,
    /// Monotonic counter of created rounds; create_round validates
    /// args.round_id == counter + 1 and increments.
    pub round_counter: u64,
    /// Max total pool volume per tier in lamports (index = tier).
    /// Three fully independent lanes: 0 = 1 SOL, 1 = 10 SOL, 2 = 100 SOL.
    /// Enforced per round in `deposit` — never a frontend-only rule.
    pub tier_caps: [u64; 3],
    pub bump: u8,
}

#[account]
pub struct Round {
    pub id: u64,
    pub status: RoundStatus,
    pub escrow: Pubkey,
    pub pot: u64,
    pub total_weight: u128,
    pub participant_count: u32,
    pub lock_slot: u64,
    pub reveal_slot: u64,
    /// Fee snapshot frozen at lock time (from config.fee_bps).
    pub fee_bps: u16,
    pub randomness: [u8; 32],
    pub winning_ticket: u128,
    /// Frozen at settle phase 1.
    pub winner: Pubkey,
    pub fee_lamports: u64,
    pub payout_lamports: u64,
    /// Frozen at settle phase 1; pay_winners validates the supplied account.
    pub payout_account: Pubkey,
    /// Pool lane of this round (index into GlobalConfig.tier_caps).
    /// Set once at create_round and never mutated.
    pub tier: u8,
    pub bump: u8,
}

#[account]
pub struct Participant {
    pub round: Pubkey,
    pub wallet: Pubkey,
    pub amount: u64,
    pub weight_start: u128,
    pub index: u32,
    pub bump: u8,
}

// ---------------- Contexts ----------------

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = operator,
        space = 8 + 32 + 32 + 2 + 8 + 8 + 8 + 8 + 8 + 24 + 1,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub operator: Signer<'info>,
    /// CHECK: treasury = platform fee wallet chosen at init; key stored on
    /// config and paid the 7.5% fee by pay_winners. Writable for that CPI.
    #[account(mut)]
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

/// Intended round id passed as an arg so the client derives the PDA; the
/// program enforces round_id == counter + 1. Seeds cannot read instruction
/// args in Anchor 0.30, so the PDA is validated manually in lib.rs.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateRoundArgs {
    pub round_id: u64,
    /// Pool lane (0=1 SOL, 1=10 SOL, 2=100 SOL). Validated < 3.
    pub tier: u8,
}

#[derive(Accounts)]
pub struct CreateRound<'info> {
    /// Validated against config PDA seeds in lib.rs (owner + bump re-derivation).
    /// CHECK: manual PDA validation in lib.rs.
    #[account(mut)]
    pub config: Account<'info, GlobalConfig>,
    /// CHECK: manual PDA validation (seeds [ROUND_SEED, round_id_le]) in lib.rs.
    #[account(zero)]
    pub round: UncheckedAccount<'info>,
    /// CHECK: manual seed validation in lib.rs.
    pub escrow: UncheckedAccount<'info>,
    #[account(mut)]
    pub operator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump)]
    pub round: Account<'info, Round>,
    #[account(
        init_if_needed,
        payer = depositor,
        space = PARTICIPANT_SPACE,
        seeds = [PARTICIPANT_SEED, round.key().as_ref(), depositor.key().as_ref()],
        bump
    )]
    pub participant: Account<'info, Participant>,
    /// CHECK: seeds validated; receives lamports from the depositor.
    #[account(mut, seeds = [ESCROW_SEED, round.key().as_ref()], bump)]
    pub escrow: AccountInfo<'info>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LockRound<'info> {
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump)]
    pub round: Account<'info, Round>,
    /// CHECK: seeds validated; listed for consistency (no lamport movement).
    #[account(seeds = [ESCROW_SEED, round.key().as_ref()], bump)]
    pub escrow: AccountInfo<'info>,
    #[account(mut)]
    pub operator: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettleRound<'info> {
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump)]
    pub round: Account<'info, Round>,
    /// CHECK: seeds validated; no movement in phase 1.
    #[account(mut, seeds = [ESCROW_SEED, round.key().as_ref()], bump)]
    pub escrow: AccountInfo<'info>,
    /// CHECK: must equal config.treasury; validated in lib.rs (no write here).
    pub treasury: AccountInfo<'info>,
    #[account(mut)]
    pub operator: Signer<'info>,
    /// CHECK: SlotHashes sysvar; layout + membership checked in winner.rs.
    pub slot_hashes: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayWinners<'info> {
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump)]
    pub round: Account<'info, Round>,
    /// CHECK: seeds validated; source of payouts.
    #[account(mut, seeds = [ESCROW_SEED, round.key().as_ref()], bump)]
    pub escrow: AccountInfo<'info>,
    /// CHECK: must equal round.winner + round.payout_account (frozen at settle).
    #[account(mut)]
    pub winner_account: AccountInfo<'info>,
    /// CHECK: must equal config.treasury (platform fee wallet); receives 7.5%.
    #[account(mut)]
    pub treasury: AccountInfo<'info>,
    #[account(mut)]
    pub operator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelRound<'info> {
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut, seeds = [ROUND_SEED, &round.id.to_le_bytes()], bump)]
    pub round: Account<'info, Round>,
    /// CHECK: seeds validated; source of refunds.
    #[account(mut, seeds = [ESCROW_SEED, round.key().as_ref()], bump)]
    pub escrow: AccountInfo<'info>,
    #[account(mut)]
    pub operator: Signer<'info>,
    pub system_program: Program<'info, System>,
}
