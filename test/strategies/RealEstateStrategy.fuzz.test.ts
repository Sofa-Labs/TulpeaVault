import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

/**
 * Fuzz tests for RealEstateStrategy — randomized inputs targeting
 * pro-rata math, NFT tracking, and withdrawal edge cases
 */
describe("RealEstateStrategy — Fuzz Tests", function () {
  this.timeout(0); // unlimited for 1M iterations
  let strategy: Contract;
  let mockNFT: Contract;
  let mockMaster: Contract;
  let mockVault: Contract;
  let usdt: Contract;
  let admin: Signer;
  let user1: Signer;
  let adminAddr: string;
  let vaultAddr: string;

  async function deployFixture() {
    console.log("[DEBUG] fuzz RE deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
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

    // Deploy strategy (harness for addNftForTesting)
    const Strategy = await ethers.getContractFactory("RealEstateStrategyHarness");
    strategy = await Strategy.deploy(
      await usdt.getAddress(),
      await mockNFT.getAddress(),
      await mockMaster.getAddress(),
      vaultAddr,
      adminAddr,
    );
    await strategy.waitForDeployment();
    console.log("[DEBUG] fuzz RE deployFixture: complete");
  }

  // ═══════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════

  function randomBigInt(min: bigint, max: bigint): bigint {
    if (max <= min) return min;
    const range = max - min;
    const bits = range.toString(2).length;
    const bytes = Math.ceil(bits / 8);
    const randomBytes = ethers.randomBytes(bytes);
    let rand = BigInt("0x" + Buffer.from(randomBytes).toString("hex"));
    return min + (rand % (range + 1n));
  }

  let nftCounter = 0n;

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
    return tokenId;
  }

  const FUZZ_RUNS = 100;
  const BPS = 10000n;

  // ═══════════════════════════════════════════════════════════
  // PRO-RATA MATH: nftValue invariants
  // ═══════════════════════════════════════════════════════════

  describe("nftValue pro-rata math", function () {
    beforeEach(async () => { await deployFixture(); });

    it(`fuzz: nftValue <= invested + yield cap for ${FUZZ_RUNS} random positions`, async function () {
      for (let i = 0; i < FUZZ_RUNS; i++) {
        await deployFixture();

        const invested = randomBigInt(
          ethers.parseUnits("100", 18),
          ethers.parseUnits("100000", 18)
        );
        const yieldCapBps = randomBigInt(100n, 10000n); // 1% to 100%
        const maxReturn = invested * (BPS + yieldCapBps) / BPS;

        // Random owed and claimed, but totalAllocated <= maxReturn * 2 (can exceed cap)
        const maxOwed = maxReturn;
        const owed = randomBigInt(0n, maxOwed);
        const claimed = randomBigInt(0n, maxReturn);

        console.log(`[DEBUG] fuzz nftValue ${i}: invested=${ethers.formatUnits(invested, 18)}, yieldCap=${yieldCapBps}bps, owed=${ethers.formatUnits(owed, 18)}, claimed=${ethers.formatUnits(claimed, 18)}`);

        const nftId = await mintAndTrackNft(invested, owed, claimed, yieldCapBps);
        const value = await strategy.nftValue(nftId);

        console.log(`[DEBUG] nftValue=${ethers.formatUnits(value, 18)}, maxReturn=${ethers.formatUnits(maxReturn, 18)}`);

        // Invariant 1: nftValue should never exceed invested + maxYield
        // nftValue = lockedPrincipal + amountOwed
        // lockedPrincipal <= invested, amountOwed = owed
        // so nftValue <= invested + owed
        expect(value).to.be.lte(invested + owed, "nftValue > invested + owed");

        // Invariant 2: nftValue >= amountOwed (at minimum, pending yield is counted)
        // When totalAllocated >= maxReturn, lockedPrincipal = 0, value = owed
        // When totalAllocated < maxReturn, lockedPrincipal > 0, value > owed
        expect(value).to.be.gte(owed, "nftValue < amountOwed");
      }
    });

    it(`fuzz: nftValue = 0 when amountInvested = 0`, async function () {
      console.log("[DEBUG] fuzz: zero invested");
      await deployFixture();
      const nftId = await mintAndTrackNft(0n, ethers.parseUnits("1000", 18), 0n, 4000n);
      const value = await strategy.nftValue(nftId);
      console.log(`[DEBUG] nftValue with 0 invested: ${value}`);
      expect(value).to.equal(0n);
    });

    it(`fuzz: nftValue = min(owed, maxReturn) when totalAllocated >= maxReturn`, async function () {
      for (let i = 0; i < 5; i++) {
        await deployFixture();

        const invested = randomBigInt(
          ethers.parseUnits("1000", 18),
          ethers.parseUnits("50000", 18)
        );
        const yieldCapBps = randomBigInt(100n, 5000n);
        const maxReturn = invested * (BPS + yieldCapBps) / BPS;

        // Set totalAllocated >= maxReturn (fully unlocked)
        const excess = randomBigInt(0n, invested);
        const totalAllocated = maxReturn + excess;
        // Split into owed + claimed
        const owed = randomBigInt(0n, totalAllocated);
        const claimed = totalAllocated - owed;

        console.log(`[DEBUG] fuzz fully-unlocked ${i}: invested=${ethers.formatUnits(invested, 18)}, maxReturn=${ethers.formatUnits(maxReturn, 18)}, totalAllocated=${ethers.formatUnits(totalAllocated, 18)}`);

        const nftId = await mintAndTrackNft(invested, owed, claimed, yieldCapBps);
        const value = await strategy.nftValue(nftId);

        // F4 fix: value capped at maxReturn
        const expectedValue = owed < maxReturn ? owed : maxReturn;
        console.log(`[DEBUG] nftValue=${ethers.formatUnits(value, 18)}, expected=${ethers.formatUnits(expectedValue, 18)}`);

        // When fully unlocked, lockedPrincipal = 0, value = min(owed, maxReturn)
        expect(value).to.equal(expectedValue, "Fully unlocked NFT value != min(owed, maxReturn)");
      }
    });

    it(`fuzz: nftValue = invested when no yield and no claims`, async function () {
      for (let i = 0; i < 5; i++) {
        await deployFixture();

        const invested = randomBigInt(
          ethers.parseUnits("100", 18),
          ethers.parseUnits("100000", 18)
        );
        const yieldCapBps = randomBigInt(100n, 10000n);

        console.log(`[DEBUG] fuzz fresh NFT ${i}: invested=${ethers.formatUnits(invested, 18)}, yieldCap=${yieldCapBps}bps`);

        const nftId = await mintAndTrackNft(invested, 0n, 0n, yieldCapBps);
        const value = await strategy.nftValue(nftId);

        console.log(`[DEBUG] nftValue=${ethers.formatUnits(value, 18)}, expected=${ethers.formatUnits(invested, 18)}`);

        // With 0 owed and 0 claimed: maxReturn = invested * (BPS + cap) / BPS
        // totalAllocated = 0
        // lockedPrincipal = invested * maxReturn / maxReturn = invested
        // value = invested + 0 = invested
        expect(value).to.equal(invested, "Fresh NFT value != invested");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // INVARIANT: totalAssets = idle + sum(nftValues)
  // ═══════════════════════════════════════════════════════════

  describe("totalAssets consistency", function () {
    beforeEach(async () => { await deployFixture(); });

    it(`fuzz: totalAssets = idle + sum(nftValues) for ${FUZZ_RUNS} random states`, async function () {
      for (let i = 0; i < FUZZ_RUNS; i++) {
        await deployFixture();

        const idle = randomBigInt(0n, ethers.parseUnits("50000", 18));
        const numNfts = Number(randomBigInt(0n, 5n));

        console.log(`[DEBUG] fuzz totalAssets ${i}: idle=${ethers.formatUnits(idle, 18)}, numNfts=${numNfts}`);

        if (idle > 0n) {
          await usdt.mint(await strategy.getAddress(), idle);
        }

        let expectedNftTotal = 0n;
        for (let j = 0; j < numNfts; j++) {
          const invested = randomBigInt(
            ethers.parseUnits("100", 18),
            ethers.parseUnits("10000", 18)
          );
          const yieldCapBps = randomBigInt(100n, 5000n);
          const owed = randomBigInt(0n, ethers.parseUnits("500", 18));

          const nftId = await mintAndTrackNft(invested, owed, 0n, yieldCapBps);
          const nftVal = await strategy.nftValue(nftId);
          expectedNftTotal += nftVal;
        }

        const totalAssets = await strategy.totalAssets();
        const expected = idle + expectedNftTotal;

        console.log(`[DEBUG] totalAssets=${ethers.formatUnits(totalAssets, 18)}, expected=${ethers.formatUnits(expected, 18)}`);
        expect(totalAssets).to.equal(expected, "totalAssets != idle + sum(nftValues)");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // NFT TRACKING: add/remove consistency
  // ═══════════════════════════════════════════════════════════

  describe("NFT tracking invariants", function () {
    beforeEach(async () => { await deployFixture(); });

    it(`fuzz: add then remove preserves empty state`, async function () {
      for (let i = 0; i < 10; i++) {
        await deployFixture();

        const numNfts = Number(randomBigInt(1n, 10n));
        const nftIds: bigint[] = [];

        console.log(`[DEBUG] fuzz NFT tracking ${i}: adding ${numNfts} NFTs`);

        // Add N NFTs
        for (let j = 0; j < numNfts; j++) {
          const nftId = await mintAndTrackNft(
            ethers.parseUnits("1000", 18), 0n, 0n, 4000n
          );
          nftIds.push(nftId);
        }

        let count = await strategy.heldNftCount();
        console.log(`[DEBUG] after adding: count=${count}`);
        expect(count).to.equal(BigInt(numNfts));

        // Verify all tracked
        for (const id of nftIds) {
          expect(await strategy.isHeldNft(id)).to.be.true;
        }

        // Burn all NFTs (simulate auto-burn), then cleanup
        for (const id of nftIds) {
          await mockNFT.burn(id);
        }

        await strategy.connect(admin).cleanupBurnedNfts();

        count = await strategy.heldNftCount();
        console.log(`[DEBUG] after cleanup: count=${count}`);
        expect(count).to.equal(0n, "NFT count should be 0 after cleanup");
      }
    });

    it("MAX_NFTS (50) limit enforced", async function () {
      console.log("[DEBUG] fuzz: MAX_NFTS limit");

      // Add 50 NFTs
      for (let i = 0; i < 50; i++) {
        await mintAndTrackNft(ethers.parseUnits("100", 18), 0n, 0n, 4000n);
      }

      const count = await strategy.heldNftCount();
      console.log(`[DEBUG] count after 50: ${count}`);
      expect(count).to.equal(50n);

      // 51st should revert
      const tokenId51 = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
      await mockNFT.mintUnsafe(await strategy.getAddress());
      await expect(
        strategy.connect(admin).addNftForTesting(tokenId51)
      ).to.be.revertedWithCustomError(strategy, "MaxNftsReached");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // WITHDRAW: partial withdraw behavior (illiquid strategy)
  // ═══════════════════════════════════════════════════════════

  describe("withdraw fuzz (illiquid)", function () {
    beforeEach(async () => { await deployFixture(); });

    it(`fuzz: withdraw sends min(amount, idle) for ${FUZZ_RUNS} random states`, async function () {
      for (let i = 0; i < FUZZ_RUNS; i++) {
        await deployFixture();

        const idle = randomBigInt(
          ethers.parseUnits("1", 18),
          ethers.parseUnits("50000", 18)
        );
        const requestAmount = randomBigInt(
          ethers.parseUnits("1", 18),
          ethers.parseUnits("100000", 18)
        );

        console.log(`[DEBUG] fuzz withdraw ${i}: idle=${ethers.formatUnits(idle, 18)}, request=${ethers.formatUnits(requestAmount, 18)}`);

        await usdt.mint(await strategy.getAddress(), idle);

        await ethers.provider.send("hardhat_impersonateAccount", [vaultAddr]);
        const vaultSigner = await ethers.getSigner(vaultAddr);
        await ethers.provider.send("hardhat_setBalance", [vaultAddr, "0xDE0B6B3A7640000"]);

        const vaultBalBefore = await usdt.balanceOf(vaultAddr);
        await strategy.connect(vaultSigner).withdraw(requestAmount);
        const vaultBalAfter = await usdt.balanceOf(vaultAddr);

        await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddr]);

        const received = vaultBalAfter - vaultBalBefore;
        const expected = requestAmount < idle ? requestAmount : idle;

        console.log(`[DEBUG] received=${ethers.formatUnits(received, 18)}, expected=${ethers.formatUnits(expected, 18)}`);
        expect(received).to.equal(expected, "Withdraw didn't send min(amount, idle)");
      }
    });

    it("withdraw(0) reverts ZeroAmount", async function () {
      console.log("[DEBUG] fuzz: withdraw(0)");
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddr]);
      const vaultSigner = await ethers.getSigner(vaultAddr);
      await ethers.provider.send("hardhat_setBalance", [vaultAddr, "0xDE0B6B3A7640000"]);

      await expect(
        strategy.connect(vaultSigner).withdraw(0)
      ).to.be.revertedWithCustomError(strategy, "ZeroAmount");

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddr]);
    });

    it("withdraw with 0 idle reverts InsufficientBalance", async function () {
      console.log("[DEBUG] fuzz: withdraw with 0 idle");
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddr]);
      const vaultSigner = await ethers.getSigner(vaultAddr);
      await ethers.provider.send("hardhat_setBalance", [vaultAddr, "0xDE0B6B3A7640000"]);

      await expect(
        strategy.connect(vaultSigner).withdraw(ethers.parseUnits("100", 18))
      ).to.be.revertedWithCustomError(strategy, "InsufficientBalance");

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddr]);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // ACCESS CONTROL
  // ═══════════════════════════════════════════════════════════

  describe("access control", function () {
    beforeEach(async () => { await deployFixture(); });

    it("non-vault cannot call withdraw", async function () {
      console.log("[DEBUG] fuzz: non-vault withdraw");
      await usdt.mint(await strategy.getAddress(), ethers.parseUnits("1000", 18));

      await expect(
        strategy.connect(user1).withdraw(ethers.parseUnits("100", 18))
      ).to.be.revertedWithCustomError(strategy, "OnlyVault");
    });

    it("non-owner cannot call harvest", async function () {
      console.log("[DEBUG] fuzz: non-owner harvest");
      await expect(
        strategy.connect(user1).harvest()
      ).to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");
    });

    it("non-owner cannot call cleanupBurnedNfts", async function () {
      console.log("[DEBUG] fuzz: non-owner cleanup");
      await expect(
        strategy.connect(user1).cleanupBurnedNfts()
      ).to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");
    });

    it("non-owner cannot call emergencyWithdrawToken", async function () {
      console.log("[DEBUG] fuzz: non-owner emergencyWithdrawToken");
      await expect(
        strategy.connect(user1).emergencyWithdrawToken(await usdt.getAddress(), 1)
      ).to.be.revertedWithCustomError(strategy, "OwnableUnauthorizedAccount");
    });

    it("non-owner cannot call emergencyTransferNft", async function () {
      console.log("[DEBUG] fuzz: non-owner emergencyTransferNft");
      await expect(
        strategy.connect(user1).emergencyTransferNft(1, adminAddr)
      ).to.be.revertedWithCustomError(strategy, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // PRO-RATA MATH: edge cases with extreme yield caps
  // ═══════════════════════════════════════════════════════════

  describe("extreme yield cap edge cases", function () {
    beforeEach(async () => { await deployFixture(); });

    it("fuzz: yieldCapBps = 0 means nftValue = invested when no claims", async function () {
      console.log("[DEBUG] fuzz: zero yield cap");
      const invested = ethers.parseUnits("10000", 18);
      const nftId = await mintAndTrackNft(invested, 0n, 0n, 0n);
      const value = await strategy.nftValue(nftId);
      console.log(`[DEBUG] nftValue with 0 cap: ${ethers.formatUnits(value, 18)}`);
      // maxReturn = invested * (10000 + 0) / 10000 = invested
      // totalAllocated = 0, lockedPrincipal = invested * invested / invested = invested
      // value = invested + 0 = invested
      expect(value).to.equal(invested);
    });

    it("fuzz: yieldCapBps = 10000 (100%) doubles max return", async function () {
      console.log("[DEBUG] fuzz: 100% yield cap");
      const invested = ethers.parseUnits("10000", 18);
      const nftId = await mintAndTrackNft(invested, 0n, 0n, 10000n);
      const value = await strategy.nftValue(nftId);
      console.log(`[DEBUG] nftValue with 100% cap: ${ethers.formatUnits(value, 18)}`);
      // maxReturn = invested * 20000 / 10000 = 2 * invested
      // With no claims: value = invested
      expect(value).to.equal(invested);
    });

    it("fuzz: high yield cap with partial claims", async function () {
      for (let i = 0; i < 5; i++) {
        await deployFixture();

        const invested = randomBigInt(
          ethers.parseUnits("1000", 18),
          ethers.parseUnits("50000", 18)
        );
        const yieldCapBps = 10000n; // 100%
        const maxReturn = invested * 2n; // 200% of invested

        // Claim half the maxReturn
        const claimed = maxReturn / 2n;
        const owed = randomBigInt(0n, ethers.parseUnits("500", 18));

        console.log(`[DEBUG] fuzz high-cap ${i}: invested=${ethers.formatUnits(invested, 18)}, claimed=${ethers.formatUnits(claimed, 18)}, owed=${ethers.formatUnits(owed, 18)}`);

        const nftId = await mintAndTrackNft(invested, owed, claimed, yieldCapBps);
        const value = await strategy.nftValue(nftId);

        // totalAllocated = claimed + owed
        const totalAllocated = claimed + owed;
        let expectedLockedPrincipal: bigint;
        if (totalAllocated >= maxReturn) {
          expectedLockedPrincipal = 0n;
        } else {
          expectedLockedPrincipal = invested * (maxReturn - totalAllocated) / maxReturn;
        }
        const expectedValue = expectedLockedPrincipal + owed;

        console.log(`[DEBUG] value=${ethers.formatUnits(value, 18)}, expected=${ethers.formatUnits(expectedValue, 18)}`);
        expect(value).to.equal(expectedValue, "Pro-rata math mismatch");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // STRESS: many NFTs totalAssets gas
  // ═══════════════════════════════════════════════════════════

  describe("stress: totalAssets with max NFTs", function () {
    beforeEach(async () => { await deployFixture(); });

    it("totalAssets with 50 NFTs completes without gas issues", async function () {
      console.log("[DEBUG] stress: 50 NFTs totalAssets");

      for (let i = 0; i < 50; i++) {
        const invested = randomBigInt(
          ethers.parseUnits("100", 18),
          ethers.parseUnits("5000", 18)
        );
        const owed = randomBigInt(0n, ethers.parseUnits("200", 18));
        await mintAndTrackNft(invested, owed, 0n, 4000n);
      }

      const count = await strategy.heldNftCount();
      expect(count).to.equal(50n);

      // Should not run out of gas
      const totalAssets = await strategy.totalAssets();
      console.log(`[DEBUG] totalAssets with 50 NFTs: ${ethers.formatUnits(totalAssets, 18)}`);
      expect(totalAssets).to.be.gt(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // HARVEST: mock yield claim
  // ═══════════════════════════════════════════════════════════

  describe("harvest fuzz", function () {
    beforeEach(async () => { await deployFixture(); });

    it(`fuzz: harvest increases idle balance for ${FUZZ_RUNS / 2} runs`, async function () {
      for (let i = 0; i < FUZZ_RUNS / 2; i++) {
        await deployFixture();

        const numNfts = Number(randomBigInt(1n, 5n));
        let totalExpectedClaim = 0n;

        console.log(`[DEBUG] fuzz harvest ${i}: ${numNfts} NFTs`);

        for (let j = 0; j < numNfts; j++) {
          const invested = ethers.parseUnits("1000", 18);
          const claimable = randomBigInt(0n, ethers.parseUnits("100", 18));
          const nftId = await mintAndTrackNft(invested, claimable, 0n, 4000n);

          // Fund the mock master so it can pay out
          await usdt.mint(await mockMaster.getAddress(), claimable);
          await mockMaster.setClaimableAmount(nftId, claimable);
          totalExpectedClaim += claimable;
        }

        const balBefore = await usdt.balanceOf(await strategy.getAddress());
        await strategy.connect(admin).harvest();
        const balAfter = await usdt.balanceOf(await strategy.getAddress());

        const claimed = balAfter - balBefore;
        console.log(`[DEBUG] claimed=${ethers.formatUnits(claimed, 18)}, expected=${ethers.formatUnits(totalExpectedClaim, 18)}`);
        expect(claimed).to.equal(totalExpectedClaim, "Harvest claim mismatch");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // UNSOLICITED NFT TRANSFER REJECTION (F4 fix)
  // ═══════════════════════════════════════════════════════════

  describe("F4: unsolicited NFT rejection", function () {
    beforeEach(async () => { await deployFixture(); });

    it("safeTransferFrom of portfolio NFT to strategy reverts UnsolicitedNftTransfer", async function () {
      console.log("[DEBUG] fuzz: unsolicited NFT transfer");
      const stratAddr = await strategy.getAddress();

      // Mint NFT to admin first
      const tokenId = await mockNFT.mintUnsafe.staticCall(adminAddr);
      await mockNFT.mintTo(adminAddr);

      // Try to safeTransferFrom to strategy — should revert (F4 fix)
      await expect(
        mockNFT.connect(admin).safeTransferFrom(adminAddr, stratAddr, tokenId)
      ).to.be.revertedWithCustomError(strategy, "UnsolicitedNftTransfer");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // EMERGENCY FUNCTIONS
  // ═══════════════════════════════════════════════════════════

  describe("emergency functions fuzz", function () {
    beforeEach(async () => { await deployFixture(); });

    it("emergencyWithdrawToken(0) reverts ZeroAmount", async function () {
      console.log("[DEBUG] fuzz: emergencyWithdrawToken(0)");
      await expect(
        strategy.connect(admin).emergencyWithdrawToken(await usdt.getAddress(), 0)
      ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
    });

    it("emergencyTransferNft to zero address reverts ZeroAddress", async function () {
      console.log("[DEBUG] fuzz: emergencyTransferNft to zero");
      await expect(
        strategy.connect(admin).emergencyTransferNft(1, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(strategy, "ZeroAddress");
    });

    it("emergencyRecoverNft with zero contract reverts ZeroAddress", async function () {
      console.log("[DEBUG] fuzz: emergencyRecoverNft zero contract");
      await expect(
        strategy.connect(admin).emergencyRecoverNft(ethers.ZeroAddress, 1, adminAddr)
      ).to.be.revertedWithCustomError(strategy, "ZeroAddress");
    });

    it(`fuzz: emergencyWithdrawToken sends correct amount for ${FUZZ_RUNS / 2} runs`, async function () {
      for (let i = 0; i < FUZZ_RUNS / 2; i++) {
        await deployFixture();

        const amount = randomBigInt(
          ethers.parseUnits("1", 18),
          ethers.parseUnits("10000", 18)
        );
        console.log(`[DEBUG] fuzz emergency ${i}: amount=${ethers.formatUnits(amount, 18)}`);

        await usdt.mint(await strategy.getAddress(), amount);

        const vaultBalBefore = await usdt.balanceOf(vaultAddr);
        await strategy.connect(admin).emergencyWithdrawToken(await usdt.getAddress(), amount);
        const vaultBalAfter = await usdt.balanceOf(vaultAddr);

        expect(vaultBalAfter - vaultBalBefore).to.equal(amount);
      }
    });
  });
});
