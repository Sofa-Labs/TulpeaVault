import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — Upgrade Safety", function () {
  let vault: Contract;
  let usdc: Contract;
  let admin: Signer;
  let user1: Signer;
  let adminAddr: string;
  let user1Addr: string;

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

    const mintAmount = ethers.parseUnits("100000", 18);
    await usdc.mint(user1Addr, mintAmount);

    const vaultAddr = await vault.getAddress();
    await usdc.connect(user1).approve(vaultAddr, ethers.MaxUint256);

    await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);
    console.log("[DEBUG] deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  it("should upgrade to V2Mock and preserve state", async function () {
    console.log("[DEBUG] test: UUPS upgrade");
    const sharesBefore = await vault.balanceOf(user1Addr);
    const totalAssetsBefore = await vault.totalAssets();

    // Deploy V2 implementation
    const V2Factory = await ethers.getContractFactory("TulpeaYieldVaultV2Mock");
    const v2Impl = await V2Factory.deploy();
    await v2Impl.waitForDeployment();

    // Upgrade
    await vault.connect(admin).upgradeToAndCall(await v2Impl.getAddress(), "0x");

    // Attach as V2
    const v2Vault = V2Factory.attach(await vault.getAddress()) as Contract;

    // Verify state preserved
    expect(await v2Vault.balanceOf(user1Addr)).to.equal(sharesBefore);
    expect(await v2Vault.totalAssets()).to.equal(totalAssetsBefore);

    // Verify V2 functionality
    expect(await v2Vault.vaultVersion()).to.equal(2);
    await v2Vault.connect(admin).setV2NewVariable(42);
    expect(await v2Vault.v2NewVariable()).to.equal(42);
    console.log("[DEBUG] upgrade successful, version:", (await v2Vault.vaultVersion()).toString());
  });

  it("should reject non-owner upgrade", async function () {
    console.log("[DEBUG] test: non-owner upgrade");
    const V2Factory = await ethers.getContractFactory("TulpeaYieldVaultV2Mock");
    const v2Impl = await V2Factory.deploy();
    await v2Impl.waitForDeployment();

    await expect(vault.connect(user1).upgradeToAndCall(await v2Impl.getAddress(), "0x"))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
  });

  it("should not be re-initializable after upgrade", async function () {
    console.log("[DEBUG] test: re-initialization blocked");
    const V2Factory = await ethers.getContractFactory("TulpeaYieldVaultV2Mock");
    const v2Impl = await V2Factory.deploy();
    await v2Impl.waitForDeployment();

    await vault.connect(admin).upgradeToAndCall(await v2Impl.getAddress(), "0x");

    const v2Vault = V2Factory.attach(await vault.getAddress()) as Contract;
    await expect(v2Vault.connect(admin).initialize(
      await usdc.getAddress(), adminAddr, 0, "Hack", "HACK"
    )).to.be.revertedWithCustomError(v2Vault, "InvalidInitialization");
  });

  it("implementation contract should have initializers disabled", async function () {
    console.log("[DEBUG] test: impl initializers disabled");
    const VaultFactory = await ethers.getContractFactory("TulpeaYieldVault");
    const impl = await VaultFactory.deploy();
    await impl.waitForDeployment();

    await expect(impl.initialize(
      await usdc.getAddress(), adminAddr, 0, "Hack", "HACK"
    )).to.be.revertedWithCustomError(impl, "InvalidInitialization");
  });

  it("should preserve strategy state after upgrade", async function () {
    console.log("[DEBUG] test: strategy state preserved");
    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    const strat = await MockStrategy.deploy(await usdc.getAddress());
    await strat.waitForDeployment();
    const stratAddr = await strat.getAddress();

    await vault.connect(admin).addStrategy(stratAddr);
    const configBefore = await vault.strategies(stratAddr);
    expect(configBefore.isActive).to.be.true;

    // Upgrade
    const V2Factory = await ethers.getContractFactory("TulpeaYieldVaultV2Mock");
    const v2Impl = await V2Factory.deploy();
    await v2Impl.waitForDeployment();
    await vault.connect(admin).upgradeToAndCall(await v2Impl.getAddress(), "0x");

    const v2Vault = V2Factory.attach(await vault.getAddress()) as Contract;
    const configAfter = await v2Vault.strategies(stratAddr);
    console.log("[DEBUG] strategy active after upgrade:", configAfter.isActive);
    expect(configAfter.isActive).to.be.true;
  });
});
