// API tests: real Express app + in-memory SQLite + a stubbed chain (no node needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { createApp } from '../src/app.js';
import { createDb, migrate } from '../src/db.js';
import { loadModel } from '../src/scoring-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const model = loadModel(path.join(here, '..', '..', 'ml', 'model.json'));

const REGISTRY = '0x00000000000000000000000000000000000000a1';
const scorer = ethers.Wallet.createRandom();
const alice = ethers.Wallet.createRandom();
const bob = ethers.Wallet.createRandom();
const auditor = ethers.Wallet.createRandom();
const officer = ethers.Wallet.createRandom();

const roleMap = new Map([
  [auditor.address.toLowerCase(), ['borrower', 'lender', 'auditor']],
  [officer.address.toLowerCase(), ['borrower', 'lender', 'officer']],
]);

const pool = { lenderAssets: '1000000000', outstanding: '200000000', reserve: '50000000', totalShares: '1000000000', cash: '850000000', utilizationBps: 2000, sharePrice: '1000000000000000000' };
const chain = {
  chainId: 31337,
  scorerWallet: scorer,
  interfaces: new Map(),
  contracts: { CreditRegistry: { hasRole: async () => true, getAddress: async () => REGISTRY } },
  getRoles: async (addr) => roleMap.get(addr.toLowerCase()) || ['borrower', 'lender'],
  getNonce: async () => 7n,
  getPoolState: async () => pool,
  getBorrowerTerms: async () => ({ tier: 0, maxAmount: '100000000', aprBps: 2400, collateralBps: 2000, effectiveScore: 0, blocked: false }),
};

let server;
let base;
let db;

const config = {
  nodeEnv: 'test',
  isProd: false,
  network: 'test',
  corsOrigins: ['http://localhost:5173'],
  jwtSecret: 'unit-test-secret-unit-test-secret-1234',
  jwtTtlSeconds: 3600,
  scoreValidityDays: 90,
  deployment: { chainId: 31337, contracts: { MockStablecoin: '0x1', CreditRegistry: REGISTRY, LendingPool: '0x3', CollateralVault: '0x4', LoanManager: '0x5' } },
};

const silent = { error() {}, info() {}, warn() {} };

before(async () => {
  db = createDb({ databaseUrl: '', sqlitePath: ':memory:' });
  await migrate(db);
  const app = createApp({ config, db, chain, model, indexer: { status: () => ({ lastBlock: 5, head: 5, error: null }) }, logger: silent });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;

  const loan = (id, borrower, status = 'Pending') => ({
    loan_id: id, borrower: borrower.toLowerCase(), status: 1, status_name: status, tier: 0, apr_bps: 2400, term_days: 30,
    collateral_posted: false, requested: '50000000', principal: '0', collateral_required: '0', interest_total: '0',
    principal_paid: '0', interest_paid: '0', created_at: 1, approved_at: 0, disbursed_at: 0, due_at: 0, closed_at: 0,
    purpose_hash: '0x00', updated_block: 1,
  });
  await db('loans').insert([loan(1, alice.address), loan(2, bob.address)]);
  const ev = (log_index, loan_id, who, name) => ({
    contract: 'LoanManager', name, block_number: log_index, tx_hash: `0xhash${log_index}`, log_index, timestamp: 1_700_000_000 + log_index,
    loan_id, accounts: `,${who.address.toLowerCase()},`, args: JSON.stringify({ loanId: String(loan_id), note: '=HYPERLINK("http://evil")' }),
  });
  await db('events').insert([ev(1, 1, alice, 'LoanApplied'), ev(2, 2, bob, 'LoanApplied')]);
});

after(async () => {
  await new Promise((r) => server.close(r));
  await db.destroy();
});

async function api(method, route, { token, body } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* csv */
  }
  return { status: res.status, json, text };
}

async function login(wallet) {
  const n = await api('POST', '/auth/nonce', { body: { address: wallet.address } });
  const signature = await wallet.signMessage(n.json.message);
  return api('POST', '/auth/verify', { body: { address: wallet.address, signature } });
}

