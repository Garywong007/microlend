import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, validateFeatures, predict, tierForScore, explain, modelHash, ValidationError } from '../src/scoring-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const model = loadModel(path.join(here, '..', '..', 'ml', 'model.json'));

test('JS scorer reproduces every Python reference vector', () => {
  assert.ok(model.test_vectors.length >= 5);
  for (const v of model.test_vectors) {
    const out = predict(model, validateFeatures(model, v.input));
    assert.ok(Math.abs(out.pd - v.pd) < 1e-8, `pd ${out.pd} vs ${v.pd}`);
    assert.ok(Math.abs(out.rawScore - v.raw_score) < 1e-4, `raw ${out.rawScore} vs ${v.raw_score}`);
    assert.equal(out.score, v.score);
  }
});

test('stronger profiles score higher than weaker ones', () => {
  const [strong, , weak] = model.test_vectors;
  assert.ok(predict(model, strong.input).score > predict(model, weak.input).score);
  assert.ok(predict(model, strong.input).pd < predict(model, weak.input).pd);
});

test('scores stay inside the configured range', () => {
  const worst = Object.fromEntries(model.features.map((f) => [f.name, f.coef > 0 ? f.max : f.min]));
  const best = Object.fromEntries(model.features.map((f) => [f.name, f.coef > 0 ? f.min : f.max]));
  assert.ok(predict(model, worst).score >= model.scaling.min_score);
  assert.ok(predict(model, best).score <= model.scaling.max_score);
  assert.ok(predict(model, worst).score < predict(model, best).score);
});

test('validation reports every invalid field', () => {
  const base = { ...model.test_vectors[0].input };
  assert.throws(
    () => validateFeatures(model, { ...base, monthly_income_usd: -5, savings_group_member: 0.5, household_size: 'abc', years_in_occupation: undefined }),
    (err) =>
      err instanceof ValidationError &&
      'monthly_income_usd' in err.details &&
      'savings_group_member' in err.details &&
      'household_size' in err.details &&
      'years_in_occupation' in err.details
  );
  // numeric strings from an HTML form are accepted
  const ok = validateFeatures(model, { ...base, monthly_income_usd: '450' });
  assert.equal(ok.monthly_income_usd, 450);
});

test('tier mapping mirrors the CreditRegistry cut-offs', () => {
  assert.deepEqual(model.tier_min_scores, [0, 450, 600, 750]);
  assert.equal(tierForScore(model, 449), 0);
  assert.equal(tierForScore(model, 450), 1);
  assert.equal(tierForScore(model, 600), 2);
  assert.equal(tierForScore(model, 750), 3);
});

test('explanations only list factors that matter and the model hash is a bytes32', () => {
  const out = predict(model, model.test_vectors[2].input); // weak profile
  const why = explain(out.contributions);
  assert.ok(why.increasingRisk.length > 0);
  assert.match(modelHash(model), /^0x[0-9a-f]{64}$/);
});
