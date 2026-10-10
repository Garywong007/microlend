# MicroLend user manual

MicroLend runs on a **test network** with a **test token (mUSDC) that has no real value**. Nothing here is real money or financial advice.

## 1. Getting started (all roles)

1. Install the MetaMask browser extension and create or import a wallet.
2. Switch MetaMask to the network the site uses (Sepolia for the public deployment; the app offers to switch). You need a little Sepolia ETH for gas; get it from a public Sepolia faucet.
3. Open the site and click **Connect wallet**. MetaMask asks you to connect, then to **sign a message**. Signing is free and only proves you own the wallet; it does not move funds.
4. The tabs you see depend on your roles. Everyone sees **Overview**; wallets act as **Borrower** and **Lender** automatically; **Credit officer**, **Audit** and **Admin** tabs appear only for wallets that were granted those roles.
5. Every action that changes the blockchain opens a MetaMask confirmation. Read the amount, then confirm. A toast shows progress and the result; failed actions show a plain-language reason.

Get test tokens: open **Borrow** → *Wallet* → **Get 1,000 test mUSDC** (once per hour).

## 2. Overview (everyone)

* Key figures: money deposited by lenders, currently lent out, reserve, share price, number of loans, repayment performance.
* Charts: pool over time, loans by status.
* **Credit model card**: how the score is calculated, the inputs, the version fingerprint stored on-chain, and the limitations.

## 3. Borrower

1. **Get a credit score.** Answer the questionnaire (monthly income, income volatility, years in your occupation, mobile-money activity and account age, existing debt payments, household size, savings-group membership). Click **Calculate my score**. The result shows your score (300-900), the estimated default probability and your tier.
2. **Record on-chain.** Click **Record on-chain** and confirm in MetaMask. This stores only your score, its expiry and the model version. Your questionnaire answers stay in the service database.
3. **Apply.** The *Apply for a loan* card shows your limit, interest rate and collateral for your tier. Enter amount, term (7-180 days) and purpose, then **Submit application**. You can have one open loan at a time.
4. **Wait for the officer.** The status badge changes from *Pending* to *Approved* (or *Rejected* with a reason). You can **Cancel** before disbursement. Approvals expire after 7 days.
5. **If collateral is required:** click **Deposit collateral**. First time only, MetaMask asks you to approve spending of mUSDC.
6. **Receive funds.** Click **Receive funds**. The principal arrives in your wallet.
7. **Repay.** Enter an amount or use **Repay all**. Partial payments are allowed; interest is paid first. When the full amount is paid the loan becomes *Repaid*, collateral is returned and your history bonus increases.
8. **Grace period.** After the due date you have 7 days. If the loan is still unpaid after that, anyone can declare it in default: collateral is taken, you are blocked from new loans, and your bonus is reset.

**Your credit profile** shows score, bonus, tier, number of repaid/late/defaulted loans and totals. It is stored on-chain, so other platforms can read it with your wallet address.

Progressive credit: each on-time loan adds +30 to your effective score (late +5, max +150), which can move you to a higher tier with a bigger limit, lower rate and less collateral.

## 4. Lender

* **Deposit:** enter an amount, approve spending (first time), confirm. You receive pool *shares*.
* **Your position:** shares, current value and earned amount. Interest raises the share price over time.
* **Withdraw:** enter an amount in mUSDC (or **Max**). You can only withdraw money that is currently idle in the pool; if most funds are lent out, withdraw less and try later. Withdrawals keep working even when the system is paused.
* **Risk you take:** read the card. Borrowers can default. Losses are covered first by collateral, then by the reserve, and only then by lenders (the share price falls). There is no guarantee.

## 5. Credit officer

1. Open **Credit officer**. The queue lists applications with the borrower's score, default probability, tier and the questionnaire inputs.
2. Check the data. Choose **Approve** (optionally for a smaller amount than requested) or **Reject** with a short reason (at least 3 characters). Only a hash of the reason goes on-chain.
3. You cannot approve your own application.
4. The **All loans** table also shows **Declare default** for loans that are past due + grace.

## 6. Auditor

* **Audit** shows summary indicators (approval rate, default rate, average time to approval and funding, volumes), event charts and the full **Event log**.
* Filter the log by event type, loan number or account. Every row has a transaction hash you can look up on Etherscan.
* **Export CSV** downloads the filtered log.
* **Attach an audit note:** enter the loan id and your note; its fingerprint is written on-chain, so a finding cannot be changed later.

## 7. Admin

* **Emergency controls:** pause or unpause the loan manager and the pool. Pausing stops new applications, approvals, collateral deposits, disbursements and deposits. Repayments, cancellations, withdrawals and default handling continue.
* **Pool parameters:** reserve share of interest (max 50%), maximum utilisation.
* **Roles:** grant or revoke Officer, Auditor and Pauser roles (separate pauser roles for the loan manager and the pool) (the app picks up changes within about 30 seconds).
* **Reserve:** add funds to the first-loss reserve. **Block / unblock** a borrower.
* **Tier configuration:** edit minimum score, limit, interest rate and collateral for each tier (scores must increase from tier to tier).

## 8. Demo script for the 10-minute video

Prepare with `npm run node`, `deploy:local`, `seed:local` (or the Sepolia deployment). Suggested order:

| Time | Scene | Shows |
|---|---|---|
| 0:00 | Problem in 30 seconds (unbanked, informal lenders), why blockchain | Evidence slide |
| 0:45 | Overview page, model card | Dashboard, charts |
| 1:30 | Lender A deposits 1,000 | tx 1; share price |
| 2:30 | New borrower: faucet, score, record on-chain | tx 11; EIP-712 explained in one sentence |
| 4:00 | Apply, officer approves, collateral, receive funds | tx 3, 4, 7, 8 |
| 5:30 | Partial repay, then full repay | tx 9; credit profile bonus |
| 6:15 | Second application shows better terms | Progressive credit |
| 6:45 | Seeded default (B5): declare default, loss waterfall | tx 10; pool share price change |
| 7:30 | Auditor: event log, filter, CSV, audit note | tx 13 |
| 8:15 | Admin: pause, role grant, tier edit | tx 16, 15, 17 |
| 9:00 | Etherscan view, CI run, gas table, deployment URLs | DevOps |
| 9:40 | Limitations and next steps | Honest close |

Tips: record at 1080p, zoom the browser to 110%, pre-fund wallets, mine blocks quickly on a local chain (use `evm_increaseTime` only in the seed script, not live), and have a spare browser profile per role.

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| "Wrong network" banner | Click **Switch network** or add the network in MetaMask |
| Nothing updates after a transaction | Wait for confirmation; the indexer polls every few seconds. Refresh the page |
| MetaMask nonce error after restarting the local chain | MetaMask → Settings → Advanced → *Clear activity tab data* |
| "Insufficient liquidity" on withdraw | The money is lent out; withdraw a smaller amount |
| "Approval expired" | The officer approved more than 7 days ago; cancel and apply again |
| Score request refused | Limit is 10 per hour; wait and retry |
| Free Render API is slow on the first request | It was asleep; wait about 30 seconds |
