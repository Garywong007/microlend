export const loanToJson = (r) => ({
  loanId: Number(r.loan_id),
  borrower: r.borrower,
  status: r.status_name,
  statusCode: Number(r.status),
  tier: Number(r.tier),
  aprBps: Number(r.apr_bps),
  termDays: Number(r.term_days),
  collateralPosted: Boolean(r.collateral_posted),
  requested: r.requested,
  principal: r.principal,
  collateralRequired: r.collateral_required,
  interestTotal: r.interest_total,
  principalPaid: r.principal_paid,
  interestPaid: r.interest_paid,
  createdAt: Number(r.created_at),
  approvedAt: Number(r.approved_at),
  disbursedAt: Number(r.disbursed_at),
  dueAt: Number(r.due_at),
  closedAt: Number(r.closed_at),
  purposeHash: r.purpose_hash,
});

export const eventToJson = (r) => ({
  id: Number(r.id),
  contract: r.contract,
  name: r.name,
  blockNumber: Number(r.block_number),
  txHash: r.tx_hash,
  logIndex: Number(r.log_index),
  timestamp: Number(r.timestamp),
  loanId: r.loan_id === null || r.loan_id === undefined ? null : Number(r.loan_id),
  args: JSON.parse(r.args),
});

export const snapshotToJson = (r) => ({
  timestamp: Number(r.timestamp),
  blockNumber: Number(r.block_number),
  lenderAssets: r.lender_assets,
  outstanding: r.outstanding,
  reserve: r.reserve,
  totalShares: r.total_shares,
  cash: r.cash,
  utilizationBps: Number(r.utilization_bps),
  sharePrice: r.share_price,
});

/** CSV cell with quote escaping and protection against spreadsheet formula injection. */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
