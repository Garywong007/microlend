const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { DAY, U, role, deployAll, giveScore, lenderDeposit, openActiveLoan, time, ethers } = require("./helpers");

describe("LendingPool", () => {
  describe("deposits and withdrawals", () => {
    it("first deposit mints shares 1:1 minus the permanently locked minimum", async () => {
      const ctx = await loadFixture(deployAll);
      const { pool, lender } = ctx;
      await expect(pool.connect(lender).deposit(U(1000)))
        .to.emit(pool, "Deposited")
        .withArgs(lender.address, U(1000), U(1000) - 1000n);
      expect(await pool.totalShares()).to.equal(U(1000));
      expect(await pool.sharesOf(lender.address)).to.equal(U(1000) - 1000n);
      expect(await pool.lenderAssets()).to.equal(U(1000));
      expect(await pool.sharePrice()).to.equal(10n ** 18n);
    });

    it("second depositor gets shares at the current price", async () => {
      const ctx = await loadFixture(deployAll);
      const { pool, lender, lender2 } = ctx;
      await lenderDeposit(ctx, lender, U(1000));
      await lenderDeposit(ctx, lender2, U(500));
      expect(await pool.sharesOf(lender2.address)).to.equal(U(500));
      expect(await pool.lenderAssets()).to.equal(U(1500));
    });

    it("withdraw burns shares and pays out the proportional assets", async () => {
      const ctx = await loadFixture(deployAll);
      const { pool, usdc, lender } = ctx;
      await lenderDeposit(ctx, lender, U(1000));
      const shares = await pool.sharesOf(lender.address);
      const before = await usdc.balanceOf(lender.address);
      await pool.connect(lender).withdraw(shares / 2n);
      const gained = (await usdc.balanceOf(lender.address)) - before;
      expect(gained).to.be.closeTo(U(500), 1000n);
      expect(await pool.sharesOf(lender.address)).to.equal(shares - shares / 2n);
    });

    it("rejects zero amounts, zero shares and over-withdrawals", async () => {
      const ctx = await loadFixture(deployAll);
      const { pool, lender } = ctx;
      await expect(pool.connect(lender).deposit(0)).to.be.revertedWithCustomError(pool, "ZeroAmount");
      await expect(pool.connect(lender).deposit(1000)).to.be.revertedWithCustomError(pool, "ZeroShares");
      await lenderDeposit(ctx, lender, U(100));
      await expect(pool.connect(lender).withdraw(0)).to.be.revertedWithCustomError(pool, "InvalidShares");
      const shares = await pool.sharesOf(lender.address);
      await expect(pool.connect(lender).withdraw(shares + 1n)).to.be.revertedWithCustomError(pool, "InvalidShares");
    });

    it("cannot withdraw cash that is currently lent out", async () => {
      const ctx = await loadFixture(deployAll);
      const { pool, lender, borrower } = ctx;
      await lenderDeposit(ctx, lender, U(1000));
      await openActiveLoan(ctx, { who: borrower, score: 700, amount: U(800) });
      const shares = await pool.sharesOf(lender.address);
      await expect(pool.connect(lender).withdraw(shares)).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
      const max = await pool.maxWithdrawable(lender.address);
      expect(max).to.equal(await pool.availableLiquidity());
      await pool.connect(lender).withdraw(await pool.convertToShares(max));
    });
  });

  describe("access control and safety", () => {
    it("only the LoanManager role can disburse, record repayments and losses", async () => {
      const { pool, outsider } = await loadFixture(deployAll);
      await expect(pool.connect(outsider).disburse(outsider.address, 1)).to.be.revertedWithCustomError(
        pool,
        "AccessControlUnauthorizedAccount"
      );
      await expect(pool.connect(outsider).recordRepayment(1, 1)).to.be.revertedWithCustomError(
        pool,
        "AccessControlUnauthorizedAccount"
      );
      await expect(pool.connect(outsider).recordLoss(1)).to.be.revertedWithCustomError(
        pool,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("recordRepayment refuses to book principal or interest the pool does not hold", async () => {
      const ctx = await loadFixture(deployAll);
      const { pool, admin, lender } = ctx;
      await pool.grantRole(role("LOAN_MANAGER_ROLE"), admin.address); // act as the manager for this test
      await lenderDeposit(ctx, lender, U(1000));
      // more principal repaid than is outstanding
      await expect(pool.connect(admin).recordRepayment(1, 1)).to.be.revertedWithCustomError(pool, "AccountingMismatch");
      // phantom interest: the implied reserve cut would exceed the pool's real balance
      await expect(pool.connect(admin).recordRepayment(0, U(100_000_000))).to.be.revertedWithCustomError(
        pool,
        "AccountingMismatch"
      );
    });

    it("pause blocks deposits but not withdrawals", async () => {
      const ctx = await loadFixture(deployAll);
      const { pool, admin, lender, outsider } = ctx;
      await lenderDeposit(ctx, lender, U(1000));
      await expect(pool.connect(outsider).pause()).to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
      await pool.connect(admin).pause();
      await expect(pool.connect(lender).deposit(U(10))).to.be.revertedWithCustomError(pool, "EnforcedPause");
      await pool.connect(lender).withdraw(U(100));
      await pool.connect(admin).unpause();
      await pool.connect(lender).deposit(U(10));
    });

    it("enforces the utilization cap", async () => {
      const ctx = await loadFixture(deployAll);
      const { pool, manager, lender, borrower, borrower2, admin } = ctx;
      await lenderDeposit(ctx, lender, U(1000));
      await pool.connect(admin).setMaxUtilizationBps(5000); // at most 500 may be lent
      await openActiveLoan(ctx, { who: borrower, score: 700, amount: U(400) });
      // second 400 loan would push utilization to 80% > 50%
      await giveScore(ctx, borrower2, 700);
      await manager.connect(borrower2).applyLoan(U(400), 30, ethers.id("x"));
      const id = await manager.openLoanOf(borrower2.address);
      await manager.connect(ctx.officer).approveLoan(id, U(400));
      await manager.connect(borrower2).depositCollateral(id);
      await expect(manager.connect(borrower2).disburse(id)).to.be.revertedWithCustomError(pool, "UtilizationTooHigh");
    });
  });

  describe("reserve and interest", () => {
    it("repayment grows lender value and diverts reserveBps of the interest to the reserve", async () => {
      const ctx = await loadFixture(deployAll);
      const { pool, manager, lender, borrower } = ctx;
      await lenderDeposit(ctx, lender, U(10_000));
      const id = await openActiveLoan(ctx, { who: borrower, score: 700, amount: U(500), termDays: 30 });
      const loan = await manager.getLoan(id);

      const valueBefore = await pool.assetsOf(lender.address);
      await time.increase(10 * DAY);
      await manager.connect(borrower).repay(id, U(1000));

      const interest = loan.interestTotal;
      const cut = (interest * 1000n) / 10_000n;
      expect(await pool.reserve()).to.equal(cut);
      expect(await pool.outstandingPrincipal()).to.equal(0n);
      expect((await pool.assetsOf(lender.address)) - valueBefore).to.be.closeTo(interest - cut, 10n);
      expect(await pool.totalInterestEarned()).to.equal(interest);
    });

    it("admin can fund the reserve; others cannot", async () => {
      const { pool, admin, outsider } = await loadFixture(deployAll);
      await expect(pool.connect(outsider).fundReserve(U(1))).to.be.revertedWithCustomError(
        pool,
        "AccessControlUnauthorizedAccount"
      );
      await expect(pool.connect(admin).fundReserve(U(250))).to.emit(pool, "ReserveFunded").withArgs(admin.address, U(250));
      expect(await pool.reserve()).to.equal(U(250));
      expect(await pool.lenderAssets()).to.equal(0n); // reserve is not lender money
      expect(await pool.availableLiquidity()).to.equal(0n);
    });

    it("validates reserve and utilization parameters", async () => {
      const { pool, admin } = await loadFixture(deployAll);
      await expect(pool.connect(admin).setReserveBps(6000)).to.be.revertedWithCustomError(pool, "InvalidBps");
      await expect(pool.connect(admin).setMaxUtilizationBps(0)).to.be.revertedWithCustomError(pool, "InvalidBps");
      await expect(pool.connect(admin).setMaxUtilizationBps(10_001)).to.be.revertedWithCustomError(pool, "InvalidBps");
    });
  });
});
