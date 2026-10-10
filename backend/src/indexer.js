import { getState, setState } from './db.js';

const SKIP_CONTRACTS = new Set(['MockStablecoin']); // ERC-20 Transfer/Approval noise is not part of the audit trail
const SNAPSHOT_CONTRACTS = new Set(['LendingPool', 'LoanManager']);
const MAX_SNAPSHOTS_PER_CHUNK = 200;

function decodeLog(entry, parsed) {
  const args = {};
  const accounts = new Set();
  parsed.fragment.inputs.forEach((input, i) => {
    const value = parsed.args[i];
    args[input.name || `arg${i}`] = typeof value === 'bigint' ? value.toString() : value;
    if (input.type === 'address') accounts.add(String(value).toLowerCase());
  });
  const loanId = args.loanId !== undefined ? Number(args.loanId) : null;
  return { name: parsed.name, args, accounts: [...accounts], loanId, contract: entry.name };
}

const loanRow = (l, block) => ({
  loan_id: l.loanId,
  borrower: l.borrower,
  status: l.status,
  status_name: l.statusName,
  tier: l.tier,
  apr_bps: l.aprBps,
  term_days: l.termDays,
  collateral_posted: l.collateralPosted,
  requested: l.requested,
  principal: l.principal,
  collateral_required: l.collateralRequired,
  interest_total: l.interestTotal,
  principal_paid: l.principalPaid,
  interest_paid: l.interestPaid,
  created_at: l.createdAt,
  approved_at: l.approvedAt,
  disbursed_at: l.disbursedAt,
  due_at: l.dueAt,
  closed_at: l.closedAt,
  purpose_hash: l.purposeHash,
  updated_block: block,
});

/**
 * Reads every protocol event from the chain, stores it (audit log), keeps a denormalised `loans` table in sync
 * by re-reading the loan struct after each event, and records pool snapshots for the dashboard charts.
 * Idempotent: (tx_hash, log_index) is unique, so re-scanning a range is safe.
 */
export function createIndexer({ config, db, chain, log = console }) {
  const blockTimes = new Map();
  let running = false;
  let timer = null;
  const status = { lastBlock: null, head: null, lastOkAt: null, error: null };

  async function blockTime(n) {
    if (blockTimes.has(n)) return blockTimes.get(n);
    const b = await chain.provider.getBlock(n);
    if (blockTimes.size > 5000) blockTimes.clear();
    blockTimes.set(n, b.timestamp);
    return b.timestamp;
  }

  async function snapshot(blockNumber) {
    const [state, timestamp] = await Promise.all([chain.getPoolState(blockNumber), blockTime(blockNumber)]);
    await db('pool_snapshots').insert({
      timestamp,
      block_number: blockNumber,
      lender_assets: state.lenderAssets,
      outstanding: state.outstanding,
      reserve: state.reserve,
      total_shares: state.totalShares,
      cash: state.cash,
      utilization_bps: state.utilizationBps,
      share_price: state.sharePrice,
    });
  }

  async function syncOnce() {
    const head = await chain.provider.getBlockNumber();
    const safeHead = head - config.confirmations;
    let last = Number((await getState(db, 'last_block')) ?? config.deployment.startBlock - 1);
    status.head = head;
    if (safeHead <= last) {
      status.lastBlock = last;
      return { events: 0, head, last };
    }

    const addresses = [...chain.interfaces.keys()];
    let total = 0;
    while (last < safeHead) {
      const from = last + 1;
      const to = Math.min(safeHead, last + config.indexerChunk);
      const logs = await chain.provider.getLogs({ address: addresses, fromBlock: from, toBlock: to });

      const rows = [];
      const loanIds = new Set();
      const snapshotBlocks = new Set();
      for (const lg of logs) {
        const entry = chain.interfaces.get(lg.address.toLowerCase());
        if (!entry || SKIP_CONTRACTS.has(entry.name)) continue;
        let parsed = null;
        try {
          parsed = entry.iface.parseLog({ topics: lg.topics, data: lg.data });
        } catch {
          parsed = null;
        }
        if (!parsed) continue;
        const d = decodeLog(entry, parsed);
        rows.push({
          contract: d.contract,
          name: d.name,
          block_number: lg.blockNumber,
          tx_hash: lg.transactionHash,
          log_index: lg.index,
          timestamp: await blockTime(lg.blockNumber),
          loan_id: d.loanId,
          accounts: `,${d.accounts.join(',')},`,
          args: JSON.stringify(d.args),
        });
        if (d.loanId) loanIds.add(d.loanId);
        if (SNAPSHOT_CONTRACTS.has(d.contract) && snapshotBlocks.size < MAX_SNAPSHOTS_PER_CHUNK) snapshotBlocks.add(lg.blockNumber);
      }

      // chain reads happen before the DB transaction so it stays short
      const loans = [];
      for (const id of loanIds) loans.push(await chain.readLoan(id));

      await db.transaction(async (trx) => {
        for (let i = 0; i < rows.length; i += 100) {
          await trx('events')
            .insert(rows.slice(i, i + 100))
            .onConflict(['tx_hash', 'log_index'])
            .ignore();
        }
        for (const l of loans) await trx('loans').insert(loanRow(l, to)).onConflict('loan_id').merge();
        await setState(trx, 'last_block', to);
      });

      for (const b of [...snapshotBlocks].sort((a, c) => a - c)) await snapshot(b);
      total += rows.length;
      last = to;
    }

    // keep the time series alive even when the pool is idle (at most one extra point per hour)
    const lastSnap = await db('pool_snapshots').max({ t: 'timestamp' }).first();
    const headTime = await blockTime(safeHead);
    if (!lastSnap?.t || headTime - Number(lastSnap.t) > 3600) await snapshot(safeHead);

    status.lastBlock = last;
    status.lastOkAt = Date.now();
    status.error = null;
    if (total) log.info?.(`[indexer] stored ${total} events up to block ${last}`);
    return { events: total, head, last };
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      await syncOnce();
    } catch (e) {
      status.error = e.message;
      log.error?.(`[indexer] ${e.message}`);
    } finally {
      running = false;
    }
  }

  return {
    syncOnce,
    status: () => ({ ...status }),
    start() {
      tick();
      timer = setInterval(tick, config.indexerIntervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