test('health and public stats work without a login', async () => {
  assert.equal((await api('GET', '/health')).json.ok, true);
  const stats = await api('GET', '/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.json.pool.utilizationBps, 2000);
  assert.equal(stats.json.loans.total, 2);
  const cfg = await api('GET', '/config');
  assert.equal(cfg.json.model.version, model.version);
});

test('protected routes reject anonymous callers', async () => {
  assert.equal((await api('GET', '/loans')).status, 401);
  assert.equal((await api('GET', '/events')).status, 401);
  assert.equal((await api('POST', '/score', { body: { features: {} } })).status, 401);
});

test('wallet login: wrong signer and replayed nonce are rejected', async () => {
  const n = await api('POST', '/auth/nonce', { body: { address: alice.address } });
  const forged = await bob.signMessage(n.json.message);
  assert.equal((await api('POST', '/auth/verify', { body: { address: alice.address, signature: forged } })).status, 401);
  // the nonce was burned by the failed attempt
  const good = await alice.signMessage(n.json.message);
  assert.equal((await api('POST', '/auth/verify', { body: { address: alice.address, signature: good } })).status, 401);
  assert.equal((await api('POST', '/auth/nonce', { body: { address: 'not-an-address' } })).status, 400);
});

test('wallet login resolves on-chain roles', async () => {
  const a = await login(alice);
  assert.equal(a.status, 200);
  assert.deepEqual(a.json.roles, ['borrower', 'lender']);
  const s = await login(auditor);
  assert.ok(s.json.roles.includes('auditor'));
});

test('borrowers only see their own loans and events', async () => {
  const { json } = await login(alice);
  const loans = await api('GET', '/loans', { token: json.token });
  assert.equal(loans.json.total, 1);
  assert.equal(loans.json.items[0].loanId, 1);
  assert.equal((await api('GET', '/loans/2', { token: json.token })).status, 404);
  assert.equal((await api('GET', '/loans/1', { token: json.token })).status, 200);
  const events = await api('GET', '/events', { token: json.token });
  assert.equal(events.json.total, 1);
  // a borrower cannot widen the view by passing someone else's address
  const spoof = await api('GET', `/loans?borrower=${bob.address}`, { token: json.token });
  assert.equal(spoof.json.total, 1);
  assert.equal(spoof.json.items[0].loanId, 1);
});

test('staff roles gate the audit and officer endpoints', async () => {
  const a = (await login(alice)).json.token;
  const au = (await login(auditor)).json.token;
  const of = (await login(officer)).json.token;

  assert.equal((await api('GET', '/audit/summary', { token: a })).status, 403);
  const summary = await api('GET', '/audit/summary', { token: au });
  assert.equal(summary.status, 200);
  assert.equal(summary.json.events.total, 2);
  assert.equal(summary.json.pool.reserveCoverageBps, 2500);

  assert.equal((await api('GET', '/officer/queue', { token: au })).status, 403);
  const queue = await api('GET', '/officer/queue', { token: of });
  assert.equal(queue.status, 200);
  assert.equal(queue.json.items.length, 2);

  assert.equal((await api('GET', '/loans', { token: au })).json.total, 2); // auditor sees everything
  assert.equal((await api('GET', '/events/export.csv', { token: a })).status, 403);
});

test('CSV export neutralises spreadsheet formulas', async () => {
  const au = (await login(auditor)).json.token;
  const res = await api('GET', '/events/export.csv', { token: au });
  assert.equal(res.status, 200);
  assert.ok(res.text.startsWith('block,timestamp_utc,contract,event,loan_id,tx_hash,args_json'));
  // args JSON starts with "{" so it is safe; a raw formula cell would have to be prefixed with a quote
  assert.ok(!/(^|,)"=/.test(res.text));
});

test('scoring: valid request returns a scorer-signed EIP-712 attestation', async () => {
  const { json } = await login(alice);
  const features = model.test_vectors[0].input;
  const res = await api('POST', '/score', { token: json.token, body: { features } });
  assert.equal(res.status, 200);
  const att = res.json.attestation;
  assert.equal(att.borrower, alice.address);
  assert.equal(att.score, res.json.score);
  assert.equal(att.nonce, '7');

  const domain = { name: 'MicroLend CreditRegistry', version: '1', chainId: 31337, verifyingContract: REGISTRY };
  const types = {
    Score: [
      { name: 'borrower', type: 'address' },
      { name: 'score', type: 'uint16' },
      { name: 'modelHash', type: 'bytes32' },
      { name: 'expiresAt', type: 'uint64' },
      { name: 'nonce', type: 'uint256' },
    ],
  };
  const { signature, signer, ...value } = att;
  assert.equal(ethers.verifyTypedData(domain, types, { ...value, nonce: BigInt(value.nonce) }, signature), scorer.address);
});

test('scoring: invalid input is rejected with per-field messages', async () => {
  const { json } = await login(bob);
  const res = await api('POST', '/score', { token: json.token, body: { features: { monthly_income_usd: -1 } } });
  assert.equal(res.status, 400);
  assert.ok(res.json.details.monthly_income_usd);
  assert.equal((await api('POST', '/score', { token: json.token, body: {} })).status, 400);
});

test('unknown routes return a JSON 404', async () => {
  const res = await api('GET', '/nope');
  assert.equal(res.status, 404);
  assert.ok(res.json.error);
});
