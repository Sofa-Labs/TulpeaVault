import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — Pause", function () {
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

  it("should pause and unpause", async function () {
    console.log("[DEBUG] test: pause/unpause");
    await vault.connect(admin).pause();
    expect(await vault.paused()).to.be.true;
    await vault.connect(admin).unpause();
    expect(await vault.paused()).to.be.false;
  });

  it("should block deposits when paused", async function () {
    console.log("[DEBUG] test: deposit blocked");
    await vault.connect(admin).pause();
    // OZ ERC4626 checks maxDeposit first (returns 0 when paused), so we get ERC4626ExceededMaxDeposit
    await expect(vault.connect(user1).deposit(ethers.parseUnits("1000", 18), user1Addr))
      .to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxDeposit");
  });

  it("should block requestRedeem when paused", async function () {
    console.log("[DEBUG] test: requestRedeem blocked");
    await vault.connect(admin).pause();
    const shares = await vault.balanceOf(user1Addr);
    await expect(vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr))
      .to.be.revertedWithCustomError(vault, "EnforcedPause");
  });

  it("should allow claim (redeem/withdraw) when paused", async function () {
    console.log("[DEBUG] test: claim allowed when paused");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
    await vault.connect(admin).fulfillRedeem(user1Addr);

    await vault.connect(admin).pause();

    // Claims should still work
    const claimable = await vault.claimableWithdrawals(user1Addr);
    await expect(vault.connect(user1).withdraw(claimable, user1Addr, user1Addr)).to.not.be.reverted;
  });

  it("should reject non-owner pause", async function () {
    console.log("[DEBUG] test: non-owner pause");
    await expect(vault.connect(user1).pause())
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
  });

  it("should reject non-owner unpause", async function () {
    console.log("[DEBUG] test: non-owner unpause");
    await vault.connect(admin).pause();
    await expect(vault.connect(user1).unpause())
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
  });

  it("should return maxDeposit=0 when paused", async function () {
    console.log("[DEBUG] test: maxDeposit when paused");
    await vault.connect(admin).pause();
    expect(await vault.maxDeposit(user1Addr)).to.equal(0);
  });

  it("should return maxMint=0 when paused", async function () {
    console.log("[DEBUG] test: maxMint when paused");
    await vault.connect(admin).pause();
    expect(await vault.maxMint(user1Addr)).to.equal(0);
  });
});
