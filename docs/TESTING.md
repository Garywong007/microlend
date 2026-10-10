# Testing and evaluation guide

## 1. What is tested

| Suite | Command | Tests | Covers |
|---|---|---|---|
| Smart contracts | `npm test` | 49 (`test/*.test.js`) | tiers, EIP-712 attestations incl. replay/forgery, pool shares/reserve/utilisation, full loan lifecycle, access control, pause behaviour, approval expiry, progressive credit, default waterfall (3 scenarios), accounting invariants |
| Scoring logic | `cd backend && npm test` | 6 (`scoring.test.js`) | JS scorer reproduces the Python reference vectors exactly; validation; tier mapping |
| REST API | `cd backend && npm test` | 10 (`api.test.js`) | wallet login (forged signature, nonce replay), role gating, data isolation between borrowers, CSV export, EIP-712 attestation verifies against the scorer address |
| Model | `npm run model:train` | metrics in `ml/metrics.json` | AUC, KS, Brier, calibration deciles, default rate by tier, fairness by group |
| Economics | `python3 ml/simulate_portfolio.py` | `ml/portfolio_results.json` | break-even default rate, tiered vs flat terms, reserve sweeps |

Record the actual results here once you have run them:

| Item | Result |
|---|---|
| Contract tests passing | 49/49 (47 in the three main suites + 2 for the test token); measured on Ubuntu 22.04 (WSL2), Node 20.20 |
| Statement / branch / function / line coverage (`npm run coverage`, 49 tests, after the Slither fixes) | 97.1% / 75.9% / 96.7% / 98.3%. Every contract has 100% statement coverage except `LendingPool` (92.3%) and `LoanManager` (97.9%). Weakest area is branch coverage: `CollateralVault` 58.3%, `LendingPool` 69.5%. Uncovered lines: LendingPool 169-170, 208-209; LoanManager 356 |
| Backend tests passing | 16/16 |
| Slither findings and decisions | 10 findings before the fixes, 7 after; every finding triaged (fixed or accepted with a reason), see `docs/SLITHER_TRIAGE.md` |
| Frontend production build | OK (`vite build`, 986 modules, JS bundle 865 KB / 270 KB gzip) |

## 2. Manual end-to-end scenarios (use for the demo and the "scenario-based evaluation")

Local chain: `npm run node`, then `npm run deploy:local && npm run seed:local`, start backend and frontend (see README).

| # | Scenario | Expected result |
|---|---|---|
| S1 | New borrower, unscored, asks for 101 mUSDC | Rejected by the contract (`AmountOutOfRange`); starter limit is 100 |
| S2 | Borrower requests a score, records it on-chain, applies for 400 | Tier from the score; officer queue shows applicant with model PD and inputs |
| S3 | Officer approves, borrower deposits collateral and receives funds | `LoanApplied` → `LoanApproved` → `CollateralDeposited` → `LoanDisbursed` in the audit log; pool "lent out" rises |
| S4 | Borrower repays in two instalments, on time | `Repaid`; collateral returned; credit profile shows +30 history bonus |
| S5 | Same borrower applies again | Higher limit / lower collateral because of the history bonus (progressive credit) |
| S6 | Loan passes due date + 7 days; anyone clicks "Declare default" | Collateral seized, reserve used, remaining loss reduces lenders' share price; borrower blocked |
| S7 | Lender tries to withdraw more than the idle cash | Clear error (`InsufficientLiquidity`), withdraw max works |
| S8 | Admin pauses the loan manager | New applications blocked, repayments still work |
| S9 | Non-staff wallet opens Audit / Officer tabs or calls `/api/audit/summary` | Tab hidden; API returns 403 |
| S10 | Replay a used score signature | Reverts (`InvalidSigner`) |

## 3. Impact indicators and how to measure them

| Indicator | How to measure with this repo |
|---|---|
| Processing time (application → funds) | `/api/audit/summary` → `speed.avgSecondsToApproval`, `avgSecondsToDisbursal`; compare with a documented traditional timeline from your evidence |
| Transparency | Share of loan events visible with a tx hash (100% by construction); time for an auditor to export the full ledger |
| Transaction cost per operation | Gas report × a stated gas price and ETH price (state the date and source of the prices) |
| Lender safety | `ml/portfolio_results.json` → `prob_lenders_lose_money`, `breakeven_default_rate` |
| Borrower cost | Average APR (12-24% by tier) vs. a **sourced** informal-credit rate (`python3 ml/simulate_portfolio.py --informal-apr <rate>`) |
| Credit portability | Demonstrate that a second contract can call `CreditRegistry.getTerms(address)` for the same wallet |
| Usability | 5-10 test users complete S2-S4; record completion rate, time and a 1-5 satisfaction score (SUS-style questions) |

