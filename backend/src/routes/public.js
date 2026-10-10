import { Router } from 'express';
import { asyncHandler } from '../errors.js';
import { snapshotToJson } from '../serializers.js';
import { modelHash } from '../scoring-core.js';
import { loadAbi } from '../config.js';

/** Public, read-only transparency endpoints: anyone can see pool health and the model card. */
export function publicRoutes({ config, db, chain, model, indexer }) {
  const r = Router();

  r.get(
    '/health',
    asyncHandler(async (req, res) => {
      const idx = indexer.status();
      res.json({
        ok: true,
        network: config.network,
        chainId: chain.chainId,
        time: new Date().toISOString(),
        indexer: { lastBlock: idx.lastBlock, head: idx.head, lag: idx.head !== null && idx.lastBlock !== null ? idx.head - idx.lastBlock : null, error: idx.error },
      });
    })
  );

  // ABIs are served by the API so the frontend always matches the deployed contracts (no copy step on deploy).
  const abis = {};
  r.get('/abis', (req, res) => {
    if (!Object.keys(abis).length) {
      for (const name of Object.keys(config.deployment.contracts)) abis[name] = loadAbi(name);
    }
    res.set('Cache-Control', 'public, max-age=300').json(abis);
  });

  r.get('/config', (req, res) => {
    res.json({
      network: config.network,
      chainId: chain.chainId,
      rpcUrl: config.network === 'localhost' ? config.rpcUrl : process.env.PUBLIC_RPC_URL || null,
      explorerUrl: process.env.EXPLORER_URL || null,
      contracts: config.deployment.contracts,
      scorer: chain.scorerWallet.address,
      model: {
        version: model.version,
        hash: modelHash(model),
        type: model.type,
        target: model.target,
        metrics: model.metrics,
        tierMinScores: model.tier_min_scores,
        features: model.features.map(({ name, label, description, min, max, binary }) => ({ name, label, description, min, max, binary })),
      },
    });
  });

  r.get(
    '/stats',
    asyncHandler(async (req, res) => {
      const [pool, rows, borrowers, scoreRequests] = await Promise.all([
        chain.getPoolState(),
        db('loans').select('status_name', 'principal', 'interest_total', 'apr_bps', 'disbursed_at'),
        db('loans').countDistinct({ n: 'borrower' }).first(),
        db('score_requests').count({ n: '*' }).first(),
      ]);

      const byStatus = {};
      let disbursed = 0n;
      let aprWeighted = 0n;
      for (const l of rows) {
        byStatus[l.status_name] = (byStatus[l.status_name] || 0) + 1;
        if (Number(l.disbursed_at) > 0) {
          const p = BigInt(l.principal);
          disbursed += p;
          aprWeighted += p * BigInt(l.apr_bps);
        }
      }
      const closed = (byStatus.Repaid || 0) + (byStatus.Defaulted || 0);
      res.json({
        pool,
        loans: {
          total: rows.length,
          byStatus,
          totalDisbursed: disbursed.toString(),
          avgAprBps: disbursed > 0n ? Number(aprWeighted / disbursed) : 0,
          defaultRate: closed ? (byStatus.Defaulted || 0) / closed : 0,
          uniqueBorrowers: Number(borrowers?.n || 0),
        },
        scoring: { requests: Number(scoreRequests?.n || 0), modelVersion: model.version },
      });
    })
  );

  r.get(
    '/pool/history',
    asyncHandler(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000);
      const rows = await db('pool_snapshots').orderBy('timestamp', 'desc').orderBy('id', 'desc').limit(limit);
      res.json({ items: rows.reverse().map(snapshotToJson) });
    })
  );

  return r;
}
