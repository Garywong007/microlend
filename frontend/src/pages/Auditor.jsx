import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '../context/AppContext.jsx';
import { api } from '../lib/api.js';
import { dateTime, duration, hashText, pct, shortAddr, shortHash, usd } from '../lib/format.js';
import { Btn, Card, Empty, ErrorNote, Field, Loading, Stat, useAsync } from '../components/ui.jsx';

const AMOUNT_KEYS = new Set(['amount', 'assets', 'principal', 'principalPart', 'interestPart', 'remaining', 'collateralRequired', 'interestTotal', 'collateralRecovered', 'principalLoss', 'reserveCovered', 'requested', 'totalRepaid', 'seized', 'returned', 'lenderLoss', 'toReserve', 'interest', 'principalLost']);
const PAGE = 25;

function argText(args) {
  return Object.entries(args)
    .filter(([k]) => k !== 'loanId')
    .map(([k, v]) => {
      if (AMOUNT_KEYS.has(k) && /^\d+$/.test(String(v))) return `${k}=${usd(v)}`;
      if (typeof v === 'string' && v.startsWith('0x') && v.length === 42) return `${k}=${shortAddr(v)}`;
      if (typeof v === 'string' && v.startsWith('0x') && v.length === 66) return `${k}=${shortHash(v)}`;
      return `${k}=${v}`;
    })
    .join('  ');
}

export default function Auditor() {
  const summary = useAsync(() => api.get('/audit/summary'));
  const [filters, setFilters] = useState({ name: '', loanId: '', account: '' });
  const [offset, setOffset] = useState(0);

  const query = () => {
    const p = new URLSearchParams();
    if (filters.name) p.set('name', filters.name);
    if (filters.loanId) p.set('loanId', filters.loanId);
    if (filters.account) p.set('account', filters.account);
    return p;
  };
  const events = useAsync(() => {
    const p = query();
    p.set('limit', PAGE);
    p.set('offset', offset);
    return api.get(`/events?${p}`);
  }, [filters.name, filters.loanId, filters.account, offset]);

  if (summary.loading) return <Loading />;
  if (summary.error) return <ErrorNote error={summary.error} />;
  const s = summary.data;
  const byName = Object.entries(s.events.byName).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const setFilter = (k, v) => {
    setOffset(0);
    setFilters({ ...filters, [k]: v });
  };

  return (
    <div className="stack">
      <div className="grid grid-stats">
        <Stat label="Logged events" value={s.events.total} hint="immutable on-chain records" />
        <Stat label="Default rate" value={`${(s.loans.defaultRate * 100).toFixed(1)}%`} hint={`${s.loans.byStatus.Defaulted || 0} defaulted loans`} />
        <Stat label="Reserve cover" value={s.pool.reserveCoverageBps === null ? '-' : pct(s.pool.reserveCoverageBps)} hint="reserve ÷ lent-out principal" />
        <Stat label="Time to approval" value={duration(s.speed.avgSecondsToApproval)} hint="average, application → approval" />
        <Stat label="Time to funds" value={duration(s.speed.avgSecondsToDisbursal)} hint="average, application → disbursal" />
        <Stat label="Scores issued" value={s.scoring.requests} hint="off-chain model requests" />
      </div>

      <div className="grid grid-2">
        <Card title="Events by type">
          <div className="chart" role="img" aria-label="Bar chart of event counts by type">
            <ResponsiveContainer>
              <BarChart data={byName} layout="vertical" margin={{ top: 5, right: 12, bottom: 0, left: 30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={130} />
                <Tooltip />
                <Bar dataKey="count" fill="#2563eb" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Activity per day">
          <div className="chart" role="img" aria-label="Bar chart of events per day">
            <ResponsiveContainer>
              <BarChart data={s.events.perDay} margin={{ top: 5, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} />
                <Tooltip />
                <Bar dataKey="count" fill="#0d9488" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <Card
        title="Event log"
        subtitle="Every state change, indexed from the blockchain"
        actions={<Btn variant="secondary" onClick={() => api.download(`/events/export.csv?${query()}`, 'microlend-events.csv')}>Export CSV</Btn>}
      >
        <div className="form-grid">
          <Field label="Event">
            <select value={filters.name} onChange={(e) => setFilter('name', e.target.value)}>
              <option value="">All</option>
              {byName.map((e) => <option key={e.name}>{e.name}</option>)}
            </select>
          </Field>
          <Field label="Loan #"><input type="number" min="1" value={filters.loanId} onChange={(e) => setFilter('loanId', e.target.value)} /></Field>
          <Field label="Wallet address"><input value={filters.account} onChange={(e) => setFilter('account', e.target.value.trim())} placeholder="0x…" /></Field>
        </div>
        {events.loading ? <Loading /> : events.error ? <ErrorNote error={events.error} /> : !events.data.items.length ? <Empty>No events match.</Empty> : (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Time</th><th>Event</th><th>Loan</th><th>Details</th><th>Tx</th></tr></thead>
                <tbody>
                  {events.data.items.map((e) => (
                    <tr key={e.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{dateTime(e.timestamp)}</td>
                      <td><strong>{e.name}</strong><div className="muted small">{e.contract}</div></td>
                      <td>{e.loanId ?? '-'}</td>
                      <td className="small mono" style={{ wordBreak: 'break-word' }}>{argText(e.args)}</td>
                      <td className="mono small" title={e.txHash}>{shortHash(e.txHash)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
              <span className="muted small">{offset + 1}–{Math.min(offset + PAGE, events.data.total)} of {events.data.total}</span>
              <span className="row">
                <Btn variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Btn>
                <Btn variant="secondary" disabled={offset + PAGE >= events.data.total} onClick={() => setOffset(offset + PAGE)}>Next</Btn>
              </span>
            </div>
          </>
        )}
      </Card>

      <AuditNote />
    </div>
  );
}

function AuditNote() {
  const { writer, runTx } = useApp();
  const [loanId, setLoanId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    await runTx('Add audit note', async () => (await writer('LoanManager')).addAuditNote(Number(loanId), hashText(note)));
    setBusy(false);
    setNote('');
  };
  return (
    <Card title="Attach an audit note" subtitle="Writes the fingerprint of your note on-chain, so the finding cannot be altered later. Keep the document itself off-chain.">
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Loan #"><input type="number" min="1" required value={loanId} onChange={(e) => setLoanId(e.target.value)} /></Field>
          <Field label="Note" hint={note.trim() ? `hash ${shortHash(hashText(note))}` : undefined}>
            <input value={note} onChange={(e) => setNote(e.target.value)} required minLength={3} maxLength={200} />
          </Field>
        </div>
        <Btn type="submit" busy={busy}>Record note on-chain</Btn>
      </form>
    </Card>
  );
}
