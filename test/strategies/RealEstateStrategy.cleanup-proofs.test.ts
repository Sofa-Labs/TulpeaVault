import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

/**
 * RealEstateStrategy.cleanupBurnedNfts() — Production-Readiness Audit Proofs
 *
 * Proves/disproves 6 findings from skeptical analysis:
 *   F1: Missing nonReentrant is safe (STATICCALL + immutable target)
 *   F2: Swap-and-pop correctness under edge burn patterns
 *   F3: totalAssets() phantom value between burn and cleanup
 *   F4: Gas at MAX_NFTS=50
 *   F5: Event accuracy
 *   F6: Transferred (not burned) NFT handling
 */
describe("RealEstateStrategy — cleanupBurnedNfts Audit Proofs", function () {
  let strategy: Contract;
  let mockNFT: Contract;
  let mockMaster: Contract;
  let usdt: Contract;
  let admin: Signer;
  let user1: Signer;
  let adminAddr: string;
  let vaultAddr: string;

  let mockVault: Contract;

  async function deployFixture() {
    console.log("[DEBUG] cleanup-proofs deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
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
    console.log("[DEBUG] cleanup-proofs deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // Helper: mint NFT to strategy (via mintUnsafe to bypass onERC721Received) and track + set position
  async function mintAndTrackNft(
    invested: bigint,
    owed: bigint = 0n,
    claimed: bigint = 0n,
    yieldCapBps: bigint = 4000n
  ): Promise<bigint> {
    const strategyAddr = await strategy.getAddress();
    const tokenId = await mockNFT.mintUnsafe.staticCall(strategyAddr);
    await mockNFT.mintUnsafe(strategyAddr);
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
    console.log(`[DEBUG] mintAndTrackNft: tokenId=${tokenId}, invested=${invested}`);
    return tokenId;
  }

  // Helper: mint N NFTs and return array of token IDs
  async function mintMultipleNfts(
    count: number,
    invested: bigint = ethers.parseUnits("1000", 18)
  ): Promise<bigint[]> {
    const ids: bigint[] = [];
    for (let i = 0; i < count; i++) {
      const id = await mintAndTrackNft(invested);
      ids.push(id);
    }
    console.log(`[DEBUG] mintMultipleNfts: minted ${count} NFTs, ids=${ids.join(",")}`);
    return ids;
  }

  // Helper: verify held NFTs match expected set
  async function expectHeldNfts(expectedIds: bigint[]) {
    const count = await strategy.heldNftCount();
    expect(count).to.equal(expectedIds.length, `heldNftCount mismatch`);

    const heldIds = await strategy.getHeldNftIds();
    console.log(`[DEBUG] expectHeldNfts: held=${heldIds.join(",")}, expected=${expectedIds.join(",")}`);

    // Check each expected ID is held
    for (const id of expectedIds) {
      expect(await strategy.isHeldNft(id)).to.be.true;
    }

    // Check held array contains exactly the expected IDs (order may differ due to swap-and-pop)
    const heldSet = new Set(heldIds.map((id: bigint) => id.toString()));
    const expectedSet = new Set(expectedIds.map((id: bigint) => id.toString()));
    expect(heldSet).to.deep.equal(expectedSet);
  }

  // ═══════════════════════════════════════════════════════════════════
  // FINDING 1: Missing nonReentrant is Safe
  // ═══════════════════════════════════════════════════════════════════

  describe("FINDING 1: Missing nonReentrant is Safe", function () {
    it("1.1 — ownerOf is view/STATICCALL, reentrancy attempt has no effect", async function () {
      console.log("[DEBUG] F1.1: deploy ReentrantNFTMock strategy");

      // Deploy strategy with ReentrantNFTMock as portfolioNFT
      const ReentrantNFT = await ethers.getContractFactory("ReentrantNFTMock");
      const reentrantNFT = await ReentrantNFT.deploy();
      await reentrantNFT.waitForDeployment();

      const Strategy = await ethers.getContractFactory("RealEstateStrategyHarness");
      const reentrantStrategy = await Strategy.deploy(
        await usdt.getAddress(),
        await reentrantNFT.getAddress(),
        await mockMaster.getAddress(),
        vaultAddr,
        adminAddr,
        []
      );
      await reentrantStrategy.waitForDeployment();

      // Mint NFT to strategy, track it
      const stratAddr = await reentrantStrategy.getAddress();
      const tokenId = await reentrantNFT.mintTo.staticCall(stratAddr);
      await reentrantNFT.mintTo(stratAddr);
      await reentrantStrategy.connect(admin).addNftForTesting(tokenId);

      // Enable reentrancy attempt in mock
      await reentrantNFT.setTargetStrategy(stratAddr);
      await reentrantNFT.setReenterOnOwnerOf(true);

      // Burn the NFT
      await reentrantNFT.burn(tokenId);

      // Cleanup should succeed — ownerOf is view, STATICCALL prevents state changes
      await expect(reentrantStrategy.connect(admin).cleanupBurnedNfts())
        .to.emit(reentrantStrategy, "BurnedNftsCleaned")
        .withArgs(1);

      console.log("[DEBUG] F1.1: cleanup succeeded with reentrant NFT");
      expect(await reentrantStrategy.heldNftCount()).to.equal(0);
    });

    it("1.2 — portfolioNFT address is immutable (no setter)", async function () {
      console.log("[DEBUG] F1.2: verify immutability");
      // portfolioNFT is declared `immutable` in contract — check it matches deployment
      expect(await strategy.portfolioNFT()).to.equal(await mockNFT.getAddress());

      // Verify no setter exists by checking ABI
      const iface = strategy.interface;
      const setterNames = Object.keys(iface.functions || {}).filter(
        (name) => name.startsWith("setPortfolioNFT") || name.startsWith("updatePortfolioNFT")
      );
      console.log(`[DEBUG] F1.2: setter functions found: ${setterNames.length}`);
      expect(setterNames.length).to.equal(0, "No setter for portfolioNFT should exist");
    });

    it("1.3 — unauthorized caller reverts NotKeeperOrOwner", async function () {
      console.log("[DEBUG] F1.3: access control");
      await expect(strategy.connect(user1).cleanupBurnedNfts())
        .to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FINDING 2: Swap-and-Pop Iteration Correctness
  // ═══════════════════════════════════════════════════════════════════

  describe("FINDING 2: Swap-and-Pop Iteration Correctness (5 NFTs)", function () {
    let ids: bigint[];

    beforeEach(async function () {
      ids = await mintMultipleNfts(5);
      console.log(`[DEBUG] F2 setup: 5 NFTs minted: ${ids.join(",")}`);
    });

    it("2.1 — all 5 burned → array empties to 0", async function () {
      console.log("[DEBUG] F2.1: burn all");
      for (const id of ids) {
        await mockNFT.burn(id);
      }
      await strategy.connect(admin).cleanupBurnedNfts();
      await expectHeldNfts([]);
    });

    it("2.2 — only first burned → 4 remain", async function () {
      console.log("[DEBUG] F2.2: burn first");
      await mockNFT.burn(ids[0]);
      await strategy.connect(admin).cleanupBurnedNfts();
      await expectHeldNfts(ids.slice(1));
    });

    it("2.3 — only last burned → 4 remain", async function () {
      console.log("[DEBUG] F2.3: burn last");
      await mockNFT.burn(ids[4]);
      await strategy.connect(admin).cleanupBurnedNfts();
      await expectHeldNfts(ids.slice(0, 4));
    });

    it("2.4 — only middle burned → 4 remain", async function () {
      console.log("[DEBUG] F2.4: burn middle");
      await mockNFT.burn(ids[2]);
      await strategy.connect(admin).cleanupBurnedNfts();
      const survivors = [ids[0], ids[1], ids[3], ids[4]];
      await expectHeldNfts(survivors);
    });

    it("2.5 — alternating burn (indices 0,2,4) → 2 remain", async function () {
      console.log("[DEBUG] F2.5: alternating burn — key edge case for swap cascade");
      await mockNFT.burn(ids[0]);
      await mockNFT.burn(ids[2]);
      await mockNFT.burn(ids[4]);
      await strategy.connect(admin).cleanupBurnedNfts();
      await expectHeldNfts([ids[1], ids[3]]);
    });

    it("2.6 — consecutive start (indices 0,1) → 3 remain", async function () {
      console.log("[DEBUG] F2.6: consecutive start burn");
      await mockNFT.burn(ids[0]);
      await mockNFT.burn(ids[1]);
      await strategy.connect(admin).cleanupBurnedNfts();
      await expectHeldNfts([ids[2], ids[3], ids[4]]);
    });

    it("2.7 — consecutive end (indices 3,4) → 3 remain", async function () {
      console.log("[DEBUG] F2.7: consecutive end burn");
      await mockNFT.burn(ids[3]);
      await mockNFT.burn(ids[4]);
      await strategy.connect(admin).cleanupBurnedNfts();
      await expectHeldNfts([ids[0], ids[1], ids[2]]);
    });

    it("2.8 — single NFT array, burned → 0 remain", async function () {
      console.log("[DEBUG] F2.8: single NFT");
      // Use fresh strategy with 1 NFT
      const singleId = ids[0];
      // Burn all except first, then cleanup, then burn first
      for (let i = 1; i < ids.length; i++) {
        await mockNFT.burn(ids[i]);
      }
      await strategy.connect(admin).cleanupBurnedNfts();
      await expectHeldNfts([singleId]);

      // Now burn the last remaining
      await mockNFT.burn(singleId);
      await strategy.connect(admin).cleanupBurnedNfts();
      await expectHeldNfts([]);
    });

    it("2.9 — no burns → 5 remain (no-op)", async function () {
      console.log("[DEBUG] F2.9: no burns");
      await strategy.connect(admin).cleanupBurnedNfts();
      await expectHeldNfts(ids);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FINDING 3: totalAssets() Phantom Value
  // ═══════════════════════════════════════════════════════════════════

  describe("FINDING 3: totalAssets() Phantom Value", function () {
    it("3.1 — fully-claimed NFT (auto-burn path): nftValue == 0 even before cleanup", async function () {
      console.log("[DEBUG] F3.1: fully claimed NFT");
      const invested = ethers.parseUnits("1000", 18);
      const yieldCapBps = 4000n; // 40%
      // maxReturn = 1000 * (10000 + 4000) / 10000 = 1400
      const maxReturn = ethers.parseUnits("1400", 18);
      // totalAllocated = totalClaimed + amountOwed >= maxReturn → lockedPrincipal = 0, value = amountOwed
      const id = await mintAndTrackNft(invested, 0n, maxReturn, yieldCapBps);

      // nftValue should be 0 (fully claimed, no owed)
      const value = await strategy.nftValue(id);
      console.log(`[DEBUG] F3.1: nftValue=${value}`);
      expect(value).to.equal(0n, "Fully claimed NFT should have 0 value");

      // totalAssets should only include idle USDT
      const idleUsdt = ethers.parseUnits("500", 18);
      await usdt.mint(await strategy.getAddress(), idleUsdt);
      const totalBefore = await strategy.totalAssets();
      console.log(`[DEBUG] F3.1: totalAssets before cleanup=${totalBefore}`);
      expect(totalBefore).to.equal(idleUsdt, "totalAssets = idle USDT (NFT value is 0)");
    });

    it("3.2 — non-standard burn (position data NOT zeroed): totalAssets skips burned NFT (FIX applied)", async function () {
      console.log("[DEBUG] F3.2: burned NFT skipped by totalAssets ownerOf check");
      const invested = ethers.parseUnits("1000", 18);
      const owed = ethers.parseUnits("200", 18);
      const id = await mintAndTrackNft(invested, owed, 0n, 4000n);

      // Check value BEFORE burn
      const valueBefore = await strategy.nftValue(id);
      console.log(`[DEBUG] F3.2: nftValue before burn=${valueBefore}`);
      expect(valueBefore).to.be.gt(0n, "NFT should have value before burn");

      // Burn the NFT WITHOUT zeroing position data (non-standard burn)
      await mockNFT.burn(id);

      // FIX: totalAssets now skips burned NFTs via ownerOf check — no phantom
      const totalAfterBurn = await strategy.totalAssets();
      console.log(`[DEBUG] F3.2: totalAssets after burn=${totalAfterBurn} (should be 0 — fix skips burned)`);
      expect(totalAfterBurn).to.equal(0n, "FIX: burned NFT skipped, no phantom value");

      // Cleanup still removes the stale tracking entry
      await strategy.connect(admin).cleanupBurnedNfts();
      const totalAfter = await strategy.totalAssets();
      console.log(`[DEBUG] F3.2: totalAssets after cleanup=${totalAfter}`);
      expect(totalAfter).to.equal(0n, "No phantom value after cleanup");
      expect(await strategy.heldNftCount()).to.equal(0n, "Tracking entry removed");
    });

    it("3.3 — after cleanup, totalAssets matches idle USDT + surviving NFT values", async function () {
      console.log("[DEBUG] F3.3: post-cleanup totalAssets accuracy");
      const invested = ethers.parseUnits("1000", 18);
      const owed = ethers.parseUnits("100", 18);

      const id1 = await mintAndTrackNft(invested, owed, 0n, 4000n); // survivor
      const id2 = await mintAndTrackNft(invested, 0n, 0n, 4000n); // survivor
      const id3 = await mintAndTrackNft(invested, owed, 0n, 4000n); // will be burned

      // Add some idle USDT
      const idleUsdt = ethers.parseUnits("500", 18);
      await usdt.mint(await strategy.getAddress(), idleUsdt);

      // Burn id3
      await mockNFT.burn(id3);
      await strategy.connect(admin).cleanupBurnedNfts();

      // Manual calculation
      const val1 = await strategy.nftValue(id1);
      const val2 = await strategy.nftValue(id2);
      const expectedTotal = idleUsdt + val1 + val2;

      const actualTotal = await strategy.totalAssets();
      console.log(`[DEBUG] F3.3: idle=${idleUsdt}, val1=${val1}, val2=${val2}, total=${actualTotal}`);
      expect(actualTotal).to.equal(expectedTotal, "totalAssets = idle + sum(surviving NFT values)");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FINDING 4: Gas at MAX_NFTS=50
  // ═══════════════════════════════════════════════════════════════════

  describe("FINDING 4: Gas at MAX_NFTS=50", function () {
    // These tests are slow due to 50 mints — increase timeout
    this.timeout(120_000);

    it("4.1 — 50 NFTs all burned → gas < 30M", async function () {
      console.log("[DEBUG] F4.1: 50 NFTs all burned — gas measurement");
      const ids = await mintMultipleNfts(50);
      for (const id of ids) {
        await mockNFT.burn(id);
      }
      const tx = await strategy.connect(admin).cleanupBurnedNfts();
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed;
      console.log(`[DEBUG] F4.1: gas used for 50 all-burned = ${gasUsed}`);
      expect(gasUsed).to.be.lt(30_000_000n, "Gas should be under 30M block limit");
    });

    it("4.2 — 50 NFTs none burned → gas (best case)", async function () {
      console.log("[DEBUG] F4.2: 50 NFTs none burned — gas measurement");
      await mintMultipleNfts(50);
      const tx = await strategy.connect(admin).cleanupBurnedNfts();
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed;
      console.log(`[DEBUG] F4.2: gas used for 50 none-burned = ${gasUsed}`);
      expect(gasUsed).to.be.lt(30_000_000n, "Gas should be under 30M block limit");
    });

    it("4.3 — 50 NFTs, 25 burned → gas (typical case)", async function () {
      console.log("[DEBUG] F4.3: 50 NFTs 25 burned — gas measurement");
      const ids = await mintMultipleNfts(50);
      // Burn every other NFT
      for (let i = 0; i < ids.length; i += 2) {
        await mockNFT.burn(ids[i]);
      }
      const tx = await strategy.connect(admin).cleanupBurnedNfts();
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed;
      console.log(`[DEBUG] F4.3: gas used for 50 half-burned = ${gasUsed}`);
      expect(gasUsed).to.be.lt(30_000_000n, "Gas should be under 30M block limit");

      // Verify correct count remains
      const remaining = await strategy.heldNftCount();
      console.log(`[DEBUG] F4.3: remaining NFTs = ${remaining}`);
      expect(remaining).to.equal(25);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FINDING 5: Event Accuracy
  // ═══════════════════════════════════════════════════════════════════

  describe("FINDING 5: Event Accuracy", function () {
    it("5.1 — 5 NFTs, 3 burned → BurnedNftsCleaned(3)", async function () {
      console.log("[DEBUG] F5.1: event count accuracy");
      const ids = await mintMultipleNfts(5);
      await mockNFT.burn(ids[0]);
      await mockNFT.burn(ids[2]);
      await mockNFT.burn(ids[4]);

      await expect(strategy.connect(admin).cleanupBurnedNfts())
        .to.emit(strategy, "BurnedNftsCleaned")
        .withArgs(3);
    });

    it("5.2 — individual NftRemoved events for each removed NFT", async function () {
      console.log("[DEBUG] F5.2: individual NftRemoved events");
      const ids = await mintMultipleNfts(5);
      await mockNFT.burn(ids[1]);
      await mockNFT.burn(ids[3]);

      const tx = await strategy.connect(admin).cleanupBurnedNfts();
      const receipt = await tx.wait();

      // Parse NftRemoved events
      const nftRemovedEvents = receipt!.logs
        .map((log: any) => {
          try {
            return strategy.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .filter((parsed: any) => parsed && parsed.name === "NftRemoved");

      console.log(`[DEBUG] F5.2: NftRemoved events count=${nftRemovedEvents.length}`);
      expect(nftRemovedEvents.length).to.equal(2, "Should emit 2 NftRemoved events");

      // Verify the removed IDs match (order may vary due to swap-and-pop)
      const removedIds = new Set(nftRemovedEvents.map((e: any) => e.args[0].toString()));
      expect(removedIds.has(ids[1].toString())).to.be.true;
      expect(removedIds.has(ids[3].toString())).to.be.true;
    });

    it("5.3 — no burns → BurnedNftsCleaned(0)", async function () {
      console.log("[DEBUG] F5.3: no burns event");
      await mintMultipleNfts(3);

      await expect(strategy.connect(admin).cleanupBurnedNfts())
        .to.emit(strategy, "BurnedNftsCleaned")
        .withArgs(0);
    });

    it("5.4 — empty array → BurnedNftsCleaned(0)", async function () {
      console.log("[DEBUG] F5.4: empty array event");
      // No NFTs minted at all
      await expect(strategy.connect(admin).cleanupBurnedNfts())
        .to.emit(strategy, "BurnedNftsCleaned")
        .withArgs(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FINDING 6: Transferred Away (Not Burned) NFT Handling
  // ═══════════════════════════════════════════════════════════════════

  describe("FINDING 6: Transferred Away (Not Burned)", function () {
    it("6.1 — transferred NFT detected as owner != address(this) and removed", async function () {
      console.log("[DEBUG] F6.1: transferred NFT removal");
      const ids = await mintMultipleNfts(3);
      const strategyAddr = await strategy.getAddress();
      const user1Addr = await user1.getAddress();

      // Impersonate strategy to transfer an NFT out
      await ethers.provider.send("hardhat_impersonateAccount", [strategyAddr]);
      await ethers.provider.send("hardhat_setBalance", [strategyAddr, "0xDE0B6B3A7640000"]);
      const strategySigner = await ethers.getSigner(strategyAddr);

      // Transfer ids[1] to user1 (not a burn — owner changes)
      await mockNFT.connect(strategySigner).transferFrom(strategyAddr, user1Addr, ids[1]);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [strategyAddr]);

      console.log(`[DEBUG] F6.1: transferred NFT ${ids[1]} to ${user1Addr}`);

      // Verify ownership changed
      const newOwner = await mockNFT.ownerOf(ids[1]);
      expect(newOwner).to.equal(user1Addr);

      // Cleanup should detect owner != strategy and remove it
      await expect(strategy.connect(admin).cleanupBurnedNfts())
        .to.emit(strategy, "BurnedNftsCleaned")
        .withArgs(1);

      await expectHeldNfts([ids[0], ids[2]]);
    });

    it("6.2 — mix of 1 burned + 1 transferred → both removed, BurnedNftsCleaned(2)", async function () {
      console.log("[DEBUG] F6.2: mixed burn + transfer");
      const ids = await mintMultipleNfts(4);
      const strategyAddr = await strategy.getAddress();
      const user1Addr = await user1.getAddress();

      // Burn ids[0]
      await mockNFT.burn(ids[0]);

      // Transfer ids[2] to user1
      await ethers.provider.send("hardhat_impersonateAccount", [strategyAddr]);
      await ethers.provider.send("hardhat_setBalance", [strategyAddr, "0xDE0B6B3A7640000"]);
      const strategySigner = await ethers.getSigner(strategyAddr);
      await mockNFT.connect(strategySigner).transferFrom(strategyAddr, user1Addr, ids[2]);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [strategyAddr]);

      console.log(`[DEBUG] F6.2: burned=${ids[0]}, transferred=${ids[2]}`);

      // Both should be removed
      const tx = await strategy.connect(admin).cleanupBurnedNfts();
      const receipt = await tx.wait();

      // Verify BurnedNftsCleaned(2)
      const cleanedEvent = receipt!.logs
        .map((log: any) => {
          try {
            return strategy.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed: any) => parsed && parsed.name === "BurnedNftsCleaned");

      expect(cleanedEvent!.args[0]).to.equal(2n, "Should report 2 removed");

      // Survivors: ids[1] and ids[3]
      await expectHeldNfts([ids[1], ids[3]]);
    });
  });
});
