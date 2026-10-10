import { useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { useApp } from '../context/AppContext.jsx';
import { api } from '../lib/api.js';
import { date, dateTime, hashText, pct, TIER_NAMES, toUnits, usd } from '../lib/format.js';
import { Badge, Btn, Card, Empty, ErrorNote, Field, Loading, Stat, useAsync } from '../components/ui.jsx';

const safeUnits = (v) => {
  try {
    return v === '' ? 0n : toUnits(v);
  } catch {
    return 0n;
  }
};
const APPROVAL_VALIDITY = 7 * 86400;

export default function Borrower() {
  const { me, config } = useApp();
  const loans = useAsync(() => api.get('/loans?limit=50'));
  if (!me) return <Loading />;
  const { terms, credit, openLoanId } = me.borrower;

  return (
    <div className="stack">
      <div className="grid grid-2">
        <WalletCard />
        <ProfileCard terms={terms} credit={credit} />
      </div>
      <ScoreCard config={config} />
      {terms.blocked ? (
        <Card title="Apply for a loan">
          <p className="error-note">This wallet is blocked from borrowing because of a previous default. Contact the administrator.</p>
        </Card>
      ) : openLoanId ? (
        <Card title="Apply for a loan">
          <p className="muted">You have an open loan (#{openLoanId}). You can apply again once it is closed.</p>
        </Card>
      ) : (
        <ApplyCard terms={terms} />
      )}
      <Card title="My loans">
        {loans.loading ? <Loading /> : loans.error ? <ErrorNote error={loans.error} /> : !loans.data.items.length ? <Empty>No loans yet.</Empty> : (
          <div className="stack">{loans.data.items.map((l) => <LoanCard key={l.loanId} loan={l} />)}</div>
        )}
      </Card>
    </div>
  );
}

function WalletCard() {
  const { me, writer, runTx, config } = useApp();
  const [busy, setBusy] = useState(false);
  const faucet = async () => {
    setBusy(true);
    await runTx('Faucet', async () => (await writer('MockStablecoin')).faucet());
    setBusy(false);
  };
  return (
    <Card title="Wallet" subtitle="Test stablecoin (mUSDC) has no real value">
      <div className="grid grid-stats">
        <Stat label="mUSDC balance" value={usd(me.wallet.stablecoinBalance)} />
        <Stat
          label="Approved for MicroLend"
          value={BigInt(me.wallet.managerAllowance) > 10n ** 24n ? 'Unlimited' : usd(me.wallet.managerAllowance)}
          hint={BigInt(me.wallet.managerAllowance) > 10n ** 24n ? 'demo wallet, approved once' : 'set per action'}
        />
      </div>
      <p className="row" style={{ marginTop: 12 }}>
        <Btn variant="secondary" onClick={faucet} busy={busy}>Get 1,000 test mUSDC</Btn>
        <span className="muted small">once per hour · {config.network}</span>
      </p>
    </Card>
  );
}

function ProfileCard({ terms, credit }) {
  const unscored = terms.effectiveScore === 0;
  const expired = credit.scoredAt > 0 && credit.expiresAt * 1000 < Date.now();
  return (
    <Card title="My credit profile" subtitle="Stored on-chain and reusable by any platform">
      <div className="row" style={{ gap: 18, alignItems: 'flex-start' }}>
        <div className="score-ring" aria-label={`Credit score ${terms.effectiveScore}`}>{unscored ? '–' : terms.effectiveScore}</div>
        <dl className="kv">
          <dt>Tier</dt>
          <dd><strong>{TIER_NAMES[terms.tier]}</strong> (T{terms.tier}){unscored && ' · unscored'}</dd>
          <dt>Limit</dt>
          <dd>{usd(terms.maxAmount, 0)} mUSDC</dd>
          <dt>Interest</dt>
          <dd>{pct(terms.aprBps)} APR (simple)</dd>
          <dt>Collateral</dt>
          <dd>{terms.collateralBps ? `${pct(terms.collateralBps)} of the loan` : 'none'}</dd>
          <dt>History</dt>
          <dd>
            {credit.loansRepaid} repaid ({credit.onTimeLoans} on time, {credit.lateLoans} late) · {credit.loansDefaulted} defaulted
            {credit.bonus > 0 && <span className="chip" style={{ marginLeft: 6 }}>+{credit.bonus} from history</span>}
          </dd>
          <dt>Score valid</dt>
          <dd>{credit.scoredAt ? (expired ? <span className="chip chip-warn">expired {date(credit.expiresAt)}</span> : `until ${date(credit.expiresAt)}`) : 'never scored'}</dd>
        </dl>
      </div>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Repay on time and your tier rises automatically: higher limits, lower rates, less collateral.
      </p>
    </Card>
  );
}

function ScoreCard({ config }) {
  const { writer, runTx, run, notify } = useApp();
  const feats = config.model.features;
  const [values, setValues] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const features = Object.fromEntries(feats.map((f) => [f.name, values[f.name] ?? '']));
      setResult(await api.post('/score', { features }));
    } catch (err) {
      if (err.details && !Array.isArray(err.details)) setErrors(err.details);
      notify('error', err.message);
    }
    setBusy(false);
  };

  const record = async () => {
    const a = result.attestation;
    await runTx('Record score on-chain', async () =>
      (await writer('CreditRegistry')).updateScoreWithSignature(a.borrower, a.score, a.modelHash, a.expiresAt, a.signature)
    );
  };

  return (
    <Card
      title="Get a credit score"
      subtitle="Answer a few questions. The score is computed off-chain; you then record it on-chain from your own wallet."
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          {feats.map((f) => (
            <Field key={f.name} label={f.label} hint={errors[f.name] ? undefined : f.description}>
              {f.binary ? (
                <select value={values[f.name] ?? ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} required>
                  <option value="">Select…</option>
                  <option value="1">Yes</option>
                  <option value="0">No</option>
                </select>
              ) : (
                <input type="number" inputMode="decimal" step="any" min={f.min} max={f.max} required value={values[f.name] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} placeholder={`${f.min} – ${f.max}`} />
              )}
              {errors[f.name] && <span className="error-note small">{errors[f.name]}</span>}
            </Field>
          ))}
        </div>
        <Btn type="submit" busy={busy}>Calculate my score</Btn>
        <p className="muted small">Answers are self-reported and kept off-chain. A credit officer verifies them before approving any loan.</p>
      </form>

      {result && (
        <div className="banner banner-info" style={{ marginTop: 14, alignItems: 'flex-start' }}>
          <div>
            <strong>Score {result.score}</strong> → tier {TIER_NAMES[result.tier]} · estimated default risk {(result.probabilityOfDefault * 100).toFixed(1)}%
            {result.reasons.increasingRisk.length > 0 && <div className="small">Raises risk: {result.reasons.increasingRisk.join(', ')}</div>}
            {result.reasons.decreasingRisk.length > 0 && <div className="small">Lowers risk: {result.reasons.decreasingRisk.join(', ')}</div>}
            <div className="small muted">Valid until {dateTime(result.attestation.expiresAt)} · model {result.model.version}</div>
          </div>
          <Btn onClick={record}>Record on-chain</Btn>
        </div>
      )}
    </Card>
  );
}

