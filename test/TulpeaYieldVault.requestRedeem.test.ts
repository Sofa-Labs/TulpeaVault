import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — requestRedeem", function () {
  let vault: Contract;
  let usdc: Contract;
  let admin: Signer;
  let user1: Signer;
  let user2: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let user2Addr: string;

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

    // User1 deposits 10k
    await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);
    // User2 deposits 20k
    await vault.connect(user2).deposit(ethers.parseUnits("20000", 18), user2Addr);
    console.log("[DEBUG] deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  it("should burn shares and record pending withdrawal", async function () {
    console.log("[DEBUG] test: requestRedeem");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

    expect(await vault.balanceOf(user1Addr)).to.equal(0);
    const pendingShares = await vault.pendingRedeemRequest(0, user1Addr);
    const pending = await vault.convertToAssets(pendingShares);
    console.log("[DEBUG] pending shares:", pendingShares.toString(), "assets:", pending.toString());
    expect(pending).to.be.gt(0);
  });

  it("should emit RedeemRequest event", async function () {
    console.log("[DEBUG] test: RedeemRequest event");
    const shares = await vault.balanceOf(user1Addr);
    await expect(vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr))
      .to.emit(vault, "RedeemRequest");
  });

  it("should track pending withdrawal shares", async function () {
    console.log("[DEBUG] test: pending shares");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

    const pendingShares = await vault.pendingWithdrawalShares(user1Addr);
    console.log("[DEBUG] pending shares:", pendingShares.toString());
    expect(pendingShares).to.equal(shares);
  });

  it("should update totalPendingShares", async function () {
    console.log("[DEBUG] test: totalPendingShares");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

    const total = await vault.totalPendingShares();
    console.log("[DEBUG] totalPendingShares:", total.toString());
    expect(total).to.equal(shares);
  });

  it("should reject zero shares", async function () {
    console.log("[DEBUG] test: zero shares");
    await expect(vault.connect(user1).requestRedeem(0, user1Addr, user1Addr))
      .to.be.revertedWithCustomError(vault, "ZeroShares");
  });

  it("should reject if already has pending withdrawal", async function () {
    console.log("[DEBUG] test: already pending");
    const shares = await vault.balanceOf(user1Addr);
    const half = shares / 2n;
    await vault.connect(user1).requestRedeem(half, user1Addr, user1Addr);
    await expect(vault.connect(user1).requestRedeem(half, user1Addr, user1Addr))
      .to.be.revertedWithCustomError(vault, "WithdrawalAlreadyPending");
  });

  it("should reject when paused", async function () {
    console.log("[DEBUG] test: paused requestRedeem");
    await vault.connect(admin).pause();
    const shares = await vault.balanceOf(user1Addr);
    await expect(vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr))
      .to.be.revertedWithCustomError(vault, "EnforcedPause");
  });

  it("should allow partial redemption", async function () {
    console.log("[DEBUG] test: partial redeem");
    const shares = await vault.balanceOf(user1Addr);
    const half = shares / 2n;
    await vault.connect(user1).requestRedeem(half, user1Addr, user1Addr);

    expect(await vault.balanceOf(user1Addr)).to.equal(shares - half);
    const pendingShares = await vault.pendingWithdrawalShares(user1Addr);
    console.log("[DEBUG] pending shares after partial:", pendingShares.toString());
    expect(pendingShares).to.equal(half);
  });

  it("should return correct pending via pendingRedeemRequest (ERC-7540)", async function () {
    console.log("[DEBUG] test: pendingRedeemRequest");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

    const pendingSharesVal = await vault.pendingRedeemRequest(0, user1Addr);
    const pending = await vault.convertToAssets(pendingSharesVal);
    console.log("[DEBUG] pendingRedeemRequest shares:", pendingSharesVal.toString(), "assets:", pending.toString());
    expect(pending).to.be.gt(0);
  });

  it("should handle multiple users requesting redeem", async function () {
    console.log("[DEBUG] test: multi-user redeem");
    const shares1 = await vault.balanceOf(user1Addr);
    const shares2 = await vault.balanceOf(user2Addr);

    await vault.connect(user1).requestRedeem(shares1, user1Addr, user1Addr);
    await vault.connect(user2).requestRedeem(shares2, user2Addr, user2Addr);

    const totalShares = await vault.totalPendingShares();
    const ps1 = await vault.pendingWithdrawalShares(user1Addr);
    const ps2 = await vault.pendingWithdrawalShares(user2Addr);
    console.log("[DEBUG] total pending shares:", totalShares.toString(), "ps1:", ps1.toString(), "ps2:", ps2.toString());
    expect(totalShares).to.equal(ps1 + ps2);
  });

  it("should NOT reduce totalSupply after requestRedeem (escrow model)", async function () {
    console.log("[DEBUG] test: totalSupply unchanged (escrow)");
    const supplyBefore = await vault.totalSupply();
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
    const supplyAfter = await vault.totalSupply();

    console.log("[DEBUG] supply before:", supplyBefore.toString(), "after:", supplyAfter.toString());
    // Escrow model: shares transferred to vault, totalSupply unchanged
    expect(supplyAfter).to.equal(supplyBefore);
  });
});
