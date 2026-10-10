import { ROLE_HASH } from './chain.js';
import { HttpError } from './errors.js';
import { modelHash } from './scoring-core.js';

const SCORE_TYPES = {
  Score: [
    { name: 'borrower', type: 'address' },
    { name: 'score', type: 'uint16' },
    { name: 'modelHash', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
};

/**
 * Signs an EIP-712 "Score" attestation that CreditRegistry.updateScoreWithSignature() verifies on-chain.
 * Only the score, its expiry and the model-version hash go on-chain - never the borrower's raw data.
 */
export async function signScoreAttestation({ chain, config, model, borrower, score }) {
  if (!(await chain.contracts.CreditRegistry.hasRole(ROLE_HASH.scorer, chain.scorerWallet.address))) {
    throw new HttpError(503, 'Scoring service is not authorised on-chain (missing SCORER_ROLE)');
  }
  const nonce = await chain.getNonce(borrower);
  const expiresAt = Math.floor(Date.now() / 1000) + config.scoreValidityDays * 86400;
  const message = { borrower, score, modelHash: modelHash(model), expiresAt, nonce };
  const domain = {
    name: 'MicroLend CreditRegistry',
    version: '1',
    chainId: chain.chainId,
    verifyingContract: await chain.contracts.CreditRegistry.getAddress(),
  };
  const signature = await chain.scorerWallet.signTypedData(domain, SCORE_TYPES, message);
  return { ...message, nonce: nonce.toString(), signature, signer: chain.scorerWallet.address };
}
