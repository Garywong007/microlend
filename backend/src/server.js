import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';
import { createChain } from './chain.js';
import { createIndexer } from './indexer.js';
import { loadModel } from './scoring-core.js';
import { createApp } from './app.js';

async function main() {
  const config = loadConfig();
  const db = createDb(config);
  await migrate(db);

  const chain = createChain(config);
  const model = loadModel(config.modelPath);
  const indexer = createIndexer({ config, db, chain });

  const deps = { config, db, chain, model, indexer, logger: console };
  const app = createApp(deps);

  try {
    if (!(await chain.scorerHasRole())) {
      console.warn(`[warn] scorer ${chain.scorerWallet.address} does not hold SCORER_ROLE on CreditRegistry - /api/score will fail`);
    }
  } catch (e) {
    console.warn(`[warn] could not reach the chain at startup (${e.message}); the indexer will keep retrying`);
  }

  indexer.start();
  const server = app.listen(config.port, () => {
    console.log(`MicroLend API on :${config.port}  network=${config.network} chainId=${chain.chainId}  model=${model.version}`);
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down`);
    indexer.stop();
    server.close(async () => {
      await db.destroy();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('Fatal startup error:', e.message);
  process.exit(1);
});
