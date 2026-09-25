# Legal & Compliance Checklist (MANDATORY before mainnet / real-money)

> DEVNET build is intentionally not real-money gambling. This checklist gates the
> mainnet switch and must be completed and signed off by counsel. No item may be
> waived by developers.

## A. Regulatory classification

- [ ] Determine target-market gambling classification (game of chance with paid entry + prize = gambling in most jurisdictions).
- [ ] Map every target jurisdiction's licensing regime (e.g. Malta MGA, UK GC, Curaçao, US state-by-state).
- [ ] Confirm Solana/program code does not create nexus in prohibited jurisdictions (geo-blocking plan).
- [ ] Assess whether "pool/raffle" framing changes classification in target markets.

## B. Licensing & registration

- [ ] Obtain required gambling licenses BEFORE accepting real-money stakes.
- [ ] Register corporate entity in a licensing-friendly jurisdiction if required.
- [ ] Appoint a compliance officer / AML officer where required.

## C. Player protection (usually license conditions)

- [ ] KYC/AML provider integrated (identity, sanctions/PEP screening).
- [ ] Age verification (18+/21+ as required) enforced before deposit.
- [ ] Self-exclusion and cooling-off periods implemented.
- [ ] Deposit/loss limits configurable by the player.
- [ ] Reality checks / session reminders.
- [ ] Problem-gambling helpline links in UI.
- [ ] RNG certification by an accredited test house (GLI-19 or equivalent) — even with VRF, obtain certification for target market.

## D. AML / financial

- [ ] Transaction monitoring with thresholds and suspicious-activity reporting.
- [ ] Travel Rule / VASP analysis for the operator's jurisdiction.
- [ ] Treasury/funds segregation policy; player-funds protection rules.
- [ ] Tax reporting strategy for players and operator per jurisdiction.

## E. Technical prerequisites for real money

- [ ] External smart-contract audit (two independent firms recommended) with fixes verified.
- [ ] Mainnet program deploy with upgrade authority held by a multisig (Squads).
- [ ] Real VRF randomness (Switchboard/Chainlink/Orao) — devnet blockhash adapter disabled.
- [ ] Incident response plan: pause mechanism, cancellation/refund runbook.
- [ ] Bug bounty program live.
- [ ] Key management: operator/treasury in HSM or multisig; no hot keys on app servers.

## F. Terms & disclosures

- [ ] Terms of Service covering odds disclosure (odds = contribution/pot, fully public).
- [ ] Privacy policy + GDPR/CCPA compliance for any PII collected by KYC.
- [ ] Jurisdictional eligibility checks at signup + VPN/detection policy.
- [ ] Public display of license number(s) and responsible-gambling resources.

## G. Sign-off

- [ ] Legal counsel approval (name, date): ______________
- [ ] Compliance officer approval (name, date): ______________
- [ ] CTO/Security approval (name, date): ______________

Only after **all** boxes are checked may `ENABLE_MAINNET=true` be set.
