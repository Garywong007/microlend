# Report, slides and video guide

Target: 10-15 page technical report, slides, 10-minute demo video, user manual, individual contribution reports. The brief is graded on a 100-mark rubric (see `REQUIREMENTS_TRACEABILITY.md`). The biggest single item beyond the code is **problem analysis and validation (15 marks)**, and it is the one the code cannot do for you.

## 1. Who writes what (6 people)

| # | Owner | Report sections | Slides | Repo evidence |
|---|---|---|---|---|
| 1 | Contracts and security | §5 Smart-contract design, §6 Security | contract design, security | `contracts/`, `docs/SECURITY.md`, Slither output |
| 2 | Testing and gas | §9 Testing and evaluation, gas analysis | testing, gas | `test/`, `docs/gas-report.txt`, coverage, `docs/TESTING.md` |
| 3 | Backend, DevOps | §7 Backend and data, §10 Deployment | architecture, deployment | `backend/`, `render.yaml`, CI, deployment URLs |
| 4 | Frontend and UX | §8 Frontend and UX, user manual, usability test | UI walkthrough | `frontend/`, screenshots, `docs/USER_MANUAL.md` |
| 5 | Data science | §4 Credit scoring and risk model (and the simulation) | model + economics | `ml/`, `docs/img/*.png` |
| 6 | Problem and project lead | §1-3 Problem, stakeholders, requirements; §11 limitations; abstract; final edit; video | problem, conclusion | evidence table, survey/interviews |

Everyone writes their own contribution report (half a page: what you built, commits/PRs, what you learned) from `git log --author` and the PR list. Do not merge all work into one person's commits.

## 2. Problem analysis and validation (15 marks) - checklist for member 6

* **Target users**: unbanked and thin-file micro-entrepreneurs (market traders, gig workers, smallholders), plus individuals and institutions who would fund them. Choose one concrete market for the report (for example Southeast Asia or sub-Saharan Africa) and describe it with data.
* **Evidence** (credible and cited): World Bank Global Findex (the topic sheet quotes about 1.3 billion unbanked adults, "Findex 2025" - open the source and check the exact figure, year and wording before quoting), informal-lending interest rates in your chosen market, microfinance repayment and default rates (for example from MIX Market or national regulators), remittance/mobile-money adoption. Every number in the report needs a reference. Do not use a number you cannot link to.
* **Existing solutions and their limits**: banks (collateral and records), microfinance institutions (high operating costs, opaque), informal lenders (high rates), mobile-money lending and BNPL (data silos, platform lock-in), crypto lending (over-collateralised, excludes the unbanked).
* **Why blockchain, and when it is not needed**: shared, tamper-evident repayment history that follows the borrower across lenders; public pool accounting and rules-based loss waterfall; permissionless default handling; automatic settlement. Be explicit that a central database would also work for a single lender; the advantage appears when several parties must trust the same record. Mention the costs (gas, key management, privacy).
* **Stakeholder analysis**: borrower, lender, credit officer, auditor, regulator, platform operator, local community. For each: need, pain point, how the system helps, risk.
* **Requirements**: functional (the traceability table), non-functional (availability, performance, scalability), security, usability. Give each an ID and link it to a test.
* **Success indicators** (target and how measured): see `TESTING.md` §3.
* **Validation**: at least one of: (a) 5-10 stakeholder interviews or a short survey, (b) usability test with 5-10 people on scenarios S2-S4, (c) expert feedback (a lecturer or someone in finance). Record questions, results and what you changed. This is where many teams lose marks.
* **Constraints, ethics, regulation**: licensing and KYC/AML, consumer-credit and interest caps, data protection of wallet-linked data, over-indebtedness risk, fairness of automated scoring, exclusion of people without smartphones, volatility/depeg of stablecoins. Be specific about the jurisdiction you choose.

## 3. Report outline (about 12 pages)

| § | Title | Pages | Content |
|---|---|---|---|
| 0 | Abstract | 0.25 | Problem, solution, results, limits |
| 1 | Problem statement and evidence | 1.5 | See §2 above |
| 2 | Stakeholders and requirements | 1 | Table with IDs |
| 3 | System architecture | 1.5 | `ARCHITECTURE.md` §1, §2, §6, §9 diagrams |
| 4 | Credit scoring and risk model | 1.5 | model card, ROC/calibration figure, fairness table, on-chain attestation (§4 below) |
| 5 | Smart-contract design | 1.5 | Roles, state machine, waterfall, tiers, transaction table |
| 6 | Security | 1 | `SECURITY.md` summary, Slither results |
| 7 | Backend and data | 0.75 | API, indexer, DB, auth |
| 8 | Frontend and UX | 0.75 | Screens per role, usability findings |
| 9 | Testing and evaluation | 1.5 | Test results, coverage, gas table, scenarios, KPIs |
| 10 | Deployment and DevOps | 0.5 | Sepolia addresses, URLs, CI |
| 11 | Limitations, ethics, future work | 0.75 | `SECURITY.md` §3 |
| 12 | Conclusion, references, appendix | 0.5 | Contribution table |

