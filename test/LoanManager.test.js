const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  DAY,
  U,
  Status,
  interestOf,
  SCORE,
  deployAll,
  giveScore,
  lenderDeposit,
  openActiveLoan,
  time,
  ethers,
} = require("./helpers");

const PURPOSE = ethers.id("stall inventory");

async function fundedFixture() {
  const ctx = await deployAll();
  await lenderDeposit(ctx, ctx.lender, U(20_000));
  await lenderDeposit(ctx, ctx.lender2, U(10_000));
  return ctx;
}

describe("LoanManager", () => {
  describe("happy path: apply -> approve -> collateral -> disburse -> repay", () => {
    it("runs the full lifecycle and keeps all four contracts consistent", async () => {
      const ctx = await loadFixture(fundedFixture);
      const { manager, pool, vault, registry, usdc, officer, borrower } = ctx;
      await giveScore(ctx, borrower, SCORE.tier2);
      const bal0 = await usdc.balanceOf(borrower.address);
      const interest = interestOf(U(500), 1600, 30);
      const collateral = (U(500) * 500n) / 10_000n;

      await expect(manager.connect(borrower).applyLoan(U(500), 30, PURPOSE))
        .to.emit(manager, "LoanApplied")
        .withArgs(1, borrower.address, U(500), 30, PURPOSE);
      expect(await manager.openLoanOf(borrower.address)).to.equal(1);

      await expect(manager.connect(officer).approveLoan(1, U(500)))
        .to.emit(manager, "LoanApproved")
        .withArgs(1, borrower.address, U(500), 1600, collateral, interest, officer.address);

      await expect(manager.connect(borrower).depositCollateral(1))
        .to.emit(manager, "CollateralDeposited")
        .withArgs(1, borrower.address, collateral);
      expect(await vault.lockedAmount(1)).to.equal(collateral);
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(collateral);

      await expect(manager.connect(borrower).disburse(1)).to.emit(manager, "LoanDisbursed");
      expect(await usdc.balanceOf(borrower.address)).to.equal(bal0 - collateral + U(500));
      expect(await pool.outstandingPrincipal()).to.equal(U(500));
      expect((await manager.getLoan(1)).status).to.equal(Status.Active);

      // first, a partial repayment: interest is paid before principal
      await time.increase(10 * DAY);
      await expect(manager.connect(borrower).repay(1, U(100)))
        .to.emit(manager, "LoanRepaid")
        .withArgs(1, borrower.address, U(100), U(100) - interest, interest, U(500) + interest - U(100));
      const [pOwed, iOwed] = await manager.amountOwed(1);
      expect(iOwed).to.equal(0n);
      expect(pOwed).to.equal(U(400) + interest);

      // then the rest (overpayment is capped at what is owed)
      await expect(manager.connect(borrower).repay(1, U(1000)))
        .to.emit(manager, "LoanClosed")
        .withArgs(1, borrower.address, true);

      const loan = await manager.getLoan(1);
      expect(loan.status).to.equal(Status.Repaid);
      expect(await manager.openLoanOf(borrower.address)).to.equal(0);
      expect((await vault.positions(1)).status).to.equal(2); // Released
      expect(await vault.totalLocked()).to.equal(0n);
      expect(await usdc.balanceOf(borrower.address)).to.equal(bal0 - interest); // borrower paid exactly the interest
      expect(await pool.outstandingPrincipal()).to.equal(0n);
      const profile = await registry.getProfile(borrower.address);
      expect(profile.loansRepaid).to.equal(1);
      expect(profile.onTimeLoans).to.equal(1);
    });

    it("unscored borrowers get starter terms: 100 limit, 24% APR, 20% collateral", async () => {
      const { manager, officer, borrower } = await loadFixture(fundedFixture);
      await expect(manager.connect(borrower).applyLoan(U(101), 30, PURPOSE)).to.be.revertedWithCustomError(
        manager,
        "AmountOutOfRange"
      );
      await manager.connect(borrower).applyLoan(U(100), 30, PURPOSE);
      await expect(manager.connect(officer).approveLoan(1, U(100)))
        .to.emit(manager, "LoanApproved")
        .withArgs(1, borrower.address, U(100), 2400, U(20), interestOf(U(100), 2400, 30), officer.address);
    });

    it("tier 3 borrowers need no collateral", async () => {
      const ctx = await loadFixture(fundedFixture);
      const { manager, vault, usdc, borrower } = ctx;
      await giveScore(ctx, borrower, SCORE.tier3);
      await manager.connect(borrower).applyLoan(U(1500), 60, PURPOSE);
      await manager.connect(ctx.officer).approveLoan(1, U(1500));
      expect((await manager.getLoan(1)).collateralRequired).to.equal(0n);
      await expect(manager.connect(borrower).depositCollateral(1)).to.be.revertedWithCustomError(
        manager,
        "NoCollateralRequired"
      );
      const before = await usdc.balanceOf(borrower.address);
      await manager.connect(borrower).disburse(1);
      expect((await usdc.balanceOf(borrower.address)) - before).to.equal(U(1500));
      expect(await vault.totalLocked()).to.equal(0n);
    });

    it("late repayment inside the grace period is accepted but not counted as on-time", async () => {
      const ctx = await loadFixture(fundedFixture);
      const { manager, registry, borrower } = ctx;
      const id = await openActiveLoan(ctx, { who: borrower, score: SCORE.tier2, amount: U(300) });
      await time.increase(33 * DAY); // due at 30d, grace until 37d
      await expect(manager.connect(borrower).repay(id, U(1000)))
        .to.emit(manager, "LoanClosed")
        .withArgs(id, borrower.address, false);
      const p = await registry.getProfile(borrower.address);
      expect(p.lateLoans).to.equal(1);
      expect(p.onTimeLoans).to.equal(0);
      expect(p.bonus).to.equal(5);
    });
  });

  describe("progressive credit", () => {
    it("one on-time loan unlocks a bigger limit and less collateral without a new score", async () => {
      const ctx = await loadFixture(fundedFixture);
      const { manager, registry, officer, borrower } = ctx;
      // score 570 = tier 1 (max 300, 10% collateral)
      const id1 = await openActiveLoan(ctx, { who: borrower, score: 570, amount: U(100) });
      expect((await manager.getLoan(id1)).collateralRequired).to.equal(U(10));
      await time.increase(10 * DAY);
      await manager.connect(borrower).repay(id1, U(500));

      // history bonus +30 -> 600 -> tier 2 (max 800, 5% collateral, 16% APR)
      expect(await registry.effectiveScore(borrower.address)).to.equal(600);
      await expect(manager.connect(borrower).applyLoan(U(400), 30, PURPOSE)).to.not.be.reverted; // > old tier-1 limit
      const id2 = await manager.openLoanOf(borrower.address);
      await manager.connect(officer).approveLoan(id2, U(400));
      const l2 = await manager.getLoan(id2);
      expect(l2.tier).to.equal(2);
      expect(l2.aprBps).to.equal(1600);
      expect(l2.collateralRequired).to.equal(U(20));
    });
  });

  describe("validation and access control", () => {
    it("rejects bad terms and a second open loan", async () => {
      const { manager, borrower } = await loadFixture(fundedFixture);
      await expect(manager.connect(borrower).applyLoan(U(50), 6, PURPOSE)).to.be.revertedWithCustomError(
        manager,
        "InvalidTerm"
      );
      await expect(manager.connect(borrower).applyLoan(U(50), 181, PURPOSE)).to.be.revertedWithCustomError(
        manager,
        "InvalidTerm"
      );
      await expect(manager.connect(borrower).applyLoan(0, 30, PURPOSE)).to.be.revertedWithCustomError(
        manager,
        "AmountOutOfRange"
      );
      await manager.connect(borrower).applyLoan(U(50), 30, PURPOSE);
      await expect(manager.connect(borrower).applyLoan(U(50), 30, PURPOSE)).to.be.revertedWithCustomError(
        manager,
        "OpenLoanExists"
      );
    });

    it("blocked borrowers cannot apply", async () => {
      const { manager, registry, admin, borrower } = await loadFixture(fundedFixture);
      await registry.connect(admin).setBlocked(borrower.address, true);
      await expect(manager.connect(borrower).applyLoan(U(50), 30, PURPOSE)).to.be.revertedWithCustomError(
        manager,
        "BorrowerBlocked"
      );
    });

    it("only officers approve/reject; approvals can be smaller but never larger than requested", async () => {
      const { manager, outsider, officer, borrower } = await loadFixture(fundedFixture);
      await manager.connect(borrower).applyLoan(U(80), 30, PURPOSE);
      await expect(manager.connect(outsider).approveLoan(1, U(80))).to.be.revertedWithCustomError(
        manager,
        "AccessControlUnauthorizedAccount"
      );
      await expect(manager.connect(outsider).rejectLoan(1, PURPOSE)).to.be.revertedWithCustomError(
        manager,
        "AccessControlUnauthorizedAccount"
      );
      await expect(manager.connect(officer).approveLoan(1, U(81))).to.be.revertedWithCustomError(
        manager,
        "AmountOutOfRange"
      );
      await expect(manager.connect(officer).approveLoan(1, 0)).to.be.revertedWithCustomError(manager, "AmountOutOfRange");
      await manager.connect(officer).approveLoan(1, U(60));
      expect((await manager.getLoan(1)).principal).to.equal(U(60));
      await expect(manager.connect(officer).approveLoan(1, U(60))).to.be.revertedWithCustomError(
        manager,
        "InvalidStatus"
      );
    });

    it("officers cannot approve their own application", async () => {
      const { manager, officer } = await loadFixture(fundedFixture);
      await manager.connect(officer).applyLoan(U(50), 30, PURPOSE);
      await expect(manager.connect(officer).approveLoan(1, U(50))).to.be.revertedWithCustomError(manager, "SelfApproval");
    });

    it("rejection frees the borrower slot", async () => {
      const { manager, officer, borrower } = await loadFixture(fundedFixture);
      await manager.connect(borrower).applyLoan(U(50), 30, PURPOSE);
      await expect(manager.connect(officer).rejectLoan(1, ethers.id("insufficient data")))
        .to.emit(manager, "LoanRejected")
        .withArgs(1, borrower.address, ethers.id("insufficient data"), officer.address);
      expect((await manager.getLoan(1)).status).to.equal(Status.Rejected);
      expect(await manager.openLoanOf(borrower.address)).to.equal(0);
      await manager.connect(borrower).applyLoan(U(50), 30, PURPOSE); // can apply again
    });

    it("cancelling after posting collateral refunds it", async () => {
      const { manager, vault, usdc, officer, borrower } = await loadFixture(fundedFixture);
      await manager.connect(borrower).applyLoan(U(100), 30, PURPOSE);
      await manager.connect(officer).approveLoan(1, U(100));
      const before = await usdc.balanceOf(borrower.address);
      await manager.connect(borrower).depositCollateral(1);
      await expect(manager.connect(borrower).depositCollateral(1)).to.be.revertedWithCustomError(
        manager,
        "CollateralAlreadyPosted"
      );
      await manager.connect(borrower).cancelLoan(1);
      expect(await usdc.balanceOf(borrower.address)).to.equal(before);
      expect(await vault.totalLocked()).to.equal(0n);
      expect((await manager.getLoan(1)).status).to.equal(Status.Cancelled);
    });

    it("cancel is borrower-only", async () => {
      const { manager, outsider, borrower } = await loadFixture(fundedFixture);
      await manager.connect(borrower).applyLoan(U(50), 30, PURPOSE);
      await expect(manager.connect(outsider).cancelLoan(1)).to.be.revertedWithCustomError(manager, "NotBorrower");
    });

    it("disburse needs collateral and an authorised caller; officers may disburse for the borrower", async () => {
      const { manager, usdc, officer, outsider, borrower } = await loadFixture(fundedFixture);
      await manager.connect(borrower).applyLoan(U(100), 30, PURPOSE);
      await manager.connect(officer).approveLoan(1, U(100));
      await expect(manager.connect(borrower).disburse(1)).to.be.revertedWithCustomError(manager, "CollateralMissing");
      await manager.connect(borrower).depositCollateral(1);
      await expect(manager.connect(outsider).disburse(1)).to.be.revertedWithCustomError(manager, "NotAuthorized");
      const before = await usdc.balanceOf(borrower.address);
      await manager.connect(officer).disburse(1);
      expect((await usdc.balanceOf(borrower.address)) - before).to.equal(U(100));
    });

    it("approvals expire after 7 days but can still be cancelled", async () => {
      const { manager, officer, borrower } = await loadFixture(fundedFixture);
      await manager.connect(borrower).applyLoan(U(100), 30, PURPOSE);
      await manager.connect(officer).approveLoan(1, U(100));
      await time.increase(8 * DAY);
      await expect(manager.connect(borrower).depositCollateral(1)).to.be.revertedWithCustomError(
        manager,
        "ApprovalExpired"
      );
      await expect(manager.connect(borrower).disburse(1)).to.be.revertedWithCustomError(manager, "ApprovalExpired");
      await manager.connect(borrower).cancelLoan(1);
    });

    it("only the borrower can repay, amounts must be positive, and only active loans can be repaid", async () => {
      const ctx = await loadFixture(fundedFixture);
      const { manager, outsider, borrower } = ctx;
      await manager.connect(borrower).applyLoan(U(50), 30, PURPOSE);
      await expect(manager.connect(borrower).repay(1, U(1))).to.be.revertedWithCustomError(manager, "InvalidStatus");
      await manager.connect(borrower).cancelLoan(1);
      const id = await openActiveLoan(ctx, { who: borrower, score: SCORE.tier2, amount: U(100) });
      await expect(manager.connect(outsider).repay(id, U(1))).to.be.revertedWithCustomError(manager, "NotBorrower");
      await expect(manager.connect(borrower).repay(id, 0)).to.be.revertedWithCustomError(manager, "ZeroAmount");
    });

    it("unknown loan ids revert", async () => {
      const { manager, borrower } = await loadFixture(fundedFixture);
      await expect(manager.getLoan(99)).to.be.revertedWithCustomError(manager, "UnknownLoan");
      await expect(manager.connect(borrower).cancelLoan(99)).to.be.revertedWithCustomError(manager, "UnknownLoan");
    });
  });

  describe("pausing", () => {
    it("pause stops new business but never blocks repayment", async () => {
      const ctx = await loadFixture(fundedFixture);
      const { manager, admin, outsider, borrower, borrower2 } = ctx;
      const id = await openActiveLoan(ctx, { who: borrower, score: SCORE.tier2, amount: U(100) });
      await expect(manager.connect(outsider).pause()).to.be.revertedWithCustomError(
        manager,
        "AccessControlUnauthorizedAccount"
      );
      await manager.connect(admin).pause();
      await expect(manager.connect(borrower2).applyLoan(U(50), 30, PURPOSE)).to.be.revertedWithCustomError(
        manager,
        "EnforcedPause"
      );
      await manager.connect(borrower).repay(id, U(1000)); // still works
      expect((await manager.getLoan(id)).status).to.equal(Status.Repaid);
      await manager.connect(admin).unpause();
      await manager.connect(borrower2).applyLoan(U(50), 30, PURPOSE);
    });
  });

  describe("audit trail", () => {
    it("auditors can attach notes to existing loans; nobody else can", async () => {
      const { manager, auditor, officer, borrower } = await loadFixture(fundedFixture);
      await manager.connect(borrower).applyLoan(U(50), 30, PURPOSE);
      const note = ethers.id("KYC document hash #1");
      await expect(manager.connect(auditor).addAuditNote(1, note))
        .to.emit(manager, "AuditNoteAdded")
        .withArgs(1, auditor.address, note);
      expect(await manager.auditNoteCount(1)).to.equal(1);
      await expect(manager.connect(officer).addAuditNote(1, note)).to.be.revertedWithCustomError(
        manager,
        "AccessControlUnauthorizedAccount"
      );
      await expect(manager.connect(auditor).addAuditNote(7, note)).to.be.revertedWithCustomError(manager, "UnknownLoan");
    });
  });

  describe("default and the loss waterfall (collateral -> reserve -> lenders)", () => {
    it("cannot be declared before due + grace; afterwards anyone can do it", async () => {
      const ctx = await loadFixture(fundedFixture);
      const { manager, outsider, borrower } = ctx;
      const id = await openActiveLoan(ctx, { who: borrower, score: SCORE.tier1, amount: U(200) });
      expect(await manager.isDefaultable(id)).to.equal(false);
      await time.increase(36 * DAY); // grace ends at 37d
      await expect(manager.connect(outsider).markDefault(id)).to.be.revertedWithCustomError(manager, "NotDefaultable");
      // the borrower can still cure while the loan is only late
      await time.increase(3 * DAY);
      expect(await manager.isDefaultable(id)).to.equal(true);
      await manager.connect(outsider).markDefault(id);
      expect((await manager.getLoan(id)).status).to.equal(Status.Defaulted);
      await expect(manager.connect(borrower).repay(id, U(1))).to.be.revertedWithCustomError(manager, "InvalidStatus");
      await expect(manager.connect(outsider).markDefault(id)).to.be.revertedWithCustomError(manager, "InvalidStatus");
    });

    it("collateral first, then reserve, then lenders share the remaining loss", async () => {
      const ctx = await loadFixture(fundedFixture);
      const { manager, pool, vault, registry, usdc, admin, outsider, borrower } = ctx;
      await pool.connect(admin).fundReserve(U(100));
      const id = await openActiveLoan(ctx, { who: borrower, score: SCORE.tier1, amount: U(300) }); // 10% collateral = 30
      const interest = interestOf(U(300), 2000, 30);
      const collateral = U(30);

      const la0 = await pool.lenderAssets();
      const reserve0 = await pool.reserve();
      const price0 = await pool.sharePrice();
      const borrowerBal = await usdc.balanceOf(borrower.address);

      await time.increase(40 * DAY);

      // expected waterfall
      const recovered = collateral; // 30 < 300 + interest owed, all of it is seized
      const toInterest = recovered < interest ? recovered : interest;
      const toPrincipal = recovered - toInterest;
      const cut = (toInterest * 1000n) / 10_000n;
      const principalLoss = U(300) - toPrincipal;
      const reserveAvail = reserve0 + cut;
      const reserveCovered = principalLoss < reserveAvail ? principalLoss : reserveAvail;
      const lenderLoss = principalLoss - reserveCovered;
      expect(lenderLoss).to.be.gt(0n); // the scenario is meant to hurt lenders

      await expect(manager.connect(outsider).markDefault(id))
        .to.emit(manager, "LoanDefaulted")
        .withArgs(id, borrower.address, recovered, principalLoss, reserveCovered);

      expect(await pool.outstandingPrincipal()).to.equal(0n);
      expect(await pool.reserve()).to.equal(reserveAvail - reserveCovered);
      expect(await pool.totalLosses()).to.equal(principalLoss);
      // lender value change = recovered - cut + reserveCovered - principal that was outstanding
      expect(await pool.lenderAssets()).to.equal(la0 + recovered - cut + reserveCovered - U(300));
      expect(await pool.sharePrice()).to.be.lt(price0);

      expect((await vault.positions(id)).status).to.equal(3); // Seized
      expect(await vault.totalLocked()).to.equal(0n);
      expect(await usdc.balanceOf(borrower.address)).to.equal(borrowerBal); // nothing is returned

      const p = await registry.getProfile(borrower.address);
      expect(p.loansDefaulted).to.equal(1);
      expect(p.bonus).to.equal(0);
      expect(p.blocked).to.equal(true);
      await expect(manager.connect(borrower).applyLoan(U(50), 30, PURPOSE)).to.be.revertedWithCustomError(
        manager,
        "BorrowerBlocked"
      );
    });

    it("surplus collateral goes back to the borrower after a partly repaid loan defaults", async () => {
      const ctx = await loadFixture(fundedFixture);
      const { manager, pool, usdc, outsider, borrower } = ctx;
      const id = await openActiveLoan(ctx, { who: borrower, score: SCORE.tier1, amount: U(300) }); // collateral 30
      const interest = interestOf(U(300), 2000, 30);
      await manager.connect(borrower).repay(id, U(290));
      const balAfterRepay = await usdc.balanceOf(borrower.address);

      const remaining = U(300) + interest - U(290); // principal still owed (interest already paid)
      const surplus = U(30) - remaining;

      await time.increase(40 * DAY);
      await expect(manager.connect(outsider).markDefault(id))
        .to.emit(manager, "LoanDefaulted")
        .withArgs(id, borrower.address, remaining, 0, 0);

      expect(await usdc.balanceOf(borrower.address)).to.equal(balAfterRepay + surplus);
      expect(await pool.outstandingPrincipal()).to.equal(0n);
      expect(await pool.totalLosses()).to.equal(0n); // lenders lose nothing
    });

    it("an uncollateralised tier-3 default is absorbed by the reserve first", async () => {
      const ctx = await loadFixture(fundedFixture);
      const { manager, pool, admin, outsider, borrower } = ctx;
      await pool.connect(admin).fundReserve(U(100));
      const id = await openActiveLoan(ctx, { who: borrower, score: SCORE.tier3, amount: U(1000) });
      const la0 = await pool.lenderAssets();
      await time.increase(40 * DAY);
      await expect(manager.connect(outsider).markDefault(id))
        .to.emit(manager, "LoanDefaulted")
        .withArgs(id, borrower.address, 0, U(1000), U(100));
      expect(await pool.reserve()).to.equal(0n);
      expect(await pool.lenderAssets()).to.equal(la0 - U(900)); // lenders absorb the 900 beyond the reserve
    });
  });

  describe("bookkeeping invariants", () => {
    it("vault balance equals totalLocked and pool balance equals reserve + lender cash across many loans", async () => {
      const ctx = await loadFixture(fundedFixture);
      const { manager, pool, vault, usdc, borrower, borrower2 } = ctx;
      const a = await openActiveLoan(ctx, { who: borrower, score: SCORE.tier1, amount: U(250) });
      await openActiveLoan(ctx, { who: borrower2, score: SCORE.tier2, amount: U(600) });
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(await vault.totalLocked());

      await time.increase(15 * DAY);
      await manager.connect(borrower).repay(a, U(100));
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(await vault.totalLocked());
      expect(await usdc.balanceOf(await pool.getAddress())).to.equal(
        (await pool.reserve()) + (await pool.lenderAssets()) - (await pool.outstandingPrincipal())
      );
    });
  });
});
