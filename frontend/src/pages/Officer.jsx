import { useState } from 'react';
import { ethers } from 'ethers';
import { useApp } from '../context/AppContext.jsx';
import { api } from '../lib/api.js';
import { date, dateTime, hashText, pct, shortAddr, TIER_NAMES, toUnits, usd } from '../lib/format.js';
import { Badge, Btn, Card, Empty, ErrorNote, Field, Loading, useAsync } from '../components/ui.jsx';

const GRACE = 7 * 86400;
const safeUnits = (v) => {
  try {
    return v === '' ? 0n : toUnits(v);
  } catch {
    return 0n;
  }
};

export default function Officer() {
  const queue = useAsync(() => api.get('/officer/queue'));
  const [status, setStatus] = useState('');
  const loans = useAsync(() => api.get(`/loans?limit=100${status ? `&status=${status}` : ''}`), [status]);

  return (
    <div className="stack">
      <Card title="Applications waiting for review" subtitle="Check the self-reported data, then approve (possibly for less) or reject. Terms are fixed from the borrower's tier at approval.">
        {queue.loading ? <Loading /> : queue.error ? <ErrorNote error={queue.error} /> : !queue.data.items.length ? <Empty>The queue is empty.</Empty> : (
          <div className="stack">{queue.data.items.map((item) => <Application key={item.loan.loanId} item={item} />)}</div>
        )}
      </Card>

      <Card
        title="All loans"
        actions={
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status" style={{ width: 'auto' }}>
            <option value="">All statuses</option>
            {['Pending', 'Approved', 'Active', 'Repaid', 'Defaulted', 'Rejected', 'Cancelled'].map((s) => <option key={s}>{s}</option>)}
          </select>
        }
      >
        {loans.loading ? <Loading /> : loans.error ? <ErrorNote error={loans.error} /> : <LoanTable items={loans.data.items} />}
      </Card>
    </div>
  );
}

function Application({ item }) {
  const { writer, runTx } = useApp();
  const { loan, terms, profile, score, pastLoans } = item;
  const max = BigInt(terms.maxAmount) < BigInt(loan.requested) ? terms.maxAmount : loan.requested;
  const [amount, setAmount] = useState(ethers.formatUnits(max, 6));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (label, send) => {
    setBusy(true);
    await runTx(label, send);
    setBusy(false);
  };
  const approveUnits = safeUnits(amount);
  const past = Object.entries(pastLoans).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ') || 'none';

  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row"><strong>Loan #{loan.loanId}</strong><Badge status={loan.status} /><span className="mono small" title={loan.borrower}>{shortAddr(loan.borrower)}</span></div>
        <span className="muted small">applied {dateTime(loan.createdAt)}</span>
      </div>

      <div className="grid grid-2" style={{ marginTop: 12 }}>
        <dl className="kv">
          <dt>Requested</dt><dd><strong>{usd(loan.requested)} mUSDC</strong> for {loan.termDays} days</dd>
          <dt>Borrower</dt><dd>{profile ? `${profile.displayName || 'unnamed'} · ${profile.country || '?'} · ${profile.occupation || '?'}` : <span className="muted">no profile submitted</span>}</dd>
          <dt>Tier now</dt><dd>{TIER_NAMES[terms.tier]} · limit {usd(terms.maxAmount, 0)} · {pct(terms.aprBps)} APR · collateral {terms.collateralBps ? pct(terms.collateralBps) : 'none'}</dd>
          <dt>Past loans</dt><dd>{past}</dd>
          <dt>Credit model</dt><dd>{score ? `score ${score.score}, default risk ${(score.probabilityOfDefault * 100).toFixed(1)}% (${score.modelVersion})` : <span className="chip chip-warn">no score requested</span>}</dd>
        </dl>
        {score && (
          <div>
            <div className="small muted" style={{ marginBottom: 4 }}>Self-reported inputs - verify before approving</div>
            <table>
              <tbody>
                {Object.entries(score.features).map(([k, v]) => <tr key={k}><td className="muted">{k.replaceAll('_', ' ')}</td><td className="num">{v}</td></tr>)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="form-grid" style={{ marginTop: 14 }}>
        <Field label="Approve amount (mUSDC)" hint={`up to ${usd(max)}`}>
          <input type="number" step="any" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Reason (required to reject)" hint="Only a hash is stored on-chain">
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} />
        </Field>
      </div>
      <div className="row">
        <Btn busy={busy} disabled={approveUnits === 0n || approveUnits > BigInt(max)} onClick={() => act('Approve loan', async () => (await writer('LoanManager')).approveLoan(loan.loanId, approveUnits))}>Approve</Btn>
        <Btn variant="danger" busy={busy} disabled={reason.trim().length < 3} onClick={() => act('Reject loan', async () => (await writer('LoanManager')).rejectLoan(loan.loanId, hashText(reason)))}>Reject</Btn>
      </div>
    </div>
  );
}

export function LoanTable({ items }) {
  const { writer, runTx, session } = useApp();
  const [busyId, setBusyId] = useState(null);
  if (!items.length) return <Empty>No loans match.</Empty>;
  const now = Date.now() / 1000;
  const canOfficer = session?.roles.includes('officer');

  const act = async (id, label, send) => {
    setBusyId(id);
    await runTx(label, send);
    setBusyId(null);
  };

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>#</th><th>Borrower</th><th>Status</th><th className="num">Principal</th><th className="num">APR</th><th>Due</th><th /></tr>
        </thead>
        <tbody>
          {items.map((l) => {
            const defaultable = l.status === 'Active' && now > l.dueAt + GRACE;
            const readyToFund = l.status === 'Approved' && (BigInt(l.collateralRequired) === 0n || l.collateralPosted);
            return (
              <tr key={l.loanId}>
                <td>{l.loanId}</td>
                <td className="mono" title={l.borrower}>{shortAddr(l.borrower)}</td>
                <td><Badge status={l.status} /></td>
                <td className="num">{usd(l.status === 'Pending' ? l.requested : l.principal)}</td>
                <td className="num">{l.aprBps ? pct(l.aprBps) : '-'}</td>
                <td>{l.dueAt ? date(l.dueAt) : '-'}{defaultable && <span className="chip chip-warn" style={{ marginLeft: 6 }}>past grace</span>}</td>
                <td className="row" style={{ justifyContent: 'flex-end' }}>
                  {canOfficer && readyToFund && (
                    <Btn variant="secondary" className="btn-sm" busy={busyId === l.loanId} onClick={() => act(l.loanId, 'Disburse', async () => (await writer('LoanManager')).disburse(l.loanId))}>Disburse</Btn>
                  )}
                  {defaultable && (
                    <Btn variant="danger" busy={busyId === l.loanId} onClick={() => act(l.loanId, 'Declare default', async () => (await writer('LoanManager')).markDefault(l.loanId))}>Declare default</Btn>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
