# Security design, threat model and known limitations

> Status: **unaudited coursework code.** It has not been reviewed by a third party and has not been formally verified. Run Slither (`npm run slither`) and the tests, attach the output to the report, and describe any finding you chose not to fix.

## 1. Smart-contract controls

| Risk | Control | Where |
|---|---|---|
| Reentrancy | `ReentrancyGuard` on every state-changing entry point that moves tokens; checks-effects-interactions (state is updated before `safeTransfer*`) | `LendingPool`, `LoanManager` |
| Unsafe ERC-20 calls | OpenZeppelin `SafeERC20` everywhere | all |
| Privilege escalation | OpenZeppelin `AccessControl`; only `LoanManager` holds `LOAN_MANAGER_ROLE` on pool / vault / registry; no `onlyOwner` backdoors; deploy script grants roles explicitly | all |
| Officer fraud | An officer cannot approve their own application (`SelfApproval`); every approval/rejection is an on-chain event; auditors can attach immutable notes | `LoanManager` |
| Share-price inflation ("first depositor") attack | `MINIMUM_SHARES` (1000) minted to nobody on the first deposit | `LendingPool.deposit` |
| Phantom accounting | `recordRepayment` reverts unless the pool balance really covers the reserve; `CollateralVault.lock` reverts unless the vault balance covers `totalLocked + amount` | `LendingPool`, `CollateralVault` |
| Liquidity run / over-lending | Utilisation cap (`maxUtilizationBps`, default 90%); withdrawals limited to idle cash | `LendingPool` |
| Rounding | All divisions round down: shares minted and interest accrued never favour the caller by more than 1 unit (6-decimals) | `LendingPool`, `LoanManager` |
| Signature replay / forgery | EIP-712 typed data with chain id + verifying contract in the domain; per-borrower nonce consumed on use; expiry ≤ 180 days; signer must hold `SCORER_ROLE` when the signature is checked; OpenZeppelin `ECDSA` rejects malleable signatures | `CreditRegistry` |
| Stale approvals | Approvals expire after 7 days (`ApprovalExpired`); terms (APR, collateral) are fixed at approval, so later tier changes cannot reprice an approved loan | `LoanManager` |
| Admin mistakes | Tier updates validated (ascending thresholds, tier 0 starts at 0); reserve share capped at 50%; pausing never blocks repayment, cancellation, withdrawal or default handling | `CreditRegistry`, `LendingPool`, `LoanManager` |
| Griefing | One open loan per wallet; permissionless `markDefault` only after `due + 7 days` | `LoanManager` |
| Compiler / tooling | Solidity 0.8.24 (checked arithmetic), custom errors, optimizer + `viaIR`, Slither in CI | `hardhat.config.js`, CI |

## 2. Off-chain controls

| Risk | Control |
|---|---|
| Account takeover / forged login | Sign-in with a wallet signature over a server-issued, single-use, 5-minute nonce; the nonce is burned even when verification fails |
| Stale roles | Roles are read from the chain, cached 30 s; the JWT carries only the address |
| Abuse of the scoring signer | Rate limit of 10 requests / hour / wallet, input range validation, every request stored (`score_requests`), scorer key revocable on-chain, scores expire |
| Injection | Parameterised queries (knex), request validation (zod), strict JSON size limit |
| Spreadsheet formula injection | CSV export prefixes cells that start with `= + - @` |
| Cross-origin abuse | CORS allow-list from `CORS_ORIGIN`, `helmet` headers, global rate limit |
| Secrets | Only via environment variables; production refuses to start with a short `JWT_SECRET` |
| Privacy | Raw questionnaire answers stay in the database; the chain gets only the score, expiry and a model-version hash; free-text purposes and reasons are stored as hashes |

## 3. Known limitations (be honest about these in the report)

1. **Self-reported inputs.** The score uses answers the borrower types in. A dishonest borrower can inflate them. Mitigations: the score only sets the tier and never approves a loan, officers verify before approving, and collateral/limits are small. A production system would use verified data (mobile-money statements, utility payments, group guarantees).
2. **Synthetic training data.** The reported AUC (≈0.68) proves the pipeline, not real-world accuracy. Replace `simulate()` in `ml/train_model.py` with real or public data before making claims.
3. **Scorer key is a trust anchor.** If the scoring key is compromised, an attacker can mint inflated scores for any wallet (bounded by officer approval, tier limits and expiry). Use a hardware/KMS-backed key and revoke on suspicion.
4. **Admin power.** The admin can pause, block borrowers, change tier terms and manage roles. For production, put the admin role behind a multisig plus a timelock.
5. **Simplified credit product.** Simple flat interest (no discount for early repayment), single bullet maturity, no late fees, one open loan per wallet, no restructuring.
6. **Mock stablecoin.** `mUSDC` is a test token. A real stablecoin brings issuer, depeg, blacklist and fee-on-transfer risks that this accounting does not handle (it assumes exact transfers).
7. **Reserve economics.** The simulation (`ml/portfolio_results.json`) shows that a reserve funded only from lender interest barely improves lender safety; real protection needs externally funded first-loss capital (sponsor, donor or insurance pool).
8. **Oracle-free timing.** The contracts rely on `block.timestamp` at day-scale granularity; the ±seconds miners can shift it do not matter for these rules.
9. **Pseudonymous is not anonymous.** Wallet addresses linked to a profile are personal data under most privacy laws. Collect the minimum, state a retention period and get consent.
10. **Regulatory.** Lending, collecting deposits and handling digital tokens are regulated in most jurisdictions (licensing, KYC/AML, consumer-credit and interest-rate rules). This prototype does not implement KYC beyond the officer's manual review.

## 4. Checklist before you claim "security tested"

- [ ] `npm test` passes (49 contract tests)
- [ ] `npm run coverage` - record statement/branch coverage
- [ ] `npm run slither` - triage each finding as fixed / accepted (with reason) / false positive
- [ ] Manually try: repay as another wallet, approve as non-officer, replay a score signature, disburse after expiry, withdraw more than liquid, markDefault before grace
- [ ] Confirm roles on the deployed Sepolia contracts (admin, officer, auditor, scorer) are what you intend
