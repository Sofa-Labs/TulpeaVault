import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — withdraw/redeem (claim)", function () {
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

    // Deposit, request redeem, fulfill
    const dep = ethers.parseUnits("10000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
    await vault.connect(admin).fulfillRedeem(user1Addr);
    console.log("[DEBUG] deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  it("should claim via redeem (share-based)", async function () {
    console.log("[DEBUG] test: redeem claim");
    const claimShares = await vault.claimableWithdrawalShares(user1Addr);
    const balBefore = await usdc.balanceOf(user1Addr);

    await vault.connect(user1).redeem(claimShares, user1Addr, user1Addr);

    const balAfter = await usdc.balanceOf(user1Addr);
    console.log("[DEBUG] USDC received:", (balAfter - balBefore).toString());
    expect(balAfter).to.be.gt(balBefore);
    expect(await vault.claimableWithdrawals(user1Addr)).to.equal(0);
  });

  it("should claim via withdraw (asset-based)", async function () {
    console.log("[DEBUG] test: withdraw claim");
    const claimable = await vault.claimableWithdrawals(user1Addr);
    const balBefore = await usdc.balanceOf(user1Addr);

    await vault.connect(user1).withdraw(claimable, user1Addr, user1Addr);

    const balAfter = await usdc.balanceOf(user1Addr);
    console.log("[DEBUG] USDC received:", (balAfter - balBefore).toString());
    expect(balAfter - balBefore).to.equal(claimable);
  });

  it("should emit RedeemClaimed and Withdraw events", async function () {
    console.log("[DEBUG] test: claim events");
    const claimShares = await vault.claimableWithdrawalShares(user1Addr);
    await expect(vault.connect(user1).redeem(claimShares, user1Addr, user1Addr))
      .to.emit(vault, "RedeemClaimed");
  });

  it("should support partial claim via redeem", async function () {
    console.log("[DEBUG] test: partial claim");
    const claimShares = await vault.claimableWithdrawalShares(user1Addr);
    const half = claimShares / 2n;

    await vault.connect(user1).redeem(half, user1Addr, user1Addr);

    const remaining = await vault.claimableWithdrawalShares(user1Addr);
    console.log("[DEBUG] remaining shares:", remaining.toString());
    expect(remaining).to.equal(claimShares - half);
  });

  it("should support partial claim via withdraw", async function () {
    console.log("[DEBUG] test: partial withdraw");
    const claimable = await vault.claimableWithdrawals(user1Addr);
    const half = claimable / 2n;

    await vault.connect(user1).withdraw(half, user1Addr, user1Addr);

    const remaining = await vault.claimableWithdrawals(user1Addr);
    console.log("[DEBUG] remaining:", remaining.toString());
    expect(remaining).to.equal(claimable - half);
  });

  it("should update totalWithdrawn", async function () {
    console.log("[DEBUG] test: totalWithdrawn");
    const claimShares = await vault.claimableWithdrawalShares(user1Addr);
    await vault.connect(user1).redeem(claimShares, user1Addr, user1Addr);

    const withdrawn = await vault.totalWithdrawn(user1Addr);
    console.log("[DEBUG] totalWithdrawn:", withdrawn.toString());
    expect(withdrawn).to.be.gt(0);
  });

  it("should update vault balance on claim", async function () {
    console.log("[DEBUG] test: vault balance update");
    const vaultAddr = await vault.getAddress();
    const idleBefore = await usdc.balanceOf(vaultAddr);
    const claimable = await vault.claimableWithdrawals(user1Addr);
    await vault.connect(user1).withdraw(claimable, user1Addr, user1Addr);
    const idleAfter = await usdc.balanceOf(vaultAddr);

    console.log("[DEBUG] idle before:", idleBefore.toString(), "after:", idleAfter.toString());
    expect(idleAfter).to.equal(idleBefore - claimable);
  });

  it("should reject claiming more than claimable (redeem)", async function () {
    console.log("[DEBUG] test: exceed claimable shares");
    const claimShares = await vault.claimableWithdrawalShares(user1Addr);
    await expect(vault.connect(user1).redeem(claimShares + 1n, user1Addr, user1Addr))
      .to.be.revertedWithCustomError(vault, "ExceedsClaimable");
  });

  it("should reject claiming more than claimable (withdraw)", async function () {
    console.log("[DEBUG] test: exceed claimable assets");
    const claimable = await vault.claimableWithdrawals(user1Addr);
    await expect(vault.connect(user1).withdraw(claimable + 1n, user1Addr, user1Addr))
      .to.be.revertedWithCustomError(vault, "ExceedsClaimable");
  });

  it("should reject zero claim", async function () {
    console.log("[DEBUG] test: zero claim");
    await expect(vault.connect(user1).redeem(0, user1Addr, user1Addr))
      .to.be.revertedWithCustomError(vault, "ZeroShares");
    await expect(vault.connect(user1).withdraw(0, user1Addr, user1Addr))
      .to.be.revertedWithCustomError(vault, "ZeroAssets");
  });

  it("should reject claim by non-owner", async function () {
    console.log("[DEBUG] test: non-owner claim");
    const claimShares = await vault.claimableWithdrawalShares(user1Addr);
    await expect(vault.connect(admin).redeem(claimShares, adminAddr, user1Addr))
      .to.be.revertedWithCustomError(vault, "Unauthorized");
  });

  it("should handle rounding dust — final 1-wei claim succeeds", async function () {
    console.log("[DEBUG] test: rounding dust");
    const claimable = await vault.claimableWithdrawals(user1Addr);
    const claimShares = await vault.claimableWithdrawalShares(user1Addr);

    // Partial claim 1: ~1/3 of shares
    const third = claimShares / 3n;
    await vault.connect(user1).redeem(third, user1Addr, user1Addr);

    // Partial claim 2: ~1/3 of shares
    await vault.connect(user1).redeem(third, user1Addr, user1Addr);

    // Final claim: remaining shares (may have 1-wei rounding dust)
    const remainingShares = await vault.claimableWithdrawalShares(user1Addr);
    const remainingAssets = await vault.claimableWithdrawals(user1Addr);
    console.log("[DEBUG] remaining shares:", remainingShares.toString(), "remaining assets:", remainingAssets.toString());

    // This should NOT revert due to rounding dust
    await vault.connect(user1).redeem(remainingShares, user1Addr, user1Addr);

    expect(await vault.claimableWithdrawals(user1Addr)).to.equal(0);
    expect(await vault.claimableWithdrawalShares(user1Addr)).to.equal(0);
    console.log("[DEBUG] rounding dust test passed — all claimed cleanly");
  });

  it("should handle rounding dust — final 1-wei withdraw succeeds", async function () {
    console.log("[DEBUG] test: rounding dust withdraw");
    const claimable = await vault.claimableWithdrawals(user1Addr);

    // Partial withdrawals
    const third = claimable / 3n;
    await vault.connect(user1).withdraw(third, user1Addr, user1Addr);
    await vault.connect(user1).withdraw(third, user1Addr, user1Addr);

    // Final claim: remaining assets
    const remainingAssets = await vault.claimableWithdrawals(user1Addr);
    console.log("[DEBUG] remaining assets:", remainingAssets.toString());

    // This should NOT revert due to rounding dust
    await vault.connect(user1).withdraw(remainingAssets, user1Addr, user1Addr);

    expect(await vault.claimableWithdrawals(user1Addr)).to.equal(0);
    expect(await vault.claimableWithdrawalShares(user1Addr)).to.equal(0);
    console.log("[DEBUG] rounding dust withdraw test passed — all claimed cleanly");
  });
});
