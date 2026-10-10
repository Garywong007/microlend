import { ethers } from 'ethers';
import { loadAbi } from './config.js';

export const ROLE_HASH = {
  admin: ethers.ZeroHash, // DEFAULT_ADMIN_ROLE
  officer: ethers.id('OFFICER_ROLE'),
  auditor: ethers.id('AUDITOR_ROLE'),
  scorer: ethers.id('SCORER_ROLE'),
};

export const LOAN_STATUS = ['None', 'Pending', 'Approved', 'Active', 'Repaid', 'Defaulted', 'Rejected', 'Cancelled'];

/** Wraps provider + contract instances + the scorer wallet. Injected into the app so tests can stub it. */
export function createChain(config) {
  const { deployment } = config;
  const network = ethers.Network.from(deployment.chainId);
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, network, { staticNetwork: network });

  const names = ['MockStablecoin', 'CreditRegistry', 'LendingPool', 'CollateralVault', 'LoanManager'];
  const contracts = {};
  const interfaces = new Map(); // lower-case address -> { name, iface }
  for (const name of names) {
    const address = deployment.contracts[name];
    const abi = loadAbi(name);
    contracts[name] = new ethers.Contract(address, abi, provider);
    interfaces.set(address.toLowerCase(), { name, iface: new ethers.Interface(abi) });
  }

  const scorerWallet = new ethers.Wallet(config.scorerPrivateKey);
  const roleCache = new Map(); // address -> { roles, at }

  async function getRoles(address) {
    const key = address.toLowerCase();
    const hit = roleCache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.roles;
    const m = contracts.LoanManager;
    const [admin, officer, auditor] = await Promise.all([
      m.hasRole(ROLE_HASH.admin, address),
      m.hasRole(ROLE_HASH.officer, address),
      m.hasRole(ROLE_HASH.auditor, address),
    ]);
    // Everybody can be a borrower or a lender; staff roles come from the chain.
    const roles = ['borrower', 'lender', ...(admin ? ['admin'] : []), ...(officer ? ['officer'] : []), ...(auditor ? ['auditor'] : [])];
    roleCache.set(key, { roles, at: Date.now() });
    return roles;
  }

  return {
    provider,
    contracts,
    interfaces,
    scorerWallet,
    chainId: deployment.chainId,
    getRoles,
    clearRoleCache: () => roleCache.clear(),
    async scorerHasRole() {
      return contracts.CreditRegistry.hasRole(ROLE_HASH.scorer, scorerWallet.address);
    },
    async getBorrowerTerms(address) {
      const t = await contracts.CreditRegistry.getTerms(address);
      return {
        tier: Number(t.tier),
        maxAmount: t.maxAmount.toString(),
        aprBps: Number(t.aprBps),
        collateralBps: Number(t.collateralBps),
        effectiveScore: Number(t.effectiveScore),
        blocked: t.blocked,
      };
    },
    async getNonce(address) {
      return contracts.CreditRegistry.nonces(address);
    },
    async getPoolState(blockTag = 'latest') {
      const p = contracts.LendingPool;
      const [lenderAssets, outstanding, reserve, totalShares, cash, utilizationBps, sharePrice] = await Promise.all([
        p.lenderAssets({ blockTag }),
        p.outstandingPrincipal({ blockTag }),
        p.reserve({ blockTag }),
        p.totalShares({ blockTag }),
        p.cash({ blockTag }),
        p.utilizationBps({ blockTag }),
        p.sharePrice({ blockTag }),
      ]);
      return {
        lenderAssets: lenderAssets.toString(),
        outstanding: outstanding.toString(),
        reserve: reserve.toString(),
        totalShares: totalShares.toString(),
        cash: cash.toString(),
        utilizationBps: Number(utilizationBps),
        sharePrice: sharePrice.toString(),
      };
    },
    async readLoan(loanId) {
      const l = await contracts.LoanManager.getLoan(loanId);
      return {
        loanId: Number(loanId),
        borrower: l.borrower.toLowerCase(),
        status: Number(l.status),
        statusName: LOAN_STATUS[Number(l.status)],
        tier: Number(l.tier),
        aprBps: Number(l.aprBps),
        termDays: Number(l.termDays),
        collateralPosted: l.collateralPosted,
        requested: l.requested.toString(),
        principal: l.principal.toString(),
        collateralRequired: l.collateralRequired.toString(),
        interestTotal: l.interestTotal.toString(),
        principalPaid: l.principalPaid.toString(),
        interestPaid: l.interestPaid.toString(),
        createdAt: Number(l.createdAt),
        approvedAt: Number(l.approvedAt),
        disbursedAt: Number(l.disbursedAt),
        dueAt: Number(l.dueAt),
        closedAt: Number(l.closedAt),
        purposeHash: l.purposeHash,
      };
    },
  };
}
