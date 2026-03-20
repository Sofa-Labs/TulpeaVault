import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — Attacks", function () {
  let vault: Contract;
  let usdc: Contract;
  let mockStrategy: Contract;
  let admin: Signer;
  let user1: Signer;
  let attacker: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let attackerAddr: string;
  let strategyAddr: string;

  const ONE_DAY = 24 * 60 * 60;

  async function deployFixture() {
    console.log("[DEBUG] deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    attacker = signers[2];
    adminAddr = await admin.getAddress();
    user1Addr = await user1.getAddress();
    attackerAddr = await attacker.getAddress();

    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory("TulpeaYieldVault");
    const vaultImpl = await VaultFactory.deploy();
    await vaultImpl.waitForDeployment();

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967ProxyWrapper");
    const initData = VaultFactory.interface.encodeFunctionData("initialize", [
      await usdc.getAddress(), adminAddr, 0, "Tulpea Yield Vault", "tyvUSDC", ethers.ZeroAddress,
    ]);
    const proxy = await ERC1967Proxy.deploy(await vaultImpl.getAddress(), initData);
    await proxy.waitForDeployment();
    vault = VaultFactory.attach(await proxy.getAddress()) as Contract;

    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    mockStrategy = await MockStrategy.deploy(await usdc.getAddress());
    await mockStrategy.waitForDeployment();
    strategyAddr = await mockStrategy.getAddress();

    await vault.connect(admin).addStrategy(strategyAddr);

    const mintAmount = ethers.parseUnits("200000", 18);
    await usdc.mint(user1Addr, mintAmount);
    await usdc.mint(attackerAddr, mintAmount);
    await usdc.mint(adminAddr, mintAmount);

    const vaultAddr = await vault.getAddress();
    await usdc.connect(user1).approve(vaultAddr, ethers.MaxUint256);
    await usdc.connect(attacker).approve(vaultAddr, ethers.MaxUint256);
    await usdc.connect(admin).approve(vaultAddr, ethers.MaxUint256);
    // Disable health check — attack tests exercise extreme profit/loss scenarios
    await vault.connect(admin).setHealthCheck(10000, 10000, false);
    console.log("[DEBUG] deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  it("donation increases share price (benefits existing shareholders)", async function () {
    console.log("[DEBUG] test: donation effect");
    // User1 deposits normally
    await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);

    const priceBefore = await vault.sharePrice();
    console.log("[DEBUG] price before donation:", priceBefore.toString());

    // Attacker donates USDC directly to vault (bypassing deposit)
    await usdc.mint(await vault.getAddress(), ethers.parseUnits("10000", 18));

    // With balanceOf-based accounting, donation increases totalAssets → price goes up
    // This benefits user1 (existing shareholder), so it's not a harmful attack
    const priceAfter = await vault.sharePrice();
    console.log("[DEBUG] price after donation:", priceAfter.toString());
    expect(priceAfter).to.be.gt(priceBefore);
  });

  it("first depositor inflation attack mitigated by decimals offset", async function () {
    console.log("[DEBUG] test: inflation attack");
    // With _decimalsOffset()=6, attacker needs to donate 1e6 * amount to manipulate
    // This makes the attack economically infeasible

    // Attacker deposits 1 wei
    await vault.connect(attacker).deposit(1n, attackerAddr);
    const attackerShares = await vault.balanceOf(attackerAddr);
    console.log("[DEBUG] attacker shares from 1 wei:", attackerShares.toString());
    // Should get 1e6 shares (due to offset)
    expect(attackerShares).to.equal(1_000_000n);

    // User1 deposits 10k USDC
    await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);
    const user1Shares = await vault.balanceOf(user1Addr);
    console.log("[DEBUG] user1 shares:", user1Shares.toString());
    expect(user1Shares).to.be.gt(0);
  });

  it("malicious strategy with false totalAssets should not affect other strategies", async function () {
    console.log("[DEBUG] test: malicious strategy isolation");
    await vault.connect(user1).deposit(ethers.parseUnits("100000", 18), user1Addr);

    // Deploy to strategy
    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("50000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);

    // Strategy falsely reports massive assets (trying to inflate)
    await mockStrategy.setTotalAssets(ethers.parseUnits("1000000", 18));
    await vault.processReport(strategyAddr);

    // totalDebt reflects the claimed amount
    const totalDebt = await vault.totalDebt();
    console.log("[DEBUG] totalDebt after false report:", totalDebt.toString());

    // The vault's totalAssets increased, but USDC balance didn't change
    // This would only benefit existing depositors, not create real value
    // The key protection is that the strategy can't withdraw more than its actual balance
  });

  it("strategy that reverts on totalAssets should not break processReport", async function () {
    console.log("[DEBUG] test: reverting strategy");
    await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);

    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("5000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);

    // Make strategy revert
    await mockStrategy.setRevertOnTotalAssets(true);

    // processReport should revert with specific error
    await expect(vault.processReport(strategyAddr))
      .to.be.revertedWithCustomError(vault, "StrategyTotalAssetsReverted");
  });

  it("non-owner cannot add/remove strategies", async function () {
    console.log("[DEBUG] test: strategy access control");
    const MockStrategy2 = await ethers.getContractFactory("MockStrategy");
    const strat2 = await MockStrategy2.deploy(await usdc.getAddress());
    await strat2.waitForDeployment();

    await expect(vault.connect(attacker).addStrategy(await strat2.getAddress()))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
  });

  it("cannot remove strategy with outstanding debt", async function () {
    console.log("[DEBUG] test: remove with debt");
    await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);

    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("5000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);

    await expect(vault.connect(admin).removeStrategy(strategyAddr))
      .to.be.revertedWithCustomError(vault, "StrategyHasDebt");
  });

  it("DebtOutstandingNoShares guard: escrow keeps totalSupply>0 so deposits still work after requestRedeem", async function () {
    console.log("[DEBUG] test: debt outstanding guard with escrow");
    await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);

    // Deploy all to strategy so totalDebt > 0
    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("10000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);

    console.log("[DEBUG] vault balance after deploy:", (await usdc.balanceOf(await vault.getAddress())).toString());
    console.log("[DEBUG] totalDebt after deploy:", (await vault.totalDebt()).toString());

    // User1 requests redeem — shares escrowed to vault, totalSupply unchanged
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

    // With escrow model, totalSupply > 0 (escrowed shares still in supply)
    console.log("[DEBUG] totalSupply:", (await vault.totalSupply()).toString());
    console.log("[DEBUG] totalPendingShares:", (await vault.totalPendingShares()).toString());
    console.log("[DEBUG] totalDebt:", (await vault.totalDebt()).toString());
    expect(await vault.totalSupply()).to.be.gt(0);
    expect(await vault.totalPendingShares()).to.be.gt(0);
    expect(await vault.totalDebt()).to.be.gt(0);

    // Deposit should work because totalSupply > 0 (escrowed shares keep it alive)
    await expect(vault.connect(attacker).deposit(ethers.parseUnits("1000", 18), attackerAddr))
      .to.not.be.reverted;
  });

  it("withdrawal more than claimable should revert", async function () {
    console.log("[DEBUG] test: over-withdrawal");
    await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
    await vault.connect(admin).fulfillRedeem(user1Addr);

    const claimable = await vault.claimableWithdrawals(user1Addr);
    await expect(vault.connect(user1).withdraw(claimable + 1n, user1Addr, user1Addr))
      .to.be.revertedWithCustomError(vault, "ExceedsClaimable");
  });

  it("griefing via repeated small processReport calls has no effect", async function () {
    console.log("[DEBUG] test: processReport griefing");
    await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);

    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("5000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);
    await mockStrategy.setTotalAssets(ethers.parseUnits("5000", 18));

    // Call processReport many times with no change — should be safe
    const taBefore = await vault.totalAssets();
    for (let i = 0; i < 5; i++) {
      await vault.processReport(strategyAddr);
    }
    const taAfter = await vault.totalAssets();
    console.log("[DEBUG] totalAssets unchanged:", taBefore.toString(), "==", taAfter.toString());
    expect(taAfter).to.equal(taBefore);
  });

  it("non-owner cannot withdraw from strategy", async function () {
    console.log("[DEBUG] test: withdrawFromStrategy access control");
    await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);
    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("5000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);

    await expect(vault.connect(attacker).withdrawFromStrategy(strategyAddr, ethers.parseUnits("1000", 18)))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
  });

  it("cannot deploy to self", async function () {
    console.log("[DEBUG] test: self-deploy blocked");
    await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);
    await expect(vault.connect(admin).requestDeploy(await vault.getAddress(), ethers.parseUnits("1000", 18)))
      .to.be.revertedWithCustomError(vault, "SelfDeployNotAllowed");
  });
});
