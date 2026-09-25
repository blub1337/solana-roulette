use anchor_lang::prelude::*;

#[error_code]
pub enum RouletteError {
    #[msg("Fee bps exceeds maximum (3000)")]
    InvalidFeeBps,
    #[msg("Deposit limits invalid (min <= max <= round size required)")]
    InvalidDepositLimits,
    #[msg("Config already initialized")]
    ConfigAlreadyInitialized,
    #[msg("Signer is not the configured operator")]
    InvalidOperator,
    #[msg("Round status does not permit this action")]
    InvalidRoundStatus,
    #[msg("Deposit would exceed the round cap; rejected, never truncated")]
    RoundOverCap,
    #[msg("Deposit below minimum")]
    DepositTooSmall,
    #[msg("Deposit above maximum")]
    DepositTooLarge,
    #[msg("Round is not FULL and cannot be locked")]
    RoundNotFull,
    #[msg("Reveal slot not reached yet")]
    RevealSlotNotReached,
    #[msg("Reveal slot blockhash missing from SlotHashes")]
    RevealBlockhashMissing,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Invalid participant account")]
    InvalidParticipant,
    #[msg("Nothing to refund")]
    NothingToRefund,
    #[msg("This wallet already has an entry in the round; top-ups are not allowed")]
    DuplicateDeposit,
    #[msg("Round is not in SETTLING; payout not permitted")]
    PayoutNotReady,
    #[msg("Payout account does not match the winner recorded at settle")]
    InvalidWinnerAccount,
    #[msg("Treasury account does not match the configured fee wallet")]
    InvalidTreasury,
    #[msg("Unknown pool tier (must be 0, 1 or 2)")]
    InvalidTier,
}
