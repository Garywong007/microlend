#!/usr/bin/env python3
"""
Monte-Carlo break-even analysis of the MicroLend pool economics (feeds the "measurable impact" part of the report).

Questions answered
  1. At which portfolio default rate does the pool stop being profitable for lenders?
  2. Do risk-based tiers + collateral beat flat terms for everybody?
  3. How much does the first-loss reserve matter?

Method: borrowers come from the synthetic generator (ml/train_model.py). The trained model gives each borrower a
probability of default; to explore different markets the model's probabilities are shifted (prior shift) so the
portfolio default rate hits each target in DEFAULT_RATES, then defaults are drawn and run through the exact
cash-flow rules of the contracts (simple interest, collateral repays interest first, reserve before lenders).

THE RESULTS DEPEND ENTIRELY ON THE ASSUMPTIONS BELOW. There is no claim about which default rate is realistic:
find a sourced range for your target market (central-bank / CGAP / MFI reports) and read the results at that rate.

    python3 ml/simulate_portfolio.py [--informal-apr 0.60]

Outputs: ml/portfolio_results.json, docs/img/portfolio_sim.png
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_model import simulate, to_score, tier_of  # noqa: E402

# ---- tier terms: MUST mirror CreditRegistry's default constructor values ----
TIER_MAX = np.array([100, 300, 800, 2000], dtype=float)
TIER_APR = np.array([0.24, 0.20, 0.16, 0.12])
TIER_COLL = np.array([0.20, 0.10, 0.05, 0.00])

# ---- simulation assumptions (all editable) ----
N_BORROWERS = 5000
POOL_LOANS = 500  # loans per simulated pool
TRIALS = 1000
LOAN_FRACTION_OF_LIMIT = 0.6  # average draw as a share of the tier limit
TERM_DAYS = 60
UTILISATION = 0.8  # share of pool assets lent out on average
FLAT = {"loan": 180.0, "apr": 0.20, "coll": 0.10}  # baseline: everybody gets tier-1-like terms, no scoring
DEFAULT_RATES = [0.005, 0.01, 0.02, 0.03, 0.05, 0.085]  # share of loans defaulting within the term
RESERVE_BPS = 0.10  # deployed default: 10% of interest goes to the reserve
RESERVE_SWEEP = [0.0, 0.10, 0.20, 0.30]
INITIAL_RESERVE_SWEEP = [0.0, 0.01, 0.02, 0.05]  # externally funded first-loss capital, share of principal lent
SWEEP_AT_DEFAULT_RATE = 0.05  # illustrative stress point where lenders are at risk (NOT a claim about reality)
INITIAL_RESERVE = 0.02  # reserve funded up front, as a share of principal lent


def model_pd(df, model):
    z = np.full(len(df), model["intercept"], dtype=float)
    for f in model["features"]:
        x = df[f["name"]].to_numpy(float)
        x = np.log1p(x) if f["transform"] == "log1p" else x
        z += f["coef"] * (x - f["mean"]) / f["std"]
    return 1 / (1 + np.exp(-z)), z


def recalibrate(logit, target):
    """Shift the log-odds so the mean probability equals `target` (keeps the ranking of borrowers)."""
    lo, hi = -15.0, 15.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if (1 / (1 + np.exp(-(logit + mid)))).mean() > target:
            hi = mid
        else:
            lo = mid
    return 1 / (1 + np.exp(-(logit + (lo + hi) / 2)))


def terms_for(scenario, tier):
    n = len(tier)
    if scenario == "flat":
        return np.full(n, FLAT["loan"]), np.full(n, FLAT["apr"]), np.full(n, FLAT["coll"])
    principal = np.round(TIER_MAX[tier] * LOAN_FRACTION_OF_LIMIT / 10) * 10
    return principal, TIER_APR[tier], TIER_COLL[tier]


def loan_outcomes(principal, apr, coll, default):
    """Per-loan cash flows, mirroring LoanManager (simple interest; collateral repays interest first)."""
    interest = principal * apr * TERM_DAYS / 365
    owed = principal + interest
    recovered = np.where(default == 1, np.minimum(principal * coll, owed), 0.0)
    rec_interest = np.minimum(recovered, interest)
    paid_interest = np.where(default == 1, rec_interest, interest)
    loss = np.where(default == 1, principal - (recovered - rec_interest), 0.0)
    return paid_interest, loss


def run_pool(paid_interest, loss, order, reserve_bps, reserve0):
    """Sequential pool accounting for one pool: the reserve absorbs defaults before lenders do."""
    reserve = reserve0
    lender_interest = lender_loss = 0.0
    for i in order:
        cut = paid_interest[i] * reserve_bps
        reserve += cut
        lender_interest += paid_interest[i] - cut
        if loss[i] > 0:
            covered = min(loss[i], reserve)
            reserve -= covered
            lender_loss += loss[i] - covered
    return lender_interest, lender_loss


def annualise(cycle_return):
    return ((1 + cycle_return) ** (365 / TERM_DAYS) - 1) * UTILISATION


def monte_carlo(seed, paid_interest, loss, principal, reserve_bps, initial_reserve=INITIAL_RESERVE):
    # same seed => same bootstrap pools and loan order for every setting compared (common random numbers)
    rng = np.random.default_rng(seed)
    ann = np.empty(TRIALS)
    for t in range(TRIALS):
        idx = rng.integers(0, N_BORROWERS, POOL_LOANS)
        p = principal[idx]
        li, ll = run_pool(paid_interest[idx], loss[idx], rng.permutation(POOL_LOANS), reserve_bps, initial_reserve * p.sum())
        ann[t] = annualise((li - ll) / p.sum())
    return {
        "mean_annual_lender_return": round(float(ann.mean()), 4),
        "p5_annual_lender_return": round(float(np.percentile(ann, 5)), 4),
        "p95_annual_lender_return": round(float(np.percentile(ann, 95)), 4),
        "prob_lenders_lose_money": round(float((ann < 0).mean()), 4),
    }


def breakeven(rates, means):
    """Default rate where the mean lender return crosses zero (linear interpolation), or None."""
    for (r0, m0), (r1, m1) in zip(zip(rates, means), zip(rates[1:], means[1:])):
        if m0 >= 0 > m1:
            return round(float(r0 + (r1 - r0) * m0 / (m0 - m1)), 4)
    return None if means[-1] < 0 and means[0] < 0 else (None if all(m >= 0 for m in means) else None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--informal-apr", type=float, default=None, help="sourced annual rate of the informal alternative, e.g. 0.60")
    args = ap.parse_args()

    model = json.loads((ROOT / "ml" / "model.json").read_text())
    df = simulate(n=N_BORROWERS, seed=7)  # different seed from the training data
    p_model, logit = model_pd(df, model)
    tier = tier_of(to_score(p_model))
    rng = np.random.default_rng(11)

    out = {
        "assumptions": {
            "borrowers": N_BORROWERS, "loans_per_pool": POOL_LOANS, "trials": TRIALS, "term_days": TERM_DAYS,
            "utilisation": UTILISATION, "loan_fraction_of_limit": LOAN_FRACTION_OF_LIMIT,
            "initial_reserve_share": INITIAL_RESERVE, "reserve_share_of_interest": RESERVE_BPS, "flat_baseline": FLAT,
            "data": "synthetic borrowers; model probabilities shifted to each target default rate (calibrated-model assumption)",
        },
        "by_default_rate": {"tiered": [], "flat": []},
    }

    defaults_by_target = {}
    for target in DEFAULT_RATES:
        p = recalibrate(logit, target)
        default = (rng.random(N_BORROWERS) < p).astype(int)
        defaults_by_target[target] = default
        for scenario in ("tiered", "flat"):
            principal, apr, coll = terms_for(scenario, tier)
            paid, loss = loan_outcomes(principal, apr, coll, default)
            row = {
                "portfolio_default_rate": target,
                "realised_default_rate": round(float(default.mean()), 4),
                "avg_apr": round(float((apr * principal).sum() / principal.sum()), 4),
                "gross_loss_rate_of_principal": round(float(loss.sum() / principal.sum()), 4),
                "interest_income_rate_of_principal": round(float(paid.sum() / principal.sum()), 4),
                **monte_carlo(101, paid, loss, principal, RESERVE_BPS),
            }
            out["by_default_rate"][scenario].append(row)

    out["breakeven_default_rate"] = {
        s: breakeven(DEFAULT_RATES, [r["mean_annual_lender_return"] for r in out["by_default_rate"][s]]) for s in ("tiered", "flat")
    }

    # reserve sweep at one illustrative default rate
    # reuse the SAME borrower default draw as the main table, so the sweeps are comparable with it
    # (a fresh draw changes the realised default rate by +-0.3pp, which moves P(loss) a lot near break-even)
    if SWEEP_AT_DEFAULT_RATE in defaults_by_target:
        default = defaults_by_target[SWEEP_AT_DEFAULT_RATE]
    else:
        default = (rng.random(N_BORROWERS) < recalibrate(logit, SWEEP_AT_DEFAULT_RATE)).astype(int)
    out["reserve_sweep"] = {"at_default_rate": SWEEP_AT_DEFAULT_RATE, "tiered": [], "flat": []}
    out["initial_reserve_sweep"] = {"at_default_rate": SWEEP_AT_DEFAULT_RATE, "reserve_share_of_interest": RESERVE_BPS, "tiered": [], "flat": []}
    for scenario in ("tiered", "flat"):
        principal, apr, coll = terms_for(scenario, tier)
        paid, loss = loan_outcomes(principal, apr, coll, default)
        for rbps in RESERVE_SWEEP:
            out["reserve_sweep"][scenario].append({"reserve_share_of_interest": rbps, **monte_carlo(202, paid, loss, principal, rbps)})
        for init in INITIAL_RESERVE_SWEEP:
            out["initial_reserve_sweep"][scenario].append(
                {"initial_reserve_share_of_principal": init, **monte_carlo(303, paid, loss, principal, RESERVE_BPS, init)})

    if args.informal_apr is not None:
        principal, apr, _ = terms_for("tiered", tier)
        avg = float((apr * principal).sum() / principal.sum())
        out["borrower_cost"] = {
            "informal_apr_assumed": args.informal_apr,
            "microlend_avg_apr": round(avg, 4),
            "saving_per_100_borrowed_over_term": round(100 * (args.informal_apr - avg) * TERM_DAYS / 365, 2),
        }

    (ROOT / "ml" / "portfolio_results.json").write_text(json.dumps(out, indent=2) + "\n")

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, ax = plt.subplots(1, 2, figsize=(11.5, 3.9))
        style = {"tiered": ("#2563eb", "MicroLend (tiers + collateral)"), "flat": ("#d97706", "Flat terms, no scoring")}
        for s, (color, label) in style.items():
            rows = out["by_default_rate"][s]
            x = [r["portfolio_default_rate"] * 100 for r in rows]
            ax[0].plot(x, [r["mean_annual_lender_return"] * 100 for r in rows], marker="o", color=color, label=label)
            ax[0].fill_between(x, [r["p5_annual_lender_return"] * 100 for r in rows], [r["p95_annual_lender_return"] * 100 for r in rows], color=color, alpha=0.12)
            ax[1].plot(x, [r["prob_lenders_lose_money"] * 100 for r in rows], marker="o", color=color, label=label)
        ax[0].axhline(0, color="#444", lw=1)
        ax[0].set(title="Annual lender return vs portfolio default rate", xlabel="loans defaulting within the term (%)", ylabel="% per year (band = 5th-95th pct)")
        ax[1].set(title="Chance that lenders lose money in a 500-loan pool", xlabel="loans defaulting within the term (%)", ylabel="% of simulated pools")
        ax[0].legend(frameon=False, fontsize=8)
        for a in ax:
            a.spines[["top", "right"]].set_visible(False)
        fig.tight_layout()
        (ROOT / "docs" / "img").mkdir(parents=True, exist_ok=True)
        fig.savefig(ROOT / "docs" / "img" / "portfolio_sim.png", dpi=150)
    except Exception as exc:
        print("figure skipped:", exc)

    print(json.dumps({"breakeven_default_rate": out["breakeven_default_rate"]}, indent=2))
    for s in ("tiered", "flat"):
        print(f"\n{s}")
        for r in out["by_default_rate"][s]:
            print(f"  default {r['portfolio_default_rate']*100:4.1f}%  return {r['mean_annual_lender_return']*100:6.1f}%  "
                  f"P(loss) {r['prob_lenders_lose_money']*100:5.1f}%  avgAPR {r['avg_apr']*100:4.1f}%  loss/prin {r['gross_loss_rate_of_principal']*100:4.2f}%")
    print("\ninitial (externally funded) reserve sweep @", SWEEP_AT_DEFAULT_RATE)
    for s_ in ("tiered", "flat"):
        for r in out["initial_reserve_sweep"][s_]:
            print(f"  {s_:6s} initial reserve {r['initial_reserve_share_of_principal']*100:3.0f}% of principal  return {r['mean_annual_lender_return']*100:6.2f}%  P(loss) {r['prob_lenders_lose_money']*100:5.1f}%")
    print("\nreserve-share-of-interest sweep @", SWEEP_AT_DEFAULT_RATE)
    for s in ("tiered", "flat"):
        for r in out["reserve_sweep"][s]:
            print(f"  {s:6s} reserve {r['reserve_share_of_interest']*100:3.0f}%  return {r['mean_annual_lender_return']*100:6.2f}%  P(loss) {r['prob_lenders_lose_money']*100:5.1f}%")


if __name__ == "__main__":
    main()
