import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — ERC-7540 Operator", function () {
  let vault: Contract;
  let usdc: Contract;
  let admin: Signer;
  let user1: Signer;
  let operator: Signer;
  let randomUser: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let operatorAddr: string;
  let randomAddr: string;

  async function deployFixture() {
    console.log("[DEBUG] deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    operator = signers[2];
    randomUser = signers[3];
    adminAddr = await admin.getAddress();
    user1Addr = await user1.getAddress();
    operatorAddr = await operator.getAddress();
    randomAddr = await randomUser.getAddress();

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

    // User1 deposits 10k
    await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);
    console.log("[DEBUG] deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // ═══════════════════════════════════════════════════════════
  // setOperator / isOperator
  // ═══════════════════════════════════════════════════════════

  describe("setOperator", function () {
    it("should approve an operator", async function () {
      console.log("[DEBUG] test: approve operator");
      expect(await vault.isOperator(user1Addr, operatorAddr)).to.equal(false);

      await vault.connect(user1).setOperator(operatorAddr, true);

      expect(await vault.isOperator(user1Addr, operatorAddr)).to.equal(true);
      console.log("[DEBUG] operator approved successfully");
    });

    it("should revoke an operator", async function () {
      console.log("[DEBUG] test: revoke operator");
      await vault.connect(user1).setOperator(operatorAddr, true);
      expect(await vault.isOperator(user1Addr, operatorAddr)).to.equal(true);

      await vault.connect(user1).setOperator(operatorAddr, false);

      expect(await vault.isOperator(user1Addr, operatorAddr)).to.equal(false);
      console.log("[DEBUG] operator revoked successfully");
    });

    it("should emit OperatorSet event on approve", async function () {
      console.log("[DEBUG] test: OperatorSet event approve");
      await expect(vault.connect(user1).setOperator(operatorAddr, true))
        .to.emit(vault, "OperatorSet")
        .withArgs(user1Addr, operatorAddr, true);
    });

    it("should emit OperatorSet event on revoke", async function () {
      console.log("[DEBUG] test: OperatorSet event revoke");
      await vault.connect(user1).setOperator(operatorAddr, true);
      await expect(vault.connect(user1).setOperator(operatorAddr, false))
        .to.emit(vault, "OperatorSet")
        .withArgs(user1Addr, operatorAddr, false);
    });

    it("should return true", async function () {
      console.log("[DEBUG] test: setOperator return value");
      const result = await vault.connect(user1).setOperator.staticCall(operatorAddr, true);
      expect(result).to.equal(true);
      console.log("[DEBUG] returned true");
    });

    it("should not affect other users' operators", async function () {
      console.log("[DEBUG] test: operator isolation");
      await vault.connect(user1).setOperator(operatorAddr, true);

      // operator is approved for user1, not for randomUser
      expect(await vault.isOperator(user1Addr, operatorAddr)).to.equal(true);
      expect(await vault.isOperator(randomAddr, operatorAddr)).to.equal(false);
      console.log("[DEBUG] operator scoped correctly");
    });

    it("should allow multiple operators for same user", async function () {
      console.log("[DEBUG] test: multiple operators");
      await vault.connect(user1).setOperator(operatorAddr, true);
      await vault.connect(user1).setOperator(randomAddr, true);

      expect(await vault.isOperator(user1Addr, operatorAddr)).to.equal(true);
      expect(await vault.isOperator(user1Addr, randomAddr)).to.equal(true);
      console.log("[DEBUG] multiple operators work");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // requestRedeem via operator
  // ═══════════════════════════════════════════════════════════

  describe("requestRedeem via operator", function () {
    it("should allow operator to requestRedeem on behalf of owner", async function () {
      console.log("[DEBUG] test: operator requestRedeem");
      await vault.connect(user1).setOperator(operatorAddr, true);

      const shares = await vault.balanceOf(user1Addr);
      console.log("[DEBUG] user1 shares:", shares.toString());

      // operator requests redeem: shares from user1, pending stored under user1 (controller)
      await vault.connect(operator).requestRedeem(shares, user1Addr, user1Addr);

      expect(await vault.balanceOf(user1Addr)).to.equal(0);
      const pending = await vault.pendingRedeemRequest(0, user1Addr);
      expect(pending).to.equal(shares);
      console.log("[DEBUG] operator requestRedeem succeeded, pending:", pending.toString());
    });

    it("should allow operator to requestRedeem with different controller", async function () {
      console.log("[DEBUG] test: operator requestRedeem different controller");
      await vault.connect(user1).setOperator(operatorAddr, true);

      const shares = await vault.balanceOf(user1Addr);

      // operator requests: shares from user1, pending stored under operator (as controller)
      await vault.connect(operator).requestRedeem(shares, operatorAddr, user1Addr);

      expect(await vault.balanceOf(user1Addr)).to.equal(0);
      const pending = await vault.pendingRedeemRequest(0, operatorAddr);
      expect(pending).to.equal(shares);
      console.log("[DEBUG] pending stored under operator as controller");
    });

    it("should emit RedeemRequest with correct fields", async function () {
      console.log("[DEBUG] test: operator requestRedeem event");
      await vault.connect(user1).setOperator(operatorAddr, true);
      const shares = await vault.balanceOf(user1Addr);

      await expect(vault.connect(operator).requestRedeem(shares, user1Addr, user1Addr))
        .to.emit(vault, "RedeemRequest")
        .withArgs(user1Addr, user1Addr, 0, operatorAddr, await vault.convertToAssets(shares));
    });

    it("should revert if caller is not owner and not operator", async function () {
      console.log("[DEBUG] test: unauthorized requestRedeem");
      const shares = await vault.balanceOf(user1Addr);

      await expect(
        vault.connect(operator).requestRedeem(shares, user1Addr, user1Addr)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
      console.log("[DEBUG] unauthorized reverted correctly");
    });

    it("should revert after operator is revoked", async function () {
      console.log("[DEBUG] test: revoked operator requestRedeem");
      await vault.connect(user1).setOperator(operatorAddr, true);
      await vault.connect(user1).setOperator(operatorAddr, false);

      const shares = await vault.balanceOf(user1Addr);
      await expect(
        vault.connect(operator).requestRedeem(shares, user1Addr, user1Addr)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
      console.log("[DEBUG] revoked operator correctly blocked");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // withdraw/redeem (claim) via operator
  // ═══════════════════════════════════════════════════════════

  describe("claim via operator", function () {
    // Helper: deposit → requestRedeem → fulfillRedeem so user1 has claimable funds
    async function setupClaimable() {
      console.log("[DEBUG] setupClaimable: start");
      const shares = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
      await vault.connect(admin).fulfillRedeem(user1Addr);
      const claimable = await vault.claimableWithdrawals(user1Addr);
      console.log("[DEBUG] setupClaimable: claimable =", claimable.toString());
      return claimable;
    }

    it("should allow operator to withdraw on behalf of owner", async function () {
      console.log("[DEBUG] test: operator withdraw");
      const claimable = await setupClaimable();
      await vault.connect(user1).setOperator(operatorAddr, true);

      const balBefore = await usdc.balanceOf(operatorAddr);
      // operator claims user1's funds, sends to operator's own address
      await vault.connect(operator).withdraw(claimable, operatorAddr, user1Addr);
      const balAfter = await usdc.balanceOf(operatorAddr);

      expect(balAfter - balBefore).to.equal(claimable);
      expect(await vault.claimableWithdrawals(user1Addr)).to.equal(0);
      console.log("[DEBUG] operator withdrew:", (balAfter - balBefore).toString());
    });

    it("should allow operator to redeem on behalf of owner", async function () {
      console.log("[DEBUG] test: operator redeem");
      await setupClaimable();
      await vault.connect(user1).setOperator(operatorAddr, true);

      const claimShares = await vault.claimableWithdrawalShares(user1Addr);
      const balBefore = await usdc.balanceOf(operatorAddr);

      await vault.connect(operator).redeem(claimShares, operatorAddr, user1Addr);

      const balAfter = await usdc.balanceOf(operatorAddr);
      expect(balAfter).to.be.gt(balBefore);
      expect(await vault.claimableWithdrawals(user1Addr)).to.equal(0);
      console.log("[DEBUG] operator redeemed:", (balAfter - balBefore).toString());
    });

    it("should allow operator to send funds to a third party receiver", async function () {
      console.log("[DEBUG] test: operator claim to third party");
      const claimable = await setupClaimable();
      await vault.connect(user1).setOperator(operatorAddr, true);

      const balBefore = await usdc.balanceOf(randomAddr);
      // operator claims user1's funds → sends to randomUser
      await vault.connect(operator).withdraw(claimable, randomAddr, user1Addr);
      const balAfter = await usdc.balanceOf(randomAddr);

      expect(balAfter - balBefore).to.equal(claimable);
      console.log("[DEBUG] funds sent to third party:", (balAfter - balBefore).toString());
    });

    it("should revert withdraw if caller is not owner and not operator", async function () {
      console.log("[DEBUG] test: unauthorized withdraw");
      const claimable = await setupClaimable();

      await expect(
        vault.connect(operator).withdraw(claimable, operatorAddr, user1Addr)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
      console.log("[DEBUG] unauthorized withdraw blocked");
    });

    it("should revert redeem if caller is not owner and not operator", async function () {
      console.log("[DEBUG] test: unauthorized redeem");
      await setupClaimable();
      const claimShares = await vault.claimableWithdrawalShares(user1Addr);

      await expect(
        vault.connect(operator).redeem(claimShares, operatorAddr, user1Addr)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
      console.log("[DEBUG] unauthorized redeem blocked");
    });

    it("should revert after operator is revoked", async function () {
      console.log("[DEBUG] test: revoked operator claim");
      const claimable = await setupClaimable();
      await vault.connect(user1).setOperator(operatorAddr, true);
      await vault.connect(user1).setOperator(operatorAddr, false);

      await expect(
        vault.connect(operator).withdraw(claimable, operatorAddr, user1Addr)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
      console.log("[DEBUG] revoked operator claim blocked");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Full operator flow (end-to-end)
  // ═══════════════════════════════════════════════════════════

  describe("full operator flow E2E", function () {
    it("should complete full cycle: setOperator → requestRedeem → fulfill → withdraw", async function () {
      console.log("[DEBUG] test: full operator E2E flow");

      // Step 1: user1 approves operator
      await vault.connect(user1).setOperator(operatorAddr, true);
      console.log("[DEBUG] step 1: operator approved");

      // Step 2: operator requests redeem on behalf of user1
      const shares = await vault.balanceOf(user1Addr);
      await vault.connect(operator).requestRedeem(shares, user1Addr, user1Addr);
      console.log("[DEBUG] step 2: requestRedeem by operator, shares:", shares.toString());

      // Step 3: admin fulfills
      await vault.connect(admin).fulfillRedeem(user1Addr);
      const claimable = await vault.claimableWithdrawals(user1Addr);
      console.log("[DEBUG] step 3: fulfilled, claimable:", claimable.toString());

      // Step 4: operator claims on behalf of user1, sends to user1
      const balBefore = await usdc.balanceOf(user1Addr);
      await vault.connect(operator).withdraw(claimable, user1Addr, user1Addr);
      const balAfter = await usdc.balanceOf(user1Addr);

      expect(balAfter - balBefore).to.equal(claimable);
      expect(await vault.claimableWithdrawals(user1Addr)).to.equal(0);
      expect(await vault.balanceOf(user1Addr)).to.equal(0);
      console.log("[DEBUG] step 4: operator claimed for user1, received:", (balAfter - balBefore).toString());
    });

    it("should allow operator to requestRedeem and claim to own address", async function () {
      console.log("[DEBUG] test: operator claims to self");

      await vault.connect(user1).setOperator(operatorAddr, true);

      // operator requests redeem, controller = user1
      const shares = await vault.balanceOf(user1Addr);
      await vault.connect(operator).requestRedeem(shares, user1Addr, user1Addr);

      await vault.connect(admin).fulfillRedeem(user1Addr);
      const claimable = await vault.claimableWithdrawals(user1Addr);

      // operator sends funds to itself
      const balBefore = await usdc.balanceOf(operatorAddr);
      await vault.connect(operator).withdraw(claimable, operatorAddr, user1Addr);
      const balAfter = await usdc.balanceOf(operatorAddr);

      expect(balAfter - balBefore).to.equal(claimable);
      console.log("[DEBUG] operator received funds to own address:", (balAfter - balBefore).toString());
    });

    it("should allow partial claim by operator", async function () {
      console.log("[DEBUG] test: operator partial claim");

      await vault.connect(user1).setOperator(operatorAddr, true);

      const shares = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
      await vault.connect(admin).fulfillRedeem(user1Addr);

      const claimable = await vault.claimableWithdrawals(user1Addr);
      const halfClaim = claimable / 2n;
      console.log("[DEBUG] total claimable:", claimable.toString(), "claiming half:", halfClaim.toString());

      // operator claims half
      await vault.connect(operator).withdraw(halfClaim, operatorAddr, user1Addr);

      const remaining = await vault.claimableWithdrawals(user1Addr);
      expect(remaining).to.be.gt(0);
      console.log("[DEBUG] remaining after partial:", remaining.toString());

      // operator claims the rest
      await vault.connect(operator).withdraw(remaining, operatorAddr, user1Addr);
      expect(await vault.claimableWithdrawals(user1Addr)).to.equal(0);
      console.log("[DEBUG] fully claimed by operator in two steps");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // cancelWithdraw — operator cannot cancel (msg.sender only)
  // ═══════════════════════════════════════════════════════════

  describe("cancelWithdraw — no operator support", function () {
    it("should NOT allow operator to cancel withdrawal (msg.sender only)", async function () {
      console.log("[DEBUG] test: operator cannot cancelWithdraw");

      await vault.connect(user1).setOperator(operatorAddr, true);
      const shares = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

      // operator tries to cancel — will revert because cancelWithdraw uses msg.sender
      // and operator has no pending shares under their own address
      await expect(
        vault.connect(operator).cancelWithdraw()
      ).to.be.revertedWithCustomError(vault, "NothingPending");
      console.log("[DEBUG] operator correctly cannot cancel user's withdrawal");
    });

    it("should allow owner to cancel their own withdrawal", async function () {
      console.log("[DEBUG] test: owner can cancelWithdraw");

      const shares = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

      await vault.connect(user1).cancelWithdraw();

      expect(await vault.balanceOf(user1Addr)).to.equal(shares);
      expect(await vault.pendingRedeemRequest(0, user1Addr)).to.equal(0);
      console.log("[DEBUG] owner cancelled successfully, shares restored:", shares.toString());
    });
  });
});
