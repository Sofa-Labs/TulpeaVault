import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — Deploy Funds", function () {
  let vault: Contract;
  let usdc: Contract;
  let mockStrategy: Contract;
  let admin: Signer;
  let user1: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let strategyAddr: string;

  const DEPOSIT_LIMIT = ethers.parseUnits("1000000", 18);
  const ONE_DAY = 24 * 60 * 60;

  async function deployFixture() {
    console.log("[DEBUG] deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
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
      await usdc.getAddress(), adminAddr, DEPOSIT_LIMIT, "Tulpea Yield Vault", "tyvUSDC", ethers.ZeroAddress,
    ]);
    const proxy = await ERC1967Proxy.deploy(await vaultImpl.getAddress(), initData);
    await proxy.waitForDeployment();
    vault = VaultFactory.attach(await proxy.getAddress()) as Contract;

    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    mockStrategy = await MockStrategy.deploy(await usdc.getAddress());
    await mockStrategy.waitForDeployment();
    strategyAddr = await mockStrategy.getAddress();

    await vault.connect(admin).addStrategy(strategyAddr);

    const mintAmount = ethers.parseUnits("100000", 18);
    await usdc.mint(user1Addr, mintAmount);
    await usdc.mint(adminAddr, mintAmount);

    const vaultAddr = await vault.getAddress();
    await usdc.connect(user1).approve(vaultAddr, ethers.MaxUint256);
    await usdc.connect(admin).approve(vaultAddr, ethers.MaxUint256);

    // Seed vault with deposits
    await vault.connect(user1).deposit(ethers.parseUnits("50000", 18), user1Addr);
    console.log("[DEBUG] deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  it("should request deploy and emit event", async function () {
    console.log("[DEBUG] test: requestDeploy");
    const amount = ethers.parseUnits("10000", 18);
    const tx = await vault.connect(admin).requestDeploy(strategyAddr, amount);
    await expect(tx).to.emit(vault, "DeploymentRequested");
    const details = await vault.getDeploymentDetails(0);
    console.log("[DEBUG] deployment details:", details);
    expect(details.strategy).to.equal(strategyAddr);
    expect(details.amount).to.equal(amount);
  });

  it("should execute deploy after timelock", async function () {
    console.log("[DEBUG] test: executeDeploy");
    const amount = ethers.parseUnits("10000", 18);
    await vault.connect(admin).requestDeploy(strategyAddr, amount);

    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);

    const vaultAddr = await vault.getAddress();
    const idleBefore = await usdc.balanceOf(vaultAddr);
    await vault.connect(admin).executeDeploy(0);
    const idleAfter = await usdc.balanceOf(vaultAddr);
    const debt = await vault.totalDebt();

    console.log("[DEBUG] idle before:", idleBefore.toString(), "after:", idleAfter.toString());
    console.log("[DEBUG] totalDebt:", debt.toString());
    expect(idleAfter).to.equal(idleBefore - amount);
    expect(debt).to.equal(amount);
  });

  it("should update strategy currentDebt on execute", async function () {
    console.log("[DEBUG] test: strategy currentDebt");
    const amount = ethers.parseUnits("10000", 18);
    await vault.connect(admin).requestDeploy(strategyAddr, amount);
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);

    const config = await vault.strategies(strategyAddr);
    console.log("[DEBUG] strategy currentDebt:", config.currentDebt.toString());
    expect(config.currentDebt).to.equal(amount);
  });

  it("should reject execute before timelock", async function () {
    console.log("[DEBUG] test: timelock not met");
    const amount = ethers.parseUnits("10000", 18);
    await vault.connect(admin).requestDeploy(strategyAddr, amount);
    await expect(vault.connect(admin).executeDeploy(0))
      .to.be.revertedWithCustomError(vault, "DeploymentTimelockNotMet");
  });

  it("should cancel deploy", async function () {
    console.log("[DEBUG] test: cancelDeploy");
    const amount = ethers.parseUnits("10000", 18);
    await vault.connect(admin).requestDeploy(strategyAddr, amount);
    await vault.connect(admin).cancelDeploy(0);
    const details = await vault.getDeploymentDetails(0);
    console.log("[DEBUG] cancelled:", details.cancelled);
    expect(details.cancelled).to.be.true;
  });

  it("should reject executing cancelled deploy", async function () {
    console.log("[DEBUG] test: execute cancelled");
    const amount = ethers.parseUnits("10000", 18);
    await vault.connect(admin).requestDeploy(strategyAddr, amount);
    await vault.connect(admin).cancelDeploy(0);
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await expect(vault.connect(admin).executeDeploy(0))
      .to.be.revertedWithCustomError(vault, "DeploymentAlreadyCancelled");
  });

  it("should reject executing twice", async function () {
    console.log("[DEBUG] test: double execute");
    const amount = ethers.parseUnits("10000", 18);
    await vault.connect(admin).requestDeploy(strategyAddr, amount);
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);
    await expect(vault.connect(admin).executeDeploy(0))
      .to.be.revertedWithCustomError(vault, "DeploymentAlreadyExecuted");
  });

  it("should reject deploy to non-active strategy", async function () {
    console.log("[DEBUG] test: inactive strategy");
    const signers = await ethers.getSigners();
    const randomAddr = await signers[5].getAddress();
    await expect(vault.connect(admin).requestDeploy(randomAddr, ethers.parseUnits("1000", 18)))
      .to.be.revertedWithCustomError(vault, "StrategyNotActive");
  });


  it("should reject zero amount deploy", async function () {
    console.log("[DEBUG] test: zero amount");
    await expect(vault.connect(admin).requestDeploy(strategyAddr, 0))
      .to.be.revertedWithCustomError(vault, "ZeroAmount");
  });

  it("should reject non-owner requestDeploy", async function () {
    console.log("[DEBUG] test: non-owner deploy");
    await expect(vault.connect(user1).requestDeploy(strategyAddr, ethers.parseUnits("1000", 18)))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
  });

  it("should transfer USDC to strategy on execute", async function () {
    console.log("[DEBUG] test: USDC transfer");
    const amount = ethers.parseUnits("10000", 18);
    await vault.connect(admin).requestDeploy(strategyAddr, amount);
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);

    const balBefore = await usdc.balanceOf(strategyAddr);
    await vault.connect(admin).executeDeploy(0);
    const balAfter = await usdc.balanceOf(strategyAddr);

    console.log("[DEBUG] strategy balance before:", balBefore.toString(), "after:", balAfter.toString());
    expect(balAfter - balBefore).to.equal(amount);
  });

  it("should reject deploy if strategy removed between request and execute", async function () {
    console.log("[DEBUG] test: strategy removed between request/execute");
    const amount = ethers.parseUnits("1000", 18);

    // Deploy a second strategy, deploy to it, then remove it
    const MockStrategy2 = await ethers.getContractFactory("MockStrategy");
    const strat2 = await MockStrategy2.deploy(await usdc.getAddress());
    await strat2.waitForDeployment();
    const strat2Addr = await strat2.getAddress();

    await vault.connect(admin).addStrategy(strat2Addr);
    const nextId = await vault.nextDeploymentId();
    console.log("[DEBUG] next deployment ID:", nextId.toString());
    await vault.connect(admin).requestDeploy(strat2Addr, amount);

    // Remove strategy before execution
    await vault.connect(admin).removeStrategy(strat2Addr);

    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);

    await expect(vault.connect(admin).executeDeploy(nextId))
      .to.be.revertedWithCustomError(vault, "StrategyNotActive");
  });
});
