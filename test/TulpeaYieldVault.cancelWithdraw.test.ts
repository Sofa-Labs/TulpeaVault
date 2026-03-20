import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — cancelWithdraw", function () {
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

  it("should cancel and re-mint original shares", async function () {
    console.log("[DEBUG] test: cancel withdraw");
    const sharesBefore = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(sharesBefore, user1Addr, user1Addr);
    expect(await vault.balanceOf(user1Addr)).to.equal(0);

    await vault.connect(user1).cancelWithdraw();
    const sharesAfter = await vault.balanceOf(user1Addr);
    console.log("[DEBUG] shares before:", sharesBefore.toString(), "after:", sharesAfter.toString());
    expect(sharesAfter).to.equal(sharesBefore);
  });

  it("should clear pending state", async function () {
    console.log("[DEBUG] test: clear pending");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
    await vault.connect(user1).cancelWithdraw();

    expect(await vault.pendingWithdrawalShares(user1Addr)).to.equal(0);
    expect(await vault.totalPendingShares()).to.equal(0);
  });

  it("should emit WithdrawalCancelled event", async function () {
    console.log("[DEBUG] test: WithdrawalCancelled event");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
    await expect(vault.connect(user1).cancelWithdraw())
      .to.emit(vault, "WithdrawalCancelled")
      .withArgs(user1Addr, shares);
  });

  it("should reject if nothing pending", async function () {
    console.log("[DEBUG] test: nothing pending");
    await expect(vault.connect(user1).cancelWithdraw())
      .to.be.revertedWithCustomError(vault, "NothingPending");
  });

  it("should reject when paused", async function () {
    console.log("[DEBUG] test: paused cancel");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
    await vault.connect(admin).pause();
    await expect(vault.connect(user1).cancelWithdraw())
      .to.be.revertedWithCustomError(vault, "EnforcedPause");
  });

  it("should allow deposit after cancel (no WithdrawalAlreadyPending)", async function () {
    console.log("[DEBUG] test: deposit after cancel");
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
    await vault.connect(user1).cancelWithdraw();

    // Should be able to request again
    const newShares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(newShares, user1Addr, user1Addr);
    expect(await vault.pendingWithdrawalShares(user1Addr)).to.be.gt(0);
  });
});
