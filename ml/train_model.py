#!/usr/bin/env python3
"""
Credit scoring model for MicroLend (probability-of-default -> 300..900 score).

IMPORTANT - what this is and is not
-----------------------------------
* The training data is SYNTHETIC. It is generated from a documented risk process (see `simulate`) so the
  whole pipeline (training, calibration, fairness check, export to the backend) is reproducible without
  personal data. It demonstrates the method; it does NOT prove predictive power on real borrowers.
* To use real data (e.g. your SC6122 default-prediction dataset, a public microfinance dataset, or pilot data),
  replace `simulate()` with a loader that returns the same columns + a 0/1 `default` column and re-run.
  Everything downstream (export, backend, tests) stays unchanged.

Outputs
-------
  ml/model.json            coefficients, scaling, metrics, test vectors  (read by backend/src/scoring-core.js)
  ml/metrics.json          evaluation summary used in the report
  ml/synthetic_sample.csv  first rows of the synthetic data (transparency)
  docs/img/model_eval.png  ROC / tier default rates / score distribution figure

Run:  python3 ml/train_model.py
"""
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score, roc_curve
from sklearn.model_selection import train_test_split

ROOT = Path(__file__).resolve().parent.parent
SEED = 42
N = 20_000
TARGET_DEFAULT_RATE = 0.085

# name, label, unit/description, transform, allowed range (also enforced by the API)
FEATURES = [
    ("monthly_income_usd", "Monthly income", "USD per month, typical month", "log1p", 30, 2000),
    ("income_volatility", "Income volatility", "0 = very stable, 1 = very unstable", "none", 0, 1),
    ("years_in_occupation", "Years in current occupation", "years", "none", 0, 40),
    ("mobile_money_txn_per_month", "Mobile-money transactions", "count per month (digital footprint)", "log1p", 0, 200),
    ("mobile_money_months_active", "Mobile-money account age", "months active", "none", 0, 60),
    ("existing_debt_ratio", "Existing debt payments / income", "ratio, 0.30 = 30% of income", "none", 0, 1.5),
    ("household_size", "Household size", "people supported", "none", 1, 12),
    ("savings_group_member", "Savings / community group member", "1 = yes, 0 = no", "none", 0, 1),
]
NAMES = [f[0] for f in FEATURES]
BINARY = {"savings_group_member"}  # accepted values: 0 or 1 only

# score = offset + factor * ln(good:bad odds); base_score at base_odds, +pdo points per doubling of odds
SCALING = {"base_score": 620, "base_odds": 15, "pdo": 80, "min_score": 300, "max_score": 900}
SCALING["factor"] = SCALING["pdo"] / math.log(2)
SCALING["offset"] = SCALING["base_score"] - SCALING["factor"] * math.log(SCALING["base_odds"])

# Must mirror CreditRegistry's default tiers (min score for tiers 0..3)
TIER_MIN_SCORES = [0, 450, 600, 750]


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def apply_transform(name, x):
    t = next(f[3] for f in FEATURES if f[0] == name)
    return np.log1p(x) if t == "log1p" else x


def simulate(n=N, seed=SEED):
    """Synthetic borrowers (informal vendors / gig workers) with a documented default process."""
    rng = np.random.default_rng(seed)
    rural = rng.random(n) < 0.45
    female = rng.random(n) < 0.50

    income = np.clip(rng.lognormal(math.log(280) - 0.15 * rural, 0.55, n), 30, 2000).round(0)
    vol = np.clip(rng.beta(2.5, 4.0, n) + 0.08 * rural, 0, 1).round(2)
    years = np.clip(rng.gamma(2.2, 3.5, n), 0, 40).round(1)
    txn = np.clip(rng.poisson(35 * np.where(rural, 0.7, 1.0) * (income / 280) ** 0.3), 0, 200).astype(float)
    months = np.clip(rng.gamma(2.0, 8.0, n), 0, 60).round(0)
    debt = np.clip(rng.beta(1.5, 5.0, n) * 1.2, 0, 1.5).round(2)
    household = np.clip(rng.poisson(3.6, n) + 1, 1, 12).astype(float)
    group = (rng.random(n) < (0.35 + 0.10 * female)).astype(float)

    # latent log-odds of default (the "true" risk process the model has to recover)
    z = (
        -0.55 * (np.log(income) - math.log(300))
        + 1.8 * (vol - 0.35)
        - 0.04 * years
        - 0.35 * (np.log1p(txn) - math.log1p(40))
        - 0.015 * months
        + 1.6 * debt
        + 0.08 * (household - 4)
        - 0.55 * group
        + rng.normal(0, 0.6, n)  # unobserved factors
    )
    lo, hi = -10.0, 10.0  # calibrate intercept so the portfolio default rate hits the target
    for _ in range(60):
        mid = (lo + hi) / 2
        if sigmoid(z + mid).mean() > TARGET_DEFAULT_RATE:
            hi = mid
        else:
            lo = mid
    p_default = sigmoid(z + (lo + hi) / 2)
    default = (rng.random(n) < p_default).astype(int)

    return pd.DataFrame(
        {
            "monthly_income_usd": income,
            "income_volatility": vol,
            "years_in_occupation": years,
            "mobile_money_txn_per_month": txn,
            "mobile_money_months_active": months,
            "existing_debt_ratio": debt,
            "household_size": household,
            "savings_group_member": group,
            "default": default,
            # protected / contextual attributes: NOT model inputs, used only for the fairness check
            "female": female.astype(int),
            "rural": rural.astype(int),
        }
    )


