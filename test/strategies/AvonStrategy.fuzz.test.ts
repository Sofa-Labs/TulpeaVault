import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

const FUZZ_RUNS = 100;

describe("AvonStrategy — Fuzz Tests", function () {
  this.timeout(0);

  let strategy: Contract;
  let usdt: Contract;
  let usdm: Contract;
  let router: Contract;
  let megaVault: Contract;
  let mockVault: Contract;
  let admin: Signer;
  let adminAddr: string;
  let vaultAddr: string;

  async function deployFixture() {
    console.log("[DEBUG] fuzz Avon deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    adminAddr = await admin.getAddress();

    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdt = await MockERC20.deploy();
    await usdt.waitForDeployment();

    usdm = await MockERC20.deploy();
    await usdm.waitForDeployment();

    const RouterFactory = await ethers.getContractFactory("MockSwapRouter");
    router = await RouterFactory.deploy();
    await router.waitForDeployment();

    // No need to fund router — MockSwapRouter mints output tokens

    const VaultFactory = await ethers.getContractFactory("MockMegaVault");
    megaVault = await VaultFactory.deploy(await usdm.getAddress());
    await megaVault.waitForDeployment();

    // Deploy MockVaultForStrategy (provides keeper() view)
    const MockVaultFactory = await ethers.getContractFactory("MockVaultForStrategy");
    mockVault = await MockVaultFactory.deploy();
    await mockVault.waitForDeployment();
    vaultAddr = await mockVault.getAddress();
    console.log("[DEBUG] MockVaultForStrategy deployed at:", vaultAddr);

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
    console.log("[DEBUG] fuzz Avon deployFixture: complete");
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

  // ═══════════════════════════════════════════════════════════
  // totalAssets consistency after random deposit
  // ═══════════════════════════════════════════════════════════

  describe("totalAssets consistency", function () {
    it(`random deposit amounts (${FUZZ_RUNS} runs)`, async function () {
      for (let i = 0; i < FUZZ_RUNS; i++) {
        await deployFixture();

        const amount = randomBigInt(
          ethers.parseUnits("1", 18),
          ethers.parseUnits("500000", 18)
        );

        // Fund strategy
        await usdt.mint(await strategy.getAddress(), amount);
        const totalBefore = await strategy.totalAssets();

        await strategy.connect(admin).deposit(amount);
        const totalAfter = await strategy.totalAssets();

        // totalAssets should not decrease after deposit (1:1 swap)
        expect(totalAfter).to.be.gte(totalBefore - ethers.parseUnits("1", 18));

        if (i % 20 === 0) {
          console.log(`[DEBUG] fuzz totalAssets run ${i}: amount=${ethers.formatUnits(amount, 18)} total=${ethers.formatUnits(totalAfter, 18)}`);
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Deposit/withdraw roundtrip
  // ═══════════════════════════════════════════════════════════

  describe("deposit/withdraw roundtrip", function () {
    it(`roundtrip within slippage tolerance (${FUZZ_RUNS} runs)`, async function () {
      for (let i = 0; i < FUZZ_RUNS; i++) {
        await deployFixture();

        const amount = randomBigInt(
          ethers.parseUnits("100", 18),
          ethers.parseUnits("100000", 18)
        );

        // Fund and deposit
        await usdt.mint(await strategy.getAddress(), amount);
        await strategy.connect(admin).deposit(amount);

        // Withdraw
        await ethers.provider.send("hardhat_impersonateAccount", [vaultAddr]);
        await admin.sendTransaction({ to: vaultAddr, value: ethers.parseEther("1") });
        const vaultSigner = await ethers.getSigner(vaultAddr);

        const vaultBalBefore = await usdt.balanceOf(vaultAddr);
        await strategy.connect(vaultSigner).withdraw(amount);
        const vaultBalAfter = await usdt.balanceOf(vaultAddr);
        await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddr]);

        const received = vaultBalAfter - vaultBalBefore;
        // At 1:1 exchange rate, should get back exactly what we deposited
        expect(received).to.equal(amount);

        if (i % 20 === 0) {
          console.log(`[DEBUG] fuzz roundtrip run ${i}: deposited=${ethers.formatUnits(amount, 18)} received=${ethers.formatUnits(received, 18)}`);
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Slippage edge cases
  // ═══════════════════════════════════════════════════════════

  describe("slippage edge cases", function () {
    it(`random exchange rates 0.995-1.005 (${FUZZ_RUNS} runs)`, async function () {
      for (let i = 0; i < FUZZ_RUNS; i++) {
        await deployFixture();

        // Random rate between 9950 and 10050 bps (within 0.5% slippage)
        const rate = randomBigInt(9950n, 10050n);
        await router.setExchangeRate(rate);

        const amount = randomBigInt(
          ethers.parseUnits("100", 18),
          ethers.parseUnits("50000", 18)
        );

        await usdt.mint(await strategy.getAddress(), amount);

        // Should succeed within 0.5% slippage
        await strategy.connect(admin).deposit(amount);
        const total = await strategy.totalAssets();
        expect(total).to.be.gt(0);

        if (i % 20 === 0) {
          console.log(`[DEBUG] fuzz slippage run ${i}: rate=${rate.toString()}bps amount=${ethers.formatUnits(amount, 18)}`);
        }
      }
    });

    it("reverts when rate drops below slippage tolerance", async function () {
      await deployFixture();

      // Set rate to 9900 bps = 99% (1% slippage > 0.5% tolerance)
      await router.setExchangeRate(9900);
      const amount = ethers.parseUnits("10000", 18);
      await usdt.mint(await strategy.getAddress(), amount);

      await expect(
        strategy.connect(admin).deposit(amount)
      ).to.be.revertedWith("Too little received");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Multiple deposit accumulation
  // ═══════════════════════════════════════════════════════════

  describe("multiple deposit accumulation", function () {
    it(`accumulates correctly over random deposits (${FUZZ_RUNS} runs)`, async function () {
      await deployFixture();
      let totalDeposited = 0n;

      const runs = Math.min(FUZZ_RUNS, 50); // limit per-fixture runs
      for (let i = 0; i < runs; i++) {
        const amount = randomBigInt(
          ethers.parseUnits("10", 18),
          ethers.parseUnits("10000", 18)
        );

        await usdt.mint(await strategy.getAddress(), amount);
        await strategy.connect(admin).deposit(amount);
        totalDeposited += amount;
      }

      const total = await strategy.totalAssets();
      console.log(`[DEBUG] fuzz accumulation: deposited=${ethers.formatUnits(totalDeposited, 18)} total=${ethers.formatUnits(total, 18)}`);
      // At 1:1 rate, totalAssets should equal total deposited
      expect(total).to.be.closeTo(totalDeposited, ethers.parseUnits("1", 18));
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Invariant: totalAssets >= idle USDT
  // ═══════════════════════════════════════════════════════════

  describe("invariant: totalAssets >= idle USDT", function () {
    it(`holds after random operations (${FUZZ_RUNS} runs)`, async function () {
      for (let i = 0; i < FUZZ_RUNS; i++) {
        await deployFixture();

        const amount = randomBigInt(
          ethers.parseUnits("100", 18),
          ethers.parseUnits("100000", 18)
        );
        await usdt.mint(await strategy.getAddress(), amount);

        // Maybe deposit (50% chance)
        if (randomBigInt(0n, 1n) === 1n) {
          const depositAmt = randomBigInt(ethers.parseUnits("1", 18), amount);
          await strategy.connect(admin).deposit(depositAmt);
        }

        const total = await strategy.totalAssets();
        const idle = await usdt.balanceOf(await strategy.getAddress());
        expect(total).to.be.gte(idle);

        if (i % 20 === 0) {
          console.log(`[DEBUG] fuzz invariant run ${i}: total=${ethers.formatUnits(total, 18)} idle=${ethers.formatUnits(idle, 18)}`);
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Invariant: withdraw never sends more than totalAssets
  // ═══════════════════════════════════════════════════════════

  describe("invariant: withdraw never sends more than totalAssets", function () {
    it(`holds for random withdraw amounts (${FUZZ_RUNS} runs)`, async function () {
      for (let i = 0; i < FUZZ_RUNS; i++) {
        await deployFixture();

        const fundAmt = randomBigInt(
          ethers.parseUnits("100", 18),
          ethers.parseUnits("100000", 18)
        );
        await usdt.mint(await strategy.getAddress(), fundAmt);

        // Deposit half
        const depositAmt = fundAmt / 2n;
        if (depositAmt > 0n) {
          await strategy.connect(admin).deposit(depositAmt);
        }

        const totalBefore = await strategy.totalAssets();

        // Try to withdraw random amount (possibly more than available)
        const withdrawAmt = randomBigInt(ethers.parseUnits("1", 18), fundAmt * 2n);

        await ethers.provider.send("hardhat_impersonateAccount", [vaultAddr]);
        await admin.sendTransaction({ to: vaultAddr, value: ethers.parseEther("1") });
        const vaultSigner = await ethers.getSigner(vaultAddr);

        const vaultBalBefore = await usdt.balanceOf(vaultAddr);
        await strategy.connect(vaultSigner).withdraw(withdrawAmt);
        const vaultBalAfter = await usdt.balanceOf(vaultAddr);
        await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddr]);

        const received = vaultBalAfter - vaultBalBefore;
        // Should never receive more than totalAssets before withdraw
        expect(received).to.be.lte(totalBefore);

        if (i % 20 === 0) {
          console.log(`[DEBUG] fuzz withdraw invariant run ${i}: total=${ethers.formatUnits(totalBefore, 18)} requested=${ethers.formatUnits(withdrawAmt, 18)} received=${ethers.formatUnits(received, 18)}`);
        }
      }
    });
  });
});
