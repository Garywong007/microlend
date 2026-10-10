import { Router } from 'express';
import { asyncHandler } from '../errors.js';
import { requireRole } from '../auth.js';
import { loanToJson } from '../serializers.js';

const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export function staffRoutes({ db, chain }) {
  const r = Router();

  /** Credit officer work queue: pending applications with everything needed for the decision. */
  r.get(
    '/officer/queue',
    requireRole('officer', 'admin'),
    asyncHandler(async (req, res) => {
      const pending = await db('loans').where({ status_name: 'Pending' }).orderBy('loan_id', 'asc').limit(100);
      const items = [];
      for (const l of pending) {
        const [terms, profile, score, history] = await Promise.all([
          chain.getBorrowerTerms(l.borrower),
          db('profiles').where({ address: l.borrower }).first(),
          db('score_requests').where({ address: l.borrower }).orderBy('id', 'desc').first(),
          db('loans').where({ borrower: l.borrower }).whereNot({ loan_id: l.loan_id }).select('status_name'),
        ]);
        const past = {};
        for (const h of history) past[h.status_name] = (past[h.status_name] || 0) + 1;
        items.push({
          loan: loanToJson(l),
          terms,
          profile: profile ? { displayName: profile.display_name, country: profile.country, occupation: profile.occupation } : null,
          score: score
            ? {
                score: Number(score.score),
                tier: Number(score.tier),
                probabilityOfDefault: Number(score.pd),
                modelVersion: score.model_version,
                features: JSON.parse(score.features), // self-reported: officer must verify
                requestedAt: Number(score.created_at),
              }
            : null,
          pastLoans: past,
        });
      }
      res.json({ items });
    })
  );

  /** Auditor overview: activity, outcomes, approval speed and reserve cover. */
  r.get(
    '/audit/summary',
    requireRole('auditor', 'admin'),
    asyncHandler(async (req, res) => {
      const [events, loans, pool, scoreCount] = await Promise.all([
        db('events').select('name', 'timestamp', 'loan_id'),
        db('loans').select('loan_id', 'status_name', 'principal', 'created_at', 'approved_at', 'disbursed_at', 'borrower'),
        chain.getPoolState(),
        db('score_requests').count({ n: '*' }).first(),
      ]);

      const byName = {};
      const byDay = {};
      const appliedAt = new Map();
      const approvedAt = new Map();
      const disbursedAt = new Map();
      for (const e of events) {
        byName[e.name] = (byName[e.name] || 0) + 1;
        const day = new Date(Number(e.timestamp) * 1000).toISOString().slice(0, 10);
        byDay[day] = (byDay[day] || 0) + 1;
        if (e.name === 'LoanApplied') appliedAt.set(e.loan_id, Number(e.timestamp));
        if (e.name === 'LoanApproved') approvedAt.set(e.loan_id, Number(e.timestamp));
        if (e.name === 'LoanDisbursed') disbursedAt.set(e.loan_id, Number(e.timestamp));
      }
      const toApproval = [...approvedAt].filter(([id]) => appliedAt.has(id)).map(([id, t]) => t - appliedAt.get(id));
      const toDisbursal = [...disbursedAt].filter(([id]) => appliedAt.has(id)).map(([id, t]) => t - appliedAt.get(id));

      const byStatus = {};
      for (const l of loans) byStatus[l.status_name] = (byStatus[l.status_name] || 0) + 1;
      const closed = (byStatus.Repaid || 0) + (byStatus.Defaulted || 0);
      const outstanding = BigInt(pool.outstanding);
      const reserve = BigInt(pool.reserve);

      res.json({
        events: {
          total: events.length,
          byName,
          perDay: Object.entries(byDay)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, count]) => ({ date, count })),
        },
        loans: {
          total: loans.length,
          byStatus,
          defaultRate: closed ? (byStatus.Defaulted || 0) / closed : 0,
          defaulted: loans.filter((l) => l.status_name === 'Defaulted').map((l) => ({ loanId: Number(l.loan_id), borrower: l.borrower, principal: l.principal })),
        },
        speed: { avgSecondsToApproval: avg(toApproval), avgSecondsToDisbursal: avg(toDisbursal) },
        pool: {
          ...pool,
          reserveCoverageBps: outstanding > 0n ? Number((reserve * 10000n) / outstanding) : null,
        },
        scoring: { requests: Number(scoreCount?.n || 0) },
      });
    })
  );

  return r;
}
