//! Solana Roulette — DEVNET-first on-chain roulette.
//!
//! Lamports only, checked arithmetic everywhere, deterministic winner selection.
//! See docs/SMART_CONTRACT.md. Mainnet use is gated off-chain (ENABLE_MAINNET)
//! and requires an external audit + real VRF (docs/RANDOMNESS.md §3).
//!
//! On-chain state machine: OPEN → FULL → RANDOMNESS_PENDING → COMPLETED | CANCELLED
//! settle_round (phase 1) freezes randomness/winner/fee/payout while FULL;
//! pay_winners (phase 2) pays atomically and flips to COMPLETED. LOCKED and
//! SETTLING exist as DTO aliases for API/UI compatibility.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
// Needed for `Round::discriminator()` when the account is written by hand.
use anchor_lang::Discriminator;

pub mod errors;
pub mod state;
pub mod winner;

pub use errors::*;
pub use state::*;
pub use winner::*;

declare_id!("AAHBk1qbXCzsbiLe7TiXuZNTvNPVtovtC6NWk9tsi6EZ");

#[program]
pub mod roulette {
    use super::*;

    /// One-time global configuration. The treasury is the platform fee wallet:
    /// it only ever RECEIVES the 7.5% fee. Player deposits NEVER touch it.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        operator: Pubkey,
        fee_bps: u16,
        max_round_size: u64,
        min_deposit: u64,
        max_deposit: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(config.bump == 0, RouletteError::ConfigAlreadyInitialized);
        require!(fee_bps <= 3000, RouletteError::InvalidFeeBps);
        require!(min_deposit > 0, RouletteError::InvalidDepositLimits);
        require!(min_deposit <= max_deposit, RouletteError::InvalidDepositLimits);
        require!(max_deposit <= max_round_size, RouletteError::InvalidDepositLimits);
        require!(max_round_size >= 2, RouletteError::InvalidDepositLimits);