def to_score(pd_):
    pd_ = np.clip(pd_, 1e-6, 1 - 1e-6)
    s = SCALING["offset"] + SCALING["factor"] * np.log((1 - pd_) / pd_)
    return np.clip(np.rint(s), SCALING["min_score"], SCALING["max_score"]).astype(int)


def tier_of(score):
    t = np.zeros_like(score)
    for i, m in enumerate(TIER_MIN_SCORES):
        t = np.where(score >= m, i, t)
    return t


def ks_stat(y, p):
    fpr, tpr, _ = roc_curve(y, p)
    return float(np.max(tpr - fpr))


def main():
    df = simulate()
    train, test = train_test_split(df, test_size=0.3, stratify=df["default"], random_state=SEED)

    def design(frame):
        return np.column_stack([apply_transform(n, frame[n].to_numpy(float)) for n in NAMES])

    Xtr, Xte = design(train), design(test)
    mean, std = Xtr.mean(axis=0), Xtr.std(axis=0)
    clf = LogisticRegression(C=1.0, max_iter=2000)
    clf.fit((Xtr - mean) / std, train["default"])
    coef, intercept = clf.coef_[0], float(clf.intercept_[0])

    # exact formula the backend uses (so exported coefficients, not sklearn, define the model)
    def predict_pd(X):
        return sigmoid(intercept + ((X - mean) / std) @ coef)

    p_te = predict_pd(Xte)
    y_te = test["default"].to_numpy()
    score_te = to_score(p_te)
    tier_te = tier_of(score_te)

    # ---- evaluation ----
    auc = float(roc_auc_score(y_te, p_te))
    ks = ks_stat(y_te, p_te)
    brier = float(brier_score_loss(y_te, p_te))
    deciles = pd.qcut(p_te, 10, labels=False, duplicates="drop")
    calib = (
        pd.DataFrame({"d": deciles, "pred": p_te, "obs": y_te})
        .groupby("d")
        .agg(mean_pred=("pred", "mean"), observed=("obs", "mean"), n=("obs", "size"))
        .round(4)
        .reset_index()
        .to_dict(orient="records")
    )
    tiers = (
        pd.DataFrame({"tier": tier_te, "obs": y_te})
        .groupby("tier")
        .agg(share=("obs", lambda s: round(len(s) / len(y_te), 4)), default_rate=("obs", "mean"), n=("obs", "size"))
        .round(4)
        .reset_index()
        .to_dict(orient="records")
    )

    # ---- fairness check (protected attributes were never model inputs) ----
    fairness = {}
    approved = score_te >= TIER_MIN_SCORES[1]  # reaches at least tier 1 (above starter terms)
    for col in ("female", "rural"):
        g = test[col].to_numpy().astype(bool)
        rate1, rate0 = float(approved[g].mean()), float(approved[~g].mean())
        fairness[col] = {
            "approval_rate_group1": round(rate1, 4),
            "approval_rate_group0": round(rate0, 4),
            "disparate_impact_ratio": round(min(rate1, rate0) / max(rate1, rate0), 4),
            "auc_group1": round(float(roc_auc_score(y_te[g], p_te[g])), 4),
            "auc_group0": round(float(roc_auc_score(y_te[~g], p_te[~g])), 4),
            "observed_default_group1": round(float(y_te[g].mean()), 4),
            "observed_default_group0": round(float(y_te[~g].mean()), 4),
            "mean_pred_default_group1": round(float(p_te[g].mean()), 4),
            "mean_pred_default_group0": round(float(p_te[~g].mean()), 4),
        }

    metrics = {
        "data": "synthetic (see ml/train_model.py::simulate)",
        "n_total": int(len(df)),
        "n_train": int(len(train)),
        "n_test": int(len(test)),
        "portfolio_default_rate": round(float(df["default"].mean()), 4),
        "test": {"auc": round(auc, 4), "ks": round(ks, 4), "brier": round(brier, 4)},
        "score_summary": {
            "min": int(score_te.min()),
            "p10": int(np.percentile(score_te, 10)),
            "median": int(np.median(score_te)),
            "p90": int(np.percentile(score_te, 90)),
            "max": int(score_te.max()),
        },
        "calibration_deciles": calib,
        "tiers": tiers,
        "fairness": fairness,
        "limitations": [
            "Synthetic data: figures show the method, not real-world accuracy.",
            "Self-reported inputs can be misstated; an officer must verify before approval.",
            "Linear model: easy to explain and audit, but cannot capture interactions.",
            "Protected attributes are excluded, yet proxies (e.g. region) can still produce group differences.",
        ],
    }

    # ---- export model.json ----
    features_out = []
    for i, (name, label, desc, transform, lo, hi) in enumerate(FEATURES):
        features_out.append(
            {
                "name": name,
                "label": label,
                "description": desc,
                "transform": transform,
                "binary": name in BINARY,
                "min": lo,
                "max": hi,
                "mean": float(mean[i]),
                "std": float(std[i]),
                "coef": float(coef[i]),
            }
        )
    canonical = json.dumps(
        {
            "features": [[f["name"], f["transform"], f["mean"], f["std"], f["coef"]] for f in features_out],
            "intercept": intercept,
            "scaling": SCALING,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    model_sha256 = hashlib.sha256(canonical.encode()).hexdigest()

    def reference_predict(row):
        z = intercept
        for f in features_out:
            x = row[f["name"]]
            x = math.log1p(x) if f["transform"] == "log1p" else x
            z += f["coef"] * (x - f["mean"]) / f["std"]
        pdef = 1 / (1 + math.exp(-z))
        s = SCALING["offset"] + SCALING["factor"] * math.log((1 - pdef) / pdef)
        return pdef, int(min(max(round(s), SCALING["min_score"]), SCALING["max_score"])), s

    vectors = []
    for row in [
        dict(monthly_income_usd=450, income_volatility=0.15, years_in_occupation=8, mobile_money_txn_per_month=70,
             mobile_money_months_active=30, existing_debt_ratio=0.10, household_size=3, savings_group_member=1),
        dict(monthly_income_usd=280, income_volatility=0.35, years_in_occupation=4, mobile_money_txn_per_month=35,
             mobile_money_months_active=14, existing_debt_ratio=0.25, household_size=4, savings_group_member=0),
        dict(monthly_income_usd=120, income_volatility=0.70, years_in_occupation=1, mobile_money_txn_per_month=5,
             mobile_money_months_active=3, existing_debt_ratio=0.60, household_size=7, savings_group_member=0),
        dict(monthly_income_usd=900, income_volatility=0.10, years_in_occupation=15, mobile_money_txn_per_month=120,
             mobile_money_months_active=48, existing_debt_ratio=0.05, household_size=2, savings_group_member=1),
        dict(monthly_income_usd=60, income_volatility=0.90, years_in_occupation=0, mobile_money_txn_per_month=0,
             mobile_money_months_active=0, existing_debt_ratio=1.2, household_size=9, savings_group_member=0),
    ]:
        pdef, score, raw = reference_predict(row)
        vectors.append({"input": row, "pd": round(pdef, 10), "score": score, "raw_score": round(raw, 6)})

    model = {
        "version": "credit-model-v1",
        "model_sha256": model_sha256,
        "type": "logistic_regression",
        "target": "probability of default within the loan term",
        "intercept": intercept,
        "features": features_out,
        "scaling": SCALING,
        "tier_min_scores": TIER_MIN_SCORES,
        "metrics": {"auc": metrics["test"]["auc"], "ks": metrics["test"]["ks"], "brier": metrics["test"]["brier"], "data": "synthetic"},
        "test_vectors": vectors,
    }
    (ROOT / "ml" / "model.json").write_text(json.dumps(model, indent=2) + "\n")
    (ROOT / "ml" / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    df.head(1000).to_csv(ROOT / "ml" / "synthetic_sample.csv", index=False)

    # ---- figure ----
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, ax = plt.subplots(1, 3, figsize=(13, 3.8))
        fpr, tpr, _ = roc_curve(y_te, p_te)
        ax[0].plot(fpr, tpr, color="#2a6fdb", lw=2, label=f"AUC = {auc:.3f}")
        ax[0].plot([0, 1], [0, 1], color="#999", ls="--", lw=1)
        ax[0].set(title="ROC (test set)", xlabel="False positive rate", ylabel="True positive rate")
        ax[0].legend(loc="lower right", frameon=False)

        t = pd.DataFrame(tiers)
        bars = ax[1].bar([f"Tier {int(i)}" for i in t["tier"]], t["default_rate"] * 100, color="#2a6fdb")
        ax[1].set(title="Observed default rate by tier", ylabel="% defaulted")
        for b, n in zip(bars, t["n"]):
            ax[1].text(b.get_x() + b.get_width() / 2, b.get_height(), f"n={n}", ha="center", va="bottom", fontsize=8)

        ax[2].hist(score_te, bins=40, color="#2a6fdb", alpha=0.85)
        for m in TIER_MIN_SCORES[1:]:
            ax[2].axvline(m, color="#d1495b", ls="--", lw=1)
        ax[2].set(title="Score distribution (red = tier cut-offs)", xlabel="score")
        for a in ax:
            a.spines[["top", "right"]].set_visible(False)
        fig.tight_layout()
        (ROOT / "docs" / "img").mkdir(parents=True, exist_ok=True)
        fig.savefig(ROOT / "docs" / "img" / "model_eval.png", dpi=150)
    except Exception as exc:  # plotting is optional
        print("figure skipped:", exc)

    print(json.dumps({"auc": auc, "ks": ks, "brier": brier, "tiers": tiers, "fairness": fairness}, indent=2))
    print("model_sha256:", model_sha256)


if __name__ == "__main__":
    main()
