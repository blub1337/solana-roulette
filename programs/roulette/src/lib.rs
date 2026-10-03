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

/// Move `amount` lamports from `from` to `to`.
///
/// Deliberately NOT a System Program `transfer` CPI: the round escrow is owned
/// by THIS program (created in create_round with `owner = crate::ID`), and the
/// System Program refuses to debit an account it does not own ("instruction
/// spent from the balance of an account it does not own"). A program may debit
/// and credit lamports on accounts it owns directly, so settlement does that,
/// with checked arithmetic on both sides.
fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    let mut from_lamports = from.try_borrow_mut_lamports()?;
    let mut to_lamports = to.try_borrow_mut_lamports()?;
    **from_lamports = (*from_lamports)
        .checked_sub(amount)
        .ok_or(RouletteError::ArithmeticOverflow)?;
    **to_lamports = (*to_lamports)
        .checked_add(amount)
        .ok_or(RouletteError::ArithmeticOverflow)?;
    Ok(())
}

// The live devnet program (upgraded in place via the operator as upgrade
// authority). Keep in sync with Anchor.toml, ROULETTE_PROGRAM_ID and
// NEXT_PUBLIC_ROULETTE_PROGRAM_ID.
declare_id!("F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos");

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

    /// Operator-only fee update. Devnet ops tool: the seed-time fee (750) was
    /// a mistake, and `initialize_config` is one-shot, so the live fee was
    /// stuck at 0.75% while every doc/UX targeted 2%. Without this instruction
    /// the only path to the intended fee is a full re-deploy + re-seed, which
    /// would change the program address and orphan every existing PDA.
    ///
    /// Guards: signer must equal the config's stored operator (the same key
    /// that opens rounds and was the upgrade authority here), the value must
    /// satisfy the same `<= 3000` cap as `initialize_config`, and the config
    /// must be initialized. The fee only ever takes effect on future locks:
    /// `create_round` snapshots `config.fee_bps` into the new Round and
    /// `lock_round` re-freezes it, so already-open rounds settle at the fee
    /// they were opened with — no retroactive change, ever.
    pub fn set_fee(ctx: Context<SetFee>, fee_bps: u16) -> Result<()> {
        let config = &mut ctx.accounts.config;
        // (The config PDA is seed-validated and must already exist — Anchor
        // deserialization fails otherwise — so no separate init check.)
        require!(
            ctx.accounts.operator.key() == config.operator,
            RouletteError::InvalidOperator
        );
        require!(fee_bps <= 3000, RouletteError::InvalidFeeBps);
        config.fee_bps = fee_bps;
        Ok(())
    }

    /// Operator-only treasury (platform fee wallet) update. Devnet ops tool:
    /// the treasury is otherwise frozen at `initialize_config`, so moving the
    /// fee recipient would require a full re-deploy + re-seed — changing the
    /// program address and orphaning every existing PDA.
    ///
    /// Same trust root as `set_fee`: the signer must equal the stored operator
    /// (the key that was the upgrade authority here). Only FUTURE payouts are
    /// affected — `pay_winners` reads `config.treasury` at call time, so any
    /// round already settled or paid keeps exactly what it recorded, and fees
    /// already received are never moved. Never retroactive.
    pub fn set_treasury(ctx: Context<SetTreasury>, treasury: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            ctx.accounts.operator.key() == config.operator,
            RouletteError::InvalidOperator
        );
        require!(treasury != Pubkey::default(), RouletteError::InvalidTreasuryAddress);
        config.treasury = treasury;
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
            reveal_input: [0u8; 32],
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

    /// Anyone locks a FULL round, committing the reveal slot and freezing the
    /// fee snapshot. PERMISSIONLESS BY CONSTRUCTION: every written value is
    /// either read from the seed-validated `config` PDA or from `Clock::get()`,
    /// so the caller's identity cannot change the result. The only caller-
    /// influenced input is the execution slot, and letting anyone lock the
    /// instant a round goes FULL *removes* the operator's ability to pick a
    /// favourable reveal slot (grinding) rather than granting one.
    pub fn lock_round(ctx: Context<LockRound>) -> Result<()> {
        let config = &ctx.accounts.config;
        let round = &mut ctx.accounts.round;
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

    /// Settle phase 1 (PERMISSIONLESS): derive entropy from the committed
    /// future blockhash and freeze winner + fee + payout on the Round account.
    /// No lamports move here. Replay-safe: recomputation is deterministic, and
    /// pay_winners later requires RANDOMNESS_PENDING + winner match.
    ///
    /// Why this is safe to open to anyone. Every value written is a pure
    /// function of state the program validates itself:
    ///   * entropy  <- `slot_hashes`, now address-pinned to the real sysvar, so
    ///                 a caller cannot supply forged hash bytes;
    ///   * winner   <- `pick_winner`, which rejects any participant list that
    ///                 is not the canonical index-ordered weight chain and
    ///                 requires `count == round.participant_count`, so a caller
    ///                 cannot substitute, reorder, truncate or pad the entries;
    ///   * fee/payout <- the FROZEN `round.fee_bps` / `round.pot`, and
    ///                 `treasury` must equal `config.treasury`.
    /// The signer is only ever the transaction fee payer. The operator can
    /// therefore neither stall nor influence settlement — it can only stop
    /// *submitting*, and anyone (including a competitor) can submit instead.
    ///
    /// `lock_round` moves the round FULL -> RANDOMNESS_PENDING and commits the
    /// reveal slot, so settle must run from RANDOMNESS_PENDING. It previously
    /// required FULL, which made settlement unreachable.
    pub fn settle_round<'info>(ctx: Context<'_, '_, 'info, 'info, SettleRound<'info>>) -> Result<()> {
        let round = &mut ctx.accounts.round;
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
        // Persist the EXACT input the program hashed, read from the SlotHashes
        // sysvar above. Without it the outcome is not independently
        // recomputable, because the sysvar holds per-slot bank hashes that no
        // RPC exposes via getBlock(slot).blockhash. Written before the freeze
        // so a replay of settle reproduces the same value byte for byte.
        round.reveal_input = reveal_blockhash;
        // Status stays RANDOMNESS_PENDING: payouts happen in pay_winners. The
        // frozen winner + amounts make any replay produce identical values, so
        // re-running settle is harmless (on-chain determinism, not trust).
        Ok(())
    }

    /// Settle phase 2 (PERMISSIONLESS): pay 92.5% to the frozen winner account
    /// and 7.5% to config.treasury, then mark COMPLETED — atomically. Requires
    /// RANDOMNESS_PENDING; a completed round can never be paid again.
    ///
    /// Safe to open to anyone: `winner_account` must equal the `round.winner`
    /// frozen in phase 1, `treasury` must equal `config.treasury`, and both
    /// amounts are the frozen `payout_lamports` / `fee_lamports`. The caller
    /// supplies no amount, no recipient and no account that is not already
    /// pinned on-chain, so a permissionless `pay_winners` moves exactly the
    /// same lamports to exactly the same accounts as an operator-signed one.
    /// This is what removes the operator's ability to censor a payout.
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
        // (a circular derivation) made invoke_signed fail with "Provided seeds
        // do not result in a valid address", which blocked every payout.
        // Settlement no longer signs at all: it moves lamports directly.

        // 92.5% to the verified winner, 7.5% to the platform fee wallet.
        // Both move lamports out of the program-owned escrow (see move_lamports).
        move_lamports(
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.winner_account.to_account_info(),
            round.payout_lamports,
        )?;
        move_lamports(
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            round.fee_lamports,
        )?;

        round.status = RoundStatus::Completed;
        Ok(())
    }

    /// Operator cancels a non-completed round: refunds every participant's
    /// exact deposit from escrow. remaining_accounts are
    /// (Participant_i, wallet_i) pairs; each wallet must match its record.
    ///
    /// DELIBERATELY STAYS OPERATOR-ONLY, unlike lock/settle/pay. Refunds are
    /// exact, so this is not a theft vector — but making it permissionless
    /// would let anyone front-run settlement of a healthy FULL round, destroy
    /// the pot and kill the fee. Note it grants no fund-holding power: a FULL
    /// round can always be settled and paid by anyone, so a vanished operator
    /// cannot strand user funds. Removing this gate safely would need a
    /// timeout (refund only after the round is provably unsettleable), which
    /// is a larger state change than this task allows.
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
        let _escrow_bump = ctx.bumps.escrow;
        let _round_key = round.key();

        // Full-walk discipline, mirroring pick_winner (C1 follow-up): the list
        // must be EVERY participant in index order, exactly once, and the
        // refunded total must equal the pot. Without this a caller could (a)
        // pass one Participant twice and double-refund it (data is not zeroed
        // here), or (b) pass a partial/empty list and strand the remaining
        // deposits behind status=Cancelled with pot=0. Legitimate callers
        // (operator.ts) send the complete index-sorted list, so this only
        // rejects malformed refund attempts.
        let mut refunded: u64 = 0;
        let mut count: u32 = 0;
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
            // Account-identity checks identical to pick_winner's (C1 fix): a
            // refund must come FROM the program's own Participant account, not
            // from any 101+-byte blob a caller fabricates. Owner first (a PDA
            // of another program or an attacker-controlled account never
            // passes), then the exact Anchor discriminator, then round/wallet.
            require!(p.owner == &crate::id(), RouletteError::InvalidParticipant);
            if data[0..8] != participant_discriminator() {
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
            let index = u32::from_le_bytes(data[96..100].try_into().unwrap());
            drop(data);

            // Position must match the deposit order: a duplicate participant
            // repeats its index, an omitted one leaves a gap — both fail.
            require!(index == count, RouletteError::InvalidParticipant);
            require!(wallet.key() == p_wallet, RouletteError::InvalidParticipant);
            refunded = refunded
                .checked_add(amount)
                .ok_or(RouletteError::ArithmeticOverflow)?;
            // `wallet` is already an &AccountInfo from remaining_accounts.
            move_lamports(
                &ctx.accounts.escrow.to_account_info(),
                wallet,
                amount,
            )?;
            count = count
                .checked_add(1)
                .ok_or(RouletteError::ArithmeticOverflow)?;
        }
        // The walk must have covered every participant exactly once and moved
        // exactly the pot: no stranded deposits, no over-refund, no double
        // refund. (A zero-amount participant cannot exist — deposits are
        // >= min_deposit > 0 — so sum(amounts) == pot identifies the full set.)
        require!(count == round.participant_count, RouletteError::InvalidParticipant);
        require!(refunded == round.pot, RouletteError::InvalidParticipant);

        round.status = RoundStatus::Cancelled;
        round.pot = 0;
        round.total_weight = 0;
        Ok(())
    }
}
