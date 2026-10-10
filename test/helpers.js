const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 86400;
const U = (n) => ethers.parseUnits(String(n), 6); // mUSDC has 6 decimals
const role = (name) => ethers.id(name); // == keccak256(utf8(name)) == Solidity keccak256("NAME")
const Status = { None: 0, Pending: 1, Approved: 2, Active: 3, Repaid: 4, Defaulted: 5, Rejected: 6, Cancelled: 7 };

/** Same formula as LoanManager.approveLoan: simple interest, floor division. */
const interestOf = (principal, aprBps, days) =>
  (BigInt(principal) * BigInt(aprBps) * BigInt(days)) / 3_650_000n;

/** Representative scores for each tier of the default CreditRegistry configuration. */
const SCORE = { tier0: 0, tier1: 500, tier2: 700, tier3: 800 };

async function deployAll() {
  const [admin, officer, auditor, scorer, lender, lender2, borrower, borrower2, outsider] =
    await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockStablecoin")).deploy(admin.address);
  const registry = await (await ethers.getContractFactory("CreditRegistry")).deploy(admin.address);
  const pool = await (await ethers.getContractFactory("LendingPool")).deploy(await usdc.getAddress(), admin.address);
  const vault = await (await ethers.getContractFactory("CollateralVault")).deploy(await usdc.getAddress(), admin.address);
  const manager = await (
    await ethers.getContractFactory("LoanManager")
  ).deploy(
    await usdc.getAddress(),
    await registry.getAddress(),
    await pool.getAddress(),
    await vault.getAddress(),
    admin.address
  );

  const managerAddr = await manager.getAddress();
  await registry.grantRole(role("LOAN_MANAGER_ROLE"), managerAddr);
  await registry.grantRole(role("SCORER_ROLE"), scorer.address);
  await pool.grantRole(role("LOAN_MANAGER_ROLE"), managerAddr);
  await vault.grantRole(role("LOAN_MANAGER_ROLE"), managerAddr);
  await manager.grantRole(role("OFFICER_ROLE"), officer.address);
  await manager.grantRole(role("AUDITOR_ROLE"), auditor.address);

  // Fund everybody with mock stablecoin and pre-approve contracts the way the UI does.
  for (const l of [lender, lender2]) {
    await usdc.mint(l.address, U(100_000));
    await usdc.connect(l).approve(await pool.getAddress(), ethers.MaxUint256);
  }
  for (const b of [borrower, borrower2, officer]) {
    await usdc.mint(b.address, U(5_000));
    await usdc.connect(b).approve(managerAddr, ethers.MaxUint256);
  }
  await usdc.mint(admin.address, U(100_000));
  await usdc.approve(await pool.getAddress(), ethers.MaxUint256);

  return { usdc, registry, pool, vault, manager, admin, officer, auditor, scorer, lender, lender2, borrower, borrower2, outsider };
}

async function giveScore(ctx, who, score, validDays = 90) {
  const expiresAt = (await time.latest()) + validDays * DAY;
  await ctx.registry.connect(ctx.scorer).updateScore(who.address, score, ethers.id("model-v1"), expiresAt);
}

async function lenderDeposit(ctx, lender, amount) {
  await ctx.pool.connect(lender).deposit(amount);
}

/** apply -> approve -> (collateral) -> disburse. Returns the loan id. */
async function openActiveLoan(ctx, { who, score, amount, termDays = 30 }) {
  if (score !== undefined) await giveScore(ctx, who, score);
  await ctx.manager.connect(who).applyLoan(amount, termDays, ethers.id("working capital"));
  const loanId = await ctx.manager.openLoanOf(who.address);
  await ctx.manager.connect(ctx.officer).approveLoan(loanId, amount);
  const loan = await ctx.manager.getLoan(loanId);
  if (loan.collateralRequired > 0n) await ctx.manager.connect(who).depositCollateral(loanId);
  await ctx.manager.connect(who).disburse(loanId);
  return loanId;
}

module.exports = { DAY, U, role, Status, interestOf, SCORE, deployAll, giveScore, lenderDeposit, openActiveLoan, time, ethers };
