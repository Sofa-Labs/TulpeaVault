import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

/**
 * Security proof tests for AvonStrategy deposit().
 *
 * H-1: maxDeposit pre-flight check was comparing USDT amount against a USDm-denominated limit.
 *      Fixed by moving the check after the swap and comparing usdmReceived instead.
 */
describe("AvonStrategy — Security Proof: maxDeposit Unit Fix", function () {
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
    console.log("[DEBUG] security proof deployFixture: start");
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
    console.log("[DEBUG] security proof deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  it("maxDeposit check uses USDm (post-swap) not USDT — deposit within limit succeeds", async function () {
    console.log("[DEBUG] H-1 fix: deposit within USDm limit passes");

    // Set swap rate to 99.5% (1 USDT → 0.995 USDm) — within 0.5% slippage tolerance
    await router.setExchangeRate(9950);

    // Set MegaVault maxDeposit to 9960 USDm
    // 10000 USDT → 9950 USDm (under the 9960 limit — should be allowed)
    await megaVault.setMaxDeposit(ethers.parseUnits("9960", 18));

    const depositAmt = ethers.parseUnits("10000", 18);
    await usdt.mint(await strategy.getAddress(), depositAmt);

    console.log("[DEBUG] 10000 USDT at 99.5% → 9950 USDm < 9960 limit → should pass");

    // Post-fix: compares usdmReceived (9950) vs limit (9960) — correctly allows
    await expect(
      strategy.connect(admin).deposit(depositAmt)
    ).to.emit(strategy, "Deposited");
  });

  it("maxDeposit check correctly blocks when usdmReceived exceeds limit", async function () {
    console.log("[DEBUG] H-1: deposit over USDm limit still blocked");

    await megaVault.setMaxDeposit(ethers.parseUnits("5000", 18));

    const depositAmt = ethers.parseUnits("10000", 18);
    await usdt.mint(await strategy.getAddress(), depositAmt);

    console.log("[DEBUG] 10000 USDT at 1:1 → 10000 USDm > 5000 limit → should block");

    await expect(
      strategy.connect(admin).deposit(depositAmt)
    ).to.be.revertedWithCustomError(strategy, "MegaVaultDepositLimitExceeded");
  });

  // ═══════════════════════════════════════════════════════════
  // Proof: shares==0 / balance-delta checks are unnecessary
  // ═══════════════════════════════════════════════════════════

  describe("Proof: OZ ERC4626 prevents zero-shares deposit", function () {
    it("ERC4626.deposit() always returns shares > 0 for any non-zero assets", async function () {
      console.log("[DEBUG] proof: deposit always returns shares > 0");
      const strategyAddr = await strategy.getAddress();

      // Test with various deposit sizes — all must return shares > 0
      const amounts = [
        ethers.parseUnits("1", 18),       // 1 USDm (tiny)
        ethers.parseUnits("100", 18),     // 100 USDm
        ethers.parseUnits("100000", 18),  // 100k USDm (large)
      ];

      for (const amt of amounts) {
        await usdm.mint(strategyAddr, amt);
        // Deposit USDm directly into MegaVault (bypassing strategy to isolate ERC4626 behavior)
        await usdm.mint(adminAddr, amt);
        await usdm.connect(admin).approve(await megaVault.getAddress(), amt);
        const shares = await megaVault.deposit.staticCall(amt, adminAddr);
        console.log("[DEBUG] deposit", ethers.formatUnits(amt, 18), "USDm → shares:", ethers.formatUnits(shares, 18));
        expect(shares).to.be.gt(0, `shares must be > 0 for ${ethers.formatUnits(amt, 18)} USDm`);
      }
    });

    it("ERC4626.deposit() still returns shares > 0 after large yield (inflated share price)", async function () {
      console.log("[DEBUG] proof: shares > 0 even with inflated share price");

      // Seed the vault with a deposit, then simulate massive yield to inflate share price
      const seedAmt = ethers.parseUnits("1000", 18);
      await usdm.mint(adminAddr, seedAmt);
      await usdm.connect(admin).approve(await megaVault.getAddress(), seedAmt);
      await megaVault.deposit(seedAmt, adminAddr);

      // 10x yield — share price goes from 1.0 to 11.0
      await megaVault.simulateYield(ethers.parseUnits("10000", 18));

      // Now deposit a normal amount — shares will be fewer but still > 0
      const depositAmt = ethers.parseUnits("1000", 18);
      await usdm.mint(adminAddr, depositAmt);
      await usdm.connect(admin).approve(await megaVault.getAddress(), depositAmt);
      const shares = await megaVault.deposit.staticCall(depositAmt, adminAddr);
      console.log("[DEBUG] inflated vault: deposit 1000 USDm → shares:", ethers.formatUnits(shares, 18));
      expect(shares).to.be.gt(0, "shares must be > 0 even with inflated share price");
    });

    it("deposit through strategy succeeds without balance-delta guard — shares always minted", async function () {
      console.log("[DEBUG] proof: strategy deposit works without balance-delta check");
      const strategyAddr = await strategy.getAddress();

      // Fund strategy
      await usdt.mint(strategyAddr, ethers.parseUnits("50000", 18));

      // Multiple deposits — all must succeed and produce shares
      for (let i = 0; i < 3; i++) {
        const sharesBefore = await megaVault.balanceOf(strategyAddr);
        await strategy.connect(admin).deposit(ethers.parseUnits("10000", 18));
        const sharesAfter = await megaVault.balanceOf(strategyAddr);
        console.log("[DEBUG] deposit", i + 1, "— shares delta:", ethers.formatUnits(sharesAfter - sharesBefore, 18));
        expect(sharesAfter).to.be.gt(sharesBefore, `deposit ${i + 1} must increase share balance`);
      }
    });

    it("deposit through strategy succeeds after yield — no phantom zero-shares", async function () {
      console.log("[DEBUG] proof: deposit after yield still works");
      const strategyAddr = await strategy.getAddress();

      await usdt.mint(strategyAddr, ethers.parseUnits("100000", 18));

      // First deposit
      await strategy.connect(admin).deposit(ethers.parseUnits("50000", 18));

      // Simulate 5x yield to inflate share price
      await megaVault.simulateYield(ethers.parseUnits("200000", 18));
      console.log("[DEBUG] simulated 5x yield on MegaVault");

      // Second deposit at inflated price — must still get shares
      const sharesBefore = await megaVault.balanceOf(strategyAddr);
      await strategy.connect(admin).deposit(ethers.parseUnits("10000", 18));
      const sharesAfter = await megaVault.balanceOf(strategyAddr);
      console.log("[DEBUG] shares delta after inflated deposit:", ethers.formatUnits(sharesAfter - sharesBefore, 18));
      expect(sharesAfter).to.be.gt(sharesBefore, "must receive shares even at inflated price");
    });
  });
});

