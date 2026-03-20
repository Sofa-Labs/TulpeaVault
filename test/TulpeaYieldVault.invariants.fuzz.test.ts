import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

/**
 * TulpeaYieldVault — Invariant & Fuzz Tests
 *
 * Covers:
 * - Core accounting invariants (totalAssets, totalDebt, share price)
 * - Withdrawal integrity (pending/claimable/claimed)
 * - Strategy safety (debt tracking, processReport)
 * - ERC-4626 compliance (deposit/redeem roundtrip, inflation attack)
 * - Multi-action fuzz sequences (random actions, random amounts)
 * - Edge cases (zero, 1 wei, max, rapid cycles)
 */
describe("TulpeaYieldVault — Invariants & Fuzz", function () {
  let vault: Contract;
  let usdc: Contract;
  let mockStrategy: Contract;
  let mockStrategy2: Contract;
  let admin: Signer;
  let users: Signer[];
  let adminAddr: string;
  let userAddrs: string[];
  let strategyAddr: string;
  let strategy2Addr: string;
  let vaultAddr: string;

  /** All addresses that could hold pending shares (users + admin) */
  let allAddrs: string[];

  const ONE_DAY = 24 * 60 * 60;
  const DECIMALS = 18; // MockUSDT uses 18 decimals
  const FUZZ_ITERATIONS = 1_000_000;

  // ═══════════════════════════════════════════════════════════
  // FIX #7: Seeded PRNG for reproducibility
  // ═══════════════════════════════════════════════════════════

  let _seed: number;

  /** Simple seeded PRNG (mulberry32) */
  function seededRandom(): number {
    let t = (_seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function initSeed() {
    _seed = Date.now() ^ 0xdeadbeef;
    console.log(`[DEBUG] PRNG SEED=${_seed} — use this to reproduce failures`);
  }

  // ═══════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════

  function parseUSDC(amount: string | number): bigint {
    return ethers.parseUnits(amount.toString(), DECIMALS);
  }

  function formatUSDC(amount: bigint): string {
    return ethers.formatUnits(amount, DECIMALS);
  }

  /** FIX #1: Random bigint with rejection sampling (no modulo bias) */
  function randomBigInt(min: bigint, max: bigint): bigint {
    if (max <= min) return min;
    const range = max - min;
    const bits = range.toString(2).length;
    const bytes = Math.ceil(bits / 8);
    const maxValid = (1n << BigInt(bytes * 8)) - 1n; // max value for this byte count
    // Rejection sampling: reject values that would cause modulo bias
    const limit = maxValid - ((maxValid % (range + 1n)) + 1n) % (range + 1n);

    for (let attempt = 0; attempt < 100; attempt++) {
      // Use seeded PRNG to generate bytes
      let val = 0n;
      for (let i = 0; i < bytes; i++) {
        val = (val << 8n) | BigInt(Math.floor(seededRandom() * 256));
      }
      if (val <= limit) {
        return min + (val % (range + 1n));
      }
    }
    // Fallback (should never reach here)
    return min;
  }

  /** Random amount between 1 USDC and maxUSDC */
  function randomAmount(maxUSDC: number = 100000): bigint {
    return randomBigInt(parseUSDC("1"), parseUSDC(maxUSDC));
  }

  /** Pick a random user index */
  function randomUser(): number {
    return Math.floor(seededRandom() * users.length);
  }

  /** Pick a random action */
  function randomAction(): string {
    const actions = ["deposit", "requestRedeem", "cancelWithdraw", "fulfillRedeem", "withdraw", "processProfit", "processLoss", "deployFunds"];
    return actions[Math.floor(seededRandom() * actions.length)];
  }

  // ═══════════════════════════════════════════════════════════
  // EXPECTED ERRORS for fuzz (FIX #5)
  // ═══════════════════════════════════════════════════════════

  const EXPECTED_REVERT_REASONS = [
    "ZeroShares", "ZeroAssets", "NothingPending", "NothingClaimable",
    "WithdrawalAlreadyPending", "InsufficientIdleBalance", "ExceedsClaimable",
    "DepositLimitExceeded", "DeploymentTimelockNotMet", "Unauthorized",
    "ERC20InsufficientBalance", "ERC20InsufficientAllowance",
    "ERC4626ExceededMaxDeposit", "DebtOutstandingNoShares",
    "EmergencyShutdownActive", "EnforcedPause",
    "ExpectedPause", "InvalidStrategy", "StrategyHasDebt",
  ];

  function isExpectedError(err: unknown): boolean {
    const msg = String(err);
    return EXPECTED_REVERT_REASONS.some((reason) => msg.includes(reason));
  }

  // ═══════════════════════════════════════════════════════════
  // DEPLOY FIXTURE
  // ═══════════════════════════════════════════════════════════

  async function deployFixture() {
    console.log("[DEBUG] deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    users = signers.slice(1, 6); // 5 users
    adminAddr = await admin.getAddress();
    userAddrs = await Promise.all(users.map((u) => u.getAddress()));
    allAddrs = [...userAddrs, adminAddr]; // FIX #2: track all addresses

    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory("TulpeaYieldVault");
    const vaultImpl = await VaultFactory.deploy();
    await vaultImpl.waitForDeployment();

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967ProxyWrapper");
    const initData = VaultFactory.interface.encodeFunctionData("initialize", [
      await usdc.getAddress(),
      adminAddr,
      0,
      "Tulpea Yield Vault",
      "tyvUSDC",
      ethers.ZeroAddress,
    ]);
    const proxy = await ERC1967Proxy.deploy(await vaultImpl.getAddress(), initData);
    await proxy.waitForDeployment();
    vault = VaultFactory.attach(await proxy.getAddress()) as Contract;
    vaultAddr = await vault.getAddress();

    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    mockStrategy = await MockStrategy.deploy(await usdc.getAddress());
    await mockStrategy.waitForDeployment();
    strategyAddr = await mockStrategy.getAddress();

    mockStrategy2 = await MockStrategy.deploy(await usdc.getAddress());
    await mockStrategy2.waitForDeployment();
    strategy2Addr = await mockStrategy2.getAddress();

    await vault.connect(admin).addStrategy(strategyAddr);
    await vault.connect(admin).addStrategy(strategy2Addr);

    // Mint and approve for all users + admin — large enough for 1000 fuzz iterations
    const mintAmount = parseUSDC("100000000"); // 100M each
    for (const addr of allAddrs) {
      await usdc.mint(addr, mintAmount);
    }
    for (const user of [...users, admin]) {
      await usdc.connect(user).approve(vaultAddr, ethers.MaxUint256);
    }
    // Disable health check — invariant tests exercise large losses
    await vault.connect(admin).setHealthCheck(10000, 10000, false);
    console.log("[DEBUG] deployFixture: complete");
  }

  // ═══════════════════════════════════════════════════════════
  // INVARIANT CHECKERS
  // ═══════════════════════════════════════════════════════════

  /**
   * INV-1: grossTotalAssets == USDC.balanceOf(vault) + totalDebt
   */
  async function checkGrossTotalAssets(label: string) {
    const gross = await vault.grossTotalAssets();
    const bal = await usdc.balanceOf(vaultAddr);
    const debt = await vault.totalDebt();
    console.log(`[DEBUG] INV-1 (${label}): gross=${formatUSDC(gross)} bal=${formatUSDC(bal)} debt=${formatUSDC(debt)}`);
    expect(gross).to.equal(bal + debt, `INV-1 failed at ${label}`);
  }

  /**
   * INV-2: totalAssets == grossTotalAssets - totalClaimableWithdrawals (or 0)
   */
  async function checkTotalAssets(label: string) {
    const ta = await vault.totalAssets();
    const gross = await vault.grossTotalAssets();
    const claimable = await vault.totalClaimableWithdrawals();
    const expected = claimable >= gross ? 0n : gross - claimable;
    console.log(`[DEBUG] INV-2 (${label}): totalAssets=${formatUSDC(ta)} expected=${formatUSDC(expected)}`);
    expect(ta).to.equal(expected, `INV-2 failed at ${label}`);
  }

  /**
   * INV-3: totalSupply >= balanceOf(vault) (escrowed shares <= total)
   */
  async function checkEscrowedShares(label: string) {
    const ts = await vault.totalSupply();
    const escrowed = await vault.balanceOf(vaultAddr);
    console.log(`[DEBUG] INV-3 (${label}): totalSupply=${ts} escrowed=${escrowed}`);
    expect(ts).to.be.gte(escrowed, `INV-3 failed at ${label}`);
  }

  /**
   * INV-4: vault USDC balance >= totalClaimableWithdrawals (solvency)
   */
  async function checkSolvency(label: string) {
    const bal = await usdc.balanceOf(vaultAddr);
    const claimable = await vault.totalClaimableWithdrawals();
    console.log(`[DEBUG] INV-4 (${label}): vaultBal=${formatUSDC(bal)} claimable=${formatUSDC(claimable)}`);
    expect(bal).to.be.gte(claimable, `INV-4 failed at ${label}`);
  }

  /**
   * FIX #3: INV-5 — dynamically iterate ALL strategies in strategyList
   */
  async function checkDebtSum(label: string) {
    const len = await vault.strategyListLength();
    let sum = 0n;
    for (let i = 0; i < len; i++) {
      const addr = await vault.strategyList(i);
      const config = await vault.strategies(addr);
      sum += config.currentDebt;
    }
    const totalDebt = await vault.totalDebt();
    console.log(`[DEBUG] INV-5 (${label}): strategyDebtSum=${formatUSDC(sum)} totalDebt=${formatUSDC(totalDebt)} (${len} strategies)`);
    expect(sum).to.equal(totalDebt, `INV-5 failed at ${label}`);
  }

  /**
   * FIX #4: INV-6 — correct invariant: if totalSupply > 0 AND no debt outstanding,
   * then totalAssets > 0. (After 100% loss, totalAssets=0 is legitimate.)
   */
  async function checkNoZeroAssetShares(label: string) {
    const ts = await vault.totalSupply();
    const ta = await vault.totalAssets();
    const debt = await vault.totalDebt();
    const vaultBal = await usdc.balanceOf(vaultAddr);
    const claimable = await vault.totalClaimableWithdrawals();
    console.log(`[DEBUG] INV-6 (${label}): totalSupply=${ts} totalAssets=${formatUSDC(ta)} totalDebt=${formatUSDC(debt)} vaultBal=${formatUSDC(vaultBal)}`);
    if (ts > 0n && debt === 0n && vaultBal > claimable) {
      // If no debt, shares exist, and vault holds unreserved USDC, totalAssets must be > 0
      expect(ta).to.be.gt(0n, `INV-6 failed at ${label}: shares exist with idle USDC but totalAssets=0`);
    }
    // totalAssets=0 is legitimate when: all USDC deployed to strategy AND strategy lost everything
    // OR when vault balance is fully reserved for claimable withdrawals
  }

  /**
   * INV-7: totalPendingShares == balanceOf(vault) (escrowed shares view)
   */
  async function checkPendingSharesView(label: string) {
    const pending = await vault.totalPendingShares();
    const escrowed = await vault.balanceOf(vaultAddr);
    console.log(`[DEBUG] INV-7 (${label}): totalPendingShares=${pending} balanceOf(vault)=${escrowed}`);
    expect(pending).to.equal(escrowed, `INV-7 failed at ${label}`);
  }

  /**
   * FIX #2 + FIX #14: INV-8 — sum(pendingWithdrawalShares[addr]) for ALL known addresses
   * equals balanceOf(vault). Works in mixed fulfilled/pending state.
   */
  async function checkPendingSharesSum(label: string) {
    let sum = 0n;
    for (const addr of allAddrs) {
      sum += await vault.pendingWithdrawalShares(addr);
    }
    const vaultShareBal = await vault.balanceOf(vaultAddr);
    console.log(`[DEBUG] INV-8 (${label}): sum(pendingShares)=${sum} balanceOf(vault)=${vaultShareBal} (${allAddrs.length} addrs)`);
    expect(sum).to.equal(vaultShareBal, `INV-8 failed at ${label}`);
  }

  /**
   * FIX #15: INV-9 — idleBalance formula verification
   */
  async function checkIdleBalanceFormula(label: string) {
    const idle = await vault.idleBalance();
    const vaultBalance = await usdc.balanceOf(vaultAddr);
    const totalClaimable = await vault.totalClaimableWithdrawals();

    // Estimate pending assets manually
    const pendingShares = await vault.balanceOf(vaultAddr);
    const totalSupply = await vault.totalSupply();
    const effectiveAssets = await vault.totalAssets();
    let estimatedPending = 0n;
    if (totalSupply > 0n && pendingShares > 0n) {
      estimatedPending = pendingShares * effectiveAssets / totalSupply;
    }

    const reserved = estimatedPending + totalClaimable;
    const expectedIdle = vaultBalance > reserved ? vaultBalance - reserved : 0n;

    console.log(`[DEBUG] INV-9 (${label}): idle=${formatUSDC(idle)} expected=${formatUSDC(expectedIdle)}`);
    // Allow 1 wei rounding from mulDiv in _estimatePendingAssets
    expect(idle).to.be.closeTo(expectedIdle, 1n, `INV-9 failed at ${label}`);
  }

  /** Run all invariant checks */
  async function checkAllInvariants(label: string) {
    await checkGrossTotalAssets(label);
    await checkTotalAssets(label);
    await checkEscrowedShares(label);
    await checkSolvency(label);
    await checkDebtSum(label);
    await checkNoZeroAssetShares(label);
    await checkPendingSharesView(label);
    await checkPendingSharesSum(label);
    await checkIdleBalanceFormula(label);
  }

  // ═══════════════════════════════════════════════════════════
  // FIX #8: deployToStrategy auto-sets MockStrategy._totalAssets
  // ═══════════════════════════════════════════════════════════

  async function deployToStrategy(strategy: string, amount: bigint) {
    await vault.connect(admin).requestDeploy(strategy, amount);
    const deployId = (await vault.nextDeploymentId()) - 1n;
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(deployId);

    // FIX #8: sync MockStrategy._totalAssets with actual deployed amount
    const config = await vault.strategies(strategy);
    const mockContract = strategy === strategyAddr ? mockStrategy : mockStrategy2;
    await mockContract.setTotalAssets(config.currentDebt);

    return deployId;
  }

  // ═══════════════════════════════════════════════════════════
  // FIX #12: USDC conservation check across ALL participants
  // ═══════════════════════════════════════════════════════════

  let initialUsdcBalances: Record<string, bigint>;

  async function snapshotInitialBalances() {
    initialUsdcBalances = {};
    for (const addr of [...allAddrs, vaultAddr, strategyAddr, strategy2Addr]) {
      initialUsdcBalances[addr] = await usdc.balanceOf(addr);
    }
  }

  async function checkUsdcConservation(label: string) {
    let totalBefore = 0n;
    let totalAfter = 0n;
    for (const addr of [...allAddrs, vaultAddr, strategyAddr, strategy2Addr]) {
      totalBefore += initialUsdcBalances[addr] || 0n;
      totalAfter += await usdc.balanceOf(addr);
    }
    console.log(`[DEBUG] CONSERVATION (${label}): before=${formatUSDC(totalBefore)} after=${formatUSDC(totalAfter)}`);
    expect(totalAfter).to.equal(totalBefore, `USDC conservation failed at ${label}`);
  }

  // ═══════════════════════════════════════════════════════════
  // TEST SETUP
  // ═══════════════════════════════════════════════════════════

  beforeEach(async function () {
    initSeed();
    await deployFixture();
    await snapshotInitialBalances();
  });

  // ═══════════════════════════════════════════════════════════
  // 1. CORE ACCOUNTING INVARIANTS
  // ═══════════════════════════════════════════════════════════

  describe("Core Accounting", function () {
    it("INV-1: grossTotalAssets == balance + totalDebt after deposit + deploy", async function () {
      console.log("[DEBUG] test: INV-1 after deposit + deploy");
      await vault.connect(users[0]).deposit(parseUSDC("50000"), userAddrs[0]);
      await checkGrossTotalAssets("post-deposit");

      await deployToStrategy(strategyAddr, parseUSDC("30000"));
      await checkGrossTotalAssets("post-deploy");
    });

    it("INV-2: totalAssets == gross - claimable after fulfillRedeem", async function () {
      console.log("[DEBUG] test: INV-2 after fulfillRedeem");
      await vault.connect(users[0]).deposit(parseUSDC("50000"), userAddrs[0]);

      const shares = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[0]).requestRedeem(shares, userAddrs[0], userAddrs[0]);
      await checkTotalAssets("post-request");

      await vault.connect(admin).fulfillRedeem(userAddrs[0]);
      await checkTotalAssets("post-fulfill");
    });

    it("INV-3: totalSupply >= escrowed shares always", async function () {
      console.log("[DEBUG] test: INV-3 escrowed shares");
      await vault.connect(users[0]).deposit(parseUSDC("50000"), userAddrs[0]);
      await vault.connect(users[1]).deposit(parseUSDC("30000"), userAddrs[1]);

      const shares0 = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[0]).requestRedeem(shares0, userAddrs[0], userAddrs[0]);
      await checkEscrowedShares("after-one-request");

      const shares1Half = (await vault.balanceOf(userAddrs[1])) / 2n;
      await vault.connect(users[1]).requestRedeem(shares1Half, userAddrs[1], userAddrs[1]);
      await checkEscrowedShares("after-two-requests");
    });

    it("INV-5: strategy debt sum == totalDebt after multi-strategy deploys + reports", async function () {
      console.log("[DEBUG] test: INV-5 strategy debt sum");
      await vault.connect(users[0]).deposit(parseUSDC("100000"), userAddrs[0]);

      await deployToStrategy(strategyAddr, parseUSDC("30000"));
      await deployToStrategy(strategy2Addr, parseUSDC("20000"));
      await checkDebtSum("post-deploy");

      // Profit on strategy 1
      await mockStrategy.setTotalAssets(parseUSDC("33000"));
      await vault.processReport(strategyAddr);
      await checkDebtSum("post-profit");

      // Loss on strategy 2
      await mockStrategy2.setTotalAssets(parseUSDC("18000"));
      await vault.processReport(strategy2Addr);
      await checkDebtSum("post-loss");
    });

    it("INV-5: strategy debt sum works with 3+ strategies", async function () {
      console.log("[DEBUG] test: INV-5 with 3 strategies");
      await vault.connect(users[0]).deposit(parseUSDC("150000"), userAddrs[0]);

      const MockStrategy = await ethers.getContractFactory("MockStrategy");
      const strategy3 = await MockStrategy.deploy(await usdc.getAddress());
      await strategy3.waitForDeployment();
      const strategy3Addr = await strategy3.getAddress();
      await vault.connect(admin).addStrategy(strategy3Addr);

      await deployToStrategy(strategyAddr, parseUSDC("30000"));
      await deployToStrategy(strategy2Addr, parseUSDC("20000"));

      // Deploy to 3rd strategy manually (deployToStrategy helper only knows 2 mocks)
      await vault.connect(admin).requestDeploy(strategy3Addr, parseUSDC("40000"));
      const deployId = (await vault.nextDeploymentId()) - 1n;
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(deployId);
      await strategy3.setTotalAssets(parseUSDC("40000"));

      await checkDebtSum("post-3-strategy-deploy");
    });

    it("INV-6: totalAssets CAN be 0 after 100% loss (corrected invariant)", async function () {
      console.log("[DEBUG] test: INV-6 corrected — 100% loss is valid");
      await vault.connect(users[0]).deposit(parseUSDC("100000"), userAddrs[0]);
      await deployToStrategy(strategyAddr, parseUSDC("100000"));

      // 100% loss
      await mockStrategy.setTotalAssets(0n);
      await vault.processReport(strategyAddr);

      const ts = await vault.totalSupply();
      const ta = await vault.totalAssets();
      const debt = await vault.totalDebt();
      console.log(`[DEBUG] totalSupply=${ts} totalAssets=${formatUSDC(ta)} totalDebt=${formatUSDC(debt)}`);

      // This is legitimate: shares exist but all value was lost
      expect(ts).to.be.gt(0n);
      expect(ta).to.equal(0n);
      expect(debt).to.equal(0n);

      // The corrected INV-6 should NOT fail here
      await checkNoZeroAssetShares("post-100pct-loss");
    });

    it("INV-6: if totalSupply > 0 AND no debt, then totalAssets > 0", async function () {
      console.log("[DEBUG] test: INV-6 with no debt");
      await vault.connect(users[0]).deposit(parseUSDC("10000"), userAddrs[0]);
      await checkNoZeroAssetShares("post-deposit-no-debt");

      const half = (await vault.balanceOf(userAddrs[0])) / 2n;
      await vault.connect(users[0]).requestRedeem(half, userAddrs[0], userAddrs[0]);
      await checkNoZeroAssetShares("post-partial-request");
    });

    it("INV: share price is stable with no profit/loss", async function () {
      console.log("[DEBUG] test: stable share price");
      await vault.connect(users[0]).deposit(parseUSDC("50000"), userAddrs[0]);
      const price1 = await vault.sharePrice();

      await vault.connect(users[1]).deposit(parseUSDC("30000"), userAddrs[1]);
      const price2 = await vault.sharePrice();

      console.log("[DEBUG] price1:", price1.toString(), "price2:", price2.toString());
      // FIX #16: tolerance scales with number of operations
      const numOps = 2;
      expect(price2).to.be.closeTo(price1, BigInt(numOps));
    });

    it("INV: share price increases after profit", async function () {
      console.log("[DEBUG] test: share price increases after profit");
      await vault.connect(users[0]).deposit(parseUSDC("50000"), userAddrs[0]);
      await deployToStrategy(strategyAddr, parseUSDC("40000"));

      const priceBefore = await vault.sharePrice();
      await mockStrategy.setTotalAssets(parseUSDC("44000")); // 10% profit
      await vault.processReport(strategyAddr);
      const priceAfter = await vault.sharePrice();

      console.log("[DEBUG] priceBefore:", priceBefore.toString(), "priceAfter:", priceAfter.toString());
      expect(priceAfter).to.be.gt(priceBefore);
    });

    it("INV: share price decreases after loss", async function () {
      console.log("[DEBUG] test: share price decreases after loss");
      await vault.connect(users[0]).deposit(parseUSDC("50000"), userAddrs[0]);
      await deployToStrategy(strategyAddr, parseUSDC("40000"));

      const priceBefore = await vault.sharePrice();
      await mockStrategy.setTotalAssets(parseUSDC("36000")); // 10% loss
      await vault.processReport(strategyAddr);
      const priceAfter = await vault.sharePrice();

      console.log("[DEBUG] priceBefore:", priceBefore.toString(), "priceAfter:", priceAfter.toString());
      expect(priceAfter).to.be.lt(priceBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 2. WITHDRAWAL INTEGRITY
  // ═══════════════════════════════════════════════════════════

  describe("Withdrawal Integrity", function () {
    it("INV-8: sum(pendingWithdrawalShares) for ALL addresses == balanceOf(vault)", async function () {
      console.log("[DEBUG] test: pending shares sum — all addresses");
      await vault.connect(users[0]).deposit(parseUSDC("50000"), userAddrs[0]);
      await vault.connect(users[1]).deposit(parseUSDC("30000"), userAddrs[1]);
      await vault.connect(users[2]).deposit(parseUSDC("20000"), userAddrs[2]);
      // Admin also deposits
      await vault.connect(admin).deposit(parseUSDC("10000"), adminAddr);

      const s0 = await vault.balanceOf(userAddrs[0]);
      const s1Half = (await vault.balanceOf(userAddrs[1])) / 2n;
      const sAdmin = await vault.balanceOf(adminAddr);

      await vault.connect(users[0]).requestRedeem(s0, userAddrs[0], userAddrs[0]);
      await vault.connect(users[1]).requestRedeem(s1Half, userAddrs[1], userAddrs[1]);
      await vault.connect(admin).requestRedeem(sAdmin, adminAddr, adminAddr);

      // FIX #2: check ALL addresses including admin
      await checkPendingSharesSum("all-addresses");
    });

    it("INV-8: pending shares sum correct after mixed fulfill/pending (FIX #14)", async function () {
      console.log("[DEBUG] test: mixed fulfilled/pending state");
      await vault.connect(users[0]).deposit(parseUSDC("50000"), userAddrs[0]);
      await vault.connect(users[1]).deposit(parseUSDC("30000"), userAddrs[1]);
      await vault.connect(users[2]).deposit(parseUSDC("20000"), userAddrs[2]);

      // All 3 request
      for (let i = 0; i < 3; i++) {
        const bal = await vault.balanceOf(userAddrs[i]);
        await vault.connect(users[i]).requestRedeem(bal, userAddrs[i], userAddrs[i]);
      }
      await checkPendingSharesSum("all-pending");

      // Fulfill only user0 — user1,2 still pending
      await vault.connect(admin).fulfillRedeem(userAddrs[0]);
      await checkPendingSharesSum("mixed-state");

      // Fulfill user1 too
      await vault.connect(admin).fulfillRedeem(userAddrs[1]);
      await checkPendingSharesSum("mostly-fulfilled");
    });

    it("INV: no user can withdraw more than their claimable", async function () {
      console.log("[DEBUG] test: cannot exceed claimable");
      await vault.connect(users[0]).deposit(parseUSDC("50000"), userAddrs[0]);

      const shares = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[0]).requestRedeem(shares, userAddrs[0], userAddrs[0]);
      await vault.connect(admin).fulfillRedeem(userAddrs[0]);

      const claimable = await vault.claimableWithdrawals(userAddrs[0]);
      console.log("[DEBUG] claimable:", formatUSDC(claimable));

      await expect(
        vault.connect(users[0]).withdraw(claimable + 1n, userAddrs[0], userAddrs[0])
      ).to.be.revertedWithCustomError(vault, "ExceedsClaimable");
    });

    it("INV: cancelWithdraw returns exact escrowed shares to original owner", async function () {
      console.log("[DEBUG] test: cancelWithdraw returns exact shares");
      await vault.connect(users[0]).deposit(parseUSDC("50000"), userAddrs[0]);

      const sharesBefore = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[0]).requestRedeem(sharesBefore, userAddrs[0], userAddrs[0]);

      const sharesAfterRequest = await vault.balanceOf(userAddrs[0]);
      expect(sharesAfterRequest).to.equal(0n);

      await vault.connect(users[0]).cancelWithdraw();
      const sharesAfterCancel = await vault.balanceOf(userAddrs[0]);

      console.log("[DEBUG] before:", sharesBefore.toString(), "after cancel:", sharesAfterCancel.toString());
      expect(sharesAfterCancel).to.equal(sharesBefore);
    });

    it("INV: fulfillRedeem claimable assets reflect current share price (after loss)", async function () {
      console.log("[DEBUG] test: fulfillRedeem reflects loss");
      await vault.connect(users[0]).deposit(parseUSDC("100000"), userAddrs[0]);
      await deployToStrategy(strategyAddr, parseUSDC("80000"));

      const shares = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[0]).requestRedeem(shares, userAddrs[0], userAddrs[0]);

      // 25% loss before fulfillment
      await mockStrategy.setTotalAssets(parseUSDC("60000")); // lost 20k
      await vault.processReport(strategyAddr);

      // FIX #9: Strategy already holds 80k USDC from the deploy — no minting needed.
      // Just withdraw what the strategy actually has.
      await vault.connect(admin).withdrawFromStrategy(strategyAddr, parseUSDC("60000"));

      await vault.connect(admin).fulfillRedeem(userAddrs[0]);
      const claimable = await vault.claimableWithdrawals(userAddrs[0]);

      console.log("[DEBUG] claimable:", formatUSDC(claimable));
      // Should be ~80000 (100k deposited - 20k loss)
      expect(claimable).to.be.lt(parseUSDC("100000"));
      expect(claimable).to.be.gt(parseUSDC("70000")); // roughly 80k
    });

    it("INV: after full claim cycle, user gets back deposit (no profit/loss)", async function () {
      console.log("[DEBUG] test: full cycle returns deposit");
      const depositAmount = parseUSDC("50000");
      await vault.connect(users[0]).deposit(depositAmount, userAddrs[0]);

      const shares = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[0]).requestRedeem(shares, userAddrs[0], userAddrs[0]);
      await vault.connect(admin).fulfillRedeem(userAddrs[0]);

      const claimable = await vault.claimableWithdrawals(userAddrs[0]);
      const balBefore = await usdc.balanceOf(userAddrs[0]);
      await vault.connect(users[0]).withdraw(claimable, userAddrs[0], userAddrs[0]);
      const balAfter = await usdc.balanceOf(userAddrs[0]);

      const received = balAfter - balBefore;
      console.log("[DEBUG] deposited:", formatUSDC(depositAmount), "received:", formatUSDC(received));
      // FIX #16: tolerance scales with operations (2 ops: deposit + withdraw)
      expect(received).to.be.closeTo(depositAmount, 2n);
    });

    it("INV: after all claims, vault balance == totalClaimable (no stuck tokens)", async function () {
      console.log("[DEBUG] test: clean exit");
      await vault.connect(users[0]).deposit(parseUSDC("50000"), userAddrs[0]);
      await vault.connect(users[1]).deposit(parseUSDC("30000"), userAddrs[1]);

      // Full cycle for user 0
      const s0 = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[0]).requestRedeem(s0, userAddrs[0], userAddrs[0]);
      await vault.connect(admin).fulfillRedeem(userAddrs[0]);
      const c0 = await vault.claimableWithdrawals(userAddrs[0]);
      await vault.connect(users[0]).withdraw(c0, userAddrs[0], userAddrs[0]);

      // Full cycle for user 1
      const s1 = await vault.balanceOf(userAddrs[1]);
      await vault.connect(users[1]).requestRedeem(s1, userAddrs[1], userAddrs[1]);
      await vault.connect(admin).fulfillRedeem(userAddrs[1]);
      const c1 = await vault.claimableWithdrawals(userAddrs[1]);
      await vault.connect(users[1]).withdraw(c1, userAddrs[1], userAddrs[1]);

      const balance = await usdc.balanceOf(vaultAddr);
      const totalClaimable = await vault.totalClaimableWithdrawals();
      console.log("[DEBUG] balance:", formatUSDC(balance), "totalClaimable:", formatUSDC(totalClaimable));
      expect(balance).to.equal(totalClaimable);
      expect(totalClaimable).to.equal(0n);
    });

    it("INV-12: USDC conservation — no free money across all participants", async function () {
      console.log("[DEBUG] test: USDC conservation");
      await vault.connect(users[0]).deposit(parseUSDC("50000"), userAddrs[0]);
      await vault.connect(users[1]).deposit(parseUSDC("50000"), userAddrs[1]);

      // User0 full cycle
      const shares0 = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[0]).requestRedeem(shares0, userAddrs[0], userAddrs[0]);
      await vault.connect(admin).fulfillRedeem(userAddrs[0]);
      const c0 = await vault.claimableWithdrawals(userAddrs[0]);
      await vault.connect(users[0]).withdraw(c0, userAddrs[0], userAddrs[0]);

      // FIX #12: check total USDC conservation across ALL participants
      await checkUsdcConservation("post-user0-withdraw");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 3. STRATEGY SAFETY
  // ═══════════════════════════════════════════════════════════

  describe("Strategy Safety", function () {
    it("INV: processReport profit comes only from strategy totalAssets increase", async function () {
      console.log("[DEBUG] test: profit from strategy only");
      await vault.connect(users[0]).deposit(parseUSDC("100000"), userAddrs[0]);
      await deployToStrategy(strategyAddr, parseUSDC("50000"));

      const totalAssetsBefore = await vault.totalAssets();
      const debtBefore = await vault.totalDebt();

      // Strategy reports 10% profit
      await mockStrategy.setTotalAssets(parseUSDC("55000"));
      await vault.processReport(strategyAddr);

      const totalAssetsAfter = await vault.totalAssets();
      const debtAfter = await vault.totalDebt();

      console.log("[DEBUG] before:", formatUSDC(totalAssetsBefore), "after:", formatUSDC(totalAssetsAfter));
      const profit = totalAssetsAfter - totalAssetsBefore;
      expect(profit).to.equal(parseUSDC("5000"));
      expect(debtAfter - debtBefore).to.equal(parseUSDC("5000"));

      await checkAllInvariants("post-profit");
    });

    it("INV: withdrawFromStrategy updates debt correctly even if strategy sends less", async function () {
      console.log("[DEBUG] test: withdrawFromStrategy partial return");
      await vault.connect(users[0]).deposit(parseUSDC("100000"), userAddrs[0]);
      await deployToStrategy(strategyAddr, parseUSDC("50000"));

      const debtBefore = await vault.totalDebt();
      // Strategy has exactly 50k from deploy — withdraw 30k (no extra minting needed)
      await vault.connect(admin).withdrawFromStrategy(strategyAddr, parseUSDC("30000"));
      const debtAfter = await vault.totalDebt();

      console.log("[DEBUG] debtBefore:", formatUSDC(debtBefore), "debtAfter:", formatUSDC(debtAfter));
      expect(debtBefore - debtAfter).to.equal(parseUSDC("30000"));

      await checkDebtSum("post-withdraw");
    });

    it("INV: cannot withdrawFromStrategy more than currentDebt", async function () {
      console.log("[DEBUG] test: withdrawFromStrategy exceeds debt");
      await vault.connect(users[0]).deposit(parseUSDC("100000"), userAddrs[0]);
      await deployToStrategy(strategyAddr, parseUSDC("50000"));

      await expect(
        vault.connect(admin).withdrawFromStrategy(strategyAddr, parseUSDC("60000"))
      ).to.be.revertedWithCustomError(vault, "WithdrawExceedsDebt");
    });

    it("INV: large loss (>=50%) triggers emergency shutdown", async function () {
      console.log("[DEBUG] test: emergency shutdown on large loss");
      await vault.connect(users[0]).deposit(parseUSDC("100000"), userAddrs[0]);
      await deployToStrategy(strategyAddr, parseUSDC("80000"));

      // 50% loss
      await mockStrategy.setTotalAssets(parseUSDC("40000"));
      await vault.processReport(strategyAddr);

      const shutdown = await vault.emergencyShutdown();
      console.log("[DEBUG] emergencyShutdown:", shutdown);
      expect(shutdown).to.be.true;

      // Deposits blocked
      expect(await vault.maxDeposit(userAddrs[1])).to.equal(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 4. ERC-4626 COMPLIANCE
  // ═══════════════════════════════════════════════════════════

  describe("ERC-4626 Compliance", function () {
    it("INV: deposit then requestRedeem+fulfill+withdraw returns <= deposited (no free money)", async function () {
      console.log("[DEBUG] test: no free money");
      // FIX #12: track all balances, not just one user
      await snapshotInitialBalances();
      const amount = parseUSDC("10000");

      await vault.connect(users[0]).deposit(amount, userAddrs[0]);
      const shares = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[0]).requestRedeem(shares, userAddrs[0], userAddrs[0]);
      await vault.connect(admin).fulfillRedeem(userAddrs[0]);
      const claimable = await vault.claimableWithdrawals(userAddrs[0]);
      await vault.connect(users[0]).withdraw(claimable, userAddrs[0], userAddrs[0]);

      // Single user check
      const balAfter = await usdc.balanceOf(userAddrs[0]);
      expect(balAfter).to.be.lte(initialUsdcBalances[userAddrs[0]]);

      // FIX #12: also check total USDC conservation
      await checkUsdcConservation("no-free-money");
    });

    it("INV: previewDeposit and previewMint are accurate", async function () {
      console.log("[DEBUG] test: preview accuracy");
      await vault.connect(users[0]).deposit(parseUSDC("50000"), userAddrs[0]);

      const depositAmount = parseUSDC("10000");
      const previewShares = await vault.previewDeposit(depositAmount);
      const actualShares = await vault.connect(users[1]).deposit.staticCall(depositAmount, userAddrs[1]);

      console.log("[DEBUG] previewShares:", previewShares.toString(), "actualShares:", actualShares.toString());
      // FIX #16: scale tolerance
      expect(previewShares).to.be.closeTo(actualShares, 2n);

      // previewMint
      const mintShares = parseUSDC("5000");
      const previewAssets = await vault.previewMint(mintShares);
      const actualAssets = await vault.connect(users[2]).mint.staticCall(mintShares, userAddrs[2]);

      console.log("[DEBUG] previewAssets:", previewAssets.toString(), "actualAssets:", actualAssets.toString());
      expect(previewAssets).to.be.closeTo(actualAssets, 2n);
    });

    it("INV: maxDeposit returns 0 when paused", async function () {
      console.log("[DEBUG] test: maxDeposit when paused");
      await vault.connect(admin).pause();
      expect(await vault.maxDeposit(userAddrs[0])).to.equal(0n);
    });

    it("INV: maxDeposit respects deposit limit", async function () {
      console.log("[DEBUG] test: maxDeposit with limit");
      const limit = parseUSDC("100000");
      await vault.connect(admin).setDepositLimit(limit);

      await vault.connect(users[0]).deposit(parseUSDC("60000"), userAddrs[0]);

      const maxDep = await vault.maxDeposit(userAddrs[1]);
      console.log("[DEBUG] maxDeposit:", formatUSDC(maxDep));
      expect(maxDep).to.be.closeTo(parseUSDC("40000"), 2n);
    });

    it("INV: first depositor cannot steal from second depositor (inflation attack)", async function () {
      console.log("[DEBUG] test: inflation attack protection");
      const tinyDeposit = 1n;
      await vault.connect(users[0]).deposit(tinyDeposit, userAddrs[0]);

      // Attacker donates 10000 USDC directly to vault
      const donation = parseUSDC("10000");
      await usdc.connect(users[0]).transfer(vaultAddr, donation);

      // User1 deposits 10000 USDC
      const normalDeposit = parseUSDC("10000");
      await vault.connect(users[1]).deposit(normalDeposit, userAddrs[1]);

      const shares1 = await vault.balanceOf(userAddrs[1]);
      console.log("[DEBUG] user1 shares:", shares1.toString());

      expect(shares1).to.be.gt(0n);

      const user1AssetValue = await vault.convertToAssets(shares1);
      console.log("[DEBUG] user1 asset value:", formatUSDC(user1AssetValue));
      expect(user1AssetValue).to.be.gt(normalDeposit * 90n / 100n);
    });

    it("INV: previewWithdraw and previewRedeem revert (ERC-7540 async)", async function () {
      console.log("[DEBUG] test: previewWithdraw/Redeem revert");
      await expect(vault.previewWithdraw(parseUSDC("100"))).to.be.revertedWith("ERC7540: async-flow");
      await expect(vault.previewRedeem(parseUSDC("100"))).to.be.revertedWith("ERC7540: async-flow");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 5. EDGE CASE SEQUENCES
  // ═══════════════════════════════════════════════════════════

  describe("Edge Case Sequences", function () {
    it("EDGE: deposit → requestRedeem → processReport(loss) → fulfillRedeem → withdraw", async function () {
      console.log("[DEBUG] test: deposit-request-loss-fulfill-withdraw sequence");
      await vault.connect(users[0]).deposit(parseUSDC("100000"), userAddrs[0]);
      await deployToStrategy(strategyAddr, parseUSDC("80000"));

      const shares = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[0]).requestRedeem(shares, userAddrs[0], userAddrs[0]);

      // 10% loss
      await mockStrategy.setTotalAssets(parseUSDC("72000"));
      await vault.processReport(strategyAddr);

      // FIX #9: strategy already holds 80k from deploy — no artificial minting
      await vault.connect(admin).withdrawFromStrategy(strategyAddr, parseUSDC("72000"));

      await vault.connect(admin).fulfillRedeem(userAddrs[0]);
      const claimable = await vault.claimableWithdrawals(userAddrs[0]);
      await vault.connect(users[0]).withdraw(claimable, userAddrs[0], userAddrs[0]);

      console.log("[DEBUG] claimable:", formatUSDC(claimable));
      expect(claimable).to.be.lt(parseUSDC("100000"));

      await checkAllInvariants("post-loss-withdraw");
    });

    it("EDGE: deposit → processReport(profit) → deposit → check no dilution", async function () {
      console.log("[DEBUG] test: profit then deposit no dilution");
      await vault.connect(users[0]).deposit(parseUSDC("50000"), userAddrs[0]);
      await deployToStrategy(strategyAddr, parseUSDC("40000"));

      // 25% profit
      await mockStrategy.setTotalAssets(parseUSDC("50000"));
      await vault.processReport(strategyAddr);

      const priceAfterProfit = await vault.sharePrice();
      console.log("[DEBUG] priceAfterProfit:", priceAfterProfit.toString());

      await vault.connect(users[1]).deposit(parseUSDC("50000"), userAddrs[1]);

      const shares0 = await vault.balanceOf(userAddrs[0]);
      const shares1 = await vault.balanceOf(userAddrs[1]);
      console.log("[DEBUG] shares0:", shares0.toString(), "shares1:", shares1.toString());

      expect(shares0).to.be.gt(shares1);

      const val0 = await vault.convertToAssets(shares0);
      const val1 = await vault.convertToAssets(shares1);
      console.log("[DEBUG] val0:", formatUSDC(val0), "val1:", formatUSDC(val1));
      expect(val0).to.be.gt(val1);

      await checkAllInvariants("post-profit-deposit");
    });

    it("EDGE: deposit with 1 wei amount", async function () {
      console.log("[DEBUG] test: 1 wei deposit");
      await vault.connect(users[0]).deposit(1n, userAddrs[0]);
      const shares = await vault.balanceOf(userAddrs[0]);
      console.log("[DEBUG] shares for 1 wei:", shares.toString());
      expect(shares).to.be.gt(0n);
      await checkAllInvariants("post-1wei-deposit");
    });

    it("EDGE: deposit with 0 amount mints 0 shares (no value gained)", async function () {
      console.log("[DEBUG] test: 0 deposit mints 0");
      const sharesBefore = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[0]).deposit(0n, userAddrs[0]);
      const sharesAfter = await vault.balanceOf(userAddrs[0]);
      console.log("[DEBUG] shares before:", sharesBefore.toString(), "after:", sharesAfter.toString());
      expect(sharesAfter).to.equal(sharesBefore);
    });

    it("EDGE: requestRedeem with 0 shares reverts", async function () {
      console.log("[DEBUG] test: 0 shares requestRedeem reverts");
      await vault.connect(users[0]).deposit(parseUSDC("1000"), userAddrs[0]);
      await expect(
        vault.connect(users[0]).requestRedeem(0n, userAddrs[0], userAddrs[0])
      ).to.be.revertedWithCustomError(vault, "ZeroShares");
    });

    it("EDGE: rapid deposit/requestRedeem/cancel cycles preserve balances", async function () {
      console.log("[DEBUG] test: rapid deposit/cancel cycles");
      const amount = parseUSDC("10000");

      for (let i = 0; i < 10; i++) {
        await vault.connect(users[0]).deposit(amount, userAddrs[0]);
        const shares = await vault.balanceOf(userAddrs[0]);
        await vault.connect(users[0]).requestRedeem(shares, userAddrs[0], userAddrs[0]);
        await vault.connect(users[0]).cancelWithdraw();
        console.log(`[DEBUG] cycle ${i}: shares=${(await vault.balanceOf(userAddrs[0])).toString()}`);
      }

      const finalShares = await vault.balanceOf(userAddrs[0]);
      expect(finalShares).to.be.gt(0n);
      expect(await vault.pendingWithdrawalShares(userAddrs[0])).to.equal(0n);
      await checkAllInvariants("post-rapid-cycles");
    });

    it("EDGE: multiple users concurrent deposits + partial withdrawals", async function () {
      console.log("[DEBUG] test: multi-user concurrent");
      const amounts = [10000, 20000, 30000, 40000, 50000];
      for (let i = 0; i < 5; i++) {
        await vault.connect(users[i]).deposit(parseUSDC(amounts[i]), userAddrs[i]);
      }
      await checkAllInvariants("post-multi-deposit");

      for (let i = 0; i < 3; i++) {
        const shares = (await vault.balanceOf(userAddrs[i])) / 3n;
        if (shares > 0n) {
          await vault.connect(users[i]).requestRedeem(shares, userAddrs[i], userAddrs[i]);
        }
      }
      await checkAllInvariants("post-multi-request");

      for (let i = 0; i < 2; i++) {
        await vault.connect(admin).fulfillRedeem(userAddrs[i]);
        const c = await vault.claimableWithdrawals(userAddrs[i]);
        if (c > 0n) {
          await vault.connect(users[i]).withdraw(c, userAddrs[i], userAddrs[i]);
        }
      }
      await checkAllInvariants("post-multi-claim");
    });

    it("EDGE: operator can requestRedeem on behalf of owner", async function () {
      console.log("[DEBUG] test: operator requestRedeem");
      await vault.connect(users[0]).deposit(parseUSDC("10000"), userAddrs[0]);

      await vault.connect(users[0]).setOperator(userAddrs[1], true);
      expect(await vault.isOperator(userAddrs[0], userAddrs[1])).to.be.true;

      const shares = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[1]).requestRedeem(shares, userAddrs[0], userAddrs[0]);

      expect(await vault.pendingWithdrawalShares(userAddrs[0])).to.equal(shares);
      await checkAllInvariants("post-operator-request");
    });

    it("EDGE: non-operator cannot requestRedeem on behalf of owner", async function () {
      console.log("[DEBUG] test: non-operator requestRedeem blocked");
      await vault.connect(users[0]).deposit(parseUSDC("10000"), userAddrs[0]);
      const shares = await vault.balanceOf(userAddrs[0]);

      await expect(
        vault.connect(users[1]).requestRedeem(shares, userAddrs[1], userAddrs[0])
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
    });

    // FIX #13: operator withdraw and redeem paths
    it("EDGE: operator can withdraw on behalf of owner", async function () {
      console.log("[DEBUG] test: operator withdraw");
      await vault.connect(users[0]).deposit(parseUSDC("10000"), userAddrs[0]);
      await vault.connect(users[0]).setOperator(userAddrs[1], true);

      const shares = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[1]).requestRedeem(shares, userAddrs[0], userAddrs[0]);
      await vault.connect(admin).fulfillRedeem(userAddrs[0]);

      const claimable = await vault.claimableWithdrawals(userAddrs[0]);
      const bal1Before = await usdc.balanceOf(userAddrs[1]);
      // Operator (user1) withdraws from owner (user0), sends to receiver (user1)
      await vault.connect(users[1]).withdraw(claimable, userAddrs[1], userAddrs[0]);
      const bal1After = await usdc.balanceOf(userAddrs[1]);

      console.log("[DEBUG] operator received:", formatUSDC(bal1After - bal1Before));
      expect(bal1After - bal1Before).to.equal(claimable);
    });

    it("EDGE: operator can redeem on behalf of owner", async function () {
      console.log("[DEBUG] test: operator redeem");
      await vault.connect(users[0]).deposit(parseUSDC("5000"), userAddrs[0]);
      await vault.connect(users[0]).setOperator(userAddrs[1], true);

      const shares = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[1]).requestRedeem(shares, userAddrs[0], userAddrs[0]);
      await vault.connect(admin).fulfillRedeem(userAddrs[0]);

      const claimShares = await vault.claimableWithdrawalShares(userAddrs[0]);
      const bal1Before = await usdc.balanceOf(userAddrs[1]);
      await vault.connect(users[1]).redeem(claimShares, userAddrs[1], userAddrs[0]);
      const bal1After = await usdc.balanceOf(userAddrs[1]);

      console.log("[DEBUG] operator redeemed assets:", formatUSDC(bal1After - bal1Before));
      expect(bal1After).to.be.gt(bal1Before);
    });

    it("EDGE: non-operator cannot withdraw on behalf of owner", async function () {
      console.log("[DEBUG] test: non-operator withdraw blocked");
      await vault.connect(users[0]).deposit(parseUSDC("10000"), userAddrs[0]);

      const shares = await vault.balanceOf(userAddrs[0]);
      await vault.connect(users[0]).requestRedeem(shares, userAddrs[0], userAddrs[0]);
      await vault.connect(admin).fulfillRedeem(userAddrs[0]);

      const claimable = await vault.claimableWithdrawals(userAddrs[0]);
      await expect(
        vault.connect(users[1]).withdraw(claimable, userAddrs[1], userAddrs[0])
      ).to.be.revertedWithCustomError(vault, "Unauthorized");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 6. FUZZ TESTS
  // ═══════════════════════════════════════════════════════════

  describe("Fuzz Tests", function () {
    it("FUZZ: random deposit amounts preserve invariants (10000 iterations)", async function () {
      this.timeout(FUZZ_ITERATIONS * 2000);
      console.log("[DEBUG] test: fuzz random deposits");

      let successCount = 0;

      for (let i = 0; i < FUZZ_ITERATIONS; i++) {
        const userIdx = randomUser();
        const amount = randomBigInt(parseUSDC("1"), parseUSDC("50000"));

        // Ensure user has enough USDC — mint if needed
        const userBal = await usdc.balanceOf(userAddrs[userIdx]);
        if (userBal < amount) {
          await usdc.mint(userAddrs[userIdx], parseUSDC("1000000"));
        }

        try {
          await vault.connect(users[userIdx]).deposit(amount, userAddrs[userIdx]);
          successCount++;
        } catch (err: unknown) {
          if (!isExpectedError(err)) {
            throw new Error(`Unexpected error at iteration ${i}: ${err}`);
          }
          continue;
        }

        if (i % 100 === 0) {
          console.log(`[DEBUG] fuzz deposit iteration ${i}: user=${userIdx} amount=${formatUSDC(amount)} successes=${successCount}`);
          await checkGrossTotalAssets(`fuzz-deposit-${i}`);
          await checkEscrowedShares(`fuzz-deposit-${i}`);
        }
      }

      console.log(`[DEBUG] fuzz deposits: ${successCount}/${FUZZ_ITERATIONS} succeeded`);
      expect(successCount).to.be.gte(FUZZ_ITERATIONS * 0.95, "At least 95% of deposit actions should succeed");

      await checkAllInvariants("post-fuzz-deposits");
    });

    it("FUZZ: random deposit + requestRedeem sequences preserve invariants (10000 iterations)", async function () {
      this.timeout(FUZZ_ITERATIONS * 2000);
      console.log("[DEBUG] test: fuzz deposit + requestRedeem");

      // Seed deposits first
      for (let i = 0; i < 5; i++) {
        await vault.connect(users[i]).deposit(parseUSDC("50000"), userAddrs[i]);
      }

      let successCount = 0;

      for (let i = 0; i < FUZZ_ITERATIONS; i++) {
        const userIdx = randomUser();

        // Decide action based on user state — always pick something productive
        const bal = await vault.balanceOf(userAddrs[userIdx]);
        const pending = await vault.pendingWithdrawalShares(userAddrs[userIdx]);
        let action: string;

        if (pending > 0n) {
          // Has pending — cancel it to free shares, then can act again
          action = "cancelWithdraw";
        } else if (bal > 0n && seededRandom() < 0.4) {
          action = "requestRedeem";
        } else {
          action = "deposit";
        }

        try {
          if (action === "deposit") {
            const amount = randomBigInt(parseUSDC("1"), parseUSDC("10000"));
            // Ensure enough USDC
            const userBal = await usdc.balanceOf(userAddrs[userIdx]);
            if (userBal < amount) {
              await usdc.mint(userAddrs[userIdx], parseUSDC("1000000"));
            }
            await vault.connect(users[userIdx]).deposit(amount, userAddrs[userIdx]);
            successCount++;
          } else if (action === "requestRedeem") {
            const shares = randomBigInt(1n, bal);
            await vault.connect(users[userIdx]).requestRedeem(shares, userAddrs[userIdx], userAddrs[userIdx]);
            successCount++;
          } else {
            // cancelWithdraw
            await vault.connect(users[userIdx]).cancelWithdraw();
            successCount++;
          }
        } catch (err: unknown) {
          if (!isExpectedError(err)) {
            throw new Error(`Unexpected error at iteration ${i} (${action}): ${err}`);
          }
          continue;
        }

        if (i % 100 === 0) {
          console.log(`[DEBUG] fuzz iteration ${i}: action=${action} user=${userIdx} successes=${successCount}`);
          await checkGrossTotalAssets(`fuzz-${i}`);
          await checkEscrowedShares(`fuzz-${i}`);
          await checkSolvency(`fuzz-${i}`);
          await checkPendingSharesSum(`fuzz-${i}`);
        }
      }

      console.log(`[DEBUG] fuzz deposit+redeem: ${successCount}/${FUZZ_ITERATIONS} succeeded`);
      expect(successCount).to.be.gte(FUZZ_ITERATIONS * 0.9, "At least 90% of actions should succeed");

      await checkAllInvariants("post-fuzz-deposit-redeem");
    });

    it("FUZZ: all-functions random sequences preserve invariants", async function () {
      this.timeout(FUZZ_ITERATIONS * 3000);
      console.log("[DEBUG] test: fuzz ALL functions");

      // Seed deposits
      for (let i = 0; i < 5; i++) {
        await vault.connect(users[i]).deposit(parseUSDC("50000"), userAddrs[i]);
      }

      // Deploy some to strategy
      await deployToStrategy(strategyAddr, parseUSDC("50000"));

      let deploymentPending = false;
      let pendingDeployId = 0n;
      let successCount = 0;
      let isPaused = false;
      const actionCounts: Record<string, number> = {};

      for (let i = 0; i < FUZZ_ITERATIONS; i++) {
        const userIdx = randomUser();

        // Read current state
        const bal = await vault.balanceOf(userAddrs[userIdx]);
        const pending = await vault.pendingWithdrawalShares(userAddrs[userIdx]);
        const claimable = await vault.claimableWithdrawals(userAddrs[userIdx]);
        const claimShares = await vault.claimableWithdrawalShares(userAddrs[userIdx]);
        const config = await vault.strategies(strategyAddr);
        const shutdown = await vault.emergencyShutdown();

        // Build list of ALL viable actions
        const viable: string[] = [];

        // User entry points
        if (!isPaused && !shutdown) viable.push("deposit", "mint");
        if (bal > 0n && pending === 0n && !isPaused) viable.push("requestRedeem");
        if (pending > 0n && !isPaused) viable.push("cancelWithdraw");
        if (claimable > 0n) viable.push("withdraw");
        if (claimShares > 0n) viable.push("redeem");

        // Admin: fulfill
        if (pending > 0n) viable.push("fulfillRedeem");

        // Admin: strategy reports
        if (config.currentDebt > 0n) viable.push("processProfit", "processLoss");

        // Admin: deploy funds
        if (!deploymentPending && !isPaused) {
          const idle = await vault.idleBalance();
          if (idle > parseUSDC("1000")) viable.push("deployFunds");
        }
        if (deploymentPending) viable.push("executeDeploy", "cancelDeploy");

        // Admin: withdrawFromStrategy
        if (config.currentDebt > 0n) viable.push("withdrawFromStrategy");

        // Admin: settings
        viable.push("setDepositLimit");
        if (!isPaused) viable.push("pause");
        if (isPaused) viable.push("unpause");
        viable.push("setOperator");

        // Admin: emergency
        if (shutdown) viable.push("resolveShutdown");

        // Fallback
        if (viable.length === 0) viable.push("deposit");

        const action = viable[Math.floor(seededRandom() * viable.length)];
        actionCounts[action] = (actionCounts[action] || 0) + 1;

        try {
          switch (action) {
            case "deposit": {
              const amount = randomBigInt(parseUSDC("100"), parseUSDC("10000"));
              const userBal = await usdc.balanceOf(userAddrs[userIdx]);
              if (userBal < amount) await usdc.mint(userAddrs[userIdx], parseUSDC("1000000"));
              if (shutdown) await vault.connect(admin).resolveEmergencyShutdown();
              await vault.connect(users[userIdx]).deposit(amount, userAddrs[userIdx]);
              successCount++;
              break;
            }
            case "mint": {
              const shares = randomBigInt(parseUSDC("1"), parseUSDC("5000"));
              const assetsNeeded = await vault.previewMint(shares);
              const userBal = await usdc.balanceOf(userAddrs[userIdx]);
              if (userBal < assetsNeeded + parseUSDC("1000")) await usdc.mint(userAddrs[userIdx], parseUSDC("1000000"));
              if (shutdown) await vault.connect(admin).resolveEmergencyShutdown();
              await vault.connect(users[userIdx]).mint(shares, userAddrs[userIdx]);
              successCount++;
              break;
            }
            case "requestRedeem": {
              const shares = randomBigInt(1n, bal);
              await vault.connect(users[userIdx]).requestRedeem(shares, userAddrs[userIdx], userAddrs[userIdx]);
              successCount++;
              break;
            }
            case "cancelWithdraw": {
              await vault.connect(users[userIdx]).cancelWithdraw();
              successCount++;
              break;
            }
            case "fulfillRedeem": {
              await vault.connect(admin).fulfillRedeem(userAddrs[userIdx]);
              successCount++;
              break;
            }
            case "withdraw": {
              const amount = randomBigInt(1n, claimable);
              await vault.connect(users[userIdx]).withdraw(amount, userAddrs[userIdx], userAddrs[userIdx]);
              successCount++;
              break;
            }
            case "redeem": {
              const shares = randomBigInt(1n, claimShares);
              await vault.connect(users[userIdx]).redeem(shares, userAddrs[userIdx], userAddrs[userIdx]);
              successCount++;
              break;
            }
            case "processProfit": {
              const profitBps = randomBigInt(1n, 1000n);
              const newAssets = config.currentDebt + (config.currentDebt * profitBps / 10000n);
              await mockStrategy.setTotalAssets(newAssets);
              await vault.processReport(strategyAddr);
              successCount++;
              break;
            }
            case "processLoss": {
              const lossBps = randomBigInt(1n, 6000n);
              const loss = config.currentDebt * lossBps / 10000n;
              const newAssets = config.currentDebt > loss ? config.currentDebt - loss : 0n;
              await mockStrategy.setTotalAssets(newAssets);
              await vault.processReport(strategyAddr);
              successCount++;
              const isShutdown = await vault.emergencyShutdown();
              if (isShutdown) {
                console.log(`[DEBUG] Emergency shutdown at iteration ${i} (lossBps=${lossBps})`);
                await vault.connect(admin).resolveEmergencyShutdown();
              }
              break;
            }
            case "deployFunds": {
              const idle = await vault.idleBalance();
              const amount = randomBigInt(parseUSDC("100"), idle / 2n);
              await vault.connect(admin).requestDeploy(strategyAddr, amount);
              pendingDeployId = (await vault.nextDeploymentId()) - 1n;
              deploymentPending = true;
              successCount++;
              break;
            }
            case "executeDeploy": {
              await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
              await ethers.provider.send("evm_mine", []);
              await vault.connect(admin).executeDeploy(pendingDeployId);
              const updatedConfig = await vault.strategies(strategyAddr);
              await mockStrategy.setTotalAssets(updatedConfig.currentDebt);
              successCount++;
              deploymentPending = false;
              break;
            }
            case "cancelDeploy": {
              await vault.connect(admin).cancelDeploy(pendingDeployId);
              successCount++;
              deploymentPending = false;
              break;
            }
            case "withdrawFromStrategy": {
              const maxW = config.currentDebt;
              if (maxW > 0n) {
                const amount = randomBigInt(1n, maxW > parseUSDC("10000") ? parseUSDC("10000") : maxW);
                const stratBal = await usdc.balanceOf(strategyAddr);
                if (stratBal < amount) await usdc.mint(strategyAddr, amount);
                await vault.connect(admin).withdrawFromStrategy(strategyAddr, amount);
                const uc = await vault.strategies(strategyAddr);
                await mockStrategy.setTotalAssets(uc.currentDebt);
                successCount++;
              }
              break;
            }
            case "setDepositLimit": {
              const currentLimit = await vault.depositLimit();
              if (currentLimit === 0n) {
                await vault.connect(admin).setDepositLimit(randomBigInt(parseUSDC("100000"), parseUSDC("10000000")));
              } else {
                await vault.connect(admin).setDepositLimit(0n);
              }
              successCount++;
              break;
            }
            case "pause": {
              await vault.connect(admin).pause();
              isPaused = true;
              successCount++;
              break;
            }
            case "unpause": {
              await vault.connect(admin).unpause();
              isPaused = false;
              successCount++;
              break;
            }
            case "setOperator": {
              const otherIdx = (userIdx + 1) % users.length;
              await vault.connect(users[userIdx]).setOperator(userAddrs[otherIdx], seededRandom() > 0.5);
              successCount++;
              break;
            }
            case "resolveShutdown": {
              await vault.connect(admin).resolveEmergencyShutdown();
              successCount++;
              break;
            }
          }
        } catch (err: unknown) {
          if (!isExpectedError(err)) {
            throw new Error(`Unexpected error at iteration ${i} (${action}, user=${userIdx}): ${err}`);
          }
          if (action === "deployFunds" || action === "executeDeploy" || action === "cancelDeploy") {
            deploymentPending = false;
          }
          continue;
        }

        // Check invariants every 500 iterations
        if (i % 500 === 0) {
          console.log(`[DEBUG] fuzz iteration ${i}: action=${action} user=${userIdx} successes=${successCount}`);
          if (isPaused) { await vault.connect(admin).unpause(); isPaused = false; }
          await checkGrossTotalAssets(`fuzz-multi-${i}`);
          await checkTotalAssets(`fuzz-multi-${i}`);
          await checkEscrowedShares(`fuzz-multi-${i}`);
          await checkSolvency(`fuzz-multi-${i}`);
          await checkDebtSum(`fuzz-multi-${i}`);
          await checkPendingSharesView(`fuzz-multi-${i}`);
          await checkPendingSharesSum(`fuzz-multi-${i}`);
        }
      }

      if (isPaused) { await vault.connect(admin).unpause(); }

      console.log(`[DEBUG] fuzz all-functions: ${successCount}/${FUZZ_ITERATIONS} succeeded`);
      console.log(`[DEBUG] action distribution:`, JSON.stringify(actionCounts));

      expect(successCount).to.be.gte(FUZZ_ITERATIONS * 0.9, "At least 90% of actions should succeed");

      // Verify every function was called at least once
      const required = [
        "deposit", "mint", "requestRedeem", "cancelWithdraw", "fulfillRedeem",
        "withdraw", "redeem", "processProfit", "processLoss",
        "deployFunds", "executeDeploy", "cancelDeploy", "withdrawFromStrategy",
        "setDepositLimit", "pause", "unpause", "setOperator",
      ];
      for (const fn of required) {
        expect(actionCounts[fn] || 0).to.be.gt(0, `Function '${fn}' was never called during fuzz`);
      }

      await checkAllInvariants("post-fuzz-all-functions");
    });

    it("FUZZ: share price monotonically increases with profit, decreases with loss (10000 iterations)", async function () {
      this.timeout(FUZZ_ITERATIONS * 2000);
      console.log("[DEBUG] test: fuzz share price monotonicity");

      await vault.connect(users[0]).deposit(parseUSDC("100000"), userAddrs[0]);
      await deployToStrategy(strategyAddr, parseUSDC("80000"));

      let lastPrice = await vault.sharePrice();
      let currentDebt = parseUSDC("80000");
      let successCount = 0;

      for (let i = 0; i < FUZZ_ITERATIONS; i++) {
        const isProfit = seededRandom() > 0.5;
        const bps = randomBigInt(10n, 500n); // 0.1% - 5%
        const delta = currentDebt * bps / 10000n;

        if (isProfit) {
          currentDebt += delta;
        } else {
          // Keep above 50% to avoid emergency shutdown
          if (delta < currentDebt / 3n) {
            currentDebt -= delta;
          } else {
            // Use a smaller loss instead of skipping
            const smallDelta = currentDebt * 10n / 10000n; // 0.1%
            currentDebt -= smallDelta;
          }
        }

        await mockStrategy.setTotalAssets(currentDebt);
        await vault.processReport(strategyAddr);

        const newPrice = await vault.sharePrice();
        successCount++;

        if (i % 100 === 0) {
          console.log(`[DEBUG] iteration ${i}: ${isProfit ? "profit" : "loss"} bps=${bps} price=${newPrice}`);
        }

        if (isProfit) {
          expect(newPrice).to.be.gte(lastPrice, `Price should increase after profit at iteration ${i}`);
        } else {
          expect(newPrice).to.be.lte(lastPrice, `Price should decrease after loss at iteration ${i}`);
        }

        lastPrice = newPrice;
      }

      console.log(`[DEBUG] fuzz share price: ${successCount}/${FUZZ_ITERATIONS} succeeded`);
      expect(successCount).to.equal(FUZZ_ITERATIONS);
    });

    it("FUZZ: 10+ depositors with random amounts, all withdraw, vault ends empty", async function () {
      this.timeout(FUZZ_ITERATIONS * 2000);
      console.log("[DEBUG] test: fuzz 10 depositors full cycle");

      const deposits: { userIdx: number; amount: bigint }[] = [];

      for (let i = 0; i < 10; i++) {
        const userIdx = i % 5;
        const amount = randomBigInt(parseUSDC("1000"), parseUSDC("50000"));
        await vault.connect(users[userIdx]).deposit(amount, userAddrs[userIdx]);
        deposits.push({ userIdx, amount });
        console.log(`[DEBUG] deposit ${i}: user=${userIdx} amount=${formatUSDC(amount)}`);
      }

      await checkAllInvariants("post-all-deposits");

      // All 5 users request full redeem
      for (let i = 0; i < 5; i++) {
        const bal = await vault.balanceOf(userAddrs[i]);
        if (bal > 0n) {
          await vault.connect(users[i]).requestRedeem(bal, userAddrs[i], userAddrs[i]);
        }
      }

      await checkAllInvariants("post-all-requests");

      // Fulfill and claim all
      for (let i = 0; i < 5; i++) {
        const pending = await vault.pendingWithdrawalShares(userAddrs[i]);
        if (pending > 0n) {
          await vault.connect(admin).fulfillRedeem(userAddrs[i]);
          const claimable = await vault.claimableWithdrawals(userAddrs[i]);
          if (claimable > 0n) {
            await vault.connect(users[i]).withdraw(claimable, userAddrs[i], userAddrs[i]);
          }
        }
      }

      const vaultBal = await usdc.balanceOf(vaultAddr);
      const totalSupply = await vault.totalSupply();
      const totalClaimable = await vault.totalClaimableWithdrawals();
      console.log("[DEBUG] final vaultBal:", formatUSDC(vaultBal), "totalSupply:", totalSupply.toString(), "totalClaimable:", formatUSDC(totalClaimable));

      expect(totalSupply).to.equal(0n);
      expect(totalClaimable).to.equal(0n);
      const numOps = deposits.length + 10;
      expect(vaultBal).to.be.lte(BigInt(numOps), `Dust should be <= ${numOps} wei (1 per operation)`);
    });

    it("FUZZ: random partial withdraw amounts from claimable (10000 iterations)", async function () {
      this.timeout(FUZZ_ITERATIONS * 2000);
      console.log("[DEBUG] test: fuzz partial withdrawals");

      let successCount = 0;

      for (let iter = 0; iter < FUZZ_ITERATIONS; iter++) {
        const userIdx = iter % 3;

        // If user has no claimable, create some: deposit → request → fulfill
        let claimable = await vault.claimableWithdrawals(userAddrs[userIdx]);
        if (claimable === 0n) {
          const pending = await vault.pendingWithdrawalShares(userAddrs[userIdx]);
          if (pending > 0n) {
            // Has pending — fulfill it
            await vault.connect(admin).fulfillRedeem(userAddrs[userIdx]);
            claimable = await vault.claimableWithdrawals(userAddrs[userIdx]);
          } else {
            // No shares at all — deposit fresh, request, fulfill
            const amount = randomBigInt(parseUSDC("1000"), parseUSDC("50000"));
            const userBal = await usdc.balanceOf(userAddrs[userIdx]);
            if (userBal < amount) {
              await usdc.mint(userAddrs[userIdx], parseUSDC("1000000"));
            }
            await vault.connect(users[userIdx]).deposit(amount, userAddrs[userIdx]);
            const shares = await vault.balanceOf(userAddrs[userIdx]);
            await vault.connect(users[userIdx]).requestRedeem(shares, userAddrs[userIdx], userAddrs[userIdx]);
            await vault.connect(admin).fulfillRedeem(userAddrs[userIdx]);
            claimable = await vault.claimableWithdrawals(userAddrs[userIdx]);
          }
        }

        if (claimable === 0n) continue;

        const amount = randomBigInt(1n, claimable);
        try {
          await vault.connect(users[userIdx]).withdraw(amount, userAddrs[userIdx], userAddrs[userIdx]);
          successCount++;
        } catch (err: unknown) {
          if (!isExpectedError(err)) {
            throw new Error(`Unexpected error at partial withdraw iteration ${iter}: ${err}`);
          }
          continue;
        }

        if (iter % 100 === 0) {
          console.log(`[DEBUG] partial withdraw iteration ${iter}: user=${userIdx} amount=${formatUSDC(amount)} successes=${successCount}`);
          await checkSolvency(`fuzz-partial-${iter}`);
        }
      }

      console.log(`[DEBUG] fuzz partial withdrawals: ${successCount}/${FUZZ_ITERATIONS} succeeded`);
      expect(successCount).to.be.gte(FUZZ_ITERATIONS * 0.9, "At least 90% of partial withdrawals should succeed");

      await checkSolvency("post-fuzz-partial");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 7. IDLE BALANCE INVARIANT (FIX #15)
  // ═══════════════════════════════════════════════════════════

  describe("Idle Balance", function () {
    it("INV-9: idleBalance formula matches manual computation", async function () {
      console.log("[DEBUG] test: idleBalance formula verification");
      await vault.connect(users[0]).deposit(parseUSDC("100000"), userAddrs[0]);

      // Before any requests — idle should equal vault balance
      await checkIdleBalanceFormula("no-pending");

      // After request — formula should still match
      const half = (await vault.balanceOf(userAddrs[0])) / 2n;
      await vault.connect(users[0]).requestRedeem(half, userAddrs[0], userAddrs[0]);
      await checkIdleBalanceFormula("with-pending");

      // After fulfill — formula should still match
      await vault.connect(admin).fulfillRedeem(userAddrs[0]);
      await checkIdleBalanceFormula("with-claimable");
    });

    it("INV-9: idleBalance formula with deployed strategy", async function () {
      console.log("[DEBUG] test: idleBalance with strategy");
      await vault.connect(users[0]).deposit(parseUSDC("100000"), userAddrs[0]);
      await deployToStrategy(strategyAddr, parseUSDC("40000"));

      await checkIdleBalanceFormula("with-strategy");

      const quarter = (await vault.balanceOf(userAddrs[0])) / 4n;
      await vault.connect(users[0]).requestRedeem(quarter, userAddrs[0], userAddrs[0]);
      await checkIdleBalanceFormula("strategy-plus-pending");
    });

    it("INV: idleBalance never goes negative even with rounding", async function () {
      console.log("[DEBUG] test: idleBalance >= 0 always");
      await vault.connect(users[0]).deposit(7n, userAddrs[0]);

      const idle = await vault.idleBalance();
      console.log("[DEBUG] idle for 7 wei deposit:", idle.toString());
      expect(idle).to.be.gte(0n);
      await checkIdleBalanceFormula("tiny-deposit");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 8. CROSS-INVARIANT STRESS TEST
  // ═══════════════════════════════════════════════════════════

  describe("Cross-Invariant Stress", function () {
    it("STRESS: full lifecycle with profit, loss, deploys, and multi-user withdrawals", async function () {
      this.timeout(FUZZ_ITERATIONS * 2000);
      console.log("[DEBUG] test: full lifecycle stress");

      // Phase 1: Multi-user deposits
      for (let i = 0; i < 5; i++) {
        await vault.connect(users[i]).deposit(parseUSDC((i + 1) * 20000), userAddrs[i]);
      }
      await checkAllInvariants("phase1-deposits");

      // Phase 2: Deploy to strategies
      await deployToStrategy(strategyAddr, parseUSDC("100000"));
      await deployToStrategy(strategy2Addr, parseUSDC("50000"));
      await checkAllInvariants("phase2-deploy");

      // Phase 3: Profit on strategy 1
      await mockStrategy.setTotalAssets(parseUSDC("110000")); // 10% profit
      await vault.processReport(strategyAddr);
      await checkAllInvariants("phase3-profit");

      // Phase 4: Loss on strategy 2
      await mockStrategy2.setTotalAssets(parseUSDC("45000")); // 10% loss
      await vault.processReport(strategy2Addr);
      await checkAllInvariants("phase4-loss");

      // Phase 5: Users 0,1 request redeem
      for (let i = 0; i < 2; i++) {
        const shares = await vault.balanceOf(userAddrs[i]);
        if (shares > 0n) {
          await vault.connect(users[i]).requestRedeem(shares, userAddrs[i], userAddrs[i]);
        }
      }
      await checkAllInvariants("phase5-requests");

      // Phase 6: User 0 cancels
      await vault.connect(users[0]).cancelWithdraw();
      await checkAllInvariants("phase6-cancel");

      // Phase 7: Withdraw from strategy to have idle (strategy already has USDC from deploy)
      await vault.connect(admin).withdrawFromStrategy(strategyAddr, parseUSDC("50000"));
      await mockStrategy.setTotalAssets(parseUSDC("60000")); // update after withdrawal
      await checkAllInvariants("phase7-strategy-withdraw");

      // Phase 8: Fulfill user 1
      await vault.connect(admin).fulfillRedeem(userAddrs[1]);
      await checkAllInvariants("phase8-fulfill");

      // Phase 9: User 1 claims
      const c1 = await vault.claimableWithdrawals(userAddrs[1]);
      if (c1 > 0n) {
        await vault.connect(users[1]).withdraw(c1, userAddrs[1], userAddrs[1]);
      }
      await checkAllInvariants("phase9-claim");

      // Phase 10: More deposits
      await vault.connect(users[3]).deposit(parseUSDC("25000"), userAddrs[3]);
      await checkAllInvariants("phase10-more-deposits");

      console.log("[DEBUG] full lifecycle stress test complete");
    });
  });
});
