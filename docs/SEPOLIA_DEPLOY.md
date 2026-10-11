# Sepolia and cloud deployment runbook

One person (the **deployer**) deploys once; everybody else tests against that deployment with their own wallets. Do not let several people deploy: each deployment creates a new set of contracts and the app only follows one.

For the existing live deployment, use [the Chinese team handover](TEAM_HANDOVER.md). Both Render services currently follow `Garywong007/microlend` branch `main`, so merging into `catjlx/microlend` alone does not update the live services.

## 0. What you need

| Item | Who | How |
|---|---|---|
| Deployer wallet with Sepolia ETH (about 0.05 ETH is plenty) | deployer | generate a fresh key (step 1), fund it from a Sepolia faucet |
| Scoring wallet (no ETH needed: it only signs messages off-chain) | deployer | generate a fresh key (step 1) |
| Sepolia RPC URL | deployer | free key from Infura or Alchemy, or a public node |
| Etherscan API key (optional, for verified source code) | deployer | etherscan.io account |
| GitHub repo, Render account, (Vercel account optional) | team | free tiers are enough |

**Keys never go into chat, GitHub issues or commits.** They live in your local `.env` (git-ignored) and in the Render dashboard.

## 1. Generate throwaway keys (in the repo root)

```bash
node -e "const {Wallet}=require('ethers');for(const n of ['DEPLOYER','SCORER']){const w=Wallet.createRandom();console.log(n,'ADDRESS',w.address,'\n',n,'PRIVATE_KEY',w.privateKey)}"
```
Save both pairs in a password manager. Fund the **deployer address** with Sepolia ETH from a faucet (a PoW faucet works). Never reuse these keys on mainnet.

## 2. Configure and deploy the contracts

Create `.env` in the repo root (it is git-ignored):

```
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/<your-key>
DEPLOYER_PRIVATE_KEY=0x<deployer private key>
SCORER_ADDRESS=<scorer ADDRESS from step 1>
ETHERSCAN_API_KEY=<optional>
```
`OFFICER_ADDRESS` and `AUDITOR_ADDRESS` are optional; by default the deployer holds those roles too, and you can grant roles to teammates later from the Admin page (section 5).

```bash
npm run build:contracts
npm test                       # must be green before spending any gas
npm run deploy:sepolia 2>&1 | tee docs/evidence/11-deploy-sepolia.txt
```
This writes `deployments/sepolia.json` and `shared/abis/*.json`. **Commit both files** and push: the backend reads them at start-up. Put the five addresses and their Etherscan links (`https://sepolia.etherscan.io/address/<address>`) into the report.

If `ETHERSCAN_API_KEY` is set the script also tries to verify the source; if it fails, run `npx hardhat verify --network sepolia <address> <constructor args>` per contract.

## 3. Deploy the backend and frontend on Render

1. Push the repo to GitHub. In Render choose **New → Blueprint** and select the repo (it reads `render.yaml`).
2. Enter the secret variables when asked:

| Variable | Value |
|---|---|
| `RPC_URL` | the same Sepolia RPC URL |
| `PUBLIC_RPC_URL` | a credential-free public Sepolia RPC, e.g. `https://ethereum-sepolia-rpc.publicnode.com`; this value is exposed to browsers, so do not copy a private provider URL containing an API key |
| `SCORER_PRIVATE_KEY` | the scorer **private key** from step 1 |
| `CORS_ORIGIN` | the frontend URL, for example `https://microlend-web.onrender.com` (set it after the first deploy, then redeploy the API) |
| `INDEXER_CHUNK` (API) | `10` for the provider configuration used by the current deployment; the code default is `2000`, which previously exceeded its `eth_getLogs` block-range limit |
| `VITE_API_URL` (static site) | the API URL, for example `https://microlend-api.onrender.com` |

3. Check `https://<api>/api/health`. It should report the Sepolia chain id `11155111`. Then open the frontend URL.

Notes: according to [Render's Free documentation](https://render.com/docs/free) (checked 2026-10-11), a Free web service sleeps after 15 minutes without inbound traffic and can take about one minute to wake. Free Postgres expires after 30 days; there is then a 14-day upgrade grace period before deletion. Check the database's actual expiration date in the dashboard and export needed data before expiry. Open the site before presenting.

## 4. Smoke test (about 15 minutes)

| # | As | Do | Expect |
|---|---|---|---|
| 1 | deployer wallet | connect, switch to Sepolia, sign in | Admin, Credit officer and Audit tabs |
| 2 | any wallet | Borrow tab, "Get 1,000 test mUSDC" | balance 1,000 (needs a little Sepolia ETH for gas) |
| 3 | lender wallet | faucet, deposit 500 | pool lender assets 500 |
| 4 | deployer | Admin: fund reserve 50 | reserve 50 |
| 5 | borrower wallet | calculate score, record on-chain | credit profile shows the score and tier |
| 6 | borrower | apply for 50 for 30 days | status Pending |
| 7 | deployer (officer) | approve | status Approved |
| 8 | borrower | deposit collateral if required, receive funds, then repay all | status Repaid, history bonus +30 |
| 9 | deployer (auditor) | Audit tab: event log, CSV export, audit note | all transactions listed with Etherscan-linkable hashes |

The officer and the borrower must be different wallets (contract rule: an officer cannot approve their own application).

## 5. Give teammates roles

Admin tab (deployer wallet) → Roles → choose the role, paste the teammate's wallet address, Grant. Roles take effect in the app within about 30 seconds. Suggested: one teammate as Credit officer, one as Auditor; everyone else uses the Borrow and Lend tabs with the faucet.

## 6. Record for the report

Contract addresses and Etherscan links, deployment transaction hashes, the URL of the API and of the site, a screenshot of the GitHub Actions run, the smoke-test screenshots, and the gas actually paid for each transaction type on Sepolia (Etherscan shows it).

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| API fails to start: "Deployment file not found" | `deployments/sepolia.json` was not committed |
| API fails to start: `JWT_SECRET` or `SCORER_PRIVATE_KEY` error | variable missing in Render |
| Browser blocked by CORS | `CORS_ORIGIN` must equal the exact frontend URL (no trailing slash) |
| "Score request refused" or invalid signer on-chain | `SCORER_ADDRESS` used at deploy time does not match the private key in `SCORER_PRIVATE_KEY` |
| Transactions pending for a long time | Sepolia congestion; wait, or raise the gas in MetaMask |
| Indexer shows no events | the API's `RPC_URL` points to a different network, or `startBlock` in `deployments/sepolia.json` is wrong |
