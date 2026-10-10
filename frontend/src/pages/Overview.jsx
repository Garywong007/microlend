import { ethers } from 'ethers';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '../context/AppContext.jsx';
import { api } from '../lib/api.js';
import { pct, shortHash, usd } from '../lib/format.js';
import { Card, Empty, ErrorNote, Loading, Stat, useAsync } from '../components/ui.jsx';

const num = (v) => Number(ethers.formatUnits(BigInt(v), 6));
const STATUS_ORDER = ['Pending', 'Approved', 'Active', 'Repaid', 'Defaulted', 'Rejected', 'Cancelled'];

export default function Overview() {
  const { config } = useApp();
  const stats = useAsync(() => api.get('/stats'));
  const history = useAsync(() => api.get('/pool/history?limit=300'));

  if (stats.loading) return <Loading />;
  if (stats.error) return <ErrorNote error={stats.error} />;
  const { pool, loans } = stats.data;

  const series = (history.data?.items || []).map((s) => ({
    time: new Date(s.timestamp * 1000).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }),
    'Lender assets': num(s.lenderAssets),
    'Lent out': num(s.outstanding),
    Reserve: num(s.reserve),
  }));
  const byStatus = STATUS_ORDER.map((s) => ({ status: s, loans: loans.byStatus[s] || 0 }));

  return (
    <div className="stack">
      <div className="grid grid-stats">
        <Stat label="Lender assets" value={`${usd(pool.lenderAssets, 0)}`} hint="mUSDC owned by lenders" />
        <Stat label="Lent out" value={usd(pool.outstanding, 0)} hint={`${pct(pool.utilizationBps)} utilisation`} />
        <Stat label="First-loss reserve" value={usd(pool.reserve, 0)} hint="absorbs defaults before lenders" />
        <Stat label="Loans issued" value={loans.total} hint={`${loans.uniqueBorrowers} borrowers`} />
        <Stat label="Avg. APR" value={loans.avgAprBps ? pct(loans.avgAprBps) : '-'} hint="weighted by principal" />
        <Stat label="Default rate" value={`${(loans.defaultRate * 100).toFixed(1)}%`} hint="of closed loans" />
      </div>

      <div className="grid grid-2">
        <Card title="Pool over time" subtitle="Every point is a snapshot taken after an on-chain event">
          {series.length < 2 ? (
            <Empty>Not enough activity yet.</Empty>
          ) : (
            <div className="chart" role="img" aria-label="Line chart of lender assets, lent-out amount and reserve over time">
              <ResponsiveContainer>
                <LineChart data={series} margin={{ top: 5, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={56} tickFormatter={(v) => v.toLocaleString('en-US')} />
                  <Tooltip formatter={(v) => `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} mUSDC`} />
                  <Legend />
                  <Line type="stepAfter" dataKey="Lender assets" stroke="#2563eb" strokeWidth={2} dot={false} />
                  <Line type="stepAfter" dataKey="Lent out" stroke="#0d9488" strokeWidth={2} strokeDasharray="6 3" dot={false} />
                  <Line type="stepAfter" dataKey="Reserve" stroke="#d97706" strokeWidth={2} strokeDasharray="2 3" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="Loans by status">
          <div className="chart" role="img" aria-label="Bar chart of loan counts by status">
            <ResponsiveContainer>
              <BarChart data={byStatus} margin={{ top: 5, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="status" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} />
                <Tooltip />
                <Bar dataKey="loans" fill="#2563eb" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <Card title="Credit model card" subtitle="The score that sets a borrower's tier. Only its result and version hash are stored on-chain.">
        <dl className="kv">
          <dt>Model</dt>
          <dd>{config.model.version} ({config.model.type.replace('_', ' ')})</dd>
          <dt>Version hash</dt>
          <dd className="mono">{shortHash(config.model.hash)}</dd>
          <dt>Evaluation</dt>
          <dd>
            AUC {config.model.metrics.auc}, KS {config.model.metrics.ks} on a held-out set of <strong>{config.model.metrics.data}</strong> data
          </dd>
          <dt>Tier thresholds</dt>
          <dd>{config.model.tierMinScores.map((m, i) => `T${i}: ≥${m}`).join('  ·  ')}</dd>
          <dt>Safeguards</dt>
          <dd>The score never approves a loan by itself - a credit officer decides, and every approval is recorded on-chain.</dd>
        </dl>
      </Card>
    </div>
  );
}
