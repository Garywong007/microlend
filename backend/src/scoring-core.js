// Pure scoring logic (no dependencies) so it can be unit-tested against the Python reference vectors.
// The same formula is implemented in ml/train_model.py::reference_predict.
import fs from 'node:fs';

export class ValidationError extends Error {
  constructor(details) {
    super('Invalid scoring input');
    this.name = 'ValidationError';
    this.details = details;
  }
}

export function loadModel(filePath) {
  const model = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!model.features?.length || typeof model.intercept !== 'number') {
    throw new Error(`Invalid model file: ${filePath}`);
  }
  return model;
}

/** Returns a clean numeric feature object or throws ValidationError listing every bad field. */
export function validateFeatures(model, input) {
  const errors = {};
  const clean = {};
  for (const f of model.features) {
    const raw = input?.[f.name];
    const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors[f.name] = 'must be a number';
    } else if (v < f.min || v > f.max) {
      errors[f.name] = `must be between ${f.min} and ${f.max}`;
    } else if (f.binary && v !== 0 && v !== 1) {
      errors[f.name] = 'must be 0 or 1';
    } else {
      clean[f.name] = v;
    }
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return clean;
}

/** Probability of default, 300..900 score and per-feature contributions (logit units). */
export function predict(model, features) {
  let z = model.intercept;
  const contributions = [];
  for (const f of model.features) {
    const x = f.transform === 'log1p' ? Math.log1p(features[f.name]) : features[f.name];
    const contribution = (f.coef * (x - f.mean)) / f.std;
    z += contribution;
    contributions.push({ feature: f.name, label: f.label, contribution });
  }
  const pd = 1 / (1 + Math.exp(-z));
  const s = model.scaling;
  const raw = s.offset + s.factor * Math.log((1 - pd) / pd);
  const score = Math.min(s.max_score, Math.max(s.min_score, Math.round(raw)));
  return { pd, score, rawScore: raw, contributions };
}

export function tierForScore(model, score) {
  let tier = 0;
  model.tier_min_scores.forEach((min, i) => {
    if (score >= min) tier = i;
  });
  return tier;
}

/** Human-readable reason codes: what pushed the risk up and what pulled it down. */
export function explain(contributions, n = 3) {
  const sorted = [...contributions].sort((a, b) => b.contribution - a.contribution);
  return {
    increasingRisk: sorted.filter((c) => c.contribution > 0.02).slice(0, n).map((c) => c.label),
    decreasingRisk: sorted
      .filter((c) => c.contribution < -0.02)
      .reverse()
      .slice(0, n)
      .map((c) => c.label),
  };
}

/** bytes32 identifier of the model version, stored on-chain next to every score. */
export function modelHash(model) {
  return `0x${model.model_sha256}`;
}
