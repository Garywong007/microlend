import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../errors.js';
import { issueNonce, verifySignature, requireAuth } from '../auth.js';

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

const nonceBody = z.object({ address: z.string().min(1).max(64) });
const verifyBody = z.object({ address: z.string().min(1).max(64), signature: z.string().min(10).max(300) });
const profileBody = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  country: z
    .string()
    .trim()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, 'Use a 2-letter country code')
    .transform((s) => s.toUpperCase())
    .optional(),
  occupation: z.string().trim().min(1).max(80).optional(),
});

const bn = (v) => v.toString();

export function sessionRoutes(deps) {
  const { db, chain } = deps;
  const r = Router();

  // --- wallet-based login -------------------------------------------------
  r.post(
    '/auth/nonce',
    authLimiter,
    asyncHandler(async (req, res) => {
      const { address } = nonceBody.parse(req.body);
      res.json({ message: await issueNonce(deps, address) });
    })
  );

  r.post(
    '/auth/verify',
    authLimiter,
    asyncHandler(async (req, res) => {
      const { address, signature } = verifyBody.parse(req.body);
      res.json(await verifySignature(deps, address, signature));
    })
  );

  // --- everything about the signed-in wallet ------------------------------
  r.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const { address } = req.user;
      const [terms, profile, shares, value, maxWithdrawable, balance, allowance, offchain] = await Promise.all([
        chain.getBorrowerTerms(address),
        chain.contracts.CreditRegistry.getProfile(address),
        chain.contracts.LendingPool.sharesOf(address),
        chain.contracts.LendingPool.assetsOf(address),
        chain.contracts.LendingPool.maxWithdrawable(address),
        chain.contracts.MockStablecoin.balanceOf(address),
        chain.contracts.MockStablecoin.allowance(address, chain.contracts.LoanManager.target),
        db('profiles').where({ address: req.user.key }).first(),
      ]);
      res.json({
        address,
        roles: req.user.roles,
        borrower: {
          terms,
          credit: {
            score: Number(profile.score),
            bonus: Number(profile.bonus),
            scoredAt: Number(profile.scoredAt),
            expiresAt: Number(profile.expiresAt),
            modelHash: profile.modelHash,
            loansRepaid: Number(profile.loansRepaid),
            loansDefaulted: Number(profile.loansDefaulted),
            onTimeLoans: Number(profile.onTimeLoans),
            lateLoans: Number(profile.lateLoans),
            totalBorrowed: bn(profile.totalBorrowed),
            totalRepaid: bn(profile.totalRepaid),
            blocked: profile.blocked,
          },
          openLoanId: Number(await chain.contracts.LoanManager.openLoanOf(address)),
        },
        lender: { shares: bn(shares), value: bn(value), maxWithdrawable: bn(maxWithdrawable) },
        wallet: { stablecoinBalance: bn(balance), managerAllowance: bn(allowance) },
        profile: offchain ? { displayName: offchain.display_name, country: offchain.country, occupation: offchain.occupation } : null,
      });
    })
  );

  // --- off-chain profile (KYC-lite metadata that never goes on-chain) -----
  r.put(
    '/profile',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = profileBody.parse(req.body);
      const row = {
        address: req.user.key,
        display_name: body.displayName ?? null,
        country: body.country ?? null,
        occupation: body.occupation ?? null,
        updated_at: Math.floor(Date.now() / 1000),
      };
      await db('profiles').insert(row).onConflict('address').merge();
      res.json({ profile: { displayName: row.display_name, country: row.country, occupation: row.occupation } });
    })
  );

  return r;
}
