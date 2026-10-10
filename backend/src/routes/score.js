import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../errors.js';
import { requireAuth } from '../auth.js';
import { validateFeatures, predict, tierForScore, explain, modelHash } from '../scoring-core.js';
import { signScoreAttestation } from '../attestation.js';

// A score request signs something the chain will trust, so it is limited per wallet (not per IP).
const scoreLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.key || 'anonymous',
  message: { error: 'Too many score requests, please try again later' },
});

const body = z.object({ features: z.record(z.unknown()) });

export function scoreRoutes({ config, db, chain, model }) {
  const r = Router();

  /**
   * Off-chain credit scoring. Returns the score plus an EIP-712 attestation the borrower submits to
   * CreditRegistry.updateScoreWithSignature() from their own wallet. The score only sets the tier (limit, APR,
   * collateral); a credit officer still has to approve every loan.
   */
  r.post(
    '/score',
    requireAuth,
    scoreLimiter,
    asyncHandler(async (req, res) => {
      const { features } = body.parse(req.body);
      const clean = validateFeatures(model, features);
      const { pd, score, contributions } = predict(model, clean);
      const tier = tierForScore(model, score);
      const attestation = await signScoreAttestation({ chain, config, model, borrower: req.user.address, score });

      await db('score_requests').insert({
        address: req.user.key,
        features: JSON.stringify(clean),
        pd,
        score,
        tier,
        model_version: model.version,
        model_hash: modelHash(model),
        nonce: attestation.nonce,
        expires_at: attestation.expiresAt,
        created_at: Math.floor(Date.now() / 1000),
      });

      res.json({
        score,
        tier,
        probabilityOfDefault: pd,
        reasons: explain(contributions),
        model: { version: model.version, hash: modelHash(model) },
        attestation,
        next: 'Submit the attestation to CreditRegistry.updateScoreWithSignature() from your wallet to record the score on-chain.',
      });
    })
  );

  r.get(
    '/score/latest',
    requireAuth,
    asyncHandler(async (req, res) => {
      const row = await db('score_requests').where({ address: req.user.key }).orderBy('id', 'desc').first();
      res.json({
        latest: row
          ? {
              score: Number(row.score),
              tier: Number(row.tier),
              probabilityOfDefault: Number(row.pd),
              modelVersion: row.model_version,
              expiresAt: Number(row.expires_at),
              createdAt: Number(row.created_at),
            }
          : null,
      });
    })
  );

  return r;
}
