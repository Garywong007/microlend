import { useState } from 'react';
import { ethers } from 'ethers';
import { useApp } from '../context/AppContext.jsx';
import { pct, shortAddr, TIER_NAMES, toUnits, usd } from '../lib/format.js';
import { Badge, Btn, Card, ErrorNote, Field, Loading, useAsync } from '../components/ui.jsx';

const ROLES = [
  { label: 'Credit officer', contract: 'LoanManager', role: 'OFFICER_ROLE' },
  { label: 'Auditor', contract: 'LoanManager', role: 'AUDITOR_ROLE' },
  { label: 'Pauser (loan manager)', contract: 'LoanManager', role: 'PAUSER_ROLE' },
  { label: 'Pauser (pool)', contract: 'LendingPool', role: 'PAUSER_ROLE' },
  { label: 'Scorer (credit registry)', contract: 'CreditRegistry', role: 'SCORER_ROLE' },
];

const safeUnits = (v) => {
  try {
    return v === '' ? 0n : toUnits(v);
  } catch {
    return 0n;
  }
};

export default function Admin() {
  const { reader, writer, runTx, config } = useApp();
  const status = useAsync(async () => {
    const pool = reader('LendingPool');
    const mgr = reader('LoanManager');
    const reg = reader('CreditRegistry');
    const [poolPaused, mgrPaused, reserveBps, maxUtil, ...tiers] = await Promise.all([
      pool.paused(), mgr.paused(), pool.reserveBps(), pool.maxUtilizationBps(), ...[0, 1, 2, 3].map((i) => reg.getTier(i)),
    ]);
    return { poolPaused, mgrPaused, reserveBps: Number(reserveBps), maxUtil: Number(maxUtil), tiers: tiers.map((t) => ({ minScore: Number(t.minScore), maxAmount: t.maxAmount, aprBps: Number(t.aprBps), collateralBps: Number(t.collateralBps) })) };
  });

  const [role, setRole] = useState(0);
  const [address, setAddress] = useState('');
  const [reserve, setReserve] = useState('');
  const [blockAddr, setBlockAddr] = useState('');
  const [bps, setBps] = useState({ reserve: '', util: '' });
  const [busy, setBusy] = useState(false);

  if (status.loading) return <Loading />;
  if (status.error) return <ErrorNote error={status.error} />;
  const s = status.data;
  const validAddr = ethers.isAddress(address);

  const act = async (label, send) => {
    setBusy(true);
    await runTx(label, send);
    setBusy(false);
  };
  const roleTx = (grant) => {
    const r = ROLES[role];
    return act(`${grant ? 'Grant' : 'Revoke'} ${r.label}`, async () => {
      const c = await writer(r.contract);
      return grant ? c.grantRole(ethers.id(r.role), address) : c.revokeRole(ethers.id(r.role), address);
    });
  };

  return (
    <div className="stack">
      <div className="grid grid-2">
        <Card title="Emergency controls" subtitle="Pausing stops new business. Repayments and withdrawals always keep working.">
          <dl className="kv" style={{ marginBottom: 12 }}>
            <dt>Loan manager</dt><dd><Badge status={s.mgrPaused ? 'Rejected' : 'Active'} /> {s.mgrPaused ? 'paused' : 'running'}</dd>
            <dt>Lending pool</dt><dd><Badge status={s.poolPaused ? 'Rejected' : 'Active'} /> {s.poolPaused ? 'paused' : 'running'}</dd>
          </dl>
          <div className="row">
            <Btn variant={s.mgrPaused ? 'primary' : 'danger'} busy={busy} onClick={() => act(s.mgrPaused ? 'Unpause loan manager' : 'Pause loan manager', async () => { const c = await writer('LoanManager'); return s.mgrPaused ? c.unpause() : c.pause(); })}>
              {s.mgrPaused ? 'Resume loans' : 'Pause loans'}
            </Btn>
            <Btn variant={s.poolPaused ? 'primary' : 'danger'} busy={busy} onClick={() => act(s.poolPaused ? 'Unpause pool' : 'Pause pool', async () => { const c = await writer('LendingPool'); return s.poolPaused ? c.unpause() : c.pause(); })}>
              {s.poolPaused ? 'Resume pool' : 'Pause pool'}
            </Btn>
          </div>
        </Card>

        <Card title="Pool parameters">
          <dl className="kv" style={{ marginBottom: 12 }}>
            <dt>Interest to reserve</dt><dd>{pct(s.reserveBps)}</dd>
            <dt>Max utilisation</dt><dd>{pct(s.maxUtil)}</dd>
          </dl>
          <div className="form-grid">
            <Field label="Reserve share (bps, max 5000)"><input type="number" min="0" max="5000" value={bps.reserve} onChange={(e) => setBps({ ...bps, reserve: e.target.value })} /></Field>
            <Field label="Max utilisation (bps)"><input type="number" min="1" max="10000" value={bps.util} onChange={(e) => setBps({ ...bps, util: e.target.value })} /></Field>
          </div>
          <div className="row">
            <Btn variant="secondary" busy={busy} disabled={bps.reserve === ''} onClick={() => act('Set reserve share', async () => (await writer('LendingPool')).setReserveBps(Number(bps.reserve)))}>Set reserve share</Btn>
            <Btn variant="secondary" busy={busy} disabled={bps.util === ''} onClick={() => act('Set max utilisation', async () => (await writer('LendingPool')).setMaxUtilizationBps(Number(bps.util)))}>Set max utilisation</Btn>
          </div>
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Roles" subtitle="Staff roles live on-chain. Changes take effect within about 30 seconds in the app.">
          <Field label="Role">
            <select value={role} onChange={(e) => setRole(Number(e.target.value))}>
              {ROLES.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}
            </select>
          </Field>
          <Field label="Wallet address"><input value={address} onChange={(e) => setAddress(e.target.value.trim())} placeholder="0x…" /></Field>
          <div className="row">
            <Btn busy={busy} disabled={!validAddr} onClick={() => roleTx(true)}>Grant</Btn>
            <Btn variant="danger" busy={busy} disabled={!validAddr} onClick={() => roleTx(false)}>Revoke</Btn>
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>
            The scoring service signs as <span className="mono">{shortAddr(config.scorer)}</span>. It needs the “Scorer” role on the credit registry:{' '}
            <button className="btn btn-secondary btn-sm" onClick={() => setAddress(config.scorer) || setRole(4)}>use this address</button>
          </p>
        </Card>

        <Card title="Reserve and borrower blocks">
          <Field label="Add to the first-loss reserve (mUSDC)">
            <input type="number" min="0" step="any" value={reserve} onChange={(e) => setReserve(e.target.value)} />
          </Field>
          <Btn busy={busy} disabled={safeUnits(reserve) === 0n} onClick={() => act('Fund reserve', async () => {
            const usdc = await writer('MockStablecoin');
            const amount = safeUnits(reserve);
            const ok = await runTx(`Approve ${usd(amount)} mUSDC`, async () => usdc.approve(config.contracts.LendingPool, amount));
            if (!ok) throw new Error('Approval was not completed');
            return (await writer('LendingPool')).fundReserve(amount);
          })}>Fund reserve</Btn>
          <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '16px 0' }} />
          <Field label="Borrower wallet" hint="Blocked wallets cannot apply for loans (defaults are blocked automatically)">
            <input value={blockAddr} onChange={(e) => setBlockAddr(e.target.value.trim())} placeholder="0x…" />
          </Field>
          <div className="row">
            <Btn variant="danger" busy={busy} disabled={!ethers.isAddress(blockAddr)} onClick={() => act('Block borrower', async () => (await writer('CreditRegistry')).setBlocked(blockAddr, true))}>Block</Btn>
            <Btn variant="secondary" busy={busy} disabled={!ethers.isAddress(blockAddr)} onClick={() => act('Unblock borrower', async () => (await writer('CreditRegistry')).setBlocked(blockAddr, false))}>Unblock</Btn>
          </div>
        </Card>
      </div>

      <TierEditor tiers={s.tiers} />
    </div>
  );
}

