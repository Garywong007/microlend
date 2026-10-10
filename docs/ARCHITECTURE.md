# MicroLend - System Architecture

Diagrams are written in [Mermaid](https://mermaid.js.org/) (GitHub renders them natively). To put them in the report or slides, paste the code into <https://mermaid.live> and export PNG/SVG.

## 1. System context and components

```mermaid
flowchart LR
  subgraph Users
    B[Borrower]
    L[Lender]
    O[Credit officer]
    A[Auditor]
    AD[Admin]
  end

  subgraph Browser
    FE[React + Vite dashboard<br/>ethers.js]
    MM[MetaMask<br/>signs every transaction]
  end

  subgraph Cloud
    API[Node.js REST API<br/>Express]
    IDX[Event indexer]
    DB[(PostgreSQL / SQLite)]
    ML[Scoring model v1<br/>logistic regression]
  end

  subgraph Ethereum[Ethereum - Sepolia testnet]
    LM[LoanManager]
    LP[LendingPool]
    CV[CollateralVault]
    CR[CreditRegistry]
    TK[mUSDC mock stablecoin]
  end

  B & L & O & A & AD --> FE
  FE <--> MM
  MM -- signed tx --> Ethereum
  FE -- REST + JWT --> API
  API --> DB
  API --> ML
  API -- "reads, signs EIP-712 score" --> Ethereum
  IDX -- "getLogs every 4 s" --> Ethereum
  IDX --> DB
```

Design rules:

* **Money and permissions live on-chain.** The API never holds user funds and cannot move them. Its only on-chain power is signing credit-score attestations with a key that holds `SCORER_ROLE`; that key can be revoked by the admin.
* **The database is a read model.** Everything in the `events` and `loans` tables is rebuilt from the blockchain by the indexer. Only off-chain things (profile, score requests, sign-in nonces) are authoritative in the DB.
* **Roles come from the chain.** Admin, officer and auditor are read from `LoanManager.hasRole()` at login and re-checked every 30 s, so revoking a role takes effect quickly even for a valid token.

## 2. Smart-contract interaction

```mermaid
flowchart TB
  LM[LoanManager<br/>state machine, roles: ADMIN / OFFICER / AUDITOR / PAUSER]
  CR[CreditRegistry<br/>scores, history bonus, tiers, EIP-712]
  LP[LendingPool<br/>shares, reserve, loss waterfall]
  CV[CollateralVault<br/>per-loan escrow]
  TK[(mUSDC ERC-20)]

  LM -- "getTerms() at apply / approve" --> CR
  LM -- "recordLoanClosed() on repay / default" --> CR
  LM -- "disburse() / recordRepayment() / recordLoss()" --> LP
  LM -- "lock() / release() / seize()" --> CV
  LM -. "transferFrom borrower" .-> TK
  LP -. "holds pool cash" .-> TK
  CV -. "holds collateral" .-> TK
  SC[Scoring service key<br/>SCORER_ROLE] -. "signs Score(...) EIP-712" .-> CR
```

`LoanManager` is the **only** contract with `LOAN_MANAGER_ROLE` on the other three. Lenders talk to `LendingPool` directly (`deposit`, `withdraw`); everybody else goes through `LoanManager`.

## 3. Loan state machine

```mermaid
stateDiagram-v2
  [*] --> Pending: applyLoan (borrower)
  Pending --> Approved: approveLoan (officer)<br/>terms fixed from tier
  Pending --> Rejected: rejectLoan (officer)
  Pending --> Cancelled: cancelLoan (borrower)
  Approved --> Approved: depositCollateral (borrower)
  Approved --> Active: disburse (borrower or officer)<br/>within 7 days of approval
  Approved --> Rejected: rejectLoan (officer)
  Approved --> Cancelled: cancelLoan (borrower)<br/>collateral refunded
  Active --> Active: repay (partial)
  Active --> Repaid: repay (full)<br/>collateral released, history bonus
  Active --> Defaulted: markDefault (anyone)<br/>after due date + 7 days grace
  Repaid --> [*]
  Defaulted --> [*]
  Rejected --> [*]
  Cancelled --> [*]
```

## 4. Default handling - the loss waterfall

```mermaid
flowchart TD
  D[markDefault after due + 7 days] --> C{Collateral posted?}
  C -- yes --> S[Seize up to the amount owed<br/>interest first, then principal<br/>surplus returned to borrower]
  C -- no --> R
  S --> R{Principal still unpaid?}
  R -- no --> Done[No loss for lenders]
  R -- yes --> RES[Reserve absorbs the loss<br/>up to its balance]
  RES --> L{Loss left?}
  L -- no --> Done
  L -- yes --> LEN[Lenders absorb the rest pro rata<br/>share price falls]
  LEN --> BLK[Borrower blocked,<br/>credit bonus reset]
  Done --> BLK
```

## 5. Sequence: score, borrow, repay

```mermaid
sequenceDiagram
  actor B as Borrower
  participant FE as Frontend
  participant API as API
  participant CR as CreditRegistry
  participant LM as LoanManager
  participant LP as LendingPool
  actor O as Officer

  B->>FE: connect MetaMask
  FE->>API: POST /auth/nonce
  API-->>FE: message to sign
  B->>FE: sign message (free)
  FE->>API: POST /auth/verify
  API-->>FE: JWT + on-chain roles

  B->>FE: fill in scoring questionnaire
  FE->>API: POST /score
  API->>API: logistic model -> PD -> score 300..900
  API-->>FE: score + EIP-712 attestation (signed by scorer key)
  B->>CR: updateScoreWithSignature(...) (borrower pays gas)
  CR->>CR: verify signer has SCORER_ROLE, consume nonce

  B->>LM: applyLoan(amount, days, purposeHash)
  LM->>CR: getTerms(borrower) - cap amount by tier
  O->>LM: approveLoan(id, amount)
  LM->>CR: getTerms(borrower) - fix APR + collateral
  B->>LM: depositCollateral(id)
  B->>LM: disburse(id)
  LM->>LP: disburse(borrower, principal)
  LP-->>B: principal in mUSDC

  B->>LM: repay(id, amount)
  LM->>LP: transfer + recordRepayment(principal, interest)
  LM->>CR: recordLoanClosed(onTime) on final payment
```

## 6. Data model (off-chain read model)

```mermaid
erDiagram
  LOANS ||--o{ EVENTS : "loan_id"
  PROFILES ||--o{ SCORE_REQUESTS : "address"
  PROFILES ||--o{ LOANS : "borrower"

  LOANS {
    int loan_id PK
    string borrower
    int status
    int tier
    int apr_bps
    int term_days
    text requested
    text principal
    text collateral_required
    text interest_total
    text principal_paid
    text interest_paid
    bigint created_at
    bigint due_at
  }
  EVENTS {
    int id PK
    string contract
    string name
    bigint block_number
    string tx_hash
    int log_index
    bigint timestamp
    int loan_id
    text accounts
    text args
  }
  POOL_SNAPSHOTS {
    int id PK
    bigint timestamp
    bigint block_number
    text lender_assets
    text outstanding
    text reserve
    text share_price
  }
  PROFILES {
    string address PK
    string display_name
    string country
    string occupation
  }
  SCORE_REQUESTS {
    int id PK
    string address
    text features
    float pd
    int score
    string model_hash
    text nonce
  }
  AUTH_NONCES {
    string address PK
    text message
    bigint expires_at
  }
  SYNC_STATE {
    string key PK
    text value
  }
```

Token amounts are stored as decimal strings (6-decimals integers) because they can exceed JavaScript's safe integer range.

## 7. Roles and permissions

| Capability | Borrower | Lender | Officer | Auditor | Admin |
|---|:-:|:-:|:-:|:-:|:-:|
| View public pool statistics, model card | ✔ | ✔ | ✔ | ✔ | ✔ |
| Request a credit score, apply, deposit collateral, repay | ✔ | | | | |
| Deposit / withdraw liquidity | | ✔ | | | |
| Approve / reject applications | | | ✔ | | |
| View all loans and the review queue | | | ✔ | ✔ | ✔ |
| Full event log, CSV export, audit summary | | | | ✔ | ✔ |
| Attach on-chain audit notes | | | | ✔ | |
| Pause, grant roles, fund reserve, tune tiers, block borrowers | | | | | ✔ |
| Declare a default after the grace period | anyone | anyone | anyone | anyone | anyone |

Borrower and lender are **not** on-chain roles: any connected wallet can act as either. Staff roles (`OFFICER_ROLE`, `AUDITOR_ROLE`, admin) are OpenZeppelin `AccessControl` roles on `LoanManager`. An officer cannot approve their own application.

## 8. Blockchain transaction types (≥ 10 required)

| # | Transaction | Contract | Sender |
|---|---|---|---|
| 1 | `deposit(amount)` | LendingPool | lender |
| 2 | `withdraw(shares)` | LendingPool | lender |
| 3 | `applyLoan(amount, termDays, purposeHash)` | LoanManager | borrower |
| 4 | `approveLoan(loanId, amount)` | LoanManager | officer |
| 5 | `rejectLoan(loanId, reasonHash)` | LoanManager | officer |
| 6 | `cancelLoan(loanId)` | LoanManager | borrower |
| 7 | `depositCollateral(loanId)` | LoanManager → CollateralVault | borrower |
| 8 | `disburse(loanId)` | LoanManager → LendingPool | borrower / officer |
| 9 | `repay(loanId, amount)` | LoanManager → LendingPool | borrower |
| 10 | `markDefault(loanId)` | LoanManager → Vault, Pool, Registry | anyone |
| 11 | `updateScoreWithSignature(...)` | CreditRegistry | borrower (relays scorer signature) |
| 12 | `updateScore(...)` | CreditRegistry | scorer |
| 13 | `addAuditNote(loanId, noteHash)` | LoanManager | auditor |
| 14 | `fundReserve(amount)` | LendingPool | admin |
| 15 | `grantRole / revokeRole` | any | admin |
| 16 | `pause / unpause` | LoanManager, LendingPool | pauser |
| 17 | `setBlocked`, `setTier` | CreditRegistry | admin |
| 18 | `setReserveBps`, `setMaxUtilizationBps` | LendingPool | admin |
| 19 | `faucet()`, `approve()` | MockStablecoin (test token) | any |

## 9. Deployment architecture

```mermaid
flowchart LR
  Dev[GitHub repo] -->|push| CI[GitHub Actions<br/>compile, test, gas, Slither,<br/>backend tests, frontend build]
  Dev -->|auto deploy| FEH[Static hosting<br/>Render / Vercel]
  Dev -->|Docker build| APIH[Render web service<br/>backend/Dockerfile]
  APIH --> PG[(Managed PostgreSQL)]
  APIH -->|JSON-RPC| RPC[Sepolia RPC<br/>Infura / Alchemy]
  Hardhat[Hardhat deploy script] -->|5 contracts| RPC
  Hardhat -->|deployments/sepolia.json<br/>shared/abis/*.json| Dev
  User[Browser + MetaMask] --> FEH
  User -->|REST| APIH
  User -->|tx| RPC
```

The API serves the contract ABIs (`GET /api/abis`) and addresses (`GET /api/config`) from the committed deployment files, so redeploying contracts never requires rebuilding the frontend.
