import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');

function readJson(file, what) {
  if (!fs.existsSync(file)) throw new Error(`${what} not found at ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadAbi(name) {
  return readJson(path.join(repoRoot, 'shared', 'abis', `${name}.json`), `ABI ${name} (run "npm run build:contracts" in the repo root)`);
}

/** Builds the runtime configuration from environment variables. Fails fast on unsafe production setups. */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const network = env.NETWORK || 'localhost';
  const isProd = nodeEnv === 'production';

  const deployment = env.DEPLOYMENT_JSON
    ? JSON.parse(env.DEPLOYMENT_JSON)
    : readJson(
        env.DEPLOYMENT_FILE || path.join(repoRoot, 'deployments', `${network}.json`),
        'Deployment file (run the deploy script first)'
      );

  const jwtSecret = env.JWT_SECRET || '';
  if (isProd && jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
  if (!env.SCORER_PRIVATE_KEY) throw new Error('SCORER_PRIVATE_KEY is required (wallet holding SCORER_ROLE on CreditRegistry)');

  return {
    nodeEnv,
    isProd,
    network,
    port: Number(env.PORT || 4000),
    rpcUrl: env.RPC_URL || 'http://127.0.0.1:8545',
    confirmations: Number(env.CONFIRMATIONS ?? (isProd ? 2 : 0)),
    corsOrigins: (env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim()),
    jwtSecret: jwtSecret || 'dev-only-secret-change-me-dev-only-secret',
    jwtTtlSeconds: Number(env.JWT_TTL_SECONDS || 8 * 3600),
    scorerPrivateKey: env.SCORER_PRIVATE_KEY,
    scoreValidityDays: Number(env.SCORE_VALIDITY_DAYS || 90),
    databaseUrl: env.DATABASE_URL || '',
    databaseSsl: env.DATABASE_SSL || 'true', // 'true' (verified TLS) | 'no-verify' | 'false'
    sqlitePath: env.SQLITE_PATH || path.join(repoRoot, 'backend', 'data', 'microlend.sqlite'),
    modelPath: env.MODEL_PATH || path.join(repoRoot, 'ml', 'model.json'),
    indexerIntervalMs: Number(env.INDEXER_INTERVAL_MS || 4000),
    indexerChunk: Number(env.INDEXER_CHUNK || 2000),
    deployment,
  };
}
