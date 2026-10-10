import { ZodError } from 'zod';
import { ValidationError } from './scoring-core.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Lets async route handlers throw; errors reach the error middleware instead of crashing the process. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function notFound(req, res, next) {
  next(new HttpError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(logger = console) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: 'Invalid request',
        details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: 'Invalid input', details: err.details });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });

    // JSON-RPC / network problems when talking to the chain
    const code = err?.code;
    if (['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 'ECONNREFUSED'].includes(code) || err?.cause?.code === 'ECONNREFUSED') {
      logger.error?.(`[chain] ${err.message}`);
      return res.status(503).json({ error: 'Blockchain node unreachable, please retry shortly' });
    }
    if (code === 'CALL_EXCEPTION') {
      logger.error?.(`[chain] call exception: ${err.reason || err.message}`);
      return res.status(502).json({ error: 'Smart contract call failed', reason: err.reason || undefined });
    }

    logger.error?.(err);
    return res.status(500).json({ error: 'Internal server error' });
  };
}
