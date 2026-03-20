import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

/**
 * harvestSingle() + harvest() Auto-Cleanup Proofs
 *
 * Verifies that harvest functions automatically remove burned NFTs from tracking
 * after claimLenderYield triggers auto-burn (recordClaim → _burn when fully repaid).
 *
 * PROOF-1: harvestSingle auto-cleans burned NFT from tracking
 * PROOF-2: harvest() auto-cleans burned NFTs during iteration
 * PROOF-3: harvestSingle reverts entirely on claimLenderYield failure (by design)
 * PROOF-4: Multi-NFT scenario — auto-burn cleanup mid-sequence
 */
describe("RealEstateStrategy — harvestSingle/harvest Auto-Cleanup Proofs", function () {
  let strategy: Contract;
  let mockNFT: Contract;
  let mockMasterAutoBurn: Contract;
  let mockVault: Contract;
  let usdt: Contract;
  let admin: Signer;
  let adminAddr: string;
  let vaultAddr: string;

  async function deployFixture() {
    console.log("[DEBUG] harvestSingle-proofs deployFixture: start");
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

    // Deploy mock master WITH auto-burn capability
    const MockMasterAutoBurn = await ethers.getContractFactory("MockPortfolioMasterWithAutoBurn");
    mockMasterAutoBurn = await MockMasterAutoBurn.deploy(await usdt.getAddress());
    await mockMasterAutoBurn.waitForDeployment();
    await mockMasterAutoBurn.setMockNFT(await mockNFT.getAddress());

    // Deploy strategy harness (with auto-burn master)
    const Strategy = await ethers.getContractFactory("RealEstateStrategyHarness");
    strategy = await Strategy.deploy(
      await usdt.getAddress(),
      await mockNFT.getAddress(),
      await mockMasterAutoBurn.getAddress(),
      vaultAddr,
      adminAddr,
    );
    await strategy.waitForDeployment();
    console.log("[DEBUG] harvestSingle-proofs deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // Helper: mint NFT to strategy and track it
  async function mintAndTrackNft(
    invested: bigint,
    owed: bigint = 0n,
    claimed: bigint = 0n,
    yieldCapBps: bigint = 4000n
  ): Promise<bigint> {
    console.log("[DEBUG] mintAndTrackNft: invested=%s owed=%s claimed=%s", invested, owed, claimed);
    const tokenId = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
    await mockNFT.mintUnsafe(await strategy.getAddress());
    await strategy.connect(admin).addNftForTesting(tokenId);
    await mockNFT.setPosition(tokenId, {
      amountInvested: invested,
      amountOwed: owed,
      totalClaimed: claimed,
      yieldCapBps: yieldCapBps,
      propertyId: 1,
      trancheType: 0,
      isSplit: false,
      splitDepth: 0,
    });
    return tokenId;
  }

  // ═══════════════════════════════════════════════════════════════
  // PROOF-1: harvestSingle auto-cleans burned NFT from tracking
  // ═══════════════════════════════════════════════════════════════

  describe("PROOF-1: harvestSingle auto-cleanup after auto-burn", function () {

    it("harvestSingle removes burned NFT from tracking after auto-burn", async function () {
      console.log("[DEBUG] PROOF-1a: harvestSingle + auto-burn → auto-cleanup");

      const invested = ethers.parseUnits("100000", 18);
      const nftId = await mintAndTrackNft(invested);

      // Set up: final yield claim that will trigger auto-burn
      const finalYield = ethers.parseUnits("5000", 18);
      await mockMasterAutoBurn.setClaimableAmount(nftId, finalYield);
      await mockMasterAutoBurn.setAutoBurn(nftId, true);
      await usdt.mint(await mockMasterAutoBurn.getAddress(), finalYield);

      // Pre-checks
      expect(await strategy.isHeldNft(nftId)).to.be.true;
      expect(await strategy.heldNftCount()).to.equal(1);
      console.log("[DEBUG] pre-harvest: isHeldNft=true, count=1");

      // harvestSingle succeeds and auto-cleans the burned NFT
      const tx = await strategy.connect(admin).harvestSingle(nftId);
      await expect(tx).to.emit(strategy, "HarvestedSingle").withArgs(nftId, finalYield);
      await expect(tx).to.emit(strategy, "NftRemoved").withArgs(nftId);

      // USDT received correctly
      const strategyBal = await usdt.balanceOf(await strategy.getAddress());
      expect(strategyBal).to.equal(finalYield);
      console.log("[DEBUG] post-harvest: strategy received %s USDT", ethers.formatUnits(strategyBal, 18));

      // FIX VERIFIED: burned NFT auto-removed from tracking
      expect(await strategy.isHeldNft(nftId)).to.be.false;
      expect(await strategy.heldNftCount()).to.equal(0);
      console.log("[DEBUG] PROOF-1a VERIFIED: auto-cleanup removed burned NFT from tracking");
    });

    it("subsequent harvestSingle on auto-burned NFT reverts with NftNotHeld (correct guard)", async function () {
      console.log("[DEBUG] PROOF-1b: second harvestSingle on cleaned-up NFT → NftNotHeld");

      const invested = ethers.parseUnits("100000", 18);
      const nftId = await mintAndTrackNft(invested);

      // First call: triggers auto-burn + auto-cleanup
      const finalYield = ethers.parseUnits("5000", 18);
      await mockMasterAutoBurn.setClaimableAmount(nftId, finalYield);
      await mockMasterAutoBurn.setAutoBurn(nftId, true);
      await usdt.mint(await mockMasterAutoBurn.getAddress(), finalYield);
      await strategy.connect(admin).harvestSingle(nftId);

      // NFT removed from tracking — guard check works correctly
      expect(await strategy.isHeldNft(nftId)).to.be.false;

      // Second call: reverts at the isHeldNft guard (not deep in claimLenderYield)
      await expect(strategy.connect(admin).harvestSingle(nftId))
        .to.be.revertedWithCustomError(strategy, "NftNotHeld");
      console.log("[DEBUG] PROOF-1b VERIFIED: second call reverts early with NftNotHeld (saves gas)");
    });

    it("totalAssets does not iterate ghost entries after auto-cleanup", async function () {
      console.log("[DEBUG] PROOF-1c: no ghost entries in totalAssets after auto-cleanup");

      const invested = ethers.parseUnits("100000", 18);
      const nftId = await mintAndTrackNft(invested);

      // Trigger auto-burn via harvestSingle
      const finalYield = ethers.parseUnits("5000", 18);
      await mockMasterAutoBurn.setClaimableAmount(nftId, finalYield);
      await mockMasterAutoBurn.setAutoBurn(nftId, true);
      await usdt.mint(await mockMasterAutoBurn.getAddress(), finalYield);
      await strategy.connect(admin).harvestSingle(nftId);

      // No ghost entries — heldNftIds is clean
      expect(await strategy.heldNftCount()).to.equal(0);

      const total = await strategy.totalAssets();
      expect(total).to.equal(finalYield); // only idle balance
      console.log("[DEBUG] PROOF-1c VERIFIED: heldNftCount=0, no ghost iteration in totalAssets");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PROOF-2: harvest() auto-cleans burned NFTs during iteration
  // ═══════════════════════════════════════════════════════════════

  describe("PROOF-2: harvest() auto-cleanup during iteration", function () {

    it("harvest removes auto-burned NFTs while correctly iterating remaining ones", async function () {
      console.log("[DEBUG] PROOF-2a: harvest + auto-burn mid-iteration → correct cleanup");

      const invested = ethers.parseUnits("100000", 18);
      const nftId1 = await mintAndTrackNft(invested);
      const nftId2 = await mintAndTrackNft(invested); // will auto-burn
      const nftId3 = await mintAndTrackNft(invested);

      const yield1 = ethers.parseUnits("1000", 18);
      const yield2 = ethers.parseUnits("5000", 18);
      const yield3 = ethers.parseUnits("2000", 18);

      await mockMasterAutoBurn.setClaimableAmount(nftId1, yield1);
      await mockMasterAutoBurn.setClaimableAmount(nftId2, yield2);
      await mockMasterAutoBurn.setAutoBurn(nftId2, true);
      await mockMasterAutoBurn.setClaimableAmount(nftId3, yield3);
      await usdt.mint(await mockMasterAutoBurn.getAddress(), yield1 + yield2 + yield3);

      expect(await strategy.heldNftCount()).to.equal(3);

      const tx = await strategy.connect(admin).harvest();
      await expect(tx).to.emit(strategy, "Harvested").withArgs(yield1 + yield2 + yield3);
      await expect(tx).to.emit(strategy, "NftRemoved").withArgs(nftId2);

      // All yield received
      const totalReceived = await usdt.balanceOf(await strategy.getAddress());
      expect(totalReceived).to.equal(yield1 + yield2 + yield3);

      // Burned NFT removed, others still tracked
      expect(await strategy.heldNftCount()).to.equal(2);
      expect(await strategy.isHeldNft(nftId1)).to.be.true;
      expect(await strategy.isHeldNft(nftId2)).to.be.false;
      expect(await strategy.isHeldNft(nftId3)).to.be.true;
      console.log("[DEBUG] PROOF-2a VERIFIED: harvest cleaned up burned NFT, kept 2 alive ones");
    });

    it("harvest handles multiple auto-burns in single call", async function () {
      console.log("[DEBUG] PROOF-2b: multiple auto-burns in single harvest");

      const invested = ethers.parseUnits("50000", 18);
      const nftId1 = await mintAndTrackNft(invested); // burn
      const nftId2 = await mintAndTrackNft(invested); // keep
      const nftId3 = await mintAndTrackNft(invested); // burn

      const yield1 = ethers.parseUnits("1000", 18);
      const yield2 = ethers.parseUnits("500", 18);
      const yield3 = ethers.parseUnits("2000", 18);

      await mockMasterAutoBurn.setClaimableAmount(nftId1, yield1);
      await mockMasterAutoBurn.setAutoBurn(nftId1, true);
      await mockMasterAutoBurn.setClaimableAmount(nftId2, yield2);
      await mockMasterAutoBurn.setClaimableAmount(nftId3, yield3);
      await mockMasterAutoBurn.setAutoBurn(nftId3, true);
      await usdt.mint(await mockMasterAutoBurn.getAddress(), yield1 + yield2 + yield3);

      const tx = await strategy.connect(admin).harvest();
      await expect(tx).to.emit(strategy, "Harvested").withArgs(yield1 + yield2 + yield3);

      // Only nftId2 remains
      expect(await strategy.heldNftCount()).to.equal(1);
      expect(await strategy.isHeldNft(nftId1)).to.be.false;
      expect(await strategy.isHeldNft(nftId2)).to.be.true;
      expect(await strategy.isHeldNft(nftId3)).to.be.false;

      const totalReceived = await usdt.balanceOf(await strategy.getAddress());
      expect(totalReceived).to.equal(yield1 + yield2 + yield3);
      console.log("[DEBUG] PROOF-2b VERIFIED: 2 of 3 NFTs auto-burned and cleaned, 1 remains");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PROOF-3: harvestSingle reverts on failure (by design)
  // ═══════════════════════════════════════════════════════════════

  describe("PROOF-3: harvestSingle revert behavior (by design)", function () {

    it("harvestSingle reverts entirely when claimLenderYield fails (vs harvest which continues)", async function () {
      console.log("[DEBUG] PROOF-3: harvestSingle vs harvest error handling");

      const invested = ethers.parseUnits("100000", 18);
      const nftId1 = await mintAndTrackNft(invested);
      const nftId2 = await mintAndTrackNft(invested);

      // Make nftId1 fail, nftId2 has yield
      await mockMasterAutoBurn.setShouldRevert(nftId1, true);
      const yield2 = ethers.parseUnits("2000", 18);
      await mockMasterAutoBurn.setClaimableAmount(nftId2, yield2);
      await usdt.mint(await mockMasterAutoBurn.getAddress(), yield2);

      // harvestSingle on failing NFT: reverts ENTIRE tx (by design — informative for caller)
      await expect(strategy.connect(admin).harvestSingle(nftId1))
        .to.be.revertedWith("claim reverted");

      // harvest() on same set: succeeds, just emits HarvestFailed for nftId1
      const tx = await strategy.connect(admin).harvest();
      await expect(tx).to.emit(strategy, "HarvestFailed");
      await expect(tx).to.emit(strategy, "Harvested");

      const bal = await usdt.balanceOf(await strategy.getAddress());
      expect(bal).to.equal(yield2);
      console.log("[DEBUG] PROOF-3 VERIFIED: harvestSingle reverts (by design), harvest() resilient");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PROOF-4: Multi-NFT compound scenario with auto-cleanup
  // ═══════════════════════════════════════════════════════════════

  describe("PROOF-4: Multi-NFT compound scenario", function () {

    it("auto-burn of one NFT during harvestSingle auto-cleans tracking", async function () {
      console.log("[DEBUG] PROOF-4: compound multi-NFT scenario with auto-cleanup");

      const invested = ethers.parseUnits("100000", 18);
      const nftId1 = await mintAndTrackNft(invested);
      const nftId2 = await mintAndTrackNft(invested);
      const nftId3 = await mintAndTrackNft(invested);

      expect(await strategy.heldNftCount()).to.equal(3);

      // nftId2 will be auto-burned on claim
      const yield1 = ethers.parseUnits("1000", 18);
      const yield2 = ethers.parseUnits("5000", 18);
      const yield3 = ethers.parseUnits("2000", 18);

      await mockMasterAutoBurn.setClaimableAmount(nftId1, yield1);
      await mockMasterAutoBurn.setClaimableAmount(nftId2, yield2);
      await mockMasterAutoBurn.setAutoBurn(nftId2, true);
      await mockMasterAutoBurn.setClaimableAmount(nftId3, yield3);
      await usdt.mint(await mockMasterAutoBurn.getAddress(), yield1 + yield2 + yield3);

      // Harvest each individually
      await strategy.connect(admin).harvestSingle(nftId1);
      await strategy.connect(admin).harvestSingle(nftId2); // auto-burns + auto-cleans nftId2
      await strategy.connect(admin).harvestSingle(nftId3);

      // All yield received
      const totalReceived = await usdt.balanceOf(await strategy.getAddress());
      expect(totalReceived).to.equal(yield1 + yield2 + yield3);
      console.log("[DEBUG] Total yield received: %s", ethers.formatUnits(totalReceived, 18));

      // Tracking is clean — burned nftId2 auto-removed
      expect(await strategy.heldNftCount()).to.equal(2);
      expect(await strategy.isHeldNft(nftId1)).to.be.true;
      expect(await strategy.isHeldNft(nftId2)).to.be.false; // auto-cleaned
      expect(await strategy.isHeldNft(nftId3)).to.be.true;

      console.log("[DEBUG] PROOF-4 VERIFIED: 2 NFTs tracked (correct), burned nftId2 auto-removed");
    });
  });
});
