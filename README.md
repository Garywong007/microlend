# MicroLend - Tokenized Micro-lending for the Unbanked

SC6113 group project. A full-stack DApp where lenders fund a transparent pool, borrowers without bank records build a reusable on-chain credit history, officers approve loans, and auditors can verify every event.

## Team handover / 小组交接入口

[中文交接文档：当前进度、地址、配置、权限和后续任务](docs/TEAM_HANDOVER.md)

* **Live frontend:** https://microlend-web.onrender.com
* **Live API:** https://microlend-api.onrender.com ([health check](https://microlend-api.onrender.com/api/health))
* **Team repository:** [catjlx/microlend](https://github.com/catjlx/microlend)
* **Current Render source:** [Garywong007/microlend](https://github.com/Garywong007/microlend), branch `main`, for both services (confirmed by the deployment owner on 2026-10-11). Changes merged into the team repository need to be synced to this fork before Render can deploy them.

Public addresses and configuration are documented; private keys and service credentials must be handed over privately and are excluded from Git.

* **Smart contracts** (Solidity 0.8.24, OpenZeppelin 5): `CreditRegistry`, `LendingPool`, `CollateralVault`, `LoanManager` (+ test token `MockStablecoin`)
* **Backend** (Node 20, Express, knex, SQLite/PostgreSQL, ethers v6): wallet-signature login, REST API, chain event indexer, off-chain credit scoring service that signs EIP-712 score attestations
* **Frontend** (React 18, Vite, ethers v6, Recharts, MetaMask): role-based dashboards for borrower, lender, credit officer, auditor and admin
* **Data science** (Python): logistic-regression default model, fairness checks, and a portfolio simulation

> **Status.** Compiled and tested on Ubuntu 22.04 (WSL2) with Node 20: 49/49 contract tests and 16/16 backend tests pass (see `docs/TESTING.md` for coverage and gas). Unaudited coursework code.

Docs: [Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY.md) · [Testing](docs/TESTING.md) · [Requirement traceability](docs/REQUIREMENTS_TRACEABILITY.md) · [User manual](docs/USER_MANUAL.md) · [Report and slides guide](docs/REPORT_GUIDE.md)

## 1. Prerequisites

* Node.js 20.11+ and npm
* Python 3.10+ in an **isolated environment** (only for `ml/` and Slither): `conda create -n microlend python=3.12 -y && conda activate microlend && pip install -r requirements-dev.txt`, or `python3 -m venv .venv && source .venv/bin/activate`. Never install into the system or conda `base` environment. Record the exact versions with `pip freeze > requirements.lock.txt`.
* MetaMask browser extension
* Optional: `slither-analyzer` (`pip install slither-analyzer`), Docker

## 2. Run everything locally (10 minutes)

```bash
npm run setup                 # root + backend + frontend dependencies
npm run build:contracts       # compile, writes shared/abis/*.json
npm test                      # 49 contract tests
npm run test:gas              # gas table -> docs/gas-report.txt
(cd backend && npm test)      # scoring + API tests

# --- start a local blockchain, deploy, add demo data ---
npm run node                  # terminal 1 (keep running)
npm run deploy:local          # terminal 2: deploys + grants roles -> deployments/localhost.json
npm run seed:local            # demo loans in every state, two lenders, an audit note
npm run local:env             # writes backend/.env and frontend/.env

# --- app ---
(cd backend && npm start)     # terminal 3: API on http://localhost:4000
(cd frontend && npm run dev)  # terminal 4: UI on http://localhost:5173
```

### MetaMask for the local chain

1. Add a network: RPC `http://127.0.0.1:8546`, chain id `31338`, symbol ETH (or just click **Switch network** in the app, which adds it). MicroLend avoids Hardhat's default port 8545 and chain id 31337 so it does not clash with other Hardhat projects in MetaMask.
2. Import accounts with the **public test keys** printed when `npm run node` starts (MicroLend uses its own mnemonic, `scripts/local-mnemonic.js`, so the addresses differ from other Hardhat projects; never use these keys on a real network).

| Account # | Role in the demo |
|---|---|
| #0 | Admin (deployer) |
| #1 | Credit officer |
| #2 | Auditor |
| #3 | Scoring service (used by the backend, not for login) |
| #4, #5 | Lenders A and B |
| #6 - #11 | Borrowers B1 - B6 (B1 repaid, B2 active, B3 pending, B4 approved, B5 defaulted, B6 rejected) |

Switch accounts in MetaMask and reload to see the different role tabs. A fresh wallet can use the **Borrow** and **Lend** tabs; use "Get 1,000 test mUSDC" first.

## 3. Deploy to Sepolia and the cloud

1. Create a wallet with Sepolia ETH (faucet), and an RPC key from Infura or Alchemy. Optionally an Etherscan API key.
2. `cp .env.example .env` and fill `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `ETHERSCAN_API_KEY`. Optional role addresses (`OFFICER_ADDRESS`, `AUDITOR_ADDRESS`, `SCORER_ADDRESS`) can be teammates' wallets.
3. `npm run deploy:sepolia` writes `deployments/sepolia.json` and `shared/abis/*.json`; commit both. Record the contract addresses and Etherscan links in the report.
4. **Backend on Render:** push to GitHub, create a *Blueprint* from `render.yaml` (API service built from `backend/Dockerfile`, PostgreSQL, static site). Set the secret variables: `RPC_URL`, `SCORER_PRIVATE_KEY` (a dedicated key that holds `SCORER_ROLE`), `CORS_ORIGIN` (the frontend URL), `NETWORK=sepolia`. `JWT_SECRET` is generated.
5. **Frontend:** the Blueprint also builds the static site. Alternatively import `frontend/` into Vercel (`frontend/vercel.json`) and set `VITE_API_URL` to the API URL.
6. Check `https://<api>/api/health` and open the site with MetaMask on Sepolia. The free Render tier sleeps, so open the URL a minute before the demo.
7. Put the public URLs into this README and the report.

## 4. Repository layout

```
contracts/      Solidity sources           test/       Hardhat tests (49)
scripts/        deploy, seed, ABI export   deployments/ addresses per network
backend/        API, indexer, scoring      frontend/   React dashboard
ml/             model + portfolio simulation, metrics, synthetic sample
docs/           architecture, security, testing, manual, report guide, images
.github/        CI (compile, test, gas, Slither, backend, frontend, model)
render.yaml     cloud blueprint            shared/abis ABIs shared by backend and frontend
```

## 5. REST API summary

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | - | liveness and chain connection |
| `GET /api/config`, `/api/abis` | - | contract addresses and ABIs for the frontend |
| `GET /api/stats`, `/api/pool/history` | - | pool KPIs and snapshot time series |
| `POST /api/auth/nonce`, `/api/auth/verify` | - | wallet-signature login, returns JWT and on-chain roles |
| `GET /api/me`, `PUT /api/profile` | JWT | wallet, roles, credit profile; optional profile data |
| `POST /api/score`, `GET /api/score/latest` | JWT | compute a score, get the signed EIP-712 attestation |
| `GET /api/loans`, `/api/loans/:id` | JWT | own loans (staff: all loans) |
| `GET /api/events`, `/api/events/export.csv` | JWT | event log (own; auditor/admin: all) with CSV export |
| `GET /api/officer/queue` | officer/admin | applications waiting for review with model inputs |
| `GET /api/audit/summary` | auditor/admin | approval/default rates, speed, volumes |

## 6. Team workflow

* One branch per task, pull requests with at least one reviewer. Each member commits under their own GitHub identity; `git shortlog -sn` and the PR list feed the individual contribution report.
* Suggested ownership (6 people): (1) contracts + security, (2) tests + gas + Slither, (3) backend + DB + deployment, (4) frontend + UX test, (5) data science + simulation, (6) problem analysis, evidence, report editing and video. Everyone presents what they built.

## 7. Limitations

Prototype for coursework: synthetic training data, mock stablecoin, testnet only, self-reported scoring inputs, no KYC/AML, admin keys not behind a multisig. See [docs/SECURITY.md](docs/SECURITY.md) section 3.

## License

MIT