## 4. Numbers already produced (and how to word them honestly)

All come from **synthetic data and stated assumptions**. Say so in the text, next to the number. Re-run the scripts to reproduce (`python3 ml/train_model.py`, `python3 ml/simulate_portfolio.py`).

**Credit model** (`ml/metrics.json`, `docs/img/model_eval.png`): logistic regression on eight self-reported/behavioural features; on 6,000 held-out synthetic borrowers AUC 0.68, KS 0.27, Brier 0.073. Observed default rate by tier rises from 0.9% (tier 3) to 5.0% (tier 2), 11.6% (tier 1) and 31.8% (tier 0), so the tier ordering works. Fairness check: approval-rate ratio 0.999 (female vs male) and 0.972 (rural vs urban); proxies such as region can still create differences. Wording: "the AUC shows the pipeline works on weakly informative synthetic data; it is not evidence of real-world predictive power".

**Why the AI score can be trusted on-chain** (the topic sheet's listed risk): the model runs off-chain, but the chain only accepts a score signed (EIP-712) by an address with `SCORER_ROLE`; the signature binds borrower, score, model-version hash, expiry and a nonce; scores expire; the admin can revoke the scorer; the officer still makes the lending decision; the model version fingerprint is public so anyone can check which model produced a score. State the residual trust assumption (the scorer key and the model owner) and the future option (zero-knowledge proof of inference or a decentralised scorer committee).

**Portfolio simulation** (`ml/portfolio_results.json`, `docs/img/portfolio_sim.png`): pools of 500 loans, 1,000 random trials per setting, same random draws for compared designs. Findings under the stated assumptions (60-day loans, 80% utilisation, loans at 60% of limit):
* Break-even loan default rate: about 7.0% with tiered terms vs about 5.4% with one flat 20% APR / 10% collateral product.
* At a 5% default rate the probability that lenders lose money is about 9% with tiers vs 38% flat.
* Diverting 0-30% of interest into the reserve barely changes lender outcomes; an externally funded starting reserve changes them a lot (tiered terms, 5% defaults: no initial reserve → return about −4%, probability of loss about 87%; reserve of 2% of principal → about +6%, 8%; reserve of 5% → about +12%, near 0%).
* Results near the break-even rate are very sensitive: the probability of loss jumps from 0% at 3% defaults to ~9% at 5% and ~79% at 8.5%. Report ranges, not single values, and say the Monte-Carlo noise is about ±1-2 percentage points.
Interpretation to write: risk-based pricing and collateral tiers matter; a self-funded reserve is weak; a sponsor/insurance first-loss tranche is what makes lender protection credible. Do not present these as predictions for a real market. Run `--informal-apr <sourced rate>` to compare with an informal lender once you have a cited rate.

## 5. Usability test protocol (member 4, ~1 hour)

5-10 participants (classmates are fine, include at least two non-technical people). Tasks: connect wallet; get a score; apply for a loan; (given an approved loan) receive funds and repay; as lender, deposit and withdraw. Record: completion yes/no, time, errors, and a 1-5 rating for clarity, trust and difficulty; ask 3 open questions. Report the table, the top 3 problems, and the changes you made afterwards.

## 6. Slides (about 15 slides, 10 minutes, plus appendix)

1. Title and team; 2. Problem and numbers (cited); 3. Who suffers, what exists today; 4. Why blockchain (and its limits); 5. Solution overview and roles; 6. Architecture; 7. Loan lifecycle (state machine); 8. Credit score and the trust problem; 9. Progressive credit and tiers; 10. Default waterfall and simulation result; 11. Security measures; 12. Live demo / video; 13. Testing, gas and KPIs; 14. Deployment; 15. Limitations, ethics, future work; Q&A. Appendix: diagrams, API table, test details.

Presentation tips: put one idea per slide, use the generated figures (`docs/img/`), rehearse the demo against a fixed script (`USER_MANUAL.md` §8), and have the deployed URL and a local fallback ready.

## 7. Final checklist before submission

- [ ] `npm run setup && npm run build:contracts && npm test` all pass; results in `TESTING.md`
- [ ] Gas table filled; at least one optimisation tried with before/after numbers
- [ ] Slither output attached; each finding triaged
- [ ] Contracts deployed to Sepolia and verified on Etherscan; addresses in README and report
- [ ] API and frontend publicly reachable; URLs in README and report
- [ ] ≥ 10 distinct transaction types shown in the video
- [ ] Evidence table with references; validation (interviews/survey/usability) written up
- [ ] Diagrams exported (architecture, contract interaction, data model, process flow, UI screens)
- [ ] User manual, contribution reports, presentation, video
- [ ] No secrets committed (`git log -p | grep -i "private_key"`), `.env` ignored
- [ ] Every statement about the model/simulation says "synthetic"