function TierEditor({ tiers }) {
  const { writer, runTx } = useApp();
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const t = edit.values;
    await runTx(`Update tier ${edit.index}`, async () =>
      (await writer('CreditRegistry')).setTier(edit.index, Number(t.minScore), toUnits(t.maxAmount), Number(t.aprBps), Number(t.collateralBps))
    );
    setBusy(false);
    setEdit(null);
  };

  return (
    <Card title="Tier configuration" subtitle="Limit, price and collateral for each credit tier. Minimum scores must stay in ascending order.">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Tier</th><th className="num">Min score</th><th className="num">Limit (mUSDC)</th><th className="num">APR</th><th className="num">Collateral</th><th /></tr></thead>
          <tbody>
            {tiers.map((t, i) => (
              <tr key={i}>
                <td>{TIER_NAMES[i]} (T{i})</td>
                <td className="num">{t.minScore}</td>
                <td className="num">{usd(t.maxAmount, 0)}</td>
                <td className="num">{pct(t.aprBps)}</td>
                <td className="num">{t.collateralBps ? pct(t.collateralBps) : 'none'}</td>
                <td><Btn variant="secondary" className="btn-sm" onClick={() => setEdit({ index: i, values: { minScore: t.minScore, maxAmount: ethers.formatUnits(t.maxAmount, 6), aprBps: t.aprBps, collateralBps: t.collateralBps } })}>Edit</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <div style={{ marginTop: 14 }}>
          <h3 style={{ marginBottom: 8 }}>Edit tier {edit.index}</h3>
          <div className="form-grid">
            {[['minScore', 'Min score'], ['maxAmount', 'Limit (mUSDC)'], ['aprBps', 'APR (bps)'], ['collateralBps', 'Collateral (bps)']].map(([k, label]) => (
              <Field key={k} label={label}>
                <input type="number" step="any" value={edit.values[k]} disabled={k === 'minScore' && edit.index === 0}
                  onChange={(e) => setEdit({ ...edit, values: { ...edit.values, [k]: e.target.value } })} />
              </Field>
            ))}
          </div>
          <div className="row">
            <Btn busy={busy} onClick={save}>Save tier</Btn>
            <Btn variant="secondary" onClick={() => setEdit(null)}>Cancel</Btn>
          </div>
        </div>
      )}
    </Card>
  );
}
