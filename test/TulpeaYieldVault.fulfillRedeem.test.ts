import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — fulfillRedeem", function () {
  let vault: Contract;
  let usdc: Contract;
  let admin: Signer;
  let user1: Signer;
  let user2: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let user2Addr: string;

  async function deployFixture() {
    console.log("[DEBUG] deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    user2 = signers[2];
    adminAddr = await admin.getAddress();
    user1Addr = await user1.getAddress();
    user2Addr = await user2.getAddress();

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

    const mintAmount = ethers.parseUnits("100000", 18);
    await usdc.mint(user1Addr, mintAmount);
    await usdc.mint(user2Addr, mintAmount);

    const vaultAddr = await vault.getAddress();
    await usdc.connect(user1).approve(vaultAddr, ethers.MaxUint256);
    await usdc.connect(user2).approve(vaultAddr, ethers.MaxUint256);

    // Deposits
    await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);
    await vault.connect(user2).deposit(ethers.parseUnits("20000", 18), user2Addr);
    // Disable health check — fulfillRedeem tests exercise large losses for loss socialization
    await vault.connect(admin).setHealthCheck(10000, 10000, false);
    console.log("[DEBUG] deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  it("should move pending to claimable", async function () {
    console.log("[DEBUG] test: fulfillRedeem");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

    const pendingEstimate = await vault.convertToAssets(await vault.pendingRedeemRequest(0, user1Addr));
    await vault.connect(admin).fulfillRedeem(user1Addr);

    expect(await vault.pendingWithdrawalShares(user1Addr)).to.equal(0);
    expect(await vault.claimableWithdrawals(user1Addr)).to.equal(pendingEstimate);
    console.log("[DEBUG] claimable:", pendingEstimate.toString());
  });

  it("should emit RedeemFulfilled event", async function () {
    console.log("[DEBUG] test: RedeemFulfilled event");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
    const pendingEstimate = await vault.convertToAssets(await vault.pendingRedeemRequest(0, user1Addr));

    await expect(vault.connect(admin).fulfillRedeem(user1Addr))
      .to.emit(vault, "RedeemFulfilled")
      .withArgs(user1Addr, pendingEstimate);
  });

  it("should update totalPendingShares and totalClaimableWithdrawals", async function () {
    console.log("[DEBUG] test: totals update");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

    const pendingEstimate = await vault.convertToAssets(await vault.pendingRedeemRequest(0, user1Addr));
    await vault.connect(admin).fulfillRedeem(user1Addr);

    expect(await vault.totalPendingShares()).to.equal(0);
    expect(await vault.totalClaimableWithdrawals()).to.equal(pendingEstimate);
  });

  it("should track claimable shares", async function () {
    console.log("[DEBUG] test: claimable shares");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
    await vault.connect(admin).fulfillRedeem(user1Addr);

    const claimShares = await vault.claimableWithdrawalShares(user1Addr);
    console.log("[DEBUG] claimable shares:", claimShares.toString());
    expect(claimShares).to.equal(shares);
  });

  it("should reject if nothing pending", async function () {
    console.log("[DEBUG] test: nothing pending");
    await expect(vault.connect(admin).fulfillRedeem(user1Addr))
      .to.be.revertedWithCustomError(vault, "NothingPending");
  });

  it("should reject non-owner", async function () {
    console.log("[DEBUG] test: non-owner fulfill");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
    await expect(vault.connect(user1).fulfillRedeem(user1Addr))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
  });

  it("should reject if insufficient idle balance", async function () {
    console.log("[DEBUG] test: insufficient idle");
    const ONE_DAY = 24 * 60 * 60;

    // Deploy a strategy and send most funds out
    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    const strat = await MockStrategy.deploy(await usdc.getAddress());
    await strat.waitForDeployment();
    const stratAddr = await strat.getAddress();
    await vault.connect(admin).addStrategy(stratAddr);

    // Deploy 25k out (leaving 5k idle)
    await vault.connect(admin).requestDeploy(stratAddr, ethers.parseUnits("25000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);

    // User1 requests full 10k redeem
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

    // Only ~5k idle but need 10k
    await expect(vault.connect(admin).fulfillRedeem(user1Addr))
      .to.be.revertedWithCustomError(vault, "InsufficientIdleBalance");
  });

  it("should fulfill multiple users", async function () {
    console.log("[DEBUG] test: multi-user fulfill");
    const shares1 = await vault.balanceOf(user1Addr);
    const shares2 = await vault.balanceOf(user2Addr);

    await vault.connect(user1).requestRedeem(shares1, user1Addr, user1Addr);
    await vault.connect(user2).requestRedeem(shares2, user2Addr, user2Addr);

    await vault.connect(admin).fulfillRedeem(user1Addr);
    await vault.connect(admin).fulfillRedeem(user2Addr);

    expect(await vault.totalPendingShares()).to.equal(0);
    const c1 = await vault.claimableWithdrawals(user1Addr);
    const c2 = await vault.claimableWithdrawals(user2Addr);
    console.log("[DEBUG] claimable1:", c1.toString(), "claimable2:", c2.toString());
    expect(c1).to.be.gt(0);
    expect(c2).to.be.gt(0);
  });

  it("should return correct maxRedeem after fulfill", async function () {
    console.log("[DEBUG] test: maxRedeem after fulfill");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
    await vault.connect(admin).fulfillRedeem(user1Addr);

    const maxR = await vault.maxRedeem(user1Addr);
    console.log("[DEBUG] maxRedeem:", maxR.toString());
    expect(maxR).to.equal(shares);
  });

  it("should return correct maxWithdraw after fulfill", async function () {
    console.log("[DEBUG] test: maxWithdraw after fulfill");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

    const pendingEstimate = await vault.convertToAssets(await vault.pendingRedeemRequest(0, user1Addr));
    await vault.connect(admin).fulfillRedeem(user1Addr);

    const maxW = await vault.maxWithdraw(user1Addr);
    console.log("[DEBUG] maxWithdraw:", maxW.toString());
    expect(maxW).to.equal(pendingEstimate);
  });

  it("should socialize loss between pending and active shareholders", async function () {
    console.log("[DEBUG] test: loss socialization");
    const ONE_DAY = 24 * 60 * 60;

    // Setup: equal deposits
    // user1 has 10k, user2 has 20k from fixture
    // Deploy strategy and send funds
    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    const strat = await MockStrategy.deploy(await usdc.getAddress());
    await strat.waitForDeployment();
    const stratAddr = await strat.getAddress();
    await vault.connect(admin).addStrategy(stratAddr);

    await vault.connect(admin).requestDeploy(stratAddr, ethers.parseUnits("15000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);

    // User1 requests redeem BEFORE loss
    const user1Shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(user1Shares, user1Addr, user1Addr);
    const estimateBeforeLoss = await vault.convertToAssets(await vault.pendingRedeemRequest(0, user1Addr));
    console.log("[DEBUG] estimate before loss:", estimateBeforeLoss.toString());

    // Strategy reports 50% loss (15k → 7.5k)
    await (strat as any).setTotalAssets(ethers.parseUnits("7500", 18));
    await vault.processReport(stratAddr);

    // Estimate AFTER loss should be lower
    const estimateAfterLoss = await vault.convertToAssets(await vault.pendingRedeemRequest(0, user1Addr));
    console.log("[DEBUG] estimate after loss:", estimateAfterLoss.toString());
    expect(estimateAfterLoss).to.be.lt(estimateBeforeLoss);

    // Withdraw from strategy to have idle for fulfillment
    await vault.connect(admin).withdrawFromStrategy(stratAddr, ethers.parseUnits("7500", 18));

    // Fulfill — user1 gets the reduced amount (loss socialized)
    await vault.connect(admin).fulfillRedeem(user1Addr);
    const claimable = await vault.claimableWithdrawals(user1Addr);
    console.log("[DEBUG] claimable after loss:", claimable.toString());
    expect(claimable).to.be.lt(ethers.parseUnits("10000", 18)); // Less than original deposit
  });

  it("should give more assets when profit occurs between request and fulfill", async function () {
    console.log("[DEBUG] test: profit between request and fulfill");
    const ONE_DAY = 24 * 60 * 60;

    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    const strat = await MockStrategy.deploy(await usdc.getAddress());
    await strat.waitForDeployment();
    const stratAddr = await strat.getAddress();
    await vault.connect(admin).addStrategy(stratAddr);

    await vault.connect(admin).requestDeploy(stratAddr, ethers.parseUnits("15000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);

    // User1 requests redeem BEFORE profit
    const user1Shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(user1Shares, user1Addr, user1Addr);
    const estimateBeforeProfit = await vault.convertToAssets(await vault.pendingRedeemRequest(0, user1Addr));
    console.log("[DEBUG] estimate before profit:", estimateBeforeProfit.toString());

    // Strategy reports profit (15k → 18k)
    await (strat as any).setTotalAssets(ethers.parseUnits("18000", 18));
    await vault.processReport(stratAddr);

    // Estimate AFTER profit should be higher
    const estimateAfterProfit = await vault.convertToAssets(await vault.pendingRedeemRequest(0, user1Addr));
    console.log("[DEBUG] estimate after profit:", estimateAfterProfit.toString());
    expect(estimateAfterProfit).to.be.gt(estimateBeforeProfit);

    // Withdraw from strategy + mint profit to have idle for fulfillment
    await usdc.mint(stratAddr, ethers.parseUnits("3000", 18));
    await vault.connect(admin).withdrawFromStrategy(stratAddr, ethers.parseUnits("18000", 18));

    // Fulfill — user1 gets the increased amount
    await vault.connect(admin).fulfillRedeem(user1Addr);
    const claimable = await vault.claimableWithdrawals(user1Addr);
    console.log("[DEBUG] claimable after profit:", claimable.toString());
    expect(claimable).to.be.gt(ethers.parseUnits("10000", 18)); // More than original deposit
  });

  it("should return correct claimableRedeemRequest (ERC-7540)", async function () {
    console.log("[DEBUG] test: claimableRedeemRequest");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
    await vault.connect(admin).fulfillRedeem(user1Addr);

    const claimableShares = await vault.claimableRedeemRequest(0, user1Addr);
    console.log("[DEBUG] claimableRedeemRequest shares:", claimableShares.toString());
    expect(claimableShares).to.equal(shares);
    const claimableAssets = await vault.claimableWithdrawals(user1Addr);
    console.log("[DEBUG] claimableWithdrawals assets:", claimableAssets.toString());
    expect(claimableAssets).to.be.gt(0);
  });
});
