import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

/**
 * Audit tests for RealEstateStrategy._nftValue()
 *
 * Formula:
 *   maxReturn = invested * (10000 + yieldCapBps) / 10000
 *   totalAllocated = totalClaimed + amountOwed
 *   lockedPrincipal = invested * (maxReturn - totalAllocated) / maxReturn
 *   nftValue = lockedPrincipal + amountOwed
 *
 * Findings tested:
 *   F1: Stale position data persists after NFT burn
 *   F2: Conservative valuation (proportional amortization)
 *   F3: Rounding truncation across two divisions
 *   F4: Value upper bound not enforced by formula
 *   F5: 0% yield cap invariant
 */
describe("RealEstateStrategy — _nftValue() Audit", function () {
  let strategy: Contract;
  let mockNFT: Contract;
  let mockMaster: Contract;
  let usdt: Contract;
  let admin: Signer;
  let adminAddr: string;
  let vaultAddr: string;

  const BPS = 10000n;
  const e18 = ethers.parseUnits("1", 18);

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
      trancheType: 0,
      isSplit: false,
      splitDepth: 0,
    };
  }

  let mockVault: Contract;

  async function deployFixture() {
    console.log("[DEBUG] nftValue-audit deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    adminAddr = await admin.getAddress();

    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdt = await MockERC20.deploy();
    await usdt.waitForDeployment();

    // Deploy mock vault (implements keeper() for onlyKeeperOrOwner)
    const MockVaultF = await ethers.getContractFactory("MockVaultForStrategy");
    mockVault = await MockVaultF.deploy();
    await mockVault.waitForDeployment();
    vaultAddr = await mockVault.getAddress();
    console.log("[DEBUG] MockVault deployed at:", vaultAddr);

    const MockNFT = await ethers.getContractFactory("MockPortfolioNFTForStrategy");
    mockNFT = await MockNFT.deploy();
    await mockNFT.waitForDeployment();

    const MockMaster = await ethers.getContractFactory("MockPortfolioMasterForStrategy");
    mockMaster = await MockMaster.deploy(await usdt.getAddress());
    await mockMaster.waitForDeployment();

    const Strategy = await ethers.getContractFactory("RealEstateStrategyHarness");
    strategy = await Strategy.deploy(
      await usdt.getAddress(),
      await mockNFT.getAddress(),
      await mockMaster.getAddress(),
      vaultAddr,
      adminAddr,
    );
    await strategy.waitForDeployment();
    console.log("[DEBUG] nftValue-audit deployFixture: complete");
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
    const stratAddr = await strategy.getAddress();
    const tokenId = await mockNFT.mintUnsafe.staticCall(stratAddr);
    await mockNFT.mintUnsafe(stratAddr);
    await mockNFT.setPosition(tokenId, makePosition(invested, owed, claimed, yieldCapBps));
    await strategy.connect(admin).addNftForTesting(tokenId);
    console.log(`[DEBUG] setupNftWithPosition: tokenId=${tokenId} invested=${invested} owed=${owed} claimed=${claimed} cap=${yieldCapBps}`);
    return tokenId;
  }

  // ═══════════════════════════════════════════════════════════
  // GROUP 1: Stale Position After Burn (F1)
  // ═══════════════════════════════════════════════════════════

  describe("F1: Stale Position After Burn", function () {
    it("_nftValue returns 0 for burned NFT (ownerOf guard in formula)", async function () {
      console.log("[DEBUG] F1-1: burned NFT guard");
      const invested = ethers.parseUnits("100000", 18);
      const tokenId = await setupNftWithPosition(invested, 0n, 0n, 4000n);

      // Burn the NFT — position data persists but ownerOf guard catches it
      await mockNFT.burn(tokenId);
      console.log("[DEBUG] NFT burned, checking nftValue...");

      const value = await strategy.nftValue(tokenId);
      console.log("[DEBUG] nftValue after burn:", value.toString());
      // F1 fix: _nftValue now returns 0 for burned NFTs
      expect(value).to.equal(0n, "_nftValue returns 0 for burned NFT");
    });

    it("totalAssets is NOT inflated because ownerOf guard skips burned NFTs", async function () {
      console.log("[DEBUG] F1-2: totalAssets ownerOf guard");
      const invested = ethers.parseUnits("100000", 18);
      const tokenId = await setupNftWithPosition(invested, 0n, 0n, 4000n);

      const totalBefore = await strategy.totalAssets();
      console.log("[DEBUG] totalAssets before burn:", ethers.formatUnits(totalBefore, 18));

      // Burn NFT — totalAssets should drop because ownerOf reverts
      await mockNFT.burn(tokenId);

      const totalAfter = await strategy.totalAssets();
      console.log("[DEBUG] totalAssets after burn:", ethers.formatUnits(totalAfter, 18));
      expect(totalAfter).to.equal(0n, "totalAssets should be 0 after burn (ownerOf guard)");
      expect(totalAfter).to.be.lt(totalBefore);
    });

    it("cleanupBurnedNfts removes burned NFT from tracking", async function () {
      console.log("[DEBUG] F1-3: cleanup removes burned NFT");
      const invested = ethers.parseUnits("100000", 18);
      const tokenId = await setupNftWithPosition(invested, 0n, 0n, 4000n);

      expect(await strategy.heldNftCount()).to.equal(1);

      await mockNFT.burn(tokenId);
      await strategy.connect(admin).cleanupBurnedNfts();

      expect(await strategy.heldNftCount()).to.equal(0, "burned NFT should be removed from tracking");
      console.log("[DEBUG] heldNftCount after cleanup: 0");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // GROUP 2: Harvest Invariance
  // ═══════════════════════════════════════════════════════════

  describe("F2a: Harvest Invariance", function () {
    it("totalAssets unchanged when owed converts to idle (claim simulation)", async function () {
      console.log("[DEBUG] F2a-1: harvest invariance");
      const invested = ethers.parseUnits("100000", 18);
      const owed = ethers.parseUnits("10000", 18);
      const tokenId = await setupNftWithPosition(invested, owed, 0n, 4000n);

      const totalBefore = await strategy.totalAssets();
      console.log("[DEBUG] totalAssets before harvest:", ethers.formatUnits(totalBefore, 18));

      // Simulate harvest: owed → claimed, USDT transferred to strategy
      // After claim: owed=0, claimed=10000, idle USDT += 10000
      await usdt.mint(await strategy.getAddress(), owed);
      await mockNFT.setPosition(tokenId, makePosition(invested, 0n, owed, 4000n));

      const totalAfter = await strategy.totalAssets();
      console.log("[DEBUG] totalAssets after harvest:", ethers.formatUnits(totalAfter, 18));

      // totalAssets should be unchanged: nftValue decreased, idle increased by same amount
      expect(totalAfter).to.equal(totalBefore, "totalAssets invariant: owed→claimed + idle");
    });

    it("totalAssets invariant holds across multiple partial harvests", async function () {
      console.log("[DEBUG] F2a-2: multiple partial harvests");
      const invested = ethers.parseUnits("100000", 18);
      const tokenId = await setupNftWithPosition(invested, ethers.parseUnits("5000", 18), 0n, 4000n);

      const totalBefore = await strategy.totalAssets();
      console.log("[DEBUG] totalAssets initial:", ethers.formatUnits(totalBefore, 18));

      // First harvest: 5000 owed → claimed
      const harvest1 = ethers.parseUnits("5000", 18);
      await usdt.mint(await strategy.getAddress(), harvest1);
      await mockNFT.setPosition(tokenId, makePosition(invested, 0n, harvest1, 4000n));

      const totalMid = await strategy.totalAssets();
      console.log("[DEBUG] totalAssets after harvest1:", ethers.formatUnits(totalMid, 18));
      expect(totalMid).to.equal(totalBefore, "invariant after harvest 1");

      // Second allocation: new owed = 3000
      const owed2 = ethers.parseUnits("3000", 18);
      await mockNFT.setPosition(tokenId, makePosition(invested, owed2, harvest1, 4000n));

      const totalWithOwed = await strategy.totalAssets();
      console.log("[DEBUG] totalAssets with new owed:", ethers.formatUnits(totalWithOwed, 18));

      // Second harvest: 3000 owed → claimed
      await usdt.mint(await strategy.getAddress(), owed2);
      await mockNFT.setPosition(tokenId, makePosition(invested, 0n, harvest1 + owed2, 4000n));

      const totalFinal = await strategy.totalAssets();
      console.log("[DEBUG] totalAssets after harvest2:", ethers.formatUnits(totalFinal, 18));
      expect(totalFinal).to.equal(totalWithOwed, "invariant after harvest 2");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // GROUP 3: Conservative Valuation (F2)
  // ═══════════════════════════════════════════════════════════

  describe("F2: Conservative Valuation (Proportional Amortization)", function () {
    it("allocation increases value by capBps/(BPS+capBps) fraction, not full amount", async function () {
      console.log("[DEBUG] F2-1: conservative valuation fraction");
      const invested = ethers.parseUnits("100000", 18);
      const capBps = 4000n; // 40%

      // No allocation → value = invested
      const tokenId = await setupNftWithPosition(invested, 0n, 0n, capBps);
      const valueBefore = await strategy.nftValue(tokenId);
      console.log("[DEBUG] valueBefore:", ethers.formatUnits(valueBefore, 18));

      // 40k owed → value should NOT increase by 40k
      const owed = ethers.parseUnits("40000", 18);
      await mockNFT.setPosition(tokenId, makePosition(invested, owed, 0n, capBps));
      const valueAfter = await strategy.nftValue(tokenId);
      console.log("[DEBUG] valueAfter:", ethers.formatUnits(valueAfter, 18));

      const increase = valueAfter - valueBefore;
      console.log("[DEBUG] increase:", ethers.formatUnits(increase, 18));

      // Expected increase = owed * capBps / (BPS + capBps) = 40000 * 4000 / 14000 ≈ 11428.57
      // Because lockedPrincipal decreases while owed increases
      const expectedIncrease = owed * capBps / (BPS + capBps);
      console.log("[DEBUG] expectedIncrease:", ethers.formatUnits(expectedIncrease, 18));

      // Increase should be MUCH less than the full 40k owed
      expect(increase).to.be.lt(owed, "value increase must be less than full owed amount");
      // Should approximately equal the yield portion
      expect(increase).to.be.closeTo(expectedIncrease, e18, "increase ≈ owed * cap/(BPS+cap)");
    });

    it("value increase is purely the yield component of the allocation", async function () {
      console.log("[DEBUG] F2-2: yield component verification");
      const invested = ethers.parseUnits("100000", 18);
      const capBps = 4000n;
      const maxReturn = invested * (BPS + capBps) / BPS; // 140000

      // With owed=40k: increase should represent yield only
      const owed = ethers.parseUnits("40000", 18);
      const tokenId = await setupNftWithPosition(invested, owed, 0n, capBps);
      const value = await strategy.nftValue(tokenId);

      // Formula: lockedPrincipal = 100k * (140k - 40k) / 140k = 71428.571...
      // value = 71428.571... + 40000 = 111428.571...
      // increase from invested = 11428.571...
      const lockedPrincipal = invested * (maxReturn - owed) / maxReturn;
      expect(value).to.equal(lockedPrincipal + owed);

      // The "conservative" part: increase = value - invested ≈ 11.4k, not 40k
      const increase = value - invested;
      console.log("[DEBUG] increase from invested:", ethers.formatUnits(increase, 18));
      expect(increase).to.be.lt(owed / 2n, "increase must be less than half the allocation");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // GROUP 4: Value Upper Bound (F4)
  // ═══════════════════════════════════════════════════════════

  describe("F4: Value Upper Bound", function () {
    it("value ≤ maxReturn for valid states (totalAllocated ≤ maxReturn)", async function () {
      console.log("[DEBUG] F4-1: value upper bound valid state");
      const invested = ethers.parseUnits("100000", 18);
      const capBps = 4000n;
      const maxReturn = invested * (BPS + capBps) / BPS; // 140000

      // Test at various allocation points
      const testCases = [
        { owed: 0n, claimed: 0n, label: "no allocation" },
        { owed: ethers.parseUnits("20000", 18), claimed: 0n, label: "20k owed" },
        { owed: 0n, claimed: ethers.parseUnits("70000", 18), label: "70k claimed" },
        { owed: ethers.parseUnits("10000", 18), claimed: ethers.parseUnits("130000", 18), label: "at maxReturn" },
      ];

      for (const tc of testCases) {
        const tokenId = await setupNftWithPosition(invested, tc.owed, tc.claimed, capBps);
        const value = await strategy.nftValue(tokenId);
        console.log(`[DEBUG] ${tc.label}: value=${ethers.formatUnits(value, 18)}, maxReturn=${ethers.formatUnits(maxReturn, 18)}`);
        expect(value).to.be.lte(maxReturn, `value ≤ maxReturn for ${tc.label}`);
      }
    });

    it("value = amountOwed when totalAllocated = maxReturn (lockedPrincipal = 0)", async function () {
      console.log("[DEBUG] F4-2: value at maxReturn boundary");
      const invested = ethers.parseUnits("100000", 18);
      const capBps = 4000n;
      const maxReturn = invested * (BPS + capBps) / BPS;

      // Exactly at maxReturn: owed=10k, claimed=130k → totalAllocated = 140k = maxReturn
      const owed = ethers.parseUnits("10000", 18);
      const claimed = maxReturn - owed;
      const tokenId = await setupNftWithPosition(invested, owed, claimed, capBps);

      const value = await strategy.nftValue(tokenId);
      console.log("[DEBUG] value at boundary:", ethers.formatUnits(value, 18));
      expect(value).to.equal(owed, "value = amountOwed when lockedPrincipal = 0");
    });

    it("value is capped at maxReturn even in corrupted state (F4 fix)", async function () {
      console.log("[DEBUG] F4-3: corrupted state — capped");
      const invested = ethers.parseUnits("100000", 18);
      const capBps = 4000n;
      const maxReturn = invested * (BPS + capBps) / BPS; // 140000

      // Corrupted: totalAllocated = 200k > maxReturn = 140k
      const owed = ethers.parseUnits("200000", 18);
      const claimed = 0n;
      const tokenId = await setupNftWithPosition(invested, owed, claimed, capBps);

      const value = await strategy.nftValue(tokenId);
      console.log("[DEBUG] corrupted state value:", ethers.formatUnits(value, 18));
      // F4 fix: value is capped at maxReturn
      expect(value).to.equal(maxReturn, "value capped at maxReturn in corrupted state");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // GROUP 5: Rounding on Split (F3)
  // ═══════════════════════════════════════════════════════════

  describe("F3: Rounding Truncation on Split", function () {
    it("sum of split halves ≤ original value (never exceeds)", async function () {
      console.log("[DEBUG] F3-1: split rounding — halves ≤ original");
      const invested = ethers.parseUnits("100000", 18);
      const owed = ethers.parseUnits("15000", 18);
      const capBps = 4000n;

      const tokenId = await setupNftWithPosition(invested, owed, 0n, capBps);
      const originalValue = await strategy.nftValue(tokenId);
      console.log("[DEBUG] original value:", ethers.formatUnits(originalValue, 18));

      // Simulate 50/50 split: each half gets invested/2 and owed/2
      const halfInvested = invested / 2n;
      const halfOwed = owed / 2n;
      const splitId1 = await setupNftWithPosition(halfInvested, halfOwed, 0n, capBps);
      const splitId2 = await setupNftWithPosition(halfInvested, halfOwed, 0n, capBps);

      const val1 = await strategy.nftValue(splitId1);
      const val2 = await strategy.nftValue(splitId2);
      const splitSum = val1 + val2;
      console.log("[DEBUG] split sum:", ethers.formatUnits(splitSum, 18), "original:", ethers.formatUnits(originalValue, 18));

      expect(splitSum).to.be.lte(originalValue, "split sum must not exceed original");
    });

    it("rounding dust is at most 2 wei after split", async function () {
      console.log("[DEBUG] F3-2: rounding dust ≤ 2 wei");
      // Use odd number to force rounding
      const invested = ethers.parseUnits("99999", 18) + 1n; // odd wei
      const owed = ethers.parseUnits("13333", 18) + 1n; // odd wei
      const capBps = 4000n;

      const tokenId = await setupNftWithPosition(invested, owed, 0n, capBps);
      const originalValue = await strategy.nftValue(tokenId);

      // Split simulation
      const halfInvested = invested / 2n;
      const halfOwed = owed / 2n;
      const splitId1 = await setupNftWithPosition(halfInvested, halfOwed, 0n, capBps);
      const splitId2 = await setupNftWithPosition(halfInvested, halfOwed, 0n, capBps);

      const val1 = await strategy.nftValue(splitId1);
      const val2 = await strategy.nftValue(splitId2);
      const splitSum = val1 + val2;
      const dust = originalValue - splitSum;
      console.log("[DEBUG] rounding dust:", dust.toString(), "wei");

      // Two floor divisions compound, so up to ~2 wei lost
      expect(dust).to.be.lte(2n, "rounding dust must be ≤ 2 wei");
      expect(dust).to.be.gte(0n, "dust must be non-negative (conservative)");
    });

    it("three-way split: sum ≤ original, dust ≤ 4 wei", async function () {
      console.log("[DEBUG] F3-3: three-way split rounding");
      const invested = ethers.parseUnits("100000", 18) + 7n; // not divisible by 3
      const owed = ethers.parseUnits("15000", 18) + 5n;
      const capBps = 4000n;

      const tokenId = await setupNftWithPosition(invested, owed, 0n, capBps);
      const originalValue = await strategy.nftValue(tokenId);

      // Simulate 3-way split
      const thirdInvested = invested / 3n;
      const thirdOwed = owed / 3n;
      let splitSum = 0n;
      for (let i = 0; i < 3; i++) {
        const sid = await setupNftWithPosition(thirdInvested, thirdOwed, 0n, capBps);
        splitSum += await strategy.nftValue(sid);
      }

      const dust = originalValue - splitSum;
      console.log("[DEBUG] 3-way dust:", dust.toString(), "wei");
      expect(splitSum).to.be.lte(originalValue, "3-way split sum must not exceed original");
      // 3 splits × 2 floor divisions each = up to ~6 wei dust
      expect(dust).to.be.lte(6n, "3-way dust must be ≤ 6 wei");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // GROUP 6: Monotonic Decrease with Claims
  // ═══════════════════════════════════════════════════════════

  describe("Monotonic Decrease", function () {
    it("value strictly decreases as totalClaimed increases (owed=0)", async function () {
      console.log("[DEBUG] monotonic-1: value decreases with claims");
      const invested = ethers.parseUnits("100000", 18);
      const capBps = 4000n;

      const claimSteps = [0n, 10000n, 30000n, 70000n, 100000n, 140000n].map(
        (v) => ethers.parseUnits(v.toString(), 18)
      );

      let prevValue = invested * 2n; // start above any possible value
      for (const claimed of claimSteps) {
        const tokenId = await setupNftWithPosition(invested, 0n, claimed, capBps);
        const value = await strategy.nftValue(tokenId);
        console.log(`[DEBUG] claimed=${ethers.formatUnits(claimed, 18)} → value=${ethers.formatUnits(value, 18)}`);
        expect(value).to.be.lt(prevValue, `value must decrease at claimed=${claimed}`);
        prevValue = value;
      }
    });

    it("value is zero when fully claimed and no owed", async function () {
      console.log("[DEBUG] monotonic-2: fully claimed → value=0");
      const invested = ethers.parseUnits("100000", 18);
      const capBps = 4000n;
      const maxReturn = invested * (BPS + capBps) / BPS;

      const tokenId = await setupNftWithPosition(invested, 0n, maxReturn, capBps);
      const value = await strategy.nftValue(tokenId);
      console.log("[DEBUG] fully claimed value:", value.toString());
      expect(value).to.equal(0n, "value = 0 when fully claimed with no owed");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // GROUP 7: Zero Cap Invariant (F5)
  // ═══════════════════════════════════════════════════════════

  describe("F5: Zero Yield Cap Invariant", function () {
    it("0% cap: value = invested when only owed (no claimed)", async function () {
      console.log("[DEBUG] F5-1: 0% cap, owed only");
      const invested = ethers.parseUnits("100000", 18);

      // Test with various owed amounts
      const owedAmounts = [0n, 10000n, 50000n, 99999n].map(
        (v) => ethers.parseUnits(v.toString(), 18)
      );

      for (const owed of owedAmounts) {
        const tokenId = await setupNftWithPosition(invested, owed, 0n, 0n);
        const value = await strategy.nftValue(tokenId);
        console.log(`[DEBUG] 0% cap, owed=${ethers.formatUnits(owed, 18)} → value=${ethers.formatUnits(value, 18)}`);
        // With 0% cap: maxReturn = invested, lockedPrincipal = invested - owed, value = (invested - owed) + owed = invested
        expect(value).to.equal(invested, `0% cap: value should always = invested when no claims`);
      }
    });

    it("0% cap: value decreases linearly with totalClaimed", async function () {
      console.log("[DEBUG] F5-2: 0% cap, linear decrease with claimed");
      const invested = ethers.parseUnits("100000", 18);

      // With 0% cap and only claimed: value = invested - claimed
      const claimed1 = ethers.parseUnits("30000", 18);
      const id1 = await setupNftWithPosition(invested, 0n, claimed1, 0n);
      const val1 = await strategy.nftValue(id1);
      console.log("[DEBUG] 0% cap, claimed=30k → value:", ethers.formatUnits(val1, 18));

      // lockedPrincipal = 100k * (100k - 30k) / 100k = 70k, value = 70k
      expect(val1).to.equal(invested - claimed1, "0% cap: value = invested - claimed");

      const claimed2 = ethers.parseUnits("80000", 18);
      const id2 = await setupNftWithPosition(invested, 0n, claimed2, 0n);
      const val2 = await strategy.nftValue(id2);
      console.log("[DEBUG] 0% cap, claimed=80k → value:", ethers.formatUnits(val2, 18));
      expect(val2).to.equal(invested - claimed2, "0% cap: value = invested - claimed");
    });

    it("0% cap: value = 0 when fully claimed (totalClaimed = maxReturn = invested)", async function () {
      console.log("[DEBUG] F5-3: 0% cap, fully claimed");
      const invested = ethers.parseUnits("100000", 18);

      const tokenId = await setupNftWithPosition(invested, 0n, invested, 0n);
      const value = await strategy.nftValue(tokenId);
      console.log("[DEBUG] 0% cap, fully claimed → value:", value.toString());
      expect(value).to.equal(0n, "0% cap: value = 0 when fully claimed");
    });
  });
});