## 4. Gas report and optimisation analysis

Measured with `npm run test:gas` (optimizer 200 runs, viaIR, Solidity 0.8.24). Columns are min / max / average gas over all calls in the test suite. The USD column of the reporter is empty because no price feed is configured: multiply gas by your stated gas price (gwei) and ETH price, and cite the date and source.


| Function | Min gas | Max gas | Avg gas | Est. cost at _ gwei and _ USD/ETH |
|---|---|---|---|---|
| LendingPool.deposit | 62,233 | 113,546 | 105,557 | |
| LendingPool.withdraw | 53,970 | 58,782 | 57,174 | |
| LoanManager.applyLoan | 190,035 | 224,447 | 218,648 | |
| LoanManager.approveLoan | 108,693 | 128,573 | 126,930 | |
| LoanManager.depositCollateral | 136,616 | 170,816 | 167,016 | |
| LoanManager.disburse | 83,494 | 102,845 | 99,766 | |
| LoanManager.repay | 157,251 | 283,705 | 228,740 | |
| LoanManager.markDefault | 177,519 | 297,041 | 241,268 | |
| CreditRegistry.updateScoreWithSignature | 100,409 | 100,409 | 100,409 | |
| Deployment: CollateralVault / CreditRegistry / LendingPool / LoanManager / MockStablecoin | - | - | 717,821 / 1,811,394 / 1,418,717 / 2,249,123 / 721,974 | |

Optimisations already in the code (discuss them, then try one more and measure before/after):

* Custom errors instead of revert strings (smaller bytecode, cheaper reverts).
* `Loan` struct packed (`address + status + tier + apr + term + flag` share one slot; timestamps are `uint64`).
* Immutable contract references (`asset`, `registry`, `pool`, `vault`) are read from bytecode, not storage.
* Only a purpose/reason **hash** is stored on-chain, never text.
* Events carry the data the indexer needs, so no on-chain enumeration is required.
* Optimiser (200 runs) and `viaIR`.

Effect of the Slither fix (checks-effects-interactions in `repay`, events before transfers in the vault), measured with the same tests:

| Item | Before | After | Change |
|---|---|---|---|
| `LoanManager.repay` average gas | 228,899 | 228,740 | -159 |
| `LoanManager.repay` max gas | 283,963 | 283,705 | -258 |
| `LoanManager.markDefault` max gas | 297,053 | 297,041 | -12 |
| LoanManager deployment gas | 2,240,934 | 2,249,123 | +8,189 (+0.4%) |

So the safer ordering did not cost gas on the hot path; the only cost is slightly larger deployed code (one extra internal function).

Ideas to try and measure: tune optimizer `runs`; replace `uint256[] _loansOf` with event-only history; cache `registry.getTerms()` results in memory (already done); remove redundant `closedAt` writes.

## 5. Running the suites

```bash
npm run setup               # installs root + backend + frontend dependencies
npm run build:contracts     # compile and export ABIs to shared/abis
npm test                    # 49 contract tests
npm run test:gas            # + docs/gas-report.txt
npm run coverage            # solidity-coverage (viaIR is switched off automatically)
cd backend && npm test      # scoring + API tests
python3 ml/train_model.py && python3 ml/simulate_portfolio.py
```

## 6. Pre-deployment checks (local, before Sepolia)

| Check | Result |
|---|---|
| Backend on PostgreSQL 16 (Docker) against the local chain | Tables created, 90 events indexed (lastBlock 88 = head), `/api/health`, `/api/stats`, `/api/pool/history` return the same figures as the SQLite run |
| Wallet login on PostgreSQL | Nonce issued and stored in `auth_nonces`; forged signature rejected with `Invalid signature` (no server error) |
| Backend Docker image (`docker build -f backend/Dockerfile .`) | Builds successfully (node:22-slim, native module compiled, `ml/model.json` and `deployments/` included) |

## 6. Pre-deployment checks (local, before Sepolia)

| Check | Result |
|---|---|
| Backend on PostgreSQL 16 (Docker) against the local chain | Tables created, 90 events indexed (lastBlock 88 = head), `/api/health`, `/api/stats`, `/api/pool/history` return the same figures as the SQLite run |
| Wallet login on PostgreSQL | Nonce issued and stored in `auth_nonces`; forged signature rejected with `Invalid signature` (no server error) |
| Backend Docker image (`docker build -f backend/Dockerfile .`) | Builds successfully (node:22-slim, native module compiled, `ml/model.json` and `deployments/` included) |
