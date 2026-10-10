const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { U, deployAll, time } = require("./helpers");

describe("MockStablecoin (test token)", () => {
  it("has 6 decimals and only the owner can mint", async () => {
    const { usdc, admin, outsider } = await loadFixture(deployAll);
    expect(await usdc.decimals()).to.equal(6);
    await usdc.connect(admin).mint(outsider.address, U(5));
    expect(await usdc.balanceOf(outsider.address)).to.equal(U(5));
    await expect(usdc.connect(outsider).mint(outsider.address, U(1)))
      .to.be.revertedWithCustomError(usdc, "OwnableUnauthorizedAccount")
      .withArgs(outsider.address);
  });

  it("faucet pays 1,000 mUSDC and enforces a one-hour cooldown per wallet", async () => {
    const { usdc, outsider, borrower } = await loadFixture(deployAll);
    const before = await usdc.balanceOf(outsider.address);
    await usdc.connect(outsider).faucet();
    expect((await usdc.balanceOf(outsider.address)) - before).to.equal(U(1000));

    await expect(usdc.connect(outsider).faucet()).to.be.revertedWithCustomError(usdc, "FaucetCooldown");
    await expect(usdc.connect(borrower).faucet()).to.not.be.reverted;

    await time.increase(3600);
    await expect(usdc.connect(outsider).faucet()).to.not.be.reverted;
    expect((await usdc.balanceOf(outsider.address)) - before).to.equal(U(2000));
  });
});
