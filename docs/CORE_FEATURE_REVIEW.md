# Core Feature Review — SolRoll (Solana Roulette Platform)

> Stand: 1. Oktober 2026 · Basis: aktueller Arbeitsbaum im Freebuff-Workspace
> Geltungsbereich: Wallet-Verbindung, Solana-Transaktionsabwicklung,
> Pool/Einzahlung/Roulette/Gewinner-Logik, Kommissionsberechnung.
>
> Kernbefund: **Die Plattform ist bereits vollständig implementiert und produktiv
> auf Devnet live** (Programm-ID `F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos`,
> Chain-Modus, echte Devnet-SOL). Alle vier Kerndomänen existieren als
> produktionsnaher, getesteter Code — die verbleibenden Punkte sind Lücken in
> Robustheit/Trade-offs, nicht fehlende Kernfunktionen.

---

## 1. Wallet-Verbindung

### Vorhanden
| Baustein | Ort | Zustand |
|---|---|---|
| Wallet-Adapter (Phantom + Solflare), devnet fixiert | `apps/web/app/providers.tsx` | fertig, mit Hard-Gate: Mainnet nur mit `NEXT_PUBLIC_ENABLE_MAINNET=true` |
| Hydration-sicherer Connect-Button | `WalletMultiButton` in `providers.tsx` | fertig (SSR-Mismatch-Bug behoben) |
| Wallet-Fehler-UX (klassifiziert, Deutsch-bereit) | `lib/walletErrors.ts` (+ Tests) | fertig |
| Cluster-Mismatch-Probe (Wallet auf falschem Netz) | `useDeposit.ts` → `probeWalletClusterMismatch` | fertig |
| Chat-Auth via Wallet-Signatur (ed25519, ±10 min Window) | `apps/api/src/chat.ts` + `hooks/useChat.ts` | fertig, live verifiziert |

### Lücken
- **Wallet-Verbindung = Grundlage, nicht Ziel:** es gibt kein Player-Konto, kein
  Profil, keine Einzahlungs-Historie pro Wallet (Nur Admin-Ledger). OK für Devnet,
  relevanter für Mainnet.
- Wallet-Adapter `autoConnect` steht an; ein „Disconnect-Reset" von Chat-Session
  (sessionStorage-Token bei Wallet-Wechsel invalidieren) ist nicht implementiert.

## 2. Solana-Transaktionsabwicklung

### Vorhanden
- **Einzahlungen (Spieler→Escrow):** zweiphasig mit Server-Verifikation —
  `POST /deposit/intent` (idempotenter PENDING-Record) → Wallet signiert die
  Programm-`deposit`-Instruction (Chain-Modus) bzw. SystemTransfer (Lokal-Modus)
  → Simulation → Send → `POST /deposit/confirm`: **der Server liest die Transaktion
  und den Participant-PDA aus der Chain zurück**, bevor gutgeschrieben wird
  (`useDeposit.ts` + `deposits.ts` + `onchain.ts`). Client-Wort zählt nie.
- **Auszahlungen (Escrow→Gewinner+Fee):** idempotent per Ledger-Schlüssel,
  in-flight-Guard, Resume-Fenster (120 s), Solvenz-Check vor Send, **Verifikation
  beider Transfers mit exakten Beträgen + Outflow-Gleichheit** nach Bestätigung
  (`payout.ts`, `checkPayoutTx`).
- **Operator-Lifecycle-TXs:** `operator.ts` baut create/lock/settle/pay/cancel
  mit exakten Anchor-Discriminators und Account-Listen (Programm-Konten manual,
  da Anchor 0.30 keine arg-seeded `init`-Constraints kann).
- **Reconciler:** PENDING-Deposits werden periodisch (15 s) neu verifiziert oder
  terminiert (`reconcilePendingDeposits`) — kein ewiges PENDING, keine Gutschrift
  ohne Chain-Beweis.
- **Persistenz-Modell:** TxLedger im Speicher + **Postgres-Spiegel**
  (Write-Through + Restore bei Boot, 3-s-Timeout) → Idempotenz-Guards überleben
  Restarts.

