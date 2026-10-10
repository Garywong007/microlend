import { useState } from 'react';
import { ethers } from 'ethers';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '../context/AppContext.jsx';
import { api } from '../lib/api.js';
import { pct, toUnits, usd } from '../lib/format.js';
import { Btn, Card, Empty, Field, Loading, Stat, useAsync } from '../components/ui.jsx';

const safeUnits = (v) => {
  try {
    return v === '' ? 0n : toUnits(v);
  } catch {
    return 0n;
  }
};

export default function Lender() {
  const { me, config, writer, reader, runTx } = useApp();
  const [deposit, setDeposit] = useState('');
  const [withdraw, setWithdraw] = useState('');
  const [busy, setBusy] = useState(false);

  const stats = useAsync(() => api.get('/stats'));
  const history = useAsync(() => api.get('/pool/history?limit=300'));
  if (!me || stats.loading) return <Loading />;

  const { pool } = stats.data;
  const position = me.lender;
  const price = Number(ethers.formatUnits(pool.sharePrice, 18));
  const priceSeries = (history.data?.items || []).map((s) => ({
    time: new Date(s.timestamp * 1000).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }),
    price: Number(ethers.formatUnits(s.sharePrice, 18)),
  }));

  const depositUnits = safeUnits(deposit);
  const doDeposit = async () => {
    setBusy(true);
    await runTx('Deposit', async () => {
      const usdc = await writer('MockStablecoin');
      const pooladdr = config.contracts.LendingPool;
      const allowance = await usdc.allowance(me.address, pooladdr);
      if (allowance < depositUnits) {
        const ok = await runTx(`Approve ${usd(depositUnits)} mUSDC`, async () => usdc.approve(pooladdr, depositUnits));
        if (!ok) throw new Error('Approval was not completed');
      }
      return (await writer('LendingPool')).deposit(depositUnits);
    });
    setBusy(false);
    setDeposit('');
  };

  const doWithdraw = async () => {
    setBusy(true);
    await runTx('Withdraw', async () => {
      const lp = reader('LendingPool');
      let shares = await lp.convertToShares(safeUnits(withdraw));
      const mine = BigInt(position.shares);
      if (shares > mine) shares = mine;
      return (await writer('LendingPool')).withdraw(shares);
    });
    setBusy(false);
    setWithdraw('');
  };

  return (
    <div className="stack">
      <div className="grid grid-stats">
        <Stat label="My position" value={usd(position.value)} hint="mUSDC, marked to current pool value" />
        <Stat label="Withdrawable now" value={usd(position.maxWithdrawable)} hint="limited by idle cash in the pool" />
        <Stat label="Share price" value={price.toFixed(4)} hint="1.0000 at launch, rises with interest" />
        <Stat label="Pool utilisation" value={pct(pool.utilizationBps)} hint={`${usd(pool.outstanding, 0)} lent out`} />
        <Stat label="First-loss reserve" value={usd(pool.reserve, 0)} hint="pays before lenders lose money" />
      </div>

      <div className="grid grid-2">
        <Card title="Deposit" subtitle="Your money is lent to verified micro-borrowers. Interest accrues in the share price.">
          <Field label="Amount (mUSDC)">
            <input type="number" min="0" step="any" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
          </Field>
          <p className="small muted">
            Balance {usd(me.wallet.stablecoinBalance)} mUSDC. You approve exactly the deposited amount for the pool contract first (a second wallet prompt).
          </p>
          <Btn onClick={doDeposit} busy={busy} disabled={depositUnits === 0n || depositUnits > BigInt(me.wallet.stablecoinBalance)}>Deposit</Btn>
        </Card>

        <Card title="Withdraw" subtitle="Available while the pool has idle cash. Paused pools still allow withdrawals.">
          <Field label="Amount (mUSDC)">
            <input type="number" min="0" step="any" value={withdraw} onChange={(e) => setWithdraw(e.target.value)} />
          </Field>
          <p className="row small muted">
            <Btn variant="secondary" onClick={() => setWithdraw(ethers.formatUnits(position.maxWithdrawable, 6))}>Max</Btn>
            Up to {usd(position.maxWithdrawable)} mUSDC right now.
          </p>
          <Btn onClick={doWithdraw} busy={busy} disabled={safeUnits(withdraw) === 0n || safeUnits(withdraw) > BigInt(position.maxWithdrawable)}>Withdraw</Btn>
        </Card>
      </div>

      <Card title="Share price history" subtitle="Rises as interest is repaid. Falls only if defaults exceed the collateral and the reserve.">
        {priceSeries.length < 2 ? (
          <Empty>Not enough history yet.</Empty>
        ) : (
          <div className="chart" role="img" aria-label="Area chart of the pool share price over time">
            <ResponsiveContainer>
              <AreaChart data={priceSeries} margin={{ top: 5, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                <YAxis domain={['auto', 'auto']} tick={{ fontSize: 11 }} width={52} tickFormatter={(v) => v.toFixed(3)} />
                <Tooltip formatter={(v) => v.toFixed(5)} />
                <Area type="stepAfter" dataKey="price" stroke="#2563eb" fill="#2563eb" fillOpacity={0.15} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card title="Risk you take as a lender">
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Borrowers can default. A defaulted loan is paid from its collateral first, then the reserve, and only then from lenders' value, shared pro rata.</li>
          <li>You can only withdraw cash that is not currently lent out. Withdrawals may wait for repayments.</li>
          <li>This is a test deployment with a mock stablecoin and a synthetic scoring model. It is not a financial product.</li>
        </ul>
      </Card>
    </div>
  );
}
