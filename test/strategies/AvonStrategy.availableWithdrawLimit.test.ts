import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

/**
 * Tests for AvonStrategy.availableWithdrawLimit() — previously untested IStrategy function.
 * Also covers emergencyWithdrawToken edge cases.
 *
 * NOTE: The MockSwapRouter doesn't handle DECIMAL_SCALE (USDm 18dec vs USDT 6dec),
 * so deposit() through swap is broken in tests. We test availableWithdrawLimit by
 * directly minting MegaVault shares to the strategy instead.
 */
describe("AvonStrategy — availableWithdrawLimit & Edge Cases", function () {
  let strategy: Contract;
  let usdt: Contract;
  let usdm: Contract;
  let router: Contract;
  let megaVault: Contract;
  let mockVault: Contract;
  let admin: Signer;
  let user1: Signer;
  let adminAddr: string;
  let vaultAddr: string;

  async function deployFixture() {
    console.log("[DEBUG] Avon availableWithdrawLimit deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    adminAddr = await admin.getAddress();

    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdt = await MockERC20.deploy();
    await usdt.waitForDeployment();

    usdm = await MockERC20.deploy();
    await usdm.waitForDeployment();

    const RouterFactory = await ethers.getContractFactory("MockSwapRouter");
    router = await RouterFactory.deploy();
    await router.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory("MockMegaVault");
    megaVault = await VaultFactory.deploy(await usdm.getAddress());
    await megaVault.waitForDeployment();

    const MockVaultFactory = await ethers.getContractFactory("MockVaultForStrategy");
    mockVault = await MockVaultFactory.deploy();
    await mockVault.waitForDeployment();
    vaultAddr = await mockVault.getAddress();

    const StrategyFactory = await ethers.getContractFactory("AvonStrategy");
    strategy = await StrategyFactory.deploy(
      await usdt.getAddress(),
      await usdm.getAddress(),
      await megaVault.getAddress(),
      await router.getAddress(),
      vaultAddr,
      adminAddr
    );
    await strategy.waitForDeployment();
    console.log("[DEBUG] Avon availableWithdrawLimit deployFixture: complete");
  }

  /**
   * Directly deposit USDm into MegaVault on behalf of the strategy.
   * This bypasses the broken swap mock (DECIMAL_SCALE issue).
   */
  async function depositDirectlyToMegaVault(usdmAmount: bigint) {
    const stratAddr = await strategy.getAddress();
    const megaVaultAddr = await megaVault.getAddress();

    // Mint USDm to admin, approve MegaVault, deposit for strategy
    await usdm.mint(adminAddr, usdmAmount);
    await usdm.connect(admin).approve(megaVaultAddr, usdmAmount);
    await megaVault.connect(admin).deposit(usdmAmount, stratAddr);
  }

  function randomBigInt(min: bigint, max: bigint): bigint {
    if (max <= min) return min;
    const range = max - min;
    const bits = range.toString(2).length;
    const bytes = Math.ceil(bits / 8);
    const randomBytes = ethers.randomBytes(bytes);
    let rand = BigInt("0x" + Buffer.from(randomBytes).toString("hex"));
    return min + (rand % (range + 1n));
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // ═══════════════════════════════════════════════════════════
  // availableWithdrawLimit()
  // ═══════════════════════════════════════════════════════════

  describe("availableWithdrawLimit", function () {
    it("should return 0 when strategy has nothing", async function () {
      console.log("[DEBUG] test: availableWithdrawLimit empty");
      const limit = await strategy.availableWithdrawLimit();
      console.log("[DEBUG] limit:", limit);
      expect(limit).to.equal(0);
    });

    it("should return only idle USDT when no MegaVault shares", async function () {
      console.log("[DEBUG] test: availableWithdrawLimit idle only");
      const amount = ethers.parseUnits("5000", 18);
      await usdt.mint(await strategy.getAddress(), amount);

      const limit = await strategy.availableWithdrawLimit();
      console.log("[DEBUG] limit:", limit);
      expect(limit).to.equal(amount);
    });

    it("should include discounted MegaVault redeemable value", async function () {
      console.log("[DEBUG] test: availableWithdrawLimit with MegaVault");
      // Directly deposit 10000 USDm into MegaVault for strategy
      const usdmAmount = ethers.parseUnits("10000", 18);
      await depositDirectlyToMegaVault(usdmAmount);

      const limit = await strategy.availableWithdrawLimit();
      const totalAssets = await strategy.totalAssets();
      console.log("[DEBUG] limit:", limit, "totalAssets:", totalAssets);

      // limit should be > 0 (has MegaVault shares)
      expect(limit).to.be.gt(0);
      // limit should be <= totalAssets (slippage discount)
      expect(limit).to.be.lte(totalAssets);
    });

    it("should return idle + discounted redeemable", async function () {
      console.log("[DEBUG] test: availableWithdrawLimit mixed");
      // Deposit USDm directly into MegaVault
      await depositDirectlyToMegaVault(ethers.parseUnits("5000", 18));

      // Add idle USDT
      const extraIdle = ethers.parseUnits("3000", 18);
      await usdt.mint(await strategy.getAddress(), extraIdle);

      const limit = await strategy.availableWithdrawLimit();
      console.log("[DEBUG] limit:", limit);
      // Should be at least extraIdle (idle + discounted MegaVault portion)
      expect(limit).to.be.gte(extraIdle);
    });

    it("should decrease after vault withdraws idle", async function () {
      console.log("[DEBUG] test: availableWithdrawLimit decreases after withdraw");
      const initial = ethers.parseUnits("10000", 18);
      await usdt.mint(await strategy.getAddress(), initial);

      const limitBefore = await strategy.availableWithdrawLimit();

      // Vault withdraws half
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddr]);
      const vaultSigner = await ethers.getSigner(vaultAddr);
      await admin.sendTransaction({ to: vaultAddr, value: ethers.parseEther("1") });
      await strategy.connect(vaultSigner).withdraw(ethers.parseUnits("5000", 18));
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddr]);

      const limitAfter = await strategy.availableWithdrawLimit();
      console.log("[DEBUG] before:", limitBefore, "after:", limitAfter);
      expect(limitAfter).to.be.lt(limitBefore);
    });

    it("should apply MAX_SLIPPAGE_BPS (0.5%) discount on MegaVault portion", async function () {
      console.log("[DEBUG] test: slippage discount calculation");
      const usdmAmount = ethers.parseUnits("100000", 18);
      await depositDirectlyToMegaVault(usdmAmount);

      // No idle USDT
      const idle = await usdt.balanceOf(await strategy.getAddress());
      expect(idle).to.equal(0);

      const limit = await strategy.availableWithdrawLimit();
      const totalAssets = await strategy.totalAssets();
      console.log("[DEBUG] limit:", limit, "totalAssets:", totalAssets);

      // limit should be ~99.5% of totalAssets (0.5% slippage discount)
      // DECIMAL_SCALE = 1e12, so totalAssets = usdmAmount / 1e12
      // redeemableUsdt = usdmAmount * 9950 / 10000 / 1e12
      const expectedLimit = usdmAmount * 9950n / 10000n / (10n ** 12n);
      console.log("[DEBUG] expectedLimit:", expectedLimit);
      expect(limit).to.equal(expectedLimit);
    });

    it("should return 0 when MegaVault is empty (no shares)", async function () {
      console.log("[DEBUG] test: availableWithdrawLimit no shares");
      // No idle, no shares
      const limit = await strategy.availableWithdrawLimit();
      expect(limit).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // emergencyWithdrawToken edge cases
  // ═══════════════════════════════════════════════════════════

  describe("emergencyWithdrawToken edge cases", function () {
    it("should recover USDm tokens stuck in strategy", async function () {
      console.log("[DEBUG] test: emergency recover USDm");
      const amount = ethers.parseUnits("1000", 18);
      await usdm.mint(await strategy.getAddress(), amount);

      const vaultBalBefore = await usdm.balanceOf(vaultAddr);
      await strategy.connect(admin).emergencyWithdrawToken(await usdm.getAddress(), amount);
      const vaultBalAfter = await usdm.balanceOf(vaultAddr);

      console.log("[DEBUG] recovered:", vaultBalAfter - vaultBalBefore);
      expect(vaultBalAfter - vaultBalBefore).to.equal(amount);
    });

    it("should recover the strategy's own asset token", async function () {
      console.log("[DEBUG] test: emergency recover asset");
      const amount = ethers.parseUnits("5000", 18);
      await usdt.mint(await strategy.getAddress(), amount);

      const vaultBalBefore = await usdt.balanceOf(vaultAddr);
      await strategy.connect(admin).emergencyWithdrawToken(await usdt.getAddress(), amount);
      const vaultBalAfter = await usdt.balanceOf(vaultAddr);

      expect(vaultBalAfter - vaultBalBefore).to.equal(amount);
    });

    it("should revert on zero amount", async function () {
      console.log("[DEBUG] test: emergency zero amount");
      await expect(
        strategy.connect(admin).emergencyWithdrawToken(await usdt.getAddress(), 0)
      ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("should revert when non-owner calls", async function () {
      console.log("[DEBUG] test: emergency non-owner");
      await expect(
        strategy.connect(user1).emergencyWithdrawToken(await usdt.getAddress(), 1)
      ).to.be.revertedWithCustomError(strategy, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Fuzz: availableWithdrawLimit invariants
  // ═══════════════════════════════════════════════════════════

  describe("fuzz: availableWithdrawLimit invariants", function () {
    const FUZZ_RUNS = 50;

    it(`availableWithdrawLimit <= totalAssets for ${FUZZ_RUNS} random states`, async function () {
      for (let i = 0; i < FUZZ_RUNS; i++) {
        await deployFixture();

        // Random idle USDT
        const idleAmount = randomBigInt(0n, ethers.parseUnits("50000", 18));
        if (idleAmount > 0n) {
          await usdt.mint(await strategy.getAddress(), idleAmount);
        }

        // Random MegaVault deposit (50% chance)
        if (randomBigInt(0n, 1n) === 1n) {
          const usdmAmt = randomBigInt(ethers.parseUnits("100", 18), ethers.parseUnits("100000", 18));
          await depositDirectlyToMegaVault(usdmAmt);
        }

        const limit = await strategy.availableWithdrawLimit();
        const total = await strategy.totalAssets();

        if (i % 10 === 0) {
          console.log(`[DEBUG] fuzz Avon limit run ${i}: limit=${ethers.formatUnits(limit, 18)}, total=${ethers.formatUnits(total, 18)}`);
        }

        expect(limit).to.be.lte(total, `Run ${i}: availableWithdrawLimit > totalAssets`);
      }
    });

    it(`availableWithdrawLimit >= idle USDT for ${FUZZ_RUNS} random states`, async function () {
      for (let i = 0; i < FUZZ_RUNS; i++) {
        await deployFixture();

        // Random idle USDT
        const idleAmount = randomBigInt(0n, ethers.parseUnits("50000", 18));
        if (idleAmount > 0n) {
          await usdt.mint(await strategy.getAddress(), idleAmount);
        }

        // Random MegaVault deposit
        const usdmAmt = randomBigInt(0n, ethers.parseUnits("50000", 18));
        if (usdmAmt > 0n) {
          await depositDirectlyToMegaVault(usdmAmt);
        }

        const limit = await strategy.availableWithdrawLimit();
        const idle = await usdt.balanceOf(await strategy.getAddress());

        if (i % 10 === 0) {
          console.log(`[DEBUG] fuzz Avon idle run ${i}: idle=${ethers.formatUnits(idle, 18)}, limit=${ethers.formatUnits(limit, 18)}`);
        }

        // availableWithdrawLimit includes idle + discounted MegaVault, so >= idle
        expect(limit).to.be.gte(idle, `Run ${i}: availableWithdrawLimit < idle`);
      }
    });

    it("extreme deposit amount (10M+ USDm) works correctly", async function () {
      console.log("[DEBUG] test: extreme deposit");
      const usdmAmount = ethers.parseUnits("10000000", 18); // 10M USDm
      await depositDirectlyToMegaVault(usdmAmount);

      const limit = await strategy.availableWithdrawLimit();
      const total = await strategy.totalAssets();
      console.log("[DEBUG] limit:", ethers.formatUnits(limit, 18), "total:", ethers.formatUnits(total, 18));

      expect(limit).to.be.gt(0);
      expect(limit).to.be.lte(total);
    });

    it("availableWithdrawLimit with MegaVault yield (share price increase)", async function () {
      console.log("[DEBUG] test: MegaVault yield");
      const usdmAmount = ethers.parseUnits("10000", 18);
      await depositDirectlyToMegaVault(usdmAmount);

      const limitBefore = await strategy.availableWithdrawLimit();

      // Simulate 10% yield in MegaVault
      await megaVault.simulateYield(ethers.parseUnits("1000", 18));

      const limitAfter = await strategy.availableWithdrawLimit();
      console.log("[DEBUG] before:", limitBefore, "after:", limitAfter);

      // After yield, redeemable value increases → limit should increase
      expect(limitAfter).to.be.gt(limitBefore);
    });
  });
});
