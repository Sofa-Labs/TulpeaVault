import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — Deposit", function () {
  let vault: Contract;
  let usdc: Contract;
  let admin: Signer;
  let user1: Signer;
  let user2: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let user2Addr: string;

  const DEPOSIT_LIMIT = ethers.parseUnits("1000000", 18);
  const SHARE_SCALE = 1_000_000n;

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
    console.log("[DEBUG] USDC deployed at:", await usdc.getAddress());

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
    console.log("[DEBUG] Vault proxy at:", await vault.getAddress());

    const mintAmount = ethers.parseUnits("100000", 18);
    await usdc.mint(user1Addr, mintAmount);
    await usdc.mint(user2Addr, mintAmount);
    await usdc.mint(adminAddr, mintAmount);

    const vaultAddr = await vault.getAddress();
    await usdc.connect(user1).approve(vaultAddr, ethers.MaxUint256);
    await usdc.connect(user2).approve(vaultAddr, ethers.MaxUint256);
    await usdc.connect(admin).approve(vaultAddr, ethers.MaxUint256);
    console.log("[DEBUG] deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  it("should deposit and receive shares at 1:1 ratio (with decimals offset)", async function () {
    console.log("[DEBUG] test: deposit 1:1 ratio");
    const dep = ethers.parseUnits("10000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);
    const shares = await vault.balanceOf(user1Addr);
    console.log("[DEBUG] shares:", shares.toString());
    expect(shares).to.equal(dep * SHARE_SCALE);
  });

  it("should update vault USDC balance on deposit", async function () {
    console.log("[DEBUG] test: vault balance update");
    const dep = ethers.parseUnits("5000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);
    const bal = await usdc.balanceOf(await vault.getAddress());
    console.log("[DEBUG] vault balance:", bal.toString());
    expect(bal).to.equal(dep);
  });

  it("should update totalAssets on deposit", async function () {
    console.log("[DEBUG] test: totalAssets update");
    const dep = ethers.parseUnits("5000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);
    expect(await vault.totalAssets()).to.equal(dep);
  });

  it("should reject deposit over limit", async function () {
    console.log("[DEBUG] test: deposit limit");
    const overLimit = DEPOSIT_LIMIT + 1n;
    await usdc.mint(user1Addr, overLimit);
    // OZ ERC4626 checks maxDeposit() first, which returns 0 when over limit
    await expect(vault.connect(user1).deposit(overLimit, user1Addr)).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxDeposit");
  });

  it("should allow deposit up to limit", async function () {
    console.log("[DEBUG] test: deposit at limit");
    // User already has 100k from fixture; mint more to reach 1M limit
    await usdc.mint(user1Addr, DEPOSIT_LIMIT);
    await vault.connect(user1).deposit(DEPOSIT_LIMIT, user1Addr);
    expect(await vault.totalAssets()).to.equal(DEPOSIT_LIMIT);
  });

  it("should allow unlimited deposits when limit is 0", async function () {
    console.log("[DEBUG] test: unlimited deposits");
    await vault.connect(admin).setDepositLimit(0);
    const big = ethers.parseUnits("100000", 18);
    await vault.connect(user1).deposit(big, user1Addr);
    expect(await vault.totalAssets()).to.equal(big);
  });

  it("should reject deposit when paused", async function () {
    console.log("[DEBUG] test: paused deposit");
    await vault.connect(admin).pause();
    const dep = ethers.parseUnits("1000", 18);
    // OZ ERC4626 checks maxDeposit() first, which returns 0 when paused
    await expect(vault.connect(user1).deposit(dep, user1Addr)).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxDeposit");
  });

  it("should allow deposit after unpause", async function () {
    console.log("[DEBUG] test: unpause deposit");
    await vault.connect(admin).pause();
    await vault.connect(admin).unpause();
    const dep = ethers.parseUnits("1000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);
    expect(await vault.totalAssets()).to.equal(dep);
  });

  it("should handle mint (share-denominated deposit)", async function () {
    console.log("[DEBUG] test: mint");
    const sharesToMint = ethers.parseUnits("1000", 24); // 24 decimals (18+6)
    await vault.connect(user1).mint(sharesToMint, user1Addr);
    const bal = await vault.balanceOf(user1Addr);
    console.log("[DEBUG] balance after mint:", bal.toString());
    expect(bal).to.equal(sharesToMint);
  });

  it("should report maxDeposit correctly", async function () {
    console.log("[DEBUG] test: maxDeposit");
    const dep = ethers.parseUnits("50000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);
    const maxDep = await vault.maxDeposit(user1Addr);
    console.log("[DEBUG] maxDeposit:", maxDep.toString());
    expect(maxDep).to.equal(DEPOSIT_LIMIT - dep);
  });

  it("should return maxDeposit=0 when paused", async function () {
    console.log("[DEBUG] test: maxDeposit paused");
    await vault.connect(admin).pause();
    expect(await vault.maxDeposit(user1Addr)).to.equal(0);
  });

  it("should handle multiple users depositing", async function () {
    console.log("[DEBUG] test: multi-user deposit");
    const dep1 = ethers.parseUnits("10000", 18);
    const dep2 = ethers.parseUnits("20000", 18);
    await vault.connect(user1).deposit(dep1, user1Addr);
    await vault.connect(user2).deposit(dep2, user2Addr);
    expect(await vault.totalAssets()).to.equal(dep1 + dep2);
    expect(await usdc.balanceOf(await vault.getAddress())).to.equal(dep1 + dep2);
  });

  it("should convert shares to assets correctly via convertToAssets", async function () {
    console.log("[DEBUG] test: convertToAssets");
    const dep = ethers.parseUnits("10000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);
    const shares = await vault.balanceOf(user1Addr);
    const assets = await vault.convertToAssets(shares);
    console.log("[DEBUG] assets:", assets.toString());
    // Due to rounding, assets should be very close to deposit
    expect(assets).to.be.closeTo(dep, ethers.parseUnits("1", 12)); // within dust
  });

  it("should handle zero deposit gracefully", async function () {
    console.log("[DEBUG] test: zero deposit");
    // Zero deposit mints 0 shares — OZ ERC4626 allows it (no revert)
    await vault.connect(user1).deposit(0, user1Addr);
    expect(await vault.balanceOf(user1Addr)).to.equal(0);
  });
});
