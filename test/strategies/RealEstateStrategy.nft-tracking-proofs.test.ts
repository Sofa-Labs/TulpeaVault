import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("RealEstateStrategy — NFT Tracking Proofs", function () {
  let strategy: Contract;
  let mockNFT: Contract;
  let mockMaster: Contract;
  let usdt: Contract;
  let admin: Signer;
  let adminAddr: string;
  let vaultAddr: string;

  let mockVault: Contract;

  async function deployFixture() {
    console.log("[DEBUG] nft-tracking deployFixture: start");
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
    console.log("[DEBUG] nft-tracking deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // ═══════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════

  /** Mint NFT to strategy (unsafeMint to bypass onERC721Received) + track via harness + set position */
  async function mintAndTrackNft(
    invested: bigint,
    owed: bigint = 0n,
    claimed: bigint = 0n,
    yieldCapBps: bigint = 4000n
  ): Promise<bigint> {
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
    console.log(`[DEBUG] mintAndTrackNft: tokenId=${tokenId} invested=${invested} owed=${owed} claimed=${claimed}`);
    return tokenId;
  }

  /** Assert full three-way consistency of heldNftIds, isHeldNft, nftIndex */
  async function assertFullConsistency(expectedIds: bigint[]) {
    const heldCount = await strategy.heldNftCount();
    console.log(`[DEBUG] assertFullConsistency: expectedIds=[${expectedIds}] heldCount=${heldCount}`);
    expect(heldCount).to.equal(expectedIds.length, "heldNftCount mismatch");

    const heldIds: bigint[] = [];
    for (let i = 0; i < Number(heldCount); i++) {
      heldIds.push(await strategy.heldNftIds(i));
    }

    // All expected IDs should be present
    for (const id of expectedIds) {
      expect(await strategy.isHeldNft(id)).to.equal(true, `isHeldNft(${id}) should be true`);
      const idx = await strategy.nftIndex(id);
      expect(heldIds[Number(idx)]).to.equal(id, `nftIndex(${id}) points to wrong element`);
    }

    // All held IDs should be in expected set
    const expectedSet = new Set(expectedIds.map(String));
    for (const id of heldIds) {
      expect(expectedSet.has(String(id))).to.equal(true, `heldNftIds contains unexpected ${id}`);
    }

    // No duplicates
    const heldSet = new Set(heldIds.map(String));
    expect(heldSet.size).to.equal(heldIds.length, "heldNftIds has duplicates");
    console.log(`[DEBUG] assertFullConsistency: passed for [${expectedIds}]`);
  }

  // ═══════════════════════════════════════════════════════════
  // PROOF 1: Phantom Profit — FIXED: burned NFTs skipped in totalAssets()
  // ═══════════════════════════════════════════════════════════

  describe("PROOF 1: Phantom Profit (FIXED)", function () {
    it("1.1: Single burned NFT is skipped by totalAssets() — no phantom profit", async function () {
      console.log("[DEBUG] PROOF 1.1: start");
      const invested = ethers.parseUnits("1000", 18);
      const tokenId = await mintAndTrackNft(invested);

      const totalBefore = await strategy.totalAssets();
      const nftVal = await strategy.nftValue(tokenId);
      console.log(`[DEBUG] totalBefore=${totalBefore} nftVal=${nftVal}`);
      expect(nftVal).to.be.gt(0n);
      expect(totalBefore).to.equal(nftVal);

      // Burn the NFT — totalAssets now skips it (ownerOf check)
      await mockNFT.burn(tokenId);
      const totalAfterBurn = await strategy.totalAssets();
      console.log(`[DEBUG] totalAfterBurn=${totalAfterBurn} (should be 0 — fix skips burned NFTs)`);
      expect(totalAfterBurn).to.equal(0n, "FIX: burned NFT skipped, no phantom profit");

      // Cleanup still works and removes the stale tracking entry
      await strategy.connect(admin).cleanupBurnedNfts();
      expect(await strategy.totalAssets()).to.equal(0n);
      expect(await strategy.heldNftCount()).to.equal(0n, "Cleanup removed tracking entry");
    });

    it("1.2: Multi-NFT — burned NFT excluded, live NFT unaffected", async function () {
      console.log("[DEBUG] PROOF 1.2: start");
      const invested1 = ethers.parseUnits("1000", 18);
      const invested2 = ethers.parseUnits("2000", 18);
      const tokenId1 = await mintAndTrackNft(invested1);
      const tokenId2 = await mintAndTrackNft(invested2);

      const val1 = await strategy.nftValue(tokenId1);
      const val2 = await strategy.nftValue(tokenId2);
      const totalBefore = await strategy.totalAssets();
      console.log(`[DEBUG] val1=${val1} val2=${val2} totalBefore=${totalBefore}`);
      expect(totalBefore).to.equal(val1 + val2);

      // Burn NFT 1 only — totalAssets should only include val2
      await mockNFT.burn(tokenId1);
      const totalAfterBurn = await strategy.totalAssets();
      console.log(`[DEBUG] totalAfterBurn=${totalAfterBurn} (should be val2 only)`);
      expect(totalAfterBurn).to.equal(val2, "FIX: only live NFT counted");

      // Cleanup removes stale tracking
      await strategy.connect(admin).cleanupBurnedNfts();
      expect(await strategy.totalAssets()).to.equal(val2);
      expect(await strategy.heldNftCount()).to.equal(1n);
    });

    it("1.3: Fully-capped NFT with unclaimed amountOwed — no phantom after burn", async function () {
      console.log("[DEBUG] PROOF 1.3: start");
      const invested = ethers.parseUnits("1000", 18);
      const owed = ethers.parseUnits("100", 18);
      const claimed = ethers.parseUnits("1400", 18);
      const tokenId = await mintAndTrackNft(invested, owed, claimed, 4000n);

      const nftVal = await strategy.nftValue(tokenId);
      console.log(`[DEBUG] nftVal=${nftVal} (should be owed=${owed})`);
      expect(nftVal).to.equal(owed, "Fully-capped NFT value = amountOwed only");

      // Burn it — totalAssets should be 0 (fix skips burned)
      await mockNFT.burn(tokenId);
      const totalAfterBurn = await strategy.totalAssets();
      console.log(`[DEBUG] totalAfterBurn=${totalAfterBurn} (should be 0 — fix applied)`);
      expect(totalAfterBurn).to.equal(0n, "FIX: no phantom from burned fully-capped NFT");

      await strategy.connect(admin).cleanupBurnedNfts();
      expect(await strategy.totalAssets()).to.equal(0n);
    });

    it("1.4: Zero-value burned NFT (fully claimed) produces no phantom", async function () {
      console.log("[DEBUG] PROOF 1.4: start");
      const invested = ethers.parseUnits("1000", 18);
      const claimed = ethers.parseUnits("1400", 18);
      const tokenId = await mintAndTrackNft(invested, 0n, claimed, 4000n);

      const nftVal = await strategy.nftValue(tokenId);
      console.log(`[DEBUG] nftVal=${nftVal} (should be 0)`);
      expect(nftVal).to.equal(0n, "Fully claimed NFT has zero value");

      await mockNFT.burn(tokenId);
      const totalAfterBurn = await strategy.totalAssets();
      console.log(`[DEBUG] totalAfterBurn=${totalAfterBurn}`);
      expect(totalAfterBurn).to.equal(0n, "No phantom from zero-value burned NFT");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // PROOF 2: totalAssets() Fragility — FIXED: try-catch prevents DoS
  // ═══════════════════════════════════════════════════════════

  describe("PROOF 2: totalAssets() Fragility (FIXED)", function () {
    it("2.1: Per-token getPosition revert is caught — totalAssets() skips it gracefully", async function () {
      console.log("[DEBUG] PROOF 2.1: start");
      const invested = ethers.parseUnits("1000", 18);
      const tokenId1 = await mintAndTrackNft(invested);
      const tokenId2 = await mintAndTrackNft(invested);

      const val2 = await strategy.nftValue(tokenId2);
      const totalBefore = await strategy.totalAssets();
      console.log(`[DEBUG] totalBefore=${totalBefore}`);
      expect(totalBefore).to.be.gt(0n);

      // Make getPosition revert for token 1 only — totalAssets should NOT revert
      await mockNFT.setRevertForToken(tokenId1, true);

      console.log("[DEBUG] totalAssets() should succeed despite reverting token...");
      const totalAfter = await strategy.totalAssets();
      console.log(`[DEBUG] totalAfter=${totalAfter} val2=${val2}`);
      expect(totalAfter).to.equal(val2, "FIX: reverting token skipped, other token counted");
    });

    it("2.2: Global revert flag — totalAssets() returns idle balance only (no DoS)", async function () {
      console.log("[DEBUG] PROOF 2.2: start");
      const tokenId = await mintAndTrackNft(ethers.parseUnits("500", 18));

      // Send some idle USDT to strategy
      const idleAmount = ethers.parseUnits("100", 18);
      await usdt.mint(await strategy.getAddress(), idleAmount);

      await mockNFT.setRevertOnGetPosition(true);
      console.log("[DEBUG] totalAssets() should return idle balance only...");
      const total = await strategy.totalAssets();
      console.log(`[DEBUG] total=${total} idleAmount=${idleAmount}`);
      expect(total).to.equal(idleAmount, "FIX: global revert caught, returns idle balance");

      // Reset — now NFT value is included again
      await mockNFT.setRevertOnGetPosition(false);
      const totalAfterReset = await strategy.totalAssets();
      console.log(`[DEBUG] After reset: totalAssets=${totalAfterReset}`);
      expect(totalAfterReset).to.be.gt(idleAmount, "NFT value included after reset");
    });

    it("2.3: Burned + reverting token — both fixes cooperate: ownerOf catch skips it", async function () {
      console.log("[DEBUG] PROOF 2.3: start");
      const invested = ethers.parseUnits("1000", 18);
      const tokenId1 = await mintAndTrackNft(invested);
      const tokenId2 = await mintAndTrackNft(invested);

      const val2 = await strategy.nftValue(tokenId2);

      // Burn token 1 and make getPosition revert for it
      await mockNFT.burn(tokenId1);
      await mockNFT.setRevertForToken(tokenId1, true);

      // totalAssets works — ownerOf catch skips burned token before getPosition is even called
      console.log("[DEBUG] totalAssets() should succeed...");
      const totalBeforeCleanup = await strategy.totalAssets();
      console.log(`[DEBUG] totalBeforeCleanup=${totalBeforeCleanup} val2=${val2}`);
      expect(totalBeforeCleanup).to.equal(val2, "FIX: burned+reverting token skipped");

      // Cleanup removes the burned token from tracking
      await strategy.connect(admin).cleanupBurnedNfts();

      // totalAssets still works, only token 2 counted
      const totalAfter = await strategy.totalAssets();
      console.log(`[DEBUG] totalAfter=${totalAfter} val2=${val2}`);
      expect(totalAfter).to.equal(val2);
      expect(await strategy.heldNftCount()).to.equal(1n, "Only token 2 remains tracked");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // PROOF 3: 0-Based Index Ambiguity
  // ═══════════════════════════════════════════════════════════

  describe("PROOF 3: 0-Based Index Ambiguity", function () {
    it("3.1: After removing NFT at index 0, nftIndex returns 0 for both deleted and valid-at-0 — isHeldNft differentiates", async function () {
      console.log("[DEBUG] PROOF 3.1: start");
      const tokenId1 = await mintAndTrackNft(ethers.parseUnits("100", 18)); // index 0
      const tokenId2 = await mintAndTrackNft(ethers.parseUnits("200", 18)); // index 1

      // Remove tokenId1 (index 0) → swap-and-pop puts tokenId2 at index 0
      await strategy.connect(admin).removeNftForTesting(tokenId1);

      // nftIndex for deleted tokenId1 is 0 (delete sets to default)
      const deletedIndex = await strategy.nftIndex(tokenId1);
      // nftIndex for valid tokenId2 is also 0 (swapped into position 0)
      const validIndex = await strategy.nftIndex(tokenId2);
      console.log(`[DEBUG] deletedIndex(tokenId1)=${deletedIndex} validIndex(tokenId2)=${validIndex}`);
      expect(deletedIndex).to.equal(0n, "Deleted token nftIndex defaults to 0");
      expect(validIndex).to.equal(0n, "Valid token at index 0");

      // isHeldNft differentiates
      expect(await strategy.isHeldNft(tokenId1)).to.equal(false, "Deleted token: isHeldNft=false");
      expect(await strategy.isHeldNft(tokenId2)).to.equal(true, "Valid token: isHeldNft=true");
      await assertFullConsistency([tokenId2]);
    });

    it("3.2: Double-remove is safe (idempotent via isHeldNft guard)", async function () {
      console.log("[DEBUG] PROOF 3.2: start");
      const tokenId = await mintAndTrackNft(ethers.parseUnits("100", 18));

      await strategy.connect(admin).removeNftForTesting(tokenId);
      expect(await strategy.heldNftCount()).to.equal(0n);

      // Second remove should be no-op (isHeldNft is false)
      await strategy.connect(admin).removeNftForTesting(tokenId);
      expect(await strategy.heldNftCount()).to.equal(0n);
      console.log("[DEBUG] PROOF 3.2: double-remove succeeded (no-op)");
    });

    it("3.3: Complex 5-NFT sequence — isHeldNft correctly differentiates ambiguous nftIndex values", async function () {
      console.log("[DEBUG] PROOF 3.3: start");
      const ids: bigint[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await mintAndTrackNft(ethers.parseUnits(`${(i + 1) * 100}`, 18)));
      }
      console.log(`[DEBUG] Minted 5 NFTs: [${ids}]`);

      // Remove index 0, 2 (original positions)
      await strategy.connect(admin).removeNftForTesting(ids[0]); // swap last → pos 0
      await strategy.connect(admin).removeNftForTesting(ids[2]); // swap last → pos where ids[2] was

      const remaining = [ids[1], ids[3], ids[4]].filter(async (id) => await strategy.isHeldNft(id));
      // Verify removed ones
      expect(await strategy.isHeldNft(ids[0])).to.equal(false);
      expect(await strategy.isHeldNft(ids[2])).to.equal(false);

      // Verify remaining are consistent
      const expectedRemaining: bigint[] = [];
      for (const id of ids) {
        if (await strategy.isHeldNft(id)) expectedRemaining.push(id);
      }
      console.log(`[DEBUG] expectedRemaining: [${expectedRemaining}]`);
      expect(expectedRemaining.length).to.equal(3);
      await assertFullConsistency(expectedRemaining);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // PROOF 4: Re-add After Removal
  // ═══════════════════════════════════════════════════════════

  describe("PROOF 4: Re-add After Removal", function () {
    it("4.1: Basic re-add works with correct state", async function () {
      console.log("[DEBUG] PROOF 4.1: start");
      const tokenId = await mintAndTrackNft(ethers.parseUnits("1000", 18));
      await assertFullConsistency([tokenId]);

      // Remove
      await strategy.connect(admin).removeNftForTesting(tokenId);
      await assertFullConsistency([]);
      expect(await strategy.isHeldNft(tokenId)).to.equal(false);

      // Re-add
      await strategy.connect(admin).addNftForTesting(tokenId);
      await assertFullConsistency([tokenId]);
      expect(await strategy.isHeldNft(tokenId)).to.equal(true);
      console.log("[DEBUG] PROOF 4.1: re-add succeeded");
    });

    it("4.2: Re-add among other NFTs preserves consistency", async function () {
      console.log("[DEBUG] PROOF 4.2: start");
      const id1 = await mintAndTrackNft(ethers.parseUnits("100", 18));
      const id2 = await mintAndTrackNft(ethers.parseUnits("200", 18));
      const id3 = await mintAndTrackNft(ethers.parseUnits("300", 18));

      // Remove id2
      await strategy.connect(admin).removeNftForTesting(id2);
      await assertFullConsistency([id1, id3]);

      // Re-add id2
      await strategy.connect(admin).addNftForTesting(id2);
      await assertFullConsistency([id1, id3, id2]); // appended at end
      console.log("[DEBUG] PROOF 4.2: re-add among others succeeded");
    });

    it("4.3: Re-add same ID is idempotent (no duplicate)", async function () {
      console.log("[DEBUG] PROOF 4.3: start");
      const tokenId = await mintAndTrackNft(ethers.parseUnits("1000", 18));

      // Double-add should be no-op (isHeldNft guard in _addNft)
      await strategy.connect(admin).addNftForTesting(tokenId);
      expect(await strategy.heldNftCount()).to.equal(1n, "No duplicate after double-add");
      await assertFullConsistency([tokenId]);
      console.log("[DEBUG] PROOF 4.3: idempotent add succeeded");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // PROOF 5: Comprehensive Swap-and-Pop Consistency
  // ═══════════════════════════════════════════════════════════

  describe("PROOF 5: Comprehensive Swap-and-Pop Consistency", function () {
    it("5.1: Sequential removal from various positions — three-way consistency after each op", async function () {
      console.log("[DEBUG] PROOF 5.1: start");
      const ids: bigint[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await mintAndTrackNft(ethers.parseUnits(`${(i + 1) * 100}`, 18)));
      }
      await assertFullConsistency(ids);

      // Remove from middle (index 2)
      const remaining = [...ids];
      await strategy.connect(admin).removeNftForTesting(ids[2]);
      remaining.splice(remaining.indexOf(ids[2]), 1);
      const liveIds1 = await collectLiveIds();
      console.log(`[DEBUG] After removing ids[2]: live=[${liveIds1}]`);
      await assertFullConsistency(liveIds1);

      // Remove from start (ids[0])
      await strategy.connect(admin).removeNftForTesting(ids[0]);
      remaining.splice(remaining.indexOf(ids[0]), 1);
      const liveIds2 = await collectLiveIds();
      console.log(`[DEBUG] After removing ids[0]: live=[${liveIds2}]`);
      await assertFullConsistency(liveIds2);

      // Remove from end (last element)
      const lastId = liveIds2[liveIds2.length - 1];
      await strategy.connect(admin).removeNftForTesting(lastId);
      const liveIds3 = await collectLiveIds();
      console.log(`[DEBUG] After removing last: live=[${liveIds3}]`);
      await assertFullConsistency(liveIds3);
      expect(liveIds3.length).to.equal(2);
    });

    it("5.2: Interleaved add/remove operations", async function () {
      console.log("[DEBUG] PROOF 5.2: start");
      const id1 = await mintAndTrackNft(ethers.parseUnits("100", 18));
      const id2 = await mintAndTrackNft(ethers.parseUnits("200", 18));
      await assertFullConsistency([id1, id2]);

      // Remove id1
      await strategy.connect(admin).removeNftForTesting(id1);
      await assertFullConsistency([id2]);

      // Add id3
      const id3 = await mintAndTrackNft(ethers.parseUnits("300", 18));
      await assertFullConsistency([id2, id3]);

      // Remove id2
      await strategy.connect(admin).removeNftForTesting(id2);
      await assertFullConsistency([id3]);

      // Re-add id1
      await strategy.connect(admin).addNftForTesting(id1);
      await assertFullConsistency([id3, id1]);

      // Add id4
      const id4 = await mintAndTrackNft(ethers.parseUnits("400", 18));
      await assertFullConsistency([id3, id1, id4]);

      // Remove id3
      await strategy.connect(admin).removeNftForTesting(id3);
      await assertFullConsistency([id1, id4]);
      console.log("[DEBUG] PROOF 5.2: interleaved complete");
    });

    it("5.3: Remove all in reverse order (minimal swap-and-pop)", async function () {
      console.log("[DEBUG] PROOF 5.3: start");
      const ids: bigint[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await mintAndTrackNft(ethers.parseUnits(`${(i + 1) * 100}`, 18)));
      }

      // Remove last → second-to-last → ... → first (never triggers swap, only pop)
      for (let i = ids.length - 1; i >= 0; i--) {
        await strategy.connect(admin).removeNftForTesting(ids[i]);
        const expected = ids.slice(0, i);
        await assertFullConsistency(expected);
        console.log(`[DEBUG] Removed ids[${i}], remaining=${i} ids`);
      }

      expect(await strategy.heldNftCount()).to.equal(0n);
    });

    it("5.4: Remove all in forward order (maximum swap-and-pop)", async function () {
      console.log("[DEBUG] PROOF 5.4: start");
      const ids: bigint[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await mintAndTrackNft(ethers.parseUnits(`${(i + 1) * 100}`, 18)));
      }

      // Remove first each time → always swaps last element into position 0
      for (let i = 0; i < ids.length; i++) {
        const liveBeforeRemove = await collectLiveIds();
        const toRemove = liveBeforeRemove[0]; // always remove first element
        console.log(`[DEBUG] Removing first element: ${toRemove}`);
        await strategy.connect(admin).removeNftForTesting(toRemove);
        const liveAfter = await collectLiveIds();
        await assertFullConsistency(liveAfter);
        console.log(`[DEBUG] After forward removal ${i + 1}: ${liveAfter.length} remaining`);
      }

      expect(await strategy.heldNftCount()).to.equal(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // UTILITY
  // ═══════════════════════════════════════════════════════════

  /** Collect all currently held NFT IDs from contract */
  async function collectLiveIds(): Promise<bigint[]> {
    const count = await strategy.heldNftCount();
    const ids: bigint[] = [];
    for (let i = 0; i < Number(count); i++) {
      ids.push(await strategy.heldNftIds(i));
    }
    return ids;
  }
});