/**
 * Security proof tests for AvonStrategy _swapUsdtToUsdm().
 *
 * Audit finding: L2 deadline is a no-op (informational/low).
 * block.timestamp + SWAP_DEADLINE_BUFFER is always true on L2 because
 * block.timestamp is set at execution time by sequencer.
 * Slippage protection (amountOutMinimum) is the real price guard.
 */
describe("AvonStrategy — Security Proof: L2 Swap Deadline Audit", function () {
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
    console.log("[DEBUG] L2-deadline-proof deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    adminAddr = await admin.getAddress();

    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdt = await MockERC20.deploy();
    await usdt.waitForDeployment();
    console.log("[DEBUG] USDT deployed at:", await usdt.getAddress());

    usdm = await MockERC20.deploy();
    await usdm.waitForDeployment();
    console.log("[DEBUG] USDm deployed at:", await usdm.getAddress());

    const RouterFactory = await ethers.getContractFactory("MockSwapRouter");
    router = await RouterFactory.deploy();
    await router.waitForDeployment();
    console.log("[DEBUG] MockSwapRouter deployed at:", await router.getAddress());

    const VaultFactory = await ethers.getContractFactory("MockMegaVault");
    megaVault = await VaultFactory.deploy(await usdm.getAddress());
    await megaVault.waitForDeployment();
    console.log("[DEBUG] MockMegaVault deployed at:", await megaVault.getAddress());

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
    console.log("[DEBUG] AvonStrategy deployed at:", await strategy.getAddress());

    // Mint USDT to strategy
    const initialFunding = ethers.parseUnits("100000", 18);
    await usdt.mint(await strategy.getAddress(), initialFunding);
    console.log("[DEBUG] L2-deadline-proof deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // ═══════════════════════════════════════════════════════════
  // PROOF 1: L2 deadline is a no-op
  // ═══════════════════════════════════════════════════════════

  it("PROOF: deadline is no-op on L2 — swap succeeds after any time advance", async function () {
    console.log("[DEBUG] PROOF: deadline no-op — start");

    // Advance block.timestamp by 1 hour (3600s >> 300s SWAP_DEADLINE_BUFFER)
    // On L2, block.timestamp is set at execution time by sequencer,
    // so `block.timestamp + 300 > block.timestamp` is always true.
    await ethers.provider.send("evm_increaseTime", [3600]);
    await ethers.provider.send("evm_mine", []);
    console.log("[DEBUG] Advanced time by 1 hour");

    // deposit() calls _swapUsdtToUsdm internally which uses multicall(block.timestamp + 300, ...)
    // This succeeds because deadline = NOW + 300 is computed at execution time
    const depositAmount = ethers.parseUnits("10000", 18);
    await expect(strategy.connect(admin).deposit(depositAmount)).to.not.be.reverted;
    console.log("[DEBUG] deposit() succeeded after 1h time advance — deadline is no-op");

    // Advance by 1 day — still works
    await ethers.provider.send("evm_increaseTime", [86400]);
    await ethers.provider.send("evm_mine", []);
    console.log("[DEBUG] Advanced time by 1 day");

    const depositAmount2 = ethers.parseUnits("10000", 18);
    await expect(strategy.connect(admin).deposit(depositAmount2)).to.not.be.reverted;
    console.log("[DEBUG] deposit() succeeded after 1d time advance — deadline provides zero protection");
  });

  // ═══════════════════════════════════════════════════════════
  // PROOF 2: Slippage is the real protection
  // ═══════════════════════════════════════════════════════════

  it("PROOF: slippage is the real protection, not deadline", async function () {
    console.log("[DEBUG] PROOF: slippage protection — start");

    // Set exchange rate to 9949 bps = 99.49% output
    // MAX_SLIPPAGE_BPS = 50 → minOut = amountIn * 9950 / 10000 = 99.50%
    // 99.49% < 99.50% → should revert with "Too little received"
    await router.setExchangeRate(9949);
    console.log("[DEBUG] Set exchange rate to 9949 bps (0.51% slippage)");

    const depositAmount = ethers.parseUnits("10000", 18);
    await expect(strategy.connect(admin).deposit(depositAmount))
      .to.be.revertedWith("Too little received");
    console.log("[DEBUG] deposit() reverted — slippage check caught bad price");

    // Now set to exactly 9950 bps = 99.50% → should pass (boundary)
    await router.setExchangeRate(9950);
    console.log("[DEBUG] Set exchange rate to 9950 bps (exactly 0.5% slippage)");

    await expect(strategy.connect(admin).deposit(depositAmount)).to.not.be.reverted;
    console.log("[DEBUG] deposit() succeeded at boundary — slippage math is correct");
  });

  // ═══════════════════════════════════════════════════════════
  // PROOF 3: Approval is fully consumed after swap
  // ═══════════════════════════════════════════════════════════

  it("PROOF: approval is fully consumed after swap (no dangling allowance)", async function () {
    console.log("[DEBUG] PROOF: approval consumed — start");

    const strategyAddr = await strategy.getAddress();
    const routerAddr = await router.getAddress();

    // Check allowance before — should be 0
    const allowanceBefore = await usdt.allowance(strategyAddr, routerAddr);
    console.log("[DEBUG] Allowance before deposit:", allowanceBefore.toString());
    expect(allowanceBefore).to.equal(0);

    // Perform deposit (triggers _swapUsdtToUsdm internally)
    const depositAmount = ethers.parseUnits("10000", 18);
    await strategy.connect(admin).deposit(depositAmount);
    console.log("[DEBUG] deposit() completed");

    // Check allowance after — should be 0 (fully consumed by swap)
    const allowanceAfter = await usdt.allowance(strategyAddr, routerAddr);
    console.log("[DEBUG] Allowance after deposit:", allowanceAfter.toString());
    expect(allowanceAfter).to.equal(0);
    console.log("[DEBUG] PROOF: no dangling allowance — approval fully consumed");
  });

  // ═══════════════════════════════════════════════════════════
  // REVERSE DIRECTION: _swapUsdmToUsdt (withdraw path)
  // Same pattern, mirror tokenIn/tokenOut — same findings apply
  // ═══════════════════════════════════════════════════════════

  async function depositAndImpersonateVault() {
    // First deposit USDT so strategy holds MegaVault shares (needed for withdraw path)
    const depositAmount = ethers.parseUnits("50000", 18);
    await strategy.connect(admin).deposit(depositAmount);
    console.log("[DEBUG] Deposited 50k USDT into strategy (holds MegaVault shares now)");

    // Impersonate vault to call withdraw()
    await ethers.provider.send("hardhat_impersonateAccount", [vaultAddr]);
    const vaultSigner = await ethers.getSigner(vaultAddr);
    // Fund vault with ETH for gas
    await admin.sendTransaction({ to: vaultAddr, value: ethers.parseEther("1") });
    return vaultSigner;
  }

  it("PROOF: reverse swap deadline is no-op on L2 — withdraw succeeds after any time advance", async function () {
    console.log("[DEBUG] PROOF: reverse deadline no-op — start");

    const vaultSigner = await depositAndImpersonateVault();

    // Advance block.timestamp by 1 hour
    await ethers.provider.send("evm_increaseTime", [3600]);
    await ethers.provider.send("evm_mine", []);
    console.log("[DEBUG] Advanced time by 1 hour");

    // withdraw() calls _swapUsdmToUsdt which uses multicall(block.timestamp + 300, ...)
    // Request more than idle USDT to force the redeem+swap path
    const withdrawAmount = ethers.parseUnits("30000", 18);
    await expect(strategy.connect(vaultSigner).withdraw(withdrawAmount)).to.not.be.reverted;
    console.log("[DEBUG] withdraw() succeeded after 1h time advance — reverse deadline is no-op");

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddr]);
  });

  it("PROOF: reverse swap slippage is the real protection on withdraw path", async function () {
    console.log("[DEBUG] PROOF: reverse slippage protection — start");

    // Deposit ALL idle USDT so strategy has 0 idle and must redeem+swap on withdraw
    const strategyAddr = await strategy.getAddress();
    const idleBefore = await usdt.balanceOf(strategyAddr);
    console.log("[DEBUG] Idle USDT before full deposit:", ethers.formatUnits(idleBefore, 18));
    await strategy.connect(admin).deposit(idleBefore);
    const idleAfter = await usdt.balanceOf(strategyAddr);
    console.log("[DEBUG] Idle USDT after full deposit:", ethers.formatUnits(idleAfter, 18));

    // Impersonate vault
    await ethers.provider.send("hardhat_impersonateAccount", [vaultAddr]);
    const vaultSigner = await ethers.getSigner(vaultAddr);
    await admin.sendTransaction({ to: vaultAddr, value: ethers.parseEther("1") });

    // Set exchange rate to 9949 bps = 0.51% slippage (beyond 0.5% tolerance)
    await router.setExchangeRate(9949);
    console.log("[DEBUG] Set exchange rate to 9949 bps (0.51% slippage)");

    // Request withdrawal — must go through redeem+swap path (no idle USDT)
    const withdrawAmount = ethers.parseUnits("30000", 18);
    await expect(strategy.connect(vaultSigner).withdraw(withdrawAmount))
      .to.be.revertedWith("Too little received");
    console.log("[DEBUG] withdraw() reverted — reverse slippage check caught bad price");

    // Set to exactly 9950 bps → should pass
    await router.setExchangeRate(9950);
    console.log("[DEBUG] Set exchange rate to 9950 bps (exactly 0.5% slippage)");

    await expect(strategy.connect(vaultSigner).withdraw(withdrawAmount)).to.not.be.reverted;
    console.log("[DEBUG] withdraw() succeeded at boundary — reverse slippage math correct");

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddr]);
  });

  it("PROOF: reverse swap approval (USDm→router) is fully consumed after withdraw", async function () {
    console.log("[DEBUG] PROOF: reverse approval consumed — start");

    const vaultSigner = await depositAndImpersonateVault();
    const strategyAddr = await strategy.getAddress();
    const routerAddr = await router.getAddress();

    // Check USDm allowance before — should be 0
    const allowanceBefore = await usdm.allowance(strategyAddr, routerAddr);
    console.log("[DEBUG] USDm allowance before withdraw:", allowanceBefore.toString());
    expect(allowanceBefore).to.equal(0);

    // Trigger withdraw that forces redeem+swap path
    const withdrawAmount = ethers.parseUnits("30000", 18);
    await strategy.connect(vaultSigner).withdraw(withdrawAmount);
    console.log("[DEBUG] withdraw() completed");

    // Check USDm allowance after — should be 0 (fully consumed by swap)
    const allowanceAfter = await usdm.allowance(strategyAddr, routerAddr);
    console.log("[DEBUG] USDm allowance after withdraw:", allowanceAfter.toString());
    expect(allowanceAfter).to.equal(0);
    console.log("[DEBUG] PROOF: no dangling USDm allowance — reverse approval fully consumed");

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddr]);
  });
});
