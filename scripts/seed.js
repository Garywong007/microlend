// Populates a LOCAL chain with realistic demo data (all loan states, 2 lenders, an audit note ...)
// so the dashboards, charts and the 10-minute demo video have something to show.
//   npm run node            (terminal 1)
//   npm run deploy:local    (terminal 2)
//   npm run seed:local
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const { ethers, network } = hre;
const U = (n) => ethers.parseUnits(String(n), 6);
const DAY = 86400;

async function advance(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}
const now = async () => (await ethers.provider.getBlock("latest")).timestamp;

async function main() {
  if (!["localhost", "hardhat"].includes(network.name)) throw new Error("seed.js is for local chains only");
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Run "npm run deploy:local" first (${file} missing)`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  const [admin, officer, auditor, scorer, lenderA, lenderB, b1, b2, b3, b4, b5, b6] = await ethers.getSigners();
  const at = (name) => ethers.getContractAt(name, d.contracts[name]);
  const usdc = await at("MockStablecoin");
  const registry = await at("CreditRegistry");
  const pool = await at("LendingPool");
  const manager = await at("LoanManager");
  const managerAddr = d.contracts.LoanManager;
  const poolAddr = d.contracts.LendingPool;

  console.log("Funding wallets with mock stablecoin ...");
  for (const [w, amt] of [
    [admin, 5_000],
    [lenderA, 50_000],
    [lenderB, 30_000],
    [b1, 3_000],
    [b2, 3_000],
    [b3, 3_000],
    [b4, 3_000],
    [b5, 3_000],
    [b6, 3_000],
    [officer, 1_000],
  ]) {
    await (await usdc.mint(w.address, U(amt))).wait();
  }
  for (const b of [b1, b2, b3, b4, b5, b6]) await (await usdc.connect(b).approve(managerAddr, ethers.MaxUint256)).wait();
  for (const l of [lenderA, lenderB]) await (await usdc.connect(l).approve(poolAddr, ethers.MaxUint256)).wait();
  await (await usdc.connect(admin).approve(poolAddr, ethers.MaxUint256)).wait();

  console.log("Lenders deposit, admin funds the first-loss reserve ...");
  await (await pool.connect(lenderA).deposit(U(20_000))).wait();
  await (await pool.connect(lenderB).deposit(U(10_000))).wait();
  await (await pool.connect(admin).fundReserve(U(500))).wait();

  const score = async (who, s) =>
    (
      await registry
        .connect(scorer)
        .updateScore(who.address, s, ethers.id("credit-model-v1"), (await now()) + 90 * DAY)
    ).wait();

  const apply = async (who, amount, days, purpose) => {
    await (await manager.connect(who).applyLoan(U(amount), days, ethers.id(purpose))).wait();
    return manager.openLoanOf(who.address);
  };
  const approve = async (id, amount) => (await manager.connect(officer).approveLoan(id, U(amount))).wait();
  const fund = async (who, id) => {
    const loan = await manager.getLoan(id);
    if (loan.collateralRequired > 0n) await (await manager.connect(who).depositCollateral(id)).wait();
    await (await manager.connect(who).disburse(id)).wait();
  };

  // ---- time-dependent stories first (they move the chain clock forward) ----
  console.log("B1: scored 720, repays a 500 loan on time -> earns history bonus");
  await score(b1, 720);
  let id = await apply(b1, 500, 30, "market stall inventory");
  await approve(id, 500);
  await fund(b1, id);
  await advance(12 * DAY);
  await (await manager.connect(b1).repay(id, U(600))).wait();
  await (await manager.connect(auditor).addAuditNote(id, ethers.id("Audit 2026-Q4: repayment verified"))).wait();

  console.log("B5: scored 480, borrows 200 and defaults -> collateral + reserve waterfall");
  await score(b5, 480);
  id = await apply(b5, 200, 30, "bicycle repair tools");
  await approve(id, 200);
  await fund(b5, id);
  await advance(40 * DAY);
  await (await manager.connect(officer).markDefault(id)).wait();

  // ---- states that should look "live" in the demo ----
  console.log("B1 comes back: tier upgrade, new loan of 700 is active");
  id = await apply(b1, 700, 45, "second cart + cold storage");
  await approve(id, 700);
  await fund(b1, id);

  console.log("B2: scored 580, active loan of 250");
  await score(b2, 580);
  id = await apply(b2, 250, 30, "sewing machine");
  await approve(id, 250);
  await fund(b2, id);

  console.log("B3: unscored, pending application of 80 (shows in the officer queue)");
  await apply(b3, 80, 30, "mobile phone top-up reselling");

  console.log("B4: scored 650, approved with collateral posted, not yet disbursed");
  await score(b4, 650);
  id = await apply(b4, 400, 60, "motorbike repair");
  await approve(id, 400);
  await (await manager.connect(b4).depositCollateral(id)).wait();

  console.log("B6: application rejected by the officer");
  id = await apply(b6, 90, 30, "unspecified");
  await (await manager.connect(officer).rejectLoan(id, ethers.id("incomplete information"))).wait();

  const idx = (a) => [admin, officer, auditor, scorer, lenderA, lenderB, b1, b2, b3, b4, b5, b6].findIndex((s) => s.address === a.address);
  console.log("\nDemo accounts (MicroLend local mnemonic (scripts/local-mnemonic.js) - public, local use only):");
  const roles = [
    ["admin", admin],
    ["officer", officer],
    ["auditor", auditor],
    ["scorer (backend key)", scorer],
    ["lender A", lenderA],
    ["lender B", lenderB],
    ["borrower B1 (repaid, tier up)", b1],
    ["borrower B2 (active)", b2],
    ["borrower B3 (pending)", b3],
    ["borrower B4 (approved)", b4],
    ["borrower B5 (defaulted)", b5],
    ["borrower B6 (rejected)", b6],
  ];
  for (const [label, w] of roles) console.log(`  #${String(idx(w)).padStart(2)}  ${w.address}  ${label}`);
  console.log("\nImport accounts into MetaMask with `npx hardhat node` private keys (index shown above).");
  console.log(`Pool lender assets: ${ethers.formatUnits(await pool.lenderAssets(), 6)} mUSDC, reserve: ${ethers.formatUnits(await pool.reserve(), 6)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
