import { Router } from 'express';
import { z } from 'zod';
import { ethers } from 'ethers';
import { asyncHandler, HttpError } from '../errors.js';
import { requireAuth, requireRole, isStaff } from '../auth.js';
import { loanToJson, eventToJson, csvCell } from '../serializers.js';

const LOAN_STATUSES = ['Pending', 'Approved', 'Active', 'Repaid', 'Defaulted', 'Rejected', 'Cancelled'];

const loanQuery = z.object({
  status: z.enum(LOAN_STATUSES).optional(),
  borrower: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const eventQuery = z.object({
  name: z.string().regex(/^[A-Za-z]+$/).max(48).optional(),
  loanId: z.coerce.number().int().min(1).optional(),
  account: z.string().optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function normaliseAddress(a) {
  if (!ethers.isAddress(a)) throw new HttpError(400, 'Invalid address filter');
  return a.toLowerCase();
}

/** Loans and the event log. Staff see everything; borrowers/lenders only see their own rows. */
export function ledgerRoutes({ db }) {
  const r = Router();

  function eventFilters(q, user) {
    // resolved eagerly so an invalid address fails the request before any query is built
    const account = isStaff(user) ? (q.account ? normaliseAddress(q.account) : null) : user.key;
    return (b) => {
      if (q.name) b.where('name', q.name);
      if (q.loanId) b.where('loan_id', q.loanId);
      if (q.from !== undefined) b.where('timestamp', '>=', q.from);
      if (q.to !== undefined) b.where('timestamp', '<=', q.to);
      if (account) b.where('accounts', 'like', `%,${account},%`);
    };
  }

  r.get(
    '/loans',
    requireAuth,
    asyncHandler(async (req, res) => {
      const q = loanQuery.parse(req.query);
      const borrower = isStaff(req.user) ? (q.borrower ? normaliseAddress(q.borrower) : null) : req.user.key;
      const filter = (b) => {
        if (q.status) b.where('status_name', q.status);
        if (borrower) b.where('borrower', borrower);
      };
      const [rows, total] = await Promise.all([
        db('loans').where(filter).orderBy('loan_id', 'desc').limit(q.limit).offset(q.offset),
        db('loans').where(filter).count({ n: '*' }).first(),
      ]);
      res.json({ items: rows.map(loanToJson), total: Number(total.n) });
    })
  );

  r.get(
    '/loans/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const id = z.coerce.number().int().min(1).parse(req.params.id);
      const row = await db('loans').where({ loan_id: id }).first();
      if (!row || (!isStaff(req.user) && row.borrower !== req.user.key)) throw new HttpError(404, 'Loan not found');
      const events = await db('events').where({ loan_id: id }).orderBy('block_number').orderBy('log_index');
      res.json({ loan: loanToJson(row), events: events.map(eventToJson) });
    })
  );

  r.get(
    '/events',
    requireAuth,
    asyncHandler(async (req, res) => {
      const q = eventQuery.parse(req.query);
      const filter = eventFilters(q, req.user);
      const [rows, total] = await Promise.all([
        db('events').where(filter).orderBy('block_number', 'desc').orderBy('log_index', 'desc').limit(q.limit).offset(q.offset),
        db('events').where(filter).count({ n: '*' }).first(),
      ]);
      res.json({ items: rows.map(eventToJson), total: Number(total.n) });
    })
  );

  // Auditors export the full log for offline review.
  r.get(
    '/events/export.csv',
    requireRole('auditor', 'admin'),
    asyncHandler(async (req, res) => {
      const q = eventQuery.parse({ ...req.query, limit: 200 });
      const rows = await db('events').where(eventFilters(q, req.user)).orderBy('block_number').orderBy('log_index').limit(10000);
      const header = ['block', 'timestamp_utc', 'contract', 'event', 'loan_id', 'tx_hash', 'args_json'];
      const lines = [header.join(',')];
      for (const e of rows.map(eventToJson)) {
        lines.push(
          [e.blockNumber, new Date(e.timestamp * 1000).toISOString(), e.contract, e.name, e.loanId, e.txHash, JSON.stringify(e.args)]
            .map(csvCell)
            .join(',')
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="microlend-events.csv"');
      res.send(lines.join('\n') + '\n');
    })
  );

  return r;
}
