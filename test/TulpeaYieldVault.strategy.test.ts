import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — Strategy Registry", function () {
  let vault: Contract;
  let usdc: Contract;
  let mockStrategy: Contract;
  let admin: Signer;
  let user1: Signer;
  let adminAddr: string;

  async function deployFixture() {
    console.log("[DEBUG] deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    adminAddr = await admin.getAddress();

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
    console.log("[DEBUG] MockStrategy at:", await mockStrategy.getAddress());
    console.log("[DEBUG] deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  it("should add a strategy", async function () {
    console.log("[DEBUG] test: addStrategy");
    await vault.connect(admin).addStrategy(await mockStrategy.getAddress());
    const config = await vault.strategies(await mockStrategy.getAddress());
    console.log("[DEBUG] strategy config:", config);
    expect(config.isActive).to.be.true;
    expect(config.currentDebt).to.equal(0);
  });

  it("should emit StrategyAdded event", async function () {
    console.log("[DEBUG] test: StrategyAdded event");
    await expect(vault.connect(admin).addStrategy(await mockStrategy.getAddress()))
      .to.emit(vault, "StrategyAdded")
      .withArgs(await mockStrategy.getAddress());
  });

  it("should reject adding same strategy twice", async function () {
    console.log("[DEBUG] test: duplicate strategy");
    await vault.connect(admin).addStrategy(await mockStrategy.getAddress());
    await expect(vault.connect(admin).addStrategy(await mockStrategy.getAddress()))
      .to.be.revertedWithCustomError(vault, "StrategyAlreadyExists");
  });

  it("should reject adding zero address", async function () {
    console.log("[DEBUG] test: zero address strategy");
    await expect(vault.connect(admin).addStrategy(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(vault, "ZeroAddress");
  });

  it("should reject adding vault itself as strategy", async function () {
    console.log("[DEBUG] test: self-deploy");
    await expect(vault.connect(admin).addStrategy(await vault.getAddress()))
      .to.be.revertedWithCustomError(vault, "SelfDeployNotAllowed");
  });

  it("should reject non-owner adding strategy", async function () {
    console.log("[DEBUG] test: non-owner addStrategy");
    await expect(vault.connect(user1).addStrategy(await mockStrategy.getAddress()))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
  });

  it("should reject adding contract that reverts on totalAssets", async function () {
    console.log("[DEBUG] test: reverting strategy");
    await mockStrategy.setRevertOnTotalAssets(true);
    await expect(vault.connect(admin).addStrategy(await mockStrategy.getAddress()))
      .to.be.revertedWithCustomError(vault, "StrategyTotalAssetsReverted");
  });

  it("should remove a strategy with zero debt", async function () {
    console.log("[DEBUG] test: removeStrategy");
    await vault.connect(admin).addStrategy(await mockStrategy.getAddress());
    await vault.connect(admin).removeStrategy(await mockStrategy.getAddress());
    const config = await vault.strategies(await mockStrategy.getAddress());
    console.log("[DEBUG] strategy after remove:", config);
    expect(config.isActive).to.be.false;
  });

  it("should emit StrategyRemoved event", async function () {
    console.log("[DEBUG] test: StrategyRemoved event");
    await vault.connect(admin).addStrategy(await mockStrategy.getAddress());
    await expect(vault.connect(admin).removeStrategy(await mockStrategy.getAddress()))
      .to.emit(vault, "StrategyRemoved")
      .withArgs(await mockStrategy.getAddress());
  });

  it("should reject removing non-existent strategy", async function () {
    console.log("[DEBUG] test: remove non-existent");
    await expect(vault.connect(admin).removeStrategy(await mockStrategy.getAddress()))
      .to.be.revertedWithCustomError(vault, "StrategyNotFound");
  });

  it("should update strategyList length on add/remove", async function () {
    console.log("[DEBUG] test: strategyList length");
    await vault.connect(admin).addStrategy(await mockStrategy.getAddress());
    expect(await vault.strategyListLength()).to.equal(1);
    await vault.connect(admin).removeStrategy(await mockStrategy.getAddress());
    expect(await vault.strategyListLength()).to.equal(0);
  });
});