        config.operator = operator;
        config.treasury = ctx.accounts.treasury.key();
        config.fee_bps = fee_bps;
        config.max_round_size = max_round_size;
        config.min_deposit = min_deposit;
        config.max_deposit = max_deposit;
        config.reveal_offset = REVEAL_OFFSET_SLOTS;
        config.round_counter = 0;
        // Devnet default tier lanes (1 / 10 / 100 SOL); may be re-initialized
        // together with the rest of the config before going live.
        config.tier_caps = [
            1_000_000_000,
            10_000_000_000,
            100_000_000_000,
        ];
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Operator opens round `args.round_id` (= counter + 1, enforced) in pool
    /// lane `args.tier` (0=1 SOL, 1=10 SOL, 2=100 SOL). The tier fixes the
    /// round's pool cap for its whole lifetime.
    pub fn create_round(ctx: Context<CreateRound>, args: CreateRoundArgs) -> Result<()> {
        // Config PDA validation (cannot use seeds= with an arg-derived seed).
        let expected_config = Pubkey::find_program_address(&[CONFIG_SEED], &crate::ID).0;
        require!(
            ctx.accounts.config.key() == expected_config,
            RouletteError::InvalidOperator
        );
        require!(
            ctx.accounts.operator.key() == ctx.accounts.config.operator,
            RouletteError::InvalidOperator
        );
        require!(
            args.round_id == ctx.accounts.config.round_counter.checked_add(1).ok_or(RouletteError::ArithmeticOverflow)?,
            RouletteError::InvalidRoundStatus
        );
        require!(
            (args.tier as usize) < ctx.accounts.config.tier_caps.len(),
            RouletteError::InvalidTier
        );

        // Round PDA validation: seeds [ROUND_SEED, round_id_le]. The account is
        // allocated by the signed create_account CPI further down, so only the
        // arg→PDA seed match must be enforced here.
        let round_id_bytes = args.round_id.to_le_bytes();
        let (expected_round, round_bump) =
            Pubkey::find_program_address(&[ROUND_SEED, &round_id_bytes], &crate::ID);
        require!(
            ctx.accounts.round.key() == expected_round,
            RouletteError::InvalidRoundStatus
        );

        // Escrow PDA validation: seeds [ESCROW_SEED, round_key].
        let (expected_escrow, escrow_bump) =
            Pubkey::find_program_address(&[ESCROW_SEED, expected_round.as_ref()], &crate::ID);
        require!(
            ctx.accounts.escrow.key() == expected_escrow,
            RouletteError::InvalidRoundStatus
        );

        // Fund the escrow with rent-exempt minimum so payouts always clear.
        //
        // Both accounts are created HERE, signed for by the program. The round
        // id arrives as an instruction ARG, and Anchor 0.30 cannot express
        // arg-derived seeds in an `init` constraint, so the allocation cannot
        // live in the context. A PDA may only be created by the program that
        // derives it, which is exactly what `new_with_signer` does: the client
        // passes `round` and `escrow` as plain writable accounts (never as
        // signers) and the runtime honours the program's own signature.
        let rent = Rent::get()?;
        let escrow_funding = rent.minimum_balance(0);
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.operator.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
                &[&[ESCROW_SEED, expected_round.as_ref(), &[escrow_bump]]],
            ),
            escrow_funding,
            0,
            &crate::ID,
        )?;

        // Allocate the round account (program-owned, rent paid by the operator).
        let round_info = ctx.accounts.round.to_account_info();
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::CreateAccount {
                    from: ctx.accounts.operator.to_account_info(),
                    to: round_info.clone(),
                },
                &[&[ROUND_SEED, &round_id_bytes, &[round_bump]]],
            ),
            rent.minimum_balance(ROUND_SPACE),
            ROUND_SPACE as u64,
            &crate::ID,
        )?;

        // Initialize the freshly allocated Round. The account is built in place
        // (rather than via `Account::try_from_unchecked`, whose `&'info
        // AccountInfo<'info>` signature cannot be satisfied from a context
        // field) and `try_to_vec` already emits the 8-byte Anchor
        // discriminator, so a single write lays down the whole account.
        let round = Round {
            id: args.round_id,
            status: RoundStatus::Open,
            escrow: expected_escrow,
            pot: 0,
            total_weight: 0,
            participant_count: 0,
            lock_slot: 0,
            reveal_slot: 0,
            fee_bps: ctx.accounts.config.fee_bps,
            randomness: [0u8; 32],
            winning_ticket: 0,
            winner: Pubkey::default(),
            fee_lamports: 0,
            payout_lamports: 0,
            payout_account: Pubkey::default(),
            tier: args.tier,
            bump: round_bump,
        };
        let encoded = {
            // `try_to_vec` serialises the FIELDS only; the 8-byte Anchor
            // discriminator is prepended by `Account::new`/`exit` in generated
            // code, so build the full ROUND_SPACE-byte payload by hand.
            let mut buf = Vec::with_capacity(ROUND_SPACE);
            buf.extend_from_slice(&Round::discriminator());
            buf.extend_from_slice(&round.try_to_vec()?);
            require!(buf.len() == ROUND_SPACE, RouletteError::ArithmeticOverflow);
            buf
        };
        round_info.try_borrow_mut_data()?.copy_from_slice(&encoded);

        // Persist the counter AFTER all validations (create is the only writer).
        let config = &mut ctx.accounts.config;
        config.round_counter = config
            .round_counter
            .checked_add(1)
            .ok_or(RouletteError::ArithmeticOverflow)?;
        Ok(())
    }

    /// Deposit lamports into the round escrow. Weight = amount. One entry per
    /// wallet per round: an existing participant CANNOT top up (the program
    /// rejects rather than breaking the cumulative weight chain).
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        let round = &mut ctx.accounts.round;

        require!(round.status == RoundStatus::Open, RouletteError::InvalidRoundStatus);
        require!(amount >= config.min_deposit, RouletteError::DepositTooSmall);
        require!(amount <= config.max_deposit, RouletteError::DepositTooLarge);

        let new_pot = round
            .pot
            .checked_add(amount)
            .ok_or(RouletteError::ArithmeticOverflow)?;
        // Pool-volume cap of THIS round's tier (independent lanes). The limit
        // applies to the whole pool, never truncated — over-cap deposits fail.
        let tier_cap = config
            .tier_caps
            .get(round.tier as usize)
            .copied()
            .ok_or(RouletteError::InvalidTier)?;
        require!(new_pot <= tier_cap, RouletteError::RoundOverCap);
        require!(new_pot <= config.max_round_size, RouletteError::RoundOverCap);

        let is_new = ctx.accounts.participant.wallet == Pubkey::default();
        if !is_new {
            return err!(RouletteError::DuplicateDeposit);
        }

        // Fund the escrow first (wallet -> escrow, signed by depositor).
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            amount,
        )?;

        let participant = &mut ctx.accounts.participant;
        participant.round = round.key();
        participant.wallet = ctx.accounts.depositor.key();
        participant.amount = amount;
        participant.weight_start = round.total_weight;
        participant.index = round.participant_count;
        participant.bump = ctx.bumps.participant;

        round.pot = new_pot;
        round.total_weight = round
            .total_weight
            .checked_add(amount as u128)
            .ok_or(RouletteError::ArithmeticOverflow)?;
        round.participant_count = round
            .participant_count
            .checked_add(1)
            .ok_or(RouletteError::ArithmeticOverflow)?;

        // Round auto-closes exactly when its tier's pool limit is reached.
        if round.pot == tier_cap {
            round.status = RoundStatus::Full;
        }
        Ok(())
    }

    /// Operator locks a FULL round and commits the reveal slot. Fee snapshot.
    pub fn lock_round(ctx: Context<LockRound>) -> Result<()> {
        let config = &ctx.accounts.config;
        let round = &mut ctx.accounts.round;
        require!(
            ctx.accounts.operator.key() == config.operator,
            RouletteError::InvalidOperator
        );
        require!(round.status == RoundStatus::Full, RouletteError::RoundNotFull);

        let clock = Clock::get()?;
        round.lock_slot = clock.slot;
        round.reveal_slot = clock
            .slot
            .checked_add(config.reveal_offset)
            .ok_or(RouletteError::ArithmeticOverflow)?;
        round.fee_bps = config.fee_bps; // freeze fee at lock
        round.status = RoundStatus::RandomnessPending;
        Ok(())
    }

    /// Settle phase 1 (operator): derive entropy from the committed future
    /// blockhash and freeze winner + fee + payout on the Round account. No
    /// lamports move here. Replay-safe: recomputation is deterministic, and
    /// pay_winners later requires RANDOMNESS_PENDING + winner match.
    ///
    /// `lock_round` moves the round FULL -> RANDOMNESS_PENDING and commits the
    /// reveal slot, so settle must run from RANDOMNESS_PENDING. It previously
    /// required FULL, which made settlement unreachable.
    pub fn settle_round<'info>(ctx: Context<'_, '_, 'info, 'info, SettleRound<'info>>) -> Result<()> {
        let round = &mut ctx.accounts.round;
        require!(
            ctx.accounts.operator.key() == ctx.accounts.config.operator,
            RouletteError::InvalidOperator
        );
        require!(
            round.status == RoundStatus::RandomnessPending,
            RouletteError::InvalidRoundStatus
        );

        let clock = Clock::get()?;
        require!(
            clock.slot >= round.reveal_slot,
            RouletteError::RevealSlotNotReached
        );

        // Treasury must match the configured platform fee wallet.
        require!(
            ctx.accounts.treasury.key() == ctx.accounts.config.treasury,
            RouletteError::InvalidTreasury
        );

        // Entropy: blockhash of the committed reveal slot (devnet-only scheme).
        let reveal_blockhash = extract_slot_hash(&ctx.accounts.slot_hashes, round.reveal_slot)?;
        let randomness = derive_randomness(&reveal_blockhash, round.id);
        let total_weight = round.total_weight;

        let ticket = compute_ticket_u128(&randomness, total_weight)?;
        let winner = pick_winner(
            &ctx.remaining_accounts,
            round.key(),
            ticket,
            round.participant_count,
        )?;

        // Fee math (checked, floor) from the FROZEN fee snapshot.
        let fee = (round.pot as u128)
            .checked_mul(round.fee_bps as u128)
            .and_then(|v| v.checked_div(10_000))
            .and_then(|v| u64::try_from(v).ok())
            .ok_or(RouletteError::ArithmeticOverflow)?;
        let payout = round.pot.checked_sub(fee).ok_or(RouletteError::ArithmeticOverflow)?;

        round.randomness = randomness;
        round.winning_ticket = ticket;
        round.winner = winner;
        round.payout_account = winner;
        round.fee_lamports = fee;
        round.payout_lamports = payout;
        // Status stays RANDOMNESS_PENDING: payouts happen in pay_winners. The
        // frozen winner + amounts make any replay produce identical values, so
        // re-running settle is harmless (on-chain determinism, not trust).
        Ok(())
    }

    /// Settle phase 2: pay 92.5% to the frozen winner account and 7.5% to
    /// config.treasury, then mark COMPLETED — atomically. Requires
    /// RANDOMNESS_PENDING; a completed round can never be paid again.
    pub fn pay_winners(ctx: Context<PayWinners>) -> Result<()> {
        let round = &mut ctx.accounts.round;
        require!(
            round.status == RoundStatus::RandomnessPending,
            RouletteError::PayoutNotReady
        );
        require!(
            round.winner != Pubkey::default(),
            RouletteError::InvalidWinnerAccount
        );
        require!(
            ctx.accounts.winner_account.key() == round.winner
                && ctx.accounts.winner_account.key() == round.payout_account,
            RouletteError::InvalidWinnerAccount
        );
        require!(
            ctx.accounts.treasury.key() == ctx.accounts.config.treasury,
            RouletteError::InvalidTreasury
        );

        // Escrow PDA seeds are [ESCROW_SEED, round_key, bump] — see the
        // derivation in create_round. Seeding with the escrow's OWN key here
        // (a circular derivation) makes invoke_signed fail with "Provided
        // seeds do not result in a valid address", which blocked every payout.
        let escrow_bump = ctx.bumps.escrow;
        let round_key = round.key();
        let escrow_seeds: &[&[&[u8]]] = &[&[ESCROW_SEED, round_key.as_ref(), &[escrow_bump]]];

        // 92.5% to the verified winner.
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.escrow.to_account_info(),
                    to: ctx.accounts.winner_account.to_account_info(),
                },
                escrow_seeds,
            ),
            round.payout_lamports,
        )?;

        // 7.5% to the platform fee wallet.
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.escrow.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
                escrow_seeds,
            ),
            round.fee_lamports,
        )?;

        round.status = RoundStatus::Completed;
        Ok(())
    }

    /// Operator cancels a non-completed round: refunds every participant's
    /// exact deposit from escrow. remaining_accounts are
    /// (Participant_i, wallet_i) pairs; each wallet must match its record.
    pub fn cancel_round<'info>(ctx: Context<'_, '_, 'info, 'info, CancelRound<'info>>) -> Result<()> {
        let round = &mut ctx.accounts.round;
        require!(
            ctx.accounts.operator.key() == ctx.accounts.config.operator,
            RouletteError::InvalidOperator
        );
        require!(
            matches!(round.status, RoundStatus::Open | RoundStatus::Full),
            RouletteError::InvalidRoundStatus
        );
        require!(round.pot > 0, RouletteError::NothingToRefund);

        // Same escrow PDA seeds as pay_winners: [ESCROW_SEED, round_key, bump].
        let escrow_bump = ctx.bumps.escrow;
        let round_key = round.key();
        let escrow_seeds: &[&[&[u8]]] = &[&[ESCROW_SEED, round_key.as_ref(), &[escrow_bump]]];

        let pairs = ctx.remaining_accounts.chunks(2);
        for pair in pairs {
            if pair.len() != 2 {
                return err!(RouletteError::InvalidParticipant);
            }
            let p = &pair[0];
            let wallet = &pair[1];

            let data = p.try_borrow_data()?;
            if data.len() < PARTICIPANT_SPACE {
                return err!(RouletteError::InvalidParticipant);
            }
            let p_round = Pubkey::try_from(&data[8..40])
                .map_err(|_| error!(RouletteError::InvalidParticipant))?;
            if p_round != round.key() {
                return err!(RouletteError::InvalidParticipant);
            }
            let p_wallet = Pubkey::try_from(&data[40..72])
                .map_err(|_| error!(RouletteError::InvalidParticipant))?;
            let amount = u64::from_le_bytes(data[72..80].try_into().unwrap());
            drop(data);

            require!(wallet.key() == p_wallet, RouletteError::InvalidParticipant);
            if amount == 0 {
                continue;
            }
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.escrow.to_account_info(),
                        to: wallet.to_account_info(),
                    },
                    escrow_seeds,
                ),
                amount,
            )?;
        }

        round.status = RoundStatus::Cancelled;
        round.pot = 0;
        round.total_weight = 0;
        Ok(())
    }
}
