/**
 * Instruction builders + client for the roulette program.
 *
 * The Anchor program (programs/roulette) owns the accounts; these builders
 * construct identical instruction shapes so the frontend can sign real
 * program interactions once deployed (CHAIN_MODE=onchain). In demo/offchain
 * mode the API uses the same math via packages/verification, and deposits are
 * clearly simulated (no user funds move).
 */
export * from "./pda.js";
export * from "./instructions.js";
export * from "./client.js";