### Lücken
- **Programm-Payout-Pfad (Chain-Modus) unterschreibt den Ledger-Split:** Im
  Chain-Modus zahlt das Programm 98/2 aus dem **Round-Escrow-PDA**, aber die
  Auszahlungs-Verifikation (`payout.ts`) berechnet fee/payout aus
  `cfg.feeBps` und verifiziert Transfers vom **Custody-Signer**. Da der
  Chain-Modus `payoutService` weglässt (`server.ts` wählt `undefined`), zahlt
  das Programm — die Server-Verifikation läuft dann gar nicht; die
  `settlement.ts`-Annahme „Signature ist vor completePaidRound confirmed"
  basiert auf `sendAndConfirmTransaction`. **Empfehlung:** Nach `pay_winners`
  den Programm-Transfer (Escrow→Winner + Escrow→Treasury) aus der TX lesen und
  gegen die eingefrorenen Round-Beträge verifizieren (siehe §5).
- Zwei parallele Wahrheiten (On-Chain-Round vs. Ledger-Split) sind konsistent
  gehalten, aber nur implizit — eine Verifikations-Brücke (§5) würde das
  explizit machen.

## 3. Pool / Einzahlung / Roulette / Gewinner-Logik

### Vorhanden (End-to-End)
- **On-Chain-Programm (Anchor 0.30, Rust):** vollständige State Machine
  `OPEN → FULL → RANDOMNESS_PENDING → COMPLETED/CANCELLED`. Instruktionen:
  `initialize_config`, `set_fee` (nur Operator, ≤ 3000 bps, nur zukünftige
  Locks), `create_round` (PDA-Validierung, Escrow mit Rent finanziert),
  `deposit` (Checked Math, Tier-Cap **nie** abschneidend, ein Eintrag pro Wallet
  pro Runde, Auto-FULL exakt bei Cap), `lock_round` (**permissionless**),
  `settle_round` (Phase 1, **permissionless**, SlotHashes-Pin als Pflicht-Guard,
  entropy = Blockhash des committed future slot), `pay_winners` (Phase 2,
  **permissionless**, eingefrorene Accounts/Beträge, atomar),
  `cancel_round` (nur Operator, exakte Vollwanderung mit Anti-Doppel-Refund).
- **Gewinner-Mathematik:** deterministisch —
  `SHA256("roulette:reveal" ‖ round_id_le ‖ reveal_blockhash)`, Ticket =
  `u128(rand[0..16]) mod total_weight`, kumulative Gewichts-Ranges
  (`winner.rs` ↔ `winnerCore.ts` spiegeln sich exakt, Property-getestet).
- **Independent Verification:** `packages/verification` kann den Gewinner aus
  Chain-Daten (inkl. persistiertem `reveal_input`) neu berechnen;
  `GET /api/round/:id/verify` + Verify-Panel im Pool-Room. Rust/TS-Parität
  Property-getestet.
- **Settlement-Driver:** unattended, eine Tick pro Lane, Re-Entrancy-Guard,
  Lane-Head-Rehydrierung (Boot + 120-s-Recheck, batched), Payout-Idempotenz via
  Chain-Status + Ledger.
- **Pools/API/UI:** 3 Lanes (1/10/100 SOL), Live-SSE,batched RPC mit TTL-Cache
  (429-resilient), Pool-Room mit Rad, Odds, Einträgen, Verify-Panel.

### Lücken
- **Randomness = Blockhash-Schema ist explizit devnet-only** (Commit-Reveal,
  32 Slots). Doku + Code sind sich einig (SlotHashes-Pin, `reveal_input`).
  **Mainnet braucht VRF** — `docs/RANDOMNESS.md` §3 nennt den Weg, implementiert
  ist er nicht. Größter fachlicher Gap für Real-Money.
- `cancel_round` bleibt bewusst operator-only (kein Timeout-Rückzug für
  unsettlebare Runden) — akzeptiert dokumentierter Trade-off.

## 4. Kommissionsberechnung

### Vorhanden
- **Single Source of Truth:** `fee_bps` wird beim **Lock** in die Round
  eingefroren; alle Displays lesen aus `createFeeResolver` (Chain-Modus liest
  On-Chain-Config; Local-Modus Environment; Fallback deklariert), nie hardcoded
  (Regression-Test gegen UX-Dokument-Divergenz existiert).
- **Mathematik:** `fee = pot * fee_bps / 10_000` (Floor), `payout = pot - fee`
  — identisch in Rust (`lib.rs settle_round`), TS
  (`computeFeeSplit` in `winnerCore.ts`), verifiziert in Payout-Verifikation.
