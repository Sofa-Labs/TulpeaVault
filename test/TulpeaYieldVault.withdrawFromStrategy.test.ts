import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — withdrawFromStrategy", function () {
  let vault: Contract;
  let usdc: Contract;
  let mockStrategy: Contract;
  let admin: Signer;
  let user1: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let strategyAddr: string;

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

    // Deposit and deploy
    await vault.connect(user1).deposit(ethers.parseUnits("100000", 18), user1Addr);
    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("50000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);
    await mockStrategy.setTotalAssets(ethers.parseUnits("50000", 18));
    console.log("[DEBUG] deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  it("should withdraw USDC from strategy to vault", async function () {
    console.log("[DEBUG] test: withdraw from strategy");
    const amount = ethers.parseUnits("20000", 18);

    const vaultAddr = await vault.getAddress();
    const idleBefore = await usdc.balanceOf(vaultAddr);
    const debtBefore = await vault.totalDebt();

    await vault.connect(admin).withdrawFromStrategy(strategyAddr, amount);

    const idleAfter = await usdc.balanceOf(vaultAddr);
    const debtAfter = await vault.totalDebt();

    console.log("[DEBUG] idle before:", idleBefore.toString(), "after:", idleAfter.toString());
    console.log("[DEBUG] debt before:", debtBefore.toString(), "after:", debtAfter.toString());

    expect(idleAfter).to.equal(idleBefore + amount);
    expect(debtAfter).to.equal(debtBefore - amount);
  });

  it("should update strategy currentDebt", async function () {
    console.log("[DEBUG] test: currentDebt update");
    const amount = ethers.parseUnits("20000", 18);
    await vault.connect(admin).withdrawFromStrategy(strategyAddr, amount);

    const config = await vault.strategies(strategyAddr);
    console.log("[DEBUG] currentDebt:", config.currentDebt.toString());
    expect(config.currentDebt).to.equal(ethers.parseUnits("30000", 18));
  });

  it("should emit FundsWithdrawnFromStrategy event", async function () {
    console.log("[DEBUG] test: FundsWithdrawnFromStrategy event");
    const amount = ethers.parseUnits("20000", 18);
    await expect(vault.connect(admin).withdrawFromStrategy(strategyAddr, amount))
      .to.emit(vault, "FundsWithdrawnFromStrategy")
      .withArgs(strategyAddr, amount);
  });

  it("should reject non-owner", async function () {
    console.log("[DEBUG] test: non-owner withdrawFromStrategy");
    await expect(vault.connect(user1).withdrawFromStrategy(strategyAddr, ethers.parseUnits("1000", 18)))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
  });

  it("should reject zero amount", async function () {
    console.log("[DEBUG] test: zero amount");
    await expect(vault.connect(admin).withdrawFromStrategy(strategyAddr, 0))
      .to.be.revertedWithCustomError(vault, "ZeroAmount");
  });

  it("should reject withdrawing more than currentDebt", async function () {
    console.log("[DEBUG] test: exceeds debt");
    await expect(vault.connect(admin).withdrawFromStrategy(strategyAddr, ethers.parseUnits("60000", 18)))
      .to.be.revertedWithCustomError(vault, "WithdrawExceedsDebt");
  });

  it("should reject withdrawing from inactive strategy", async function () {
    console.log("[DEBUG] test: inactive strategy");
    const signers = await ethers.getSigners();
    const randomAddr = await signers[5].getAddress();
    await expect(vault.connect(admin).withdrawFromStrategy(randomAddr, ethers.parseUnits("1000", 18)))
      .to.be.revertedWithCustomError(vault, "StrategyNotFound");
  });

  it("should withdraw full debt", async function () {
    console.log("[DEBUG] test: full withdrawal");
    const fullDebt = ethers.parseUnits("50000", 18);
    await vault.connect(admin).withdrawFromStrategy(strategyAddr, fullDebt);

    const config = await vault.strategies(strategyAddr);
    expect(config.currentDebt).to.equal(0);
    expect(await vault.totalDebt()).to.equal(0);
  });

  it("should keep totalAssets unchanged after withdrawal", async function () {
    console.log("[DEBUG] test: totalAssets unchanged");
    const taBefore = await vault.totalAssets();
    await vault.connect(admin).withdrawFromStrategy(strategyAddr, ethers.parseUnits("20000", 18));
    const taAfter = await vault.totalAssets();

    console.log("[DEBUG] totalAssets before:", taBefore.toString(), "after:", taAfter.toString());
    expect(taAfter).to.equal(taBefore);
  });
});
