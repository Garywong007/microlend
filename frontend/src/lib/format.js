import { ethers } from 'ethers';

export const DECIMALS = 6;
export const toUnits = (human) => ethers.parseUnits(String(human), DECIMALS);

/** "1234567890" (6-decimals) -> "1,234.57" */
export function usd(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '-';
  const n = Number(ethers.formatUnits(BigInt(value), DECIMALS));
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const pct = (bps) => `${(Number(bps) / 100).toFixed(Number(bps) % 100 === 0 ? 0 : 2)}%`;
export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
export const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');

export function date(ts) {
  if (!ts) return '-';
  return new Date(Number(ts) * 1000).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}
export function dateTime(ts) {
  if (!ts) return '-';
  return new Date(Number(ts) * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function duration(seconds) {
  if (seconds === null || seconds === undefined) return '-';
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

export const TIER_NAMES = ['Starter', 'Builder', 'Trusted', 'Established'];

export const STATUS_HINT = {
  Pending: 'Waiting for a credit officer',
  Approved: 'Approved - complete the steps to receive funds',
  Active: 'Funds received - repayment in progress',
  Repaid: 'Fully repaid',
  Defaulted: 'Defaulted',
  Rejected: 'Not approved',
  Cancelled: 'Cancelled by the borrower',
};

/** Hashes free text so only a fingerprint (never the text) is written on-chain. */
export const hashText = (text) => ethers.id(text.trim());

/** Turns wallet / contract errors into messages a non-technical user can act on. */
const CUSTOM_ERRORS = {
  AccessControlUnauthorizedAccount: 'Your wallet does not have the role required for this action.',
  AmountOutOfRange: 'The amount is outside the limit for your current tier.',
  InvalidTerm: 'Choose a term between 7 and 180 days.',
  OpenLoanExists: 'You already have an open loan. Finish or cancel it first.',
  BorrowerBlocked: 'This wallet is blocked from borrowing (previous default).',
  SelfApproval: 'You cannot approve your own application.',
  CollateralMissing: 'Deposit the required collateral first.',
  CollateralAlreadyPosted: 'Collateral has already been deposited.',
  NoCollateralRequired: 'No collateral is required for this loan.',
  ApprovalExpired: 'The approval expired (valid for 7 days). Cancel and apply again.',
  NotBorrower: 'Only the borrower can do this.',
  NotAuthorized: 'You are not allowed to do this.',
  NotDefaultable: 'The loan is not yet past its due date plus the grace period.',
  InvalidStatus: 'The loan is not in the right state for this action.',
  UnknownLoan: 'That loan does not exist.',
  ZeroAmount: 'Enter an amount greater than zero.',
  EnforcedPause: 'This part of the protocol is paused right now.',
  InsufficientLiquidity: 'The pool does not have enough idle cash for this right now.',
  UtilizationTooHigh: 'The pool is at its lending limit. Try again later.',
  InvalidSigner: 'The score attestation is invalid or was already used. Request a new score.',
  InvalidExpiry: 'The score attestation has expired. Request a new score.',
  InvalidShares: 'Invalid share amount.',
  ZeroShares: 'The deposit is too small.',
  FaucetCooldown: 'The faucet can be used once per hour.',
  ERC20InsufficientBalance: 'Your wallet balance is too low.',
  ERC20InsufficientAllowance: 'Approve the contract to use your tokens first.',
};

export function friendlyError(e) {
  if (!e) return 'Unknown error';
  if (e.code === 'ACTION_REJECTED' || e.info?.error?.code === 4001) return 'You rejected the request in your wallet.';
  const name = e.revert?.name || e.errorName;
  if (name && CUSTOM_ERRORS[name]) return CUSTOM_ERRORS[name];
  if (name) return `Contract rejected the request (${name}).`;
  if (e.status && e.message) return e.message; // ApiError
  if (e.shortMessage) return e.shortMessage;
  return e.message || 'Something went wrong';
}