- **Enforcement:** Chain-Modus via Programm (Round-frozen `fee_bps`), Local-Modus
  via Runtime-Split + Verifikation. Kein Pfad, in dem ein Client die Rate
  beeinflussen könnte.
- **Guardrails:** `set_fee` operator-only, ≤ 3000 bps; `initialize_config`
  one-shot; keine retroaktive Änderung (nur zukünftige Locks).

### Lücken
- Kein Fee-Reporting/Analysis (accrued fees werden nur im Admin-Overview
  gezeigt, kein Verlauf).

---

## 5. Konkrete Empfehlungen (Priorisiert)

1. **P0 — Programm-Payout-Verifikationsbrücke (Chain-Modus):** Nach
   `backend.runLifecycle("pay", …)` die TX zurücklesen und prüfen:
   Escrow→Winner == `round.payout_lamports`, Escrow→Treasury ==
   `round.fee_lamports`, sonst NICHT abschließen. Heute verlässt sich der
   Chain-Modus auf `sendAndConfirmTransaction` + tx err-Feld; die strenge
   Betragsprüfung des Local-Pfads fehlt dort.
2. **P0 — VRF-Upgrade-Pfad (für Real-Money):** Blockhash-Entropie ist devnet-only
   per Design; für Mainnet `docs/RANDOMNESS.md` §3 (VRF) implementieren.
3. **P1 — Chat-Session-Rotation bei Wallet-Wechsel** (Disconnect → Token
   invalidieren) und `CHAT_SESSION_SECRET` explizit auf Render/Production
   setzen (Fallback auf `ADMIN_TOKEN` funktioniert, aber Rotationskopplung).
4. **P1 — Dedizierte RPC-URL (Helius/QuickNode):** Public devnet RPC 429-Stürme
   sind der dominante Betriebs-Fehler; Batching+Caching mildern, eine dedizierte
   URL eliminiert die Quelle.
5. **P2 — Player-Historie/Profil:** Einzahlungs-/Gewinn-Historie pro Wallet
   (aus dem Postgres-Spiegel ableitbar).
6. **P2 — Fee-Reporting:**_fee-Ledger-View im Admin (accrued per round,
   Zeitreihe).

## 6. Verifikationszustand (Stand dieser Review)

- **260/260** Unit/Property-Tests (23 Dateien, inkl. 11 Chat-Tests, 15
  Admin-Tests, 780-Zeilen-Round-Lifecycle-Suite) ✓
- `npm run typecheck` clean ✓
- Live-Preview: Health `mode=chain, realFunds=true`, custody ready,
  Escrow `FgEPpAm…` ≠ Fee-Wallet `6B9M…` ✓
- Browser-Checks (Playwright): Admin-Login, Chat-E2E mit echter Wallet-Signatur,
  Pool-UI auf 3 Seiten — alle PASS, 0 JS-Fehler ✓
- Bisherige Session-Fixes, die in die Review einfließen: RPC-429-Resilienz
  (batched Pools/Admin-Rounds + TTL-Caches + last-good), Lane-Head-Rehydrierung,
  Hydration-Fix, Prozess-Guards, Admin-Auth-Harmonisierung (Workspace ↔ Render).

## 7. Fazit

**Was da ist:** Ein funktionsvollständiges, gut abgegrenztes Devnet-Produkt:
On-Chain-Einzahlungen mit Server-Verifikation, deterministische On-Chain-
Auslosung mit Independent Verification, permissionless Settlement, atomare
PayWinners, eingefrorene Fees, Admin-Konsole mit Kill-Switch, Audit-Spiegel in
Postgres, Chat mit Wallet-Auth. Die Security-Grundsätze (kein Client-Vertrauen,
checked math, fail-closed Admin, devnet-only custody) sind durchgängig
umgesetzt und getestet.

**Was fehlt / signifikant zu ändern:**
1. Payout-Verifikations-Brücke für den Chain-Modus (P0, klein).
2. VRF für Real-Money-Randomness (P0 für Mainnet, größer).
3. Fee/Player-Reporting, Chat-Session-Rotation, dedizierte RPC (P1/P2).

Die Plattform muss für den vereinbarten Devnet-Betrieb **keine** Kernfunktion
mehr neu bauen; die aufgeführten Punkte sind Härtung, Mainnet-Voraussetzungen
und Operator-QoL.