function ApplyCard({ terms }) {
  const { writer, runTx } = useApp();
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState(30);
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);

  const principal = safeUnits(amount);
  const max = BigInt(terms.maxAmount);
  const preview = useMemo(() => {
    const interest = (principal * BigInt(terms.aprBps) * BigInt(days || 0)) / 3_650_000n;
    return { interest, total: principal + interest, collateral: (principal * BigInt(terms.collateralBps)) / 10_000n };
  }, [principal, days, terms]);

  const valid = principal > 0n && principal <= max && days >= 7 && days <= 180 && purpose.trim().length > 2;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    await runTx('Apply for loan', async () => (await writer('LoanManager')).applyLoan(principal, Number(days), hashText(purpose)));
    setBusy(false);
    setAmount('');
    setPurpose('');
  };

  return (
    <Card title="Apply for a loan" subtitle={`Up to ${usd(terms.maxAmount, 0)} mUSDC at ${pct(terms.aprBps)} APR for your tier`}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Amount (mUSDC)"><input type="number" min="1" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
          <Field label="Term (days)" hint="7 to 180"><input type="number" min="7" max="180" value={days} onChange={(e) => setDays(e.target.value)} required /></Field>
          <Field label="What is the money for?" hint="Only a fingerprint (hash) goes on-chain">
            <input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={120} required placeholder="e.g. stock for my market stall" />
          </Field>
        </div>
        {principal > 0n && (
          <p className="small muted">
            Interest {usd(preview.interest)} · total to repay <strong>{usd(preview.total)}</strong> · collateral to deposit after approval <strong>{usd(preview.collateral)}</strong>
            {principal > max && <span className="error-note"> · above your limit</span>}
          </p>
        )}
        <Btn type="submit" busy={busy} disabled={!valid}>Submit application</Btn>
      </form>
    </Card>
  );
}

