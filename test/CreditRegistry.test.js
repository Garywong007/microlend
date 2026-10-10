const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { DAY, U, role, deployAll, giveScore, time, ethers, SCORE, interestOf, openActiveLoan, lenderDeposit } = require("./helpers");

describe("CreditRegistry", () => {
  it("treats unscored wallets as tier 0 (starter terms)", async () => {
    const { registry, borrower } = await loadFixture(deployAll);
    const t = await registry.getTerms(borrower.address);
    expect(t.tier).to.equal(0);
    expect(t.maxAmount).to.equal(U(100));
    expect(t.aprBps).to.equal(2400);
    expect(t.collateralBps).to.equal(2000);
    expect(t.blocked).to.equal(false);
  });

  it("maps attested scores to the right tiers", async () => {
    const ctx = await loadFixture(deployAll);
    const { registry, borrower } = ctx;
    const cases = [
      [449, 0],
      [450, 1],
      [599, 1],
      [600, 2],
      [749, 2],
      [750, 3],
      [1000, 3],
    ];
    for (const [score, tier] of cases) {
      await giveScore(ctx, borrower, score);
      expect((await registry.getTerms(borrower.address)).tier, `score ${score}`).to.equal(tier);
    }
  });

  it("only SCORER_ROLE can submit scores directly", async () => {
    const { registry, outsider, borrower } = await loadFixture(deployAll);
    const exp = (await time.latest()) + 30 * DAY;
    await expect(
      registry.connect(outsider).updateScore(borrower.address, 700, ethers.id("m"), exp)
    ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
  });

  it("rejects out-of-range scores and bad expiries", async () => {
    const { registry, scorer, borrower } = await loadFixture(deployAll);
    const now = await time.latest();
    await expect(
      registry.connect(scorer).updateScore(borrower.address, 1001, ethers.id("m"), now + DAY)
    ).to.be.revertedWithCustomError(registry, "ScoreOutOfRange");
    await expect(
      registry.connect(scorer).updateScore(borrower.address, 700, ethers.id("m"), now - 1)
    ).to.be.revertedWithCustomError(registry, "InvalidExpiry");
    await expect(
      registry.connect(scorer).updateScore(borrower.address, 700, ethers.id("m"), now + 400 * DAY)
    ).to.be.revertedWithCustomError(registry, "InvalidExpiry");
  });

  it("falls back to tier 0 once the attestation expires", async () => {
    const ctx = await loadFixture(deployAll);
    await giveScore(ctx, ctx.borrower, 800, 10);
    expect((await ctx.registry.getTerms(ctx.borrower.address)).tier).to.equal(3);
    await time.increase(11 * DAY);
    expect((await ctx.registry.getTerms(ctx.borrower.address)).tier).to.equal(0);
  });

  describe("EIP-712 signed attestations", () => {
    async function sign(ctx, signer, borrower, score, expiresAt, nonce) {
      const { chainId } = await ethers.provider.getNetwork();
      const domain = {
        name: "MicroLend CreditRegistry",
        version: "1",
        chainId,
        verifyingContract: await ctx.registry.getAddress(),
      };
      const types = {
        Score: [
          { name: "borrower", type: "address" },
          { name: "score", type: "uint16" },
          { name: "modelHash", type: "bytes32" },
          { name: "expiresAt", type: "uint64" },
          { name: "nonce", type: "uint256" },
        ],
      };
      const modelHash = ethers.id("model-v1");
      const sig = await signer.signTypedData(domain, types, { borrower: borrower.address, score, modelHash, expiresAt, nonce });
      return { modelHash, sig };
    }

    it("accepts a scorer signature submitted by the borrower and consumes the nonce", async () => {
      const ctx = await loadFixture(deployAll);
      const { registry, scorer, borrower } = ctx;
      const exp = (await time.latest()) + 60 * DAY;
      const nonce = await registry.nonces(borrower.address);
      const { modelHash, sig } = await sign(ctx, scorer, borrower, 710, exp, nonce);

      await expect(registry.connect(borrower).updateScoreWithSignature(borrower.address, 710, modelHash, exp, sig))
        .to.emit(registry, "ScoreUpdated")
        .withArgs(borrower.address, 710, modelHash, exp, scorer.address);
      expect(await registry.nonces(borrower.address)).to.equal(nonce + 1n);
      expect((await registry.getTerms(borrower.address)).tier).to.equal(2);
    });

    it("cannot be replayed", async () => {
      const ctx = await loadFixture(deployAll);
      const { registry, scorer, borrower } = ctx;
      const exp = (await time.latest()) + 60 * DAY;
      const { modelHash, sig } = await sign(ctx, scorer, borrower, 710, exp, await registry.nonces(borrower.address));
      await registry.connect(borrower).updateScoreWithSignature(borrower.address, 710, modelHash, exp, sig);
      await expect(
        registry.connect(borrower).updateScoreWithSignature(borrower.address, 710, modelHash, exp, sig)
      ).to.be.revertedWithCustomError(registry, "InvalidSigner");
    });

    it("rejects signatures from wallets without SCORER_ROLE and tampered scores", async () => {
      const ctx = await loadFixture(deployAll);
      const { registry, scorer, outsider, borrower } = ctx;
      const exp = (await time.latest()) + 60 * DAY;
      const nonce = await registry.nonces(borrower.address);

      const bad = await sign(ctx, outsider, borrower, 900, exp, nonce);
      await expect(
        registry.connect(borrower).updateScoreWithSignature(borrower.address, 900, bad.modelHash, exp, bad.sig)
      ).to.be.revertedWithCustomError(registry, "InvalidSigner");

      const good = await sign(ctx, scorer, borrower, 500, exp, nonce);
      // borrower tries to bump 500 -> 900 after the scorer signed
      await expect(
        registry.connect(borrower).updateScoreWithSignature(borrower.address, 900, good.modelHash, exp, good.sig)
      ).to.be.revertedWithCustomError(registry, "InvalidSigner");
    });
  });

  describe("history bonus (progressive credit)", () => {
    it("on-time repayment raises the effective score and is written to the profile", async () => {
      const ctx = await loadFixture(deployAll);
      const { registry, borrower, manager, lender } = ctx;
      await lenderDeposit(ctx, lender, U(10_000));

      const id = await openActiveLoan(ctx, { who: borrower, score: 600, amount: U(200), termDays: 30 });
      await time.increase(20 * DAY);
      await manager.connect(borrower).repay(id, U(300)); // capped at the amount owed
      const p = await registry.getProfile(borrower.address);
      expect(p.loansRepaid).to.equal(1);
      expect(p.onTimeLoans).to.equal(1);
      expect(p.bonus).to.equal(30);
      expect(await registry.effectiveScore(borrower.address)).to.equal(630);
      expect(p.totalRepaid).to.equal(U(200) + interestOf(U(200), 1600, 30));
    });

    it("only the LoanManager may write loan outcomes", async () => {
      const { registry, outsider, borrower } = await loadFixture(deployAll);
      await expect(
        registry.connect(outsider).recordLoanClosed(borrower.address, 1, 1, true, false)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });

  describe("admin controls", () => {
    it("admin can block / unblock a borrower", async () => {
      const { registry, admin, outsider, borrower } = await loadFixture(deployAll);
      await expect(registry.connect(outsider).setBlocked(borrower.address, true)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount"
      );
      await registry.connect(admin).setBlocked(borrower.address, true);
      expect((await registry.getTerms(borrower.address)).blocked).to.equal(true);
      await registry.connect(admin).setBlocked(borrower.address, false);
      expect((await registry.getTerms(borrower.address)).blocked).to.equal(false);
    });

    it("admin can retune tiers but not break their ordering", async () => {
      const { registry, admin } = await loadFixture(deployAll);
      await registry.connect(admin).setTier(2, 620, U(900), 1500, 400);
      expect((await registry.getTier(2)).maxAmount).to.equal(U(900));
      await expect(registry.connect(admin).setTier(2, 440, U(900), 1500, 400)).to.be.revertedWithCustomError(
        registry,
        "InvalidTierConfig"
      ); // must stay above tier 1
      await expect(registry.connect(admin).setTier(0, 10, U(100), 2400, 2000)).to.be.revertedWithCustomError(
        registry,
        "InvalidTierConfig"
      ); // tier 0 starts at 0
      await expect(registry.connect(admin).setTier(4, 900, U(1), 1, 1)).to.be.revertedWithCustomError(
        registry,
        "InvalidTierConfig"
      );
    });
  });
});
