import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — processReport", function () {
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

  async function deployFixture() {
    console.log("[DEBUG] deployFixture: start");
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
    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("50000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);

    // Set strategy totalAssets to match deployed amount
    await mockStrategy.setTotalAssets(ethers.parseUnits("50000", 18));

    // Disable health check — these tests exercise large losses that exceed default 1% limit
    await vault.connect(admin).setHealthCheck(10000, 10000, false);
    console.log("[DEBUG] deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  it("should detect profit and increase totalDebt", async function () {
    console.log("[DEBUG] test: profit detection");
    const profit = ethers.parseUnits("5000", 18);
    await mockStrategy.setTotalAssets(ethers.parseUnits("55000", 18)); // 50k + 5k profit

    const debtBefore = await vault.totalDebt();
    await vault.processReport(strategyAddr);
    const debtAfter = await vault.totalDebt();

    console.log("[DEBUG] debt before:", debtBefore.toString(), "after:", debtAfter.toString());
    expect(debtAfter).to.equal(debtBefore + profit);
  });

  it("should emit StrategyReported event with profit", async function () {
    console.log("[DEBUG] test: profit event");
    await mockStrategy.setTotalAssets(ethers.parseUnits("55000", 18));
    await expect(vault.processReport(strategyAddr))
      .to.emit(vault, "StrategyReported")
      .withArgs(strategyAddr, ethers.parseUnits("5000", 18), 0, ethers.parseUnits("55000", 18));
  });

  it("should detect loss and decrease totalDebt immediately", async function () {
    console.log("[DEBUG] test: loss detection");
    const loss = ethers.parseUnits("10000", 18);
    await mockStrategy.setTotalAssets(ethers.parseUnits("40000", 18)); // 50k - 10k loss

    const debtBefore = await vault.totalDebt();
    await vault.processReport(strategyAddr);
    const debtAfter = await vault.totalDebt();

    console.log("[DEBUG] debt before:", debtBefore.toString(), "after:", debtAfter.toString());
    expect(debtAfter).to.equal(debtBefore - loss);
  });

  it("should emit StrategyReported event with loss", async function () {
    console.log("[DEBUG] test: loss event");
    await mockStrategy.setTotalAssets(ethers.parseUnits("40000", 18));
    await expect(vault.processReport(strategyAddr))
      .to.emit(vault, "StrategyReported")
      .withArgs(strategyAddr, 0, ethers.parseUnits("10000", 18), ethers.parseUnits("40000", 18));
  });

  it("should handle no change (no profit, no loss)", async function () {
    console.log("[DEBUG] test: no change");
    // totalAssets already set to 50000 in fixture
    await expect(vault.processReport(strategyAddr))
      .to.emit(vault, "StrategyReported")
      .withArgs(strategyAddr, 0, 0, ethers.parseUnits("50000", 18));
  });

  it("should be onlyOwner (non-owner cannot call)", async function () {
    console.log("[DEBUG] test: onlyOwner");
    await mockStrategy.setTotalAssets(ethers.parseUnits("55000", 18));
    // user1 (not admin) calls processReport — should revert
    await expect(vault.connect(user1).processReport(strategyAddr))
      .to.be.revertedWithCustomError(vault, "NotKeeperOrOwner");
  });

  it("should revert for inactive strategy", async function () {
    console.log("[DEBUG] test: inactive strategy");
    const signers = await ethers.getSigners();
    const randomAddr = await signers[5].getAddress();
    await expect(vault.processReport(randomAddr))
      .to.be.revertedWithCustomError(vault, "StrategyNotActive");
  });

  it("should revert when strategy totalAssets reverts", async function () {
    console.log("[DEBUG] test: reverting totalAssets");
    await mockStrategy.setRevertOnTotalAssets(true);
    await expect(vault.processReport(strategyAddr))
      .to.be.revertedWithCustomError(vault, "StrategyTotalAssetsReverted");
  });

  it("should update strategy config on profit", async function () {
    console.log("[DEBUG] test: strategy config update (profit)");
    await mockStrategy.setTotalAssets(ethers.parseUnits("55000", 18));
    await vault.processReport(strategyAddr);

    const config = await vault.strategies(strategyAddr);
    console.log("[DEBUG] currentDebt:", config.currentDebt.toString());
    expect(config.currentDebt).to.equal(ethers.parseUnits("55000", 18));
    expect(config.lastTotalAssets).to.equal(ethers.parseUnits("55000", 18));
  });

  it("should update strategy config on loss", async function () {
    console.log("[DEBUG] test: strategy config update (loss)");
    await mockStrategy.setTotalAssets(ethers.parseUnits("40000", 18));
    await vault.processReport(strategyAddr);

    const config = await vault.strategies(strategyAddr);
    console.log("[DEBUG] currentDebt:", config.currentDebt.toString());
    expect(config.currentDebt).to.equal(ethers.parseUnits("40000", 18));
  });

  it("should increase totalAssets on profit (instant unlock)", async function () {
    console.log("[DEBUG] test: totalAssets increase");
    const taBefore = await vault.totalAssets();
    await mockStrategy.setTotalAssets(ethers.parseUnits("55000", 18));
    await vault.processReport(strategyAddr);
    const taAfter = await vault.totalAssets();

    console.log("[DEBUG] totalAssets before:", taBefore.toString(), "after:", taAfter.toString());
    expect(taAfter).to.equal(taBefore + ethers.parseUnits("5000", 18));
  });

  it("should decrease totalAssets on loss", async function () {
    console.log("[DEBUG] test: totalAssets decrease");
    const taBefore = await vault.totalAssets();
    await mockStrategy.setTotalAssets(ethers.parseUnits("40000", 18));
    await vault.processReport(strategyAddr);
    const taAfter = await vault.totalAssets();

    console.log("[DEBUG] totalAssets before:", taBefore.toString(), "after:", taAfter.toString());
    expect(taAfter).to.equal(taBefore - ethers.parseUnits("10000", 18));
  });

  it("should handle multiple sequential reports", async function () {
    console.log("[DEBUG] test: multiple reports");
    // Report 1: profit
    await mockStrategy.setTotalAssets(ethers.parseUnits("55000", 18));
    await vault.processReport(strategyAddr);

    // Report 2: more profit
    await mockStrategy.setTotalAssets(ethers.parseUnits("60000", 18));
    await vault.processReport(strategyAddr);

    const config = await vault.strategies(strategyAddr);
    console.log("[DEBUG] currentDebt after 2 reports:", config.currentDebt.toString());
    expect(config.currentDebt).to.equal(ethers.parseUnits("60000", 18));
    expect(await vault.totalDebt()).to.equal(ethers.parseUnits("60000", 18));
  });

  it("should handle profit then loss", async function () {
    console.log("[DEBUG] test: profit then loss");
    await mockStrategy.setTotalAssets(ethers.parseUnits("55000", 18));
    await vault.processReport(strategyAddr);

    await mockStrategy.setTotalAssets(ethers.parseUnits("45000", 18));
    await vault.processReport(strategyAddr);

    expect(await vault.totalDebt()).to.equal(ethers.parseUnits("45000", 18));
  });

  it("should handle total loss (strategy reports 0)", async function () {
    console.log("[DEBUG] test: total loss");
    await mockStrategy.setTotalAssets(0);
    await vault.processReport(strategyAddr);

    expect(await vault.totalDebt()).to.equal(0);
    const config = await vault.strategies(strategyAddr);
    expect(config.currentDebt).to.equal(0);
  });

  it("should handle multiple strategies independently", async function () {
    console.log("[DEBUG] test: multiple strategies");
    // Deploy second strategy
    const MockStrategy2 = await ethers.getContractFactory("MockStrategy");
    const strat2 = await MockStrategy2.deploy(await usdc.getAddress());
    await strat2.waitForDeployment();
    const strat2Addr = await strat2.getAddress();
    await vault.connect(admin).addStrategy(strat2Addr);

    // Deploy to second strategy
    await vault.connect(admin).requestDeploy(strat2Addr, ethers.parseUnits("20000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(1);
    await strat2.setTotalAssets(ethers.parseUnits("20000", 18));

    // Strategy 1 profits, strategy 2 loses
    await mockStrategy.setTotalAssets(ethers.parseUnits("55000", 18)); // +5k
    await strat2.setTotalAssets(ethers.parseUnits("18000", 18)); // -2k

    await vault.processReport(strategyAddr);
    await vault.processReport(strat2Addr);

    // totalDebt = 55000 + 18000 = 73000 (was 70000)
    expect(await vault.totalDebt()).to.equal(ethers.parseUnits("73000", 18));
  });

  it("should increase share price on profit with instant unlock", async function () {
    console.log("[DEBUG] test: share price increase");
    const priceBefore = await vault.sharePrice();
    await mockStrategy.setTotalAssets(ethers.parseUnits("55000", 18));
    await vault.processReport(strategyAddr);
    const priceAfter = await vault.sharePrice();

    console.log("[DEBUG] price before:", priceBefore.toString(), "after:", priceAfter.toString());
    expect(priceAfter).to.be.gt(priceBefore);
  });

  it("should decrease share price on loss", async function () {
    console.log("[DEBUG] test: share price decrease");
    const priceBefore = await vault.sharePrice();
    await mockStrategy.setTotalAssets(ethers.parseUnits("40000", 18));
    await vault.processReport(strategyAddr);
    const priceAfter = await vault.sharePrice();

    console.log("[DEBUG] price before:", priceBefore.toString(), "after:", priceAfter.toString());
    expect(priceAfter).to.be.lt(priceBefore);
  });
});