function LoanCard({ loan }) {
  const { me, writer, reader, runTx, notify, config } = useApp();
  const [repayAmount, setRepayAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const owed = useAsync(async () => {
    if (loan.status !== 'Active') return null;
    const [p, i] = await reader('LoanManager').amountOwed(loan.loanId);
    return { principal: p, interest: i, total: p + i };
  }, [loan.loanId, loan.status]);

  const now = Date.now() / 1000;
  const approvalExpiry = loan.approvedAt + APPROVAL_VALIDITY;
  const approvalExpired = loan.status === 'Approved' && now > approvalExpiry;
  const overdue = loan.status === 'Active' && now > loan.dueAt;
  const collateralNeeded = BigInt(loan.collateralRequired) > 0n && !loan.collateralPosted;

  const act = async (label, send) => {
    setBusy(true);
    await runTx(label, send);
    setBusy(false);
  };

  // the contract pulls tokens itself, so the wallet must approve exactly what is needed first
  const ensureAllowance = async (needed) => {
    if (BigInt(me.wallet.managerAllowance) >= needed) return true;
    const r = await runTx(`Approve ${usd(needed)} mUSDC`, async () =>
      (await writer('MockStablecoin')).approve(config.contracts.LoanManager, needed)
    );
    return !!r;
  };

  const depositCollateral = () =>
    act('Deposit collateral', async () => {
      if (!(await ensureAllowance(BigInt(loan.collateralRequired)))) throw new Error('Approval was not completed');
      return (await writer('LoanManager')).depositCollateral(loan.loanId);
    });

  const repay = (amountUnits) =>
    act('Repay', async () => {
      if (!(await ensureAllowance(amountUnits))) throw new Error('Approval was not completed');
      return (await writer('LoanManager')).repay(loan.loanId, amountUnits);
    });

  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row"><strong>Loan #{loan.loanId}</strong><Badge status={loan.status} /></div>
        <span className="muted small">applied {date(loan.createdAt)}</span>
      </div>
      <dl className="kv" style={{ marginTop: 10 }}>
        <dt>Amount</dt>
        <dd>{BigInt(loan.principal) > 0n ? usd(loan.principal) : usd(loan.requested)} mUSDC{BigInt(loan.principal) === 0n && ' (requested)'}</dd>
        {loan.status !== 'Pending' && loan.status !== 'Rejected' && (
          <>
            <dt>Rate / term</dt><dd>{pct(loan.aprBps)} APR · {loan.termDays} days · interest {usd(loan.interestTotal)}</dd>
            <dt>Collateral</dt>
            <dd>{BigInt(loan.collateralRequired) === 0n ? 'none' : `${usd(loan.collateralRequired)} (${loan.collateralPosted ? 'deposited' : 'not yet deposited'})`}</dd>
          </>
        )}
        {loan.status === 'Active' && (
          <>
            <dt>Due</dt><dd>{date(loan.dueAt)}{overdue && <span className="chip chip-warn" style={{ marginLeft: 6 }}>overdue - 7 day grace period</span>}</dd>
            <dt>Still owed</dt><dd>{owed.data ? usd(owed.data.total) : '…'} mUSDC</dd>
          </>
        )}
        {loan.status === 'Approved' && <><dt>Approval valid until</dt><dd>{approvalExpired ? <span className="error-note">expired - cancel and reapply</span> : dateTime(approvalExpiry)}</dd></>}
      </dl>

      <div className="row" style={{ marginTop: 12 }}>
        {loan.status === 'Approved' && !approvalExpired && collateralNeeded && (
          <Btn onClick={depositCollateral} busy={busy}>1 · Deposit collateral ({usd(loan.collateralRequired)})</Btn>
        )}
        {loan.status === 'Approved' && !approvalExpired && !collateralNeeded && (
          <Btn onClick={() => act('Receive funds', async () => (await writer('LoanManager')).disburse(loan.loanId))} busy={busy}>
            {BigInt(loan.collateralRequired) > 0n ? '2 · ' : ''}Receive {usd(loan.principal)} mUSDC
          </Btn>
        )}
        {(loan.status === 'Pending' || loan.status === 'Approved') && (
          <Btn variant="secondary" onClick={() => act('Cancel loan', async () => (await writer('LoanManager')).cancelLoan(loan.loanId))} busy={busy}>Cancel</Btn>
        )}
        {loan.status === 'Active' && owed.data && (
          <>
            <input style={{ maxWidth: 140 }} type="number" min="0" step="any" placeholder="Amount" value={repayAmount} onChange={(e) => setRepayAmount(e.target.value)} aria-label="Repayment amount" />
            <Btn variant="secondary" onClick={() => setRepayAmount(ethers.formatUnits(owed.data.total, 6))}>Repay all</Btn>
            <Btn busy={busy} disabled={safeUnits(repayAmount) === 0n} onClick={() => repay(safeUnits(repayAmount) > owed.data.total ? owed.data.total : safeUnits(repayAmount))}>Repay</Btn>
          </>
        )}
      </div>
      {loan.status === 'Active' && <p className="muted small" style={{ marginBottom: 0 }}>Interest is paid first, then principal. Repaying in full releases your collateral.</p>}
    </div>
  );
}
