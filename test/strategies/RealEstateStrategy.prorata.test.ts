import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

/**
 * Pro-Rata Math Tests for RealEstateStrategy._nftValue()
 *
 * Formula:
 *   maxReturn = invested * (10000 + yieldCapBps) / 10000
 *   totalAllocated = totalClaimed + amountOwed
 *   lockedPrincipal = invested * (maxReturn - totalAllocated) / maxReturn
 *   nftValue = lockedPrincipal + amountOwed
 */
describe("RealEstateStrategy — Pro-Rata Math", function () {
  let strategy: Contract;
  let mockNFT: Contract;
  let mockMaster: Contract;
  let usdt: Contract;
  let admin: Signer;
  let adminAddr: string;
  let vaultAddr: string;

  const BPS = 10000n;
  const e18 = ethers.parseUnits("1", 18);

  // Helper: create NFTPosition struct
  function makePosition(
    invested: bigint,
    owed: bigint,
    claimed: bigint,
    yieldCapBps: bigint
  ) {
    return {
      amountInvested: invested,
      amountOwed: owed,
      totalClaimed: claimed,
      yieldCapBps: yieldCapBps,
      propertyId: 1,
      trancheType: 0, // SENIOR
      isSplit: false,
      splitDepth: 0,
    };
  }

  let mockVault: Contract;

  async function deployFixture() {
    console.log("[DEBUG] prorata deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    adminAddr = await admin.getAddress();

    // Deploy USDT
    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdt = await MockERC20.deploy();
    await usdt.waitForDeployment();

    // Deploy mock vault (implements keeper() for onlyKeeperOrOwner)
    const MockVaultF = await ethers.getContractFactory("MockVaultForStrategy");
    mockVault = await MockVaultF.deploy();
    await mockVault.waitForDeployment();
    vaultAddr = await mockVault.getAddress();
    console.log("[DEBUG] MockVault deployed at:", vaultAddr);

    // Deploy mock NFT
    const MockNFT = await ethers.getContractFactory("MockPortfolioNFTForStrategy");
    mockNFT = await MockNFT.deploy();
    await mockNFT.waitForDeployment();

    // Deploy mock master
    const MockMaster = await ethers.getContractFactory("MockPortfolioMasterForStrategy");
    mockMaster = await MockMaster.deploy(await usdt.getAddress());
    await mockMaster.waitForDeployment();

    // Deploy RealEstateStrategy (harness for test access)
    const Strategy = await ethers.getContractFactory("RealEstateStrategyHarness");
    strategy = await Strategy.deploy(
      await usdt.getAddress(),
      await mockNFT.getAddress(),
      await mockMaster.getAddress(),
      vaultAddr,
      adminAddr,
    );
    await strategy.waitForDeployment();
    console.log("[DEBUG] prorata deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // Helper: mint NFT to strategy, set position, and add to tracking
  async function setupNftWithPosition(
    invested: bigint,
    owed: bigint,
    claimed: bigint,
    yieldCapBps: bigint
  ): Promise<bigint> {
    const tokenId = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
    await mockNFT.mintUnsafe(await strategy.getAddress());
    await mockNFT.setPosition(tokenId, makePosition(invested, owed, claimed, yieldCapBps));

    // Track via harness (F4 fix: onERC721Received rejects unsolicited transfers)
    await strategy.connect(admin).addNftForTesting(tokenId);
    return tokenId;
  }

  // ═══════════════════════════════════════════════════════════
  // 1. Basic: Deploy 100k, 40% cap → nftValue = 100k
  // ═══════════════════════════════════════════════════════════

  it("100k invested, 40% cap, no allocations → value = 100k", async function () {
    console.log("[DEBUG] test: basic 100k");
    const invested = ethers.parseUnits("100000", 18);
    const tokenId = await setupNftWithPosition(invested, 0n, 0n, 4000n);

    const value = await strategy.nftValue(tokenId);
    console.log("[DEBUG] nftValue:", value.toString());
    expect(value).to.equal(invested);
  });

  // ═══════════════════════════════════════════════════════════
  // 2. After 2k repayment (owed=2k) → value increases
  // ═══════════════════════════════════════════════════════════

  it("100k invested, 40% cap, 2k owed → value = lockedPrincipal + 2k", async function () {
    console.log("[DEBUG] test: 2k owed");
    const invested = ethers.parseUnits("100000", 18);
    const owed = ethers.parseUnits("2000", 18);
    const tokenId = await setupNftWithPosition(invested, owed, 0n, 4000n);

    // maxReturn = 100000 * 14000 / 10000 = 140000
    // totalAllocated = 0 + 2000 = 2000
    // lockedPrincipal = 100000 * (140000 - 2000) / 140000 = 100000 * 138000 / 140000 = 98571.428...
    // nftValue = 98571 + 2000 = 100571
    const value = await strategy.nftValue(tokenId);
    console.log("[DEBUG] nftValue:", ethers.formatUnits(value, 18));
    // Expected: ~100571.43 USDT
    const expected = invested * (140000n * BPS - 2000n * BPS) / (140000n * BPS) + owed;
    // More precisely:
    const maxReturn = invested * 14000n / BPS;
    const lockedPrincipal = invested * (maxReturn - owed) / maxReturn;
    const expectedValue = lockedPrincipal + owed;
    console.log("[DEBUG] expected:", ethers.formatUnits(expectedValue, 18));
    expect(value).to.equal(expectedValue);
  });

  // ═══════════════════════════════════════════════════════════
  // 3. After claim 2k → value decreases
  // ═══════════════════════════════════════════════════════════

  it("100k invested, 40% cap, claimed 2k → value < 100k", async function () {
    console.log("[DEBUG] test: 2k claimed");
    const invested = ethers.parseUnits("100000", 18);
    const claimed = ethers.parseUnits("2000", 18);
    const tokenId = await setupNftWithPosition(invested, 0n, claimed, 4000n);

    // maxReturn = 140000
    // totalAllocated = 2000 + 0 = 2000
    // lockedPrincipal = 100000 * (140000 - 2000) / 140000 = 98571.43
    // nftValue = 98571.43 + 0 = 98571.43
    const value = await strategy.nftValue(tokenId);
    console.log("[DEBUG] nftValue:", ethers.formatUnits(value, 18));
    const maxReturn = invested * 14000n / BPS;
    const lockedPrincipal = invested * (maxReturn - claimed) / maxReturn;
    expect(value).to.equal(lockedPrincipal);
    expect(value).to.be.lt(invested);
  });

  // ═══════════════════════════════════════════════════════════
  // 4. After second 2k repayment → value = lockedPrincipal + 2k
  // ═══════════════════════════════════════════════════════════

  it("100k invested, 40% cap, claimed 2k + owed 2k → correct value", async function () {
    console.log("[DEBUG] test: claimed 2k + owed 2k");
    const invested = ethers.parseUnits("100000", 18);
    const owed = ethers.parseUnits("2000", 18);
    const claimed = ethers.parseUnits("2000", 18);
    const tokenId = await setupNftWithPosition(invested, owed, claimed, 4000n);

    // maxReturn = 140000
    // totalAllocated = 2000 + 2000 = 4000
    // lockedPrincipal = 100000 * (140000 - 4000) / 140000 = 97142.857
    // nftValue = 97142.857 + 2000 = 99142.857
    const value = await strategy.nftValue(tokenId);
    console.log("[DEBUG] nftValue:", ethers.formatUnits(value, 18));
    const maxReturn = invested * 14000n / BPS;
    const totalAlloc = claimed + owed;
    const lockedPrincipal = invested * (maxReturn - totalAlloc) / maxReturn;
    expect(value).to.equal(lockedPrincipal + owed);
  });

  // ═══════════════════════════════════════════════════════════
  // 5. 100% allocated → lockedPrincipal = 0
  // ═══════════════════════════════════════════════════════════

  it("100% maxReturn allocated → lockedPrincipal = 0, value = amountOwed", async function () {
    console.log("[DEBUG] test: fully allocated");
    const invested = ethers.parseUnits("100000", 18);
    const maxReturn = invested * 14000n / BPS; // 140000
    // totalAllocated = maxReturn, with owed=10000 and claimed=130000
    const owed = ethers.parseUnits("10000", 18);
    const claimed = maxReturn - owed;
    const tokenId = await setupNftWithPosition(invested, owed, claimed, 4000n);

    const value = await strategy.nftValue(tokenId);
    console.log("[DEBUG] nftValue:", ethers.formatUnits(value, 18));
    expect(value).to.equal(owed);
  });

  // ═══════════════════════════════════════════════════════════
  // 6. Multiple NFTs with different caps
  // ═══════════════════════════════════════════════════════════

  it("multiple NFTs with different yield caps → correct individual values", async function () {
    console.log("[DEBUG] test: multiple NFTs");
    const inv1 = ethers.parseUnits("50000", 18);
    const inv2 = ethers.parseUnits("30000", 18);
    const id1 = await setupNftWithPosition(inv1, 0n, 0n, 4000n); // 40% cap
    const id2 = await setupNftWithPosition(inv2, 0n, 0n, 2000n); // 20% cap

    const val1 = await strategy.nftValue(id1);
    const val2 = await strategy.nftValue(id2);
    console.log("[DEBUG] val1:", ethers.formatUnits(val1, 18), "val2:", ethers.formatUnits(val2, 18));
    expect(val1).to.equal(inv1);
    expect(val2).to.equal(inv2);
  });

  // ═══════════════════════════════════════════════════════════
  // 7. 0% yield cap → repayments are pure principal return
  // ═══════════════════════════════════════════════════════════

  it("0% yield cap → all allocations reduce lockedPrincipal to 0", async function () {
    console.log("[DEBUG] test: 0% cap");
    const invested = ethers.parseUnits("100000", 18);
    // With 0% cap, maxReturn = invested = 100000
    // If owed = 5000, totalAllocated = 5000
    // lockedPrincipal = 100000 * (100000 - 5000) / 100000 = 95000
    // nftValue = 95000 + 5000 = 100000
    const owed = ethers.parseUnits("5000", 18);
    const tokenId = await setupNftWithPosition(invested, owed, 0n, 0n);

    const value = await strategy.nftValue(tokenId);
    console.log("[DEBUG] nftValue:", ethers.formatUnits(value, 18));
    // With 0% cap: maxReturn = invested, so nftValue always = invested (when owed only)
    const maxReturn = invested;
    const lockedPrincipal = invested * (maxReturn - owed) / maxReturn;
    expect(value).to.equal(lockedPrincipal + owed);
    // This should equal invested (100000)
    expect(value).to.equal(invested);
  });

  // ═══════════════════════════════════════════════════════════
  // 8. 100% yield cap → repayments are 50% yield
  // ═══════════════════════════════════════════════════════════

  it("100% yield cap → maxReturn = 2x invested", async function () {
    console.log("[DEBUG] test: 100% cap");
    const invested = ethers.parseUnits("100000", 18);
    // 100% cap = 10000 bps
    // maxReturn = 100000 * 20000 / 10000 = 200000
    const owed = ethers.parseUnits("20000", 18);
    const tokenId = await setupNftWithPosition(invested, owed, 0n, 10000n);

    const value = await strategy.nftValue(tokenId);
    console.log("[DEBUG] nftValue:", ethers.formatUnits(value, 18));
    const maxReturn = invested * 20000n / BPS;
    const lockedPrincipal = invested * (maxReturn - owed) / maxReturn;
    expect(value).to.equal(lockedPrincipal + owed);
  });

  // ═══════════════════════════════════════════════════════════
  // 9. No allocations → nftValue = invested
  // ═══════════════════════════════════════════════════════════

  it("no allocations → nftValue = amountInvested", async function () {
    console.log("[DEBUG] test: no allocations");
    const invested = ethers.parseUnits("75000", 18);
    const tokenId = await setupNftWithPosition(invested, 0n, 0n, 3000n);

    const value = await strategy.nftValue(tokenId);
    expect(value).to.equal(invested);
  });

  // ═══════════════════════════════════════════════════════════
  // 10. totalAllocated > maxReturn → lockedPrincipal = 0
  // ═══════════════════════════════════════════════════════════

  it("totalAllocated exceeds maxReturn → lockedPrincipal = 0", async function () {
    console.log("[DEBUG] test: over-allocated");
    const invested = ethers.parseUnits("100000", 18);
    // maxReturn = 140000, set totalAllocated = 150000
    const claimed = ethers.parseUnits("145000", 18);
    const owed = ethers.parseUnits("5000", 18);
    const tokenId = await setupNftWithPosition(invested, owed, claimed, 4000n);

    const value = await strategy.nftValue(tokenId);
    console.log("[DEBUG] nftValue:", ethers.formatUnits(value, 18));
    // lockedPrincipal = 0 (clamped), nftValue = owed = 5000
    expect(value).to.equal(owed);
  });

  // ═══════════════════════════════════════════════════════════
  // 11. Small amounts (1 wei)
  // ═══════════════════════════════════════════════════════════

  it("1 wei invested → nftValue = 1 (no overflow/underflow)", async function () {
    console.log("[DEBUG] test: 1 wei");
    const tokenId = await setupNftWithPosition(1n, 0n, 0n, 4000n);

    const value = await strategy.nftValue(tokenId);
    console.log("[DEBUG] nftValue:", value.toString());
    expect(value).to.equal(1n);
  });

  // ═══════════════════════════════════════════════════════════
  // 12. Large amounts (10M USDT)
  // ═══════════════════════════════════════════════════════════

  it("10M invested → nftValue = 10M", async function () {
    console.log("[DEBUG] test: 10M");
    const invested = ethers.parseUnits("10000000", 18);
    const tokenId = await setupNftWithPosition(invested, 0n, 0n, 4000n);

    const value = await strategy.nftValue(tokenId);
    expect(value).to.equal(invested);
  });

  // ═══════════════════════════════════════════════════════════
  // 13. Burned NFT → nftValue = 0
  // ═══════════════════════════════════════════════════════════

  it("burned NFT (no position data) → nftValue = 0", async function () {
    console.log("[DEBUG] test: burned NFT");
    // Token 999 doesn't exist
    const value = await strategy.nftValue(999);
    expect(value).to.equal(0);
  });

  // ═══════════════════════════════════════════════════════════
  // 14. No NFTs → totalAssets = idle only
  // ═══════════════════════════════════════════════════════════

  it("no NFTs held → totalAssets = idle balance", async function () {
    console.log("[DEBUG] test: no NFTs");
    const idle = ethers.parseUnits("5000", 18);
    await usdt.mint(await strategy.getAddress(), idle);

    const total = await strategy.totalAssets();
    console.log("[DEBUG] totalAssets:", ethers.formatUnits(total, 18));
    expect(total).to.equal(idle);
  });

  // ═══════════════════════════════════════════════════════════
  // 15. Zero invested → nftValue = 0
  // ═══════════════════════════════════════════════════════════

  it("zero invested position → nftValue = 0", async function () {
    console.log("[DEBUG] test: zero invested");
    const tokenId = await setupNftWithPosition(0n, 0n, 0n, 4000n);

    const value = await strategy.nftValue(tokenId);
    expect(value).to.equal(0);
  });
});
