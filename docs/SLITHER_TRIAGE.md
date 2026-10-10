# Slither triage

Tool: Slither 0.11.6, Solidity 0.8.24, 99 detectors, config in `slither.config.json` (excludes `naming-convention`, `solc-version`, `timestamp`; ignores tests, node_modules and the mock token). Raw output: `docs/evidence/09-slither.txt` (before) and `docs/evidence/10-slither-after.txt` (after).

**Run 1 (before changes): 10 results, 0 High, 7 Medium (`incorrect-equality`), 3 Low (`reentrancy-benign`, `reentrancy-events` x2).**

| # | Detector | Location | Decision | Reason |
|---|---|---|---|---|
| 1-7 | `incorrect-equality` (Medium) | `LendingPool`: `totalShares == 0` (x3), `la == 0` (x2), `assetsBefore == 0`, `shares == 0` | **Accepted - not exploitable** | These are zero-value guards against division by zero and the first-deposit case, not conditions that an attacker needs to hit exactly. `lenderAssets()` depends on the token balance, so anyone can donate tokens to the pool, but a donation only *raises* the value, which can never turn a zero guard into a harmful path. The classic "first depositor" inflation attack is limited by `MINIMUM_SHARES` (1000 shares locked to nobody on the first deposit): an attacker who donates tokens gives away almost all of it to the locked shares and to later depositors, and any deposit that would round to zero shares reverts with `ZeroShares` instead of silently losing funds. Reasoning only, there is no dedicated donation test yet (good candidate for an extra test). |
| 8 | `reentrancy-benign` (Low) | `LoanManager.repay` -> `_closeRepaid`: `openLoanOf` written after external calls | **Fixed** | The function was already `nonReentrant` and all callees are our own trusted contracts and the asset token, so it was not exploitable, but it broke checks-effects-interactions. `repay` now closes a fully repaid loan in storage (`_markRepaid`: status, `closedAt`, `openLoanOf`) *before* the token transfer and pool call, and does the external work (`_settleRepaid`: release collateral, update credit record) afterwards. |
| 9-10 | `reentrancy-events` (Low) | `CollateralVault.release`, `CollateralVault.seize`: events emitted after token transfers | **Fixed** | Events are now emitted before the transfers (state is already final at that point). Both functions are restricted to `LOAN_MANAGER_ROLE`, which only the non-reentrant `LoanManager` holds, so this was cosmetic, but it removes the warning and keeps the log order consistent with state. |

**Run 2 (after the changes):**

| Item | Result |
|---|---|
| Tests after the change | 49 passing |
| Slither results | 7 (all `incorrect-equality`, accepted as above); 0 High, 0 reentrancy |

## Things Slither does not tell you (mention in the report)

* It is a static analyser: it does not prove business logic (loss waterfall, share accounting). Those rely on the 49 tests and the accounting invariant test.
* No formal verification, no fuzzing, no third-party audit. Possible next steps: Echidna/Foundry invariant tests for "pool cash + outstanding = lender assets + reserve", and a donation-attack test.
