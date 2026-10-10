# Requirement traceability (SC6113 brief → this repository)

Use this table to write the report and to make sure nothing in the rubric is forgotten. "Team to do" marks work that code alone cannot cover.

## Mandatory functional requirements

| Requirement | Where it is implemented | Status / team to do |
|---|---|---|
| Role-based authentication, ≥ 3 roles | Wallet-signature login + JWT (`backend/src/auth.js`); roles Admin / Officer / Auditor read on-chain from `LoanManager`, plus Borrower / Lender for any wallet; role-gated routes (`requireRole`) and role-gated UI tabs (`frontend/src/App.jsx`); on-chain `AccessControl` | Done. Include the role matrix (`ARCHITECTURE.md` §7) |
| MetaMask integration and wallet transaction signing | `frontend/src/context/AppContext.jsx` (connect, network switch, `personal_sign`, every contract call through the signer, `runTx` status toasts) | Done |
| ≥ 3 interacting smart contracts | `CreditRegistry`, `LendingPool`, `CollateralVault`, `LoanManager` (+ `MockStablecoin`); `LoanManager` calls the other three | Done. Diagram: `ARCHITECTURE.md` §2 |
| ≥ 10 blockchain transaction types | 19 listed in `ARCHITECTURE.md` §8 | Done. Demonstrate ≥ 10 in the video |
| Backend REST API | `backend/src/routes/*.js` (public, session, ledger, score, staff) | Done |
| Persistent data storage | SQLite (dev) / PostgreSQL (cloud) via knex, tables in `backend/src/db.js` | Done |
| Comprehensive exception handling | `backend/src/errors.js` (HTTP, validation, chain errors), contract custom errors mapped to messages in `frontend/src/lib/format.js` | Done |
| Responsive dashboard: history, event logs, visualisations | Overview, Lend, Audit pages with Recharts; event log with filters, paging, CSV export | Done. Take screenshots on desktop and phone width |
| Gas estimation, optimisation analysis | `npm run test:gas` → `docs/gas-report.txt` (hardhat-gas-reporter) | **Team to do:** run it, fill the table in `TESTING.md` §4, write the optimisation discussion |
| Smart-contract testing | 49 tests in `test/` | **Team to do:** run, record pass count and coverage |
| Public cloud deployment | `backend/Dockerfile`, `render.yaml`, `frontend/vercel.json`, `.github/workflows/ci.yml` | **Team to do:** deploy to Sepolia + Render/Vercel and record URLs |

## Rubric (100 marks)

| Criterion (marks) | Evidence in repo | Team to do |
|---|---|---|
| Real-world problem analysis and validation (15) | `REPORT_GUIDE.md` §2 checklist; model card; simulation | Gather credible sources, run the survey/interviews, write stakeholder analysis, discuss ethics/regulation |
| System architecture and technical design (10) | `ARCHITECTURE.md` (components, contracts, state machine, ER, sequence, deployment) | Export the diagrams into the report |
| Smart-contract design and security (15) | 4 contracts; `SECURITY.md`; Slither config | Run Slither, include findings and decisions |
| Frontend development and UX (10) | `frontend/` (5 role-based pages, responsive CSS, accessible labels, error messages) | Screenshots, short usability test (see `REPORT_GUIDE.md` §5) |
| Backend, API and database integration (10) | `backend/` (REST, indexer, DB, scoring service) | API table in report (list in `README.md`) |
| Blockchain integration and functionality (10) | Event indexer, EIP-712 attestations, wallet flows | Demonstrate end-to-end on Sepolia |
| Testing, evaluation and impact measurement (10) | Contract + API + scoring tests; model evaluation (`ml/metrics.json`); portfolio simulation (`ml/portfolio_results.json`) | Fill measured KPIs (`REPORT_GUIDE.md` §4) |
| Cloud deployment and DevOps (5) | CI workflow, Dockerfile, Render blueprint | Deploy; screenshot of CI run and deployed URLs |
| Innovation and practical feasibility (5) | Progressive credit (history bonus → tier up → collateral down), verifiable off-chain scoring (EIP-712), permissionless default handling, first-loss reserve analysis | Explain feasibility limits honestly (`SECURITY.md` §3) |
| Technical report (5) | `REPORT_GUIDE.md` outline | Write |
| Presentation and demonstration (5) | `scripts/seed.js` gives a ready demo dataset; demo script in `USER_MANUAL.md` §6 | Slides, 10-minute video |

## Deliverables

| Deliverable | Source |
|---|---|
| 10-15 page report | `REPORT_GUIDE.md` |
| Architecture, contract interaction, data model, process flow, UI diagrams | `ARCHITECTURE.md` (Mermaid) + screenshots |
| GitHub repository with docs and contribution history | this repo; every member commits from their own account via PRs |
| Public URL, contract deployment details, testing report | `deployments/sepolia.json` after deploy; `TESTING.md` |
| Slides and 10-minute demo | team |
| User manual and individual contribution report | `USER_MANUAL.md`; contribution report from `git shortlog -sn` + PR list |
