import fs from 'node:fs';
import path from 'node:path';
import knex from 'knex';

/** SQLite for local development, PostgreSQL (DATABASE_URL) in the cloud. The same knex code runs on both. */
export function createDb(config) {
  if (config.databaseUrl) {
    const local = /(localhost|127\.0\.0\.1)/.test(config.databaseUrl);
    let ssl = false;
    if (!local && config.databaseSsl !== 'false') ssl = config.databaseSsl === 'no-verify' ? { rejectUnauthorized: false } : true;
    return knex({
      client: 'pg',
      connection: { connectionString: config.databaseUrl, ssl },
      pool: { min: 0, max: 5 },
    });
  }
  if (config.sqlitePath !== ':memory:') fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
  return knex({
    client: 'better-sqlite3',
    connection: { filename: config.sqlitePath },
    useNullAsDefault: true,
  });
}

async function ensureTable(db, name, build) {
  if (!(await db.schema.hasTable(name))) await db.schema.createTable(name, build);
}

export async function migrate(db) {
  await ensureTable(db, 'events', (t) => {
    t.increments('id');
    t.string('contract', 32).notNullable();
    t.string('name', 48).notNullable();
    t.bigInteger('block_number').notNullable();
    t.string('tx_hash', 70).notNullable();
    t.integer('log_index').notNullable();
    t.bigInteger('timestamp').notNullable();
    t.integer('loan_id');
    t.text('accounts').notNullable().defaultTo(',');
    t.text('args').notNullable();
    t.unique(['tx_hash', 'log_index']);
    t.index(['name']);
    t.index(['loan_id']);
    t.index(['timestamp']);
  });

  await ensureTable(db, 'loans', (t) => {
    t.integer('loan_id').primary();
    t.string('borrower', 64).notNullable().index();
    t.integer('status').notNullable().index();
    t.string('status_name', 16).notNullable();
    t.integer('tier').notNullable();
    t.integer('apr_bps').notNullable();
    t.integer('term_days').notNullable();
    t.boolean('collateral_posted').notNullable();
    t.text('requested').notNullable();
    t.text('principal').notNullable();
    t.text('collateral_required').notNullable();
    t.text('interest_total').notNullable();
    t.text('principal_paid').notNullable();
    t.text('interest_paid').notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('approved_at').notNullable();
    t.bigInteger('disbursed_at').notNullable();
    t.bigInteger('due_at').notNullable();
    t.bigInteger('closed_at').notNullable();
    t.string('purpose_hash', 70).notNullable();
    t.bigInteger('updated_block').notNullable();
  });

  await ensureTable(db, 'pool_snapshots', (t) => {
    t.increments('id');
    t.bigInteger('timestamp').notNullable().index();
    t.bigInteger('block_number').notNullable();
    t.text('lender_assets').notNullable();
    t.text('outstanding').notNullable();
    t.text('reserve').notNullable();
    t.text('total_shares').notNullable();
    t.text('cash').notNullable();
    t.integer('utilization_bps').notNullable();
    t.text('share_price').notNullable();
  });

  await ensureTable(db, 'profiles', (t) => {
    t.string('address', 64).primary();
    t.string('display_name', 80);
    t.string('country', 2);
    t.string('occupation', 80);
    t.bigInteger('updated_at').notNullable();
  });

  await ensureTable(db, 'score_requests', (t) => {
    t.increments('id');
    t.string('address', 64).notNullable().index();
    t.text('features').notNullable();
    t.float('pd').notNullable();
    t.integer('score').notNullable();
    t.integer('tier').notNullable();
    t.string('model_version', 40).notNullable();
    t.string('model_hash', 70).notNullable();
    t.text('nonce').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('created_at').notNullable();
  });

  await ensureTable(db, 'auth_nonces', (t) => {
    t.string('address', 64).primary();
    t.text('message').notNullable();
    t.bigInteger('expires_at').notNullable();
  });

  await ensureTable(db, 'sync_state', (t) => {
    t.string('key', 40).primary();
    t.text('value').notNullable();
  });
}

export const getState = async (db, key) => (await db('sync_state').where({ key }).first())?.value;
export const setState = (db, key, value) =>
  db('sync_state').insert({ key, value: String(value) }).onConflict('key').merge();
