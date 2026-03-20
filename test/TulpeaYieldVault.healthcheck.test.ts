import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — healthCheck", function () {
  let vault: Contract;
  let usdc: Contract;
  let mockStrategy: Contract;
  let admin: Signer;
  let user1: Signer;
  let user2: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let strategyAddr: string;

  const ONE_DAY = 24 * 60 * 60;
  const DEPLOYED = ethers.parseUnits("50000", 18);

  async function deployFixture() {
    console.log("[DEBUG] healthcheck deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    user2 = signers[2];
    adminAddr = await admin.getAddress();
    user1Addr = await user1.getAddress();

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
    await usdc.mint(adminAddr, mintAmount);

    const vaultAddr = await vault.getAddress();
    await usdc.connect(user1).approve(vaultAddr, ethers.MaxUint256);
    await usdc.connect(admin).approve(vaultAddr, ethers.MaxUint256);

    // Deposit and deploy to strategy
    await vault.connect(user1).deposit(ethers.parseUnits("100000", 18), user1Addr);
    await vault.connect(admin).requestDeploy(strategyAddr, DEPLOYED);
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);

    // Set strategy totalAssets to match deployed amount
    await mockStrategy.setTotalAssets(DEPLOYED);
    console.log("[DEBUG] healthcheck deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // ═══════════════════════════════════════════════════════════
  // DEFAULT VALUES
  // ═══════════════════════════════════════════════════════════

  it("should have correct default values after initialization", async function () {
    console.log("[DEBUG] test: default values");
    const maxProfit = await vault.maxProfitReportBps();
    const maxLoss = await vault.maxLossReportBps();
    const enabled = await vault.healthCheckEnabled();

    console.log("[DEBUG] maxProfit:", maxProfit.toString(), "maxLoss:", maxLoss.toString(), "enabled:", enabled);
    expect(maxProfit).to.equal(10000n); // 100%
    expect(maxLoss).to.equal(100n);     // 1%
    expect(enabled).to.equal(true);
  });

  // ═══════════════════════════════════════════════════════════
  // HEALTH CHECK BLOCKS EXCESSIVE PROFIT
  // ═══════════════════════════════════════════════════════════

  it("should block profit exceeding maxProfitReportBps", async function () {
    console.log("[DEBUG] test: block excessive profit");
    // Default maxProfitReportBps = 10000 (100%). 50k deployed, so max profit = 50k
    // Set strategy to 150k = 200% profit = exceeds 100%
    await mockStrategy.setTotalAssets(ethers.parseUnits("150000", 18));

    console.log("[DEBUG] expecting revert with HealthCheckFailed");
    await expect(vault.processReport(strategyAddr))
      .to.be.revertedWithCustomError(vault, "HealthCheckFailed")
      .withArgs(
        ethers.parseUnits("100000", 18), // delta = 150k - 50k
        ethers.parseUnits("50000", 18),  // maxAllowed = 50k * 100%
        false // isLoss = false
      );
  });

  it("should block profit just over the limit", async function () {
    console.log("[DEBUG] test: block profit just over limit");
    // Set tight limit: 5% profit max
    await vault.connect(admin).setHealthCheck(500, 100, true);

    // 50k deployed, 5% = 2500 max profit. Set to 52501 = 2501 profit
    await mockStrategy.setTotalAssets(ethers.parseUnits("52501", 18));

    console.log("[DEBUG] expecting revert");
    await expect(vault.processReport(strategyAddr))
      .to.be.revertedWithCustomError(vault, "HealthCheckFailed");
  });

  // ═══════════════════════════════════════════════════════════
  // HEALTH CHECK BLOCKS EXCESSIVE LOSS
  // ═══════════════════════════════════════════════════════════

  it("should block loss exceeding maxLossReportBps", async function () {
    console.log("[DEBUG] test: block excessive loss");
    // Default maxLossReportBps = 100 (1%). 50k deployed, so max loss = 500
    // Set strategy to 49000 = 1000 loss = 2% > 1%
    await mockStrategy.setTotalAssets(ethers.parseUnits("49000", 18));

    console.log("[DEBUG] expecting revert with HealthCheckFailed");
    await expect(vault.processReport(strategyAddr))
      .to.be.revertedWithCustomError(vault, "HealthCheckFailed")
      .withArgs(
        ethers.parseUnits("1000", 18),  // delta = 50k - 49k
        ethers.parseUnits("500", 18),   // maxAllowed = 50k * 1%
        true // isLoss = true
      );
  });

  it("should block loss just over the limit", async function () {
    console.log("[DEBUG] test: block loss just over limit");
    // Default 1% loss limit on 50k = 500 max loss
    // 49499 = 501 loss > 500 allowed
    await mockStrategy.setTotalAssets(ethers.parseUnits("49499", 18));

    console.log("[DEBUG] expecting revert");
    await expect(vault.processReport(strategyAddr))
      .to.be.revertedWithCustomError(vault, "HealthCheckFailed");
  });

  // ═══════════════════════════════════════════════════════════
  // HEALTH CHECK PASSES WITHIN BOUNDS
  // ═══════════════════════════════════════════════════════════

  it("should pass when profit is within bounds", async function () {
    console.log("[DEBUG] test: profit within bounds");
    // 50k deployed, 100% max profit = 50k. Set to 99k = 98% profit
    await mockStrategy.setTotalAssets(ethers.parseUnits("99000", 18));

    console.log("[DEBUG] processReport should succeed");
    await expect(vault.processReport(strategyAddr)).to.not.be.reverted;

    const debt = await vault.totalDebt();
    console.log("[DEBUG] totalDebt after:", debt.toString());
    expect(debt).to.equal(ethers.parseUnits("99000", 18));
  });

  it("should pass when loss is exactly at the limit", async function () {
    console.log("[DEBUG] test: loss exactly at limit");
    // 50k deployed, 1% max loss = 500. Set to 49500 = exactly 500 loss = 1%
    await mockStrategy.setTotalAssets(ethers.parseUnits("49500", 18));

    console.log("[DEBUG] processReport should succeed (exactly at limit)");
    await expect(vault.processReport(strategyAddr)).to.not.be.reverted;
  });

  it("should pass when profit is exactly at the limit", async function () {
    console.log("[DEBUG] test: profit exactly at limit");
    // 50k deployed, 100% max profit = 50k. Set to 100k = exactly 100%
    await mockStrategy.setTotalAssets(ethers.parseUnits("100000", 18));

    console.log("[DEBUG] processReport should succeed (exactly at limit)");
    await expect(vault.processReport(strategyAddr)).to.not.be.reverted;
  });

  it("should pass when no change in assets", async function () {
    console.log("[DEBUG] test: no change");
    // Strategy still at 50k = no change
    await expect(vault.processReport(strategyAddr)).to.not.be.reverted;
  });

  // ═══════════════════════════════════════════════════════════
  // HEALTH CHECK DISABLE/ENABLE
  // ═══════════════════════════════════════════════════════════

  it("should allow any profit/loss when health check is disabled", async function () {
    console.log("[DEBUG] test: disabled health check");
    await vault.connect(admin).setHealthCheck(10000, 100, false);

    // 50k deployed, set to 200k = 300% profit — would fail if enabled
    await mockStrategy.setTotalAssets(ethers.parseUnits("200000", 18));

    console.log("[DEBUG] processReport should succeed (health check disabled)");
    await expect(vault.processReport(strategyAddr)).to.not.be.reverted;
  });

  it("should allow owner to bypass by disable → process → re-enable", async function () {
    console.log("[DEBUG] test: owner bypass pattern");
    // Set very tight limits
    await vault.connect(admin).setHealthCheck(100, 100, true); // 1% profit / 1% loss

    // 50k deployed, 10k profit = 20% — blocked
    await mockStrategy.setTotalAssets(ethers.parseUnits("60000", 18));
    await expect(vault.processReport(strategyAddr))
      .to.be.revertedWithCustomError(vault, "HealthCheckFailed");

    // Disable, process, re-enable
    console.log("[DEBUG] disabling health check");
    await vault.connect(admin).setHealthCheck(100, 100, false);
    await expect(vault.processReport(strategyAddr)).to.not.be.reverted;

    console.log("[DEBUG] re-enabling health check");
    await vault.connect(admin).setHealthCheck(100, 100, true);
    expect(await vault.healthCheckEnabled()).to.equal(true);
  });

  // ═══════════════════════════════════════════════════════════
  // setHealthCheck VALIDATION
  // ═══════════════════════════════════════════════════════════

  it("should reject maxProfitBps > MAX_BPS", async function () {
    console.log("[DEBUG] test: invalid profit bps");
    await expect(vault.connect(admin).setHealthCheck(10001, 100, true))
      .to.be.revertedWithCustomError(vault, "InvalidBpsValue")
      .withArgs(10001);
  });

  it("should reject maxLossBps > MAX_BPS", async function () {
    console.log("[DEBUG] test: invalid loss bps");
    await expect(vault.connect(admin).setHealthCheck(10000, 10001, true))
      .to.be.revertedWithCustomError(vault, "InvalidBpsValue")
      .withArgs(10001);
  });

  it("should emit HealthCheckConfigured event", async function () {
    console.log("[DEBUG] test: event emission");
    await expect(vault.connect(admin).setHealthCheck(500, 200, true))
      .to.emit(vault, "HealthCheckConfigured")
      .withArgs(500, 200, true);
  });

  it("should revert when non-owner calls setHealthCheck", async function () {
    console.log("[DEBUG] test: non-owner access");
    await expect(vault.connect(user1).setHealthCheck(500, 200, true))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
  });

  // ═══════════════════════════════════════════════════════════
  // HEALTH CHECK SKIPPED WHEN previousDebt == 0
  // ═══════════════════════════════════════════════════════════

  it("should skip health check when previousDebt is 0 (first report)", async function () {
    console.log("[DEBUG] test: skip on first report (previousDebt=0)");
    // Add a new strategy with no debt deployed
    const MockStrategy2 = await ethers.getContractFactory("MockStrategy");
    const mockStrategy2 = await MockStrategy2.deploy(await usdc.getAddress());
    await mockStrategy2.waitForDeployment();
    const strategy2Addr = await mockStrategy2.getAddress();

    await vault.connect(admin).addStrategy(strategy2Addr);

    // Strategy reports 1000 with no debt — would be infinite % but should be skipped
    await mockStrategy2.setTotalAssets(ethers.parseUnits("1000", 18));

    console.log("[DEBUG] processReport with no debt should succeed");
    await expect(vault.processReport(strategy2Addr)).to.not.be.reverted;
  });

  // ═══════════════════════════════════════════════════════════
  // COEXISTS WITH EMERGENCY SHUTDOWN
  // ═══════════════════════════════════════════════════════════

  it("should still trigger emergency shutdown for 50%+ loss when health check allows it", async function () {
    console.log("[DEBUG] test: emergency shutdown coexistence");
    // Set generous health check: 100% loss allowed
    await vault.connect(admin).setHealthCheck(10000, 10000, true);

    // 50k deployed, set to 20k = 60% loss — health check passes (100% allowed), emergency shutdown triggers (>50%)
    await mockStrategy.setTotalAssets(ethers.parseUnits("20000", 18));

    console.log("[DEBUG] processReport should succeed but trigger emergency shutdown");
    await expect(vault.processReport(strategyAddr))
      .to.emit(vault, "EmergencyShutdownTriggered");

    const shutdown = await vault.emergencyShutdown();
    console.log("[DEBUG] emergencyShutdown:", shutdown);
    expect(shutdown).to.equal(true);
  });

  it("health check fires before emergency shutdown (tighter bounds)", async function () {
    console.log("[DEBUG] test: health check fires first");
    // Default: 1% loss limit. 50k deployed, set to 20k = 60% loss
    // Health check rejects first (1% < 60%), emergency shutdown never reached
    await mockStrategy.setTotalAssets(ethers.parseUnits("20000", 18));

    console.log("[DEBUG] expecting HealthCheckFailed, not EmergencyShutdown");
    await expect(vault.processReport(strategyAddr))
      .to.be.revertedWithCustomError(vault, "HealthCheckFailed");

    // Emergency shutdown should NOT have been triggered
    expect(await vault.emergencyShutdown()).to.equal(false);
  });
});
