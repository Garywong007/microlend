import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';
import { HttpError } from './errors.js';

const NONCE_TTL_SECONDS = 300;
const STAFF = ['admin', 'officer', 'auditor'];
export const isStaff = (user) => !!user && user.roles.some((r) => STAFF.includes(r));

export function buildSignInMessage({ address, nonce, issuedAt, chainId }) {
  return [
    'MicroLend wants you to sign in with your wallet.',
    '',
    `Address: ${address}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    '',
    'This signature costs no gas and does not authorise any transaction.',
  ].join('\n');
}

/** Step 1: server issues a single-use nonce embedded in a human-readable message. */
export async function issueNonce({ db, chain }, rawAddress) {
  if (!ethers.isAddress(rawAddress)) throw new HttpError(400, 'Invalid wallet address');
  const address = ethers.getAddress(rawAddress);
  const nonce = crypto.randomBytes(16).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const message = buildSignInMessage({ address, nonce, issuedAt: new Date(now * 1000).toISOString(), chainId: chain.chainId });
  await db('auth_nonces')
    .insert({ address: address.toLowerCase(), message, expires_at: now + NONCE_TTL_SECONDS })
    .onConflict('address')
    .merge();
  return message;
}

/** Step 2: wallet signs the message (personal_sign); server verifies, resolves on-chain roles, issues a JWT. */
export async function verifySignature({ db, chain, config }, rawAddress, signature) {
  if (!ethers.isAddress(rawAddress)) throw new HttpError(400, 'Invalid wallet address');
  const address = ethers.getAddress(rawAddress);
  const key = address.toLowerCase();
  const row = await db('auth_nonces').where({ address: key }).first();
  const now = Math.floor(Date.now() / 1000);
  if (!row || Number(row.expires_at) < now) throw new HttpError(401, 'Sign-in request expired, please try again');

  // single use, whatever the outcome (burn before verifying)
  await db('auth_nonces').where({ address: key }).del();

  let recovered;
  try {
    recovered = ethers.verifyMessage(row.message, signature);
  } catch {
    throw new HttpError(401, 'Invalid signature');
  }
  if (recovered.toLowerCase() !== key) throw new HttpError(401, 'Signature does not match the wallet address');

  const roles = await chain.getRoles(address);
  const token = jwt.sign({ sub: key }, config.jwtSecret, { expiresIn: config.jwtTtlSeconds, algorithm: 'HS256' });
  return { token, address, roles, expiresIn: config.jwtTtlSeconds };
}

/** Populates req.user = { address, roles } when a valid Bearer token is present. Roles are re-read from the chain (cached 30 s). */
export function authenticate({ chain, config }) {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return next();
    try {
      const payload = jwt.verify(header.slice(7), config.jwtSecret, { algorithms: ['HS256'] });
      const address = ethers.getAddress(payload.sub);
      req.user = { address, key: address.toLowerCase(), roles: await chain.getRoles(address) };
      return next();
    } catch (e) {
      if (e?.name === 'JsonWebTokenError' || e?.name === 'TokenExpiredError' || e?.name === 'NotBeforeError') {
        return next(new HttpError(401, 'Session expired or invalid, please sign in again'));
      }
      return next(e);
    }
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  next();
}

export const requireRole =
  (...allowed) =>
  (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Authentication required'));
    if (!req.user.roles.some((r) => allowed.includes(r))) {
      return next(new HttpError(403, `Requires one of the roles: ${allowed.join(', ')}`));
    }
    next();
  };
