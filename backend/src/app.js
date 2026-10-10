import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { authenticate } from './auth.js';
import { errorHandler, notFound } from './errors.js';
import { publicRoutes } from './routes/public.js';
import { sessionRoutes } from './routes/session.js';
import { ledgerRoutes } from './routes/ledger.js';
import { scoreRoutes } from './routes/score.js';
import { staffRoutes } from './routes/staff.js';

/**
 * Builds the Express app. Everything it needs is injected (config, db, chain, model, indexer)
 * so tests can run it against an in-memory database and a stubbed chain.
 */
export function createApp(deps) {
  const { config } = deps;
  const app = express();

  app.set('trust proxy', 1); // behind Render/Vercel/Nginx: correct client IPs for rate limiting
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // non-browser clients (curl, health checks) send no Origin header
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    })
  );
  app.use(express.json({ limit: '50kb' }));
  if (config.nodeEnv !== 'test') app.use(morgan(config.isProd ? 'combined' : 'dev'));
  app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));
  app.use('/api', authenticate(deps));

  app.use('/api', publicRoutes(deps));
  app.use('/api', sessionRoutes(deps));
  app.use('/api', ledgerRoutes(deps));
  app.use('/api', scoreRoutes(deps));
  app.use('/api', staffRoutes(deps));

  app.use(notFound);
  app.use(errorHandler(deps.logger || console));
  return app;
}
