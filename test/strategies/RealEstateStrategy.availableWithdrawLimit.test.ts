import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

/**
 * Tests for RealEstateStrategy.availableWithdrawLimit() — previously untested IStrategy function.
 * Also covers heldNftCount() and getHeldNftIds() view functions with edge cases.
 */
describe("RealEstateStrategy — availableWithdrawLimit & View Functions", function () {
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
    console.log("[DEBUG] RE availableWithdrawLimit deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    adminAddr = await admin.getAddress();

    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdt = await MockERC20.deploy();
    await usdt.waitForDeployment();

    const MockVaultF = await ethers.getContractFactory("MockVaultForStrategy");
    mockVault = await MockVaultF.deploy();
    await mockVault.waitForDeployment();
    vaultAddr = await mockVault.getAddress();

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
    console.log("[DEBUG] RE availableWithdrawLimit deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // ═══════════════════════════════════════════════════════════
  // availableWithdrawLimit()
  // ═══════════════════════════════════════════════════════════

  describe("availableWithdrawLimit", function () {
    it("should return 0 when strategy has no idle assets", async function () {
      console.log("[DEBUG] test: availableWithdrawLimit empty");
      const limit = await strategy.availableWithdrawLimit();
      console.log("[DEBUG] limit:", limit);
      expect(limit).to.equal(0);
    });

    it("should return exact idle balance when funds are present", async function () {
      console.log("[DEBUG] test: availableWithdrawLimit with idle");
      const amount = ethers.parseUnits("5000", 18);
      await usdt.mint(await strategy.getAddress(), amount);
      const limit = await strategy.availableWithdrawLimit();
      console.log("[DEBUG] limit:", limit);
      expect(limit).to.equal(amount);
    });

    it("should return only idle even when NFTs are held (illiquid)", async function () {
      console.log("[DEBUG] test: availableWithdrawLimit with NFTs");
      const idle = ethers.parseUnits("1000", 18);
      await usdt.mint(await strategy.getAddress(), idle);

      // Add an NFT worth 10000
      const tokenId = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
      await mockNFT.mintUnsafe(await strategy.getAddress());
      await strategy.connect(admin).addNftForTesting(tokenId);
      await mockNFT.setPosition(tokenId, {
        amountInvested: ethers.parseUnits("10000", 18),
        amountOwed: 0,
        totalClaimed: 0,
        yieldCapBps: 4000,
        propertyId: 1,
        trancheType: 0,
        isSplit: false,
        splitDepth: 0,
      });

      const totalAssets = await strategy.totalAssets();
      const limit = await strategy.availableWithdrawLimit();
      console.log("[DEBUG] totalAssets:", totalAssets, "limit:", limit);

      // totalAssets includes NFT value, but availableWithdrawLimit only counts idle
      expect(totalAssets).to.be.gt(limit);
      expect(limit).to.equal(idle);
    });

    it("should increase after harvesting yield from NFTs", async function () {
      console.log("[DEBUG] test: availableWithdrawLimit after harvest");
      // Start with no idle
      const limitBefore = await strategy.availableWithdrawLimit();
      expect(limitBefore).to.equal(0);

      // Add NFT and set up yield
      const tokenId = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
      await mockNFT.mintUnsafe(await strategy.getAddress());
      await strategy.connect(admin).addNftForTesting(tokenId);
      await mockNFT.setPosition(tokenId, {
        amountInvested: ethers.parseUnits("10000", 18),
        amountOwed: ethers.parseUnits("500", 18),
        totalClaimed: 0,
        yieldCapBps: 4000,
        propertyId: 1,
        trancheType: 0,
        isSplit: false,
        splitDepth: 0,
      });

      const claimable = ethers.parseUnits("500", 18);
      await usdt.mint(await mockMaster.getAddress(), claimable);
      await mockMaster.setClaimableAmount(tokenId, claimable);

      // Harvest
      await strategy.connect(admin).harvest();

      const limitAfter = await strategy.availableWithdrawLimit();
      console.log("[DEBUG] limit after harvest:", limitAfter);
      expect(limitAfter).to.equal(claimable);
    });

    it("should decrease after vault withdraws", async function () {
      console.log("[DEBUG] test: availableWithdrawLimit decreases after withdraw");
      const initial = ethers.parseUnits("10000", 18);
      await usdt.mint(await strategy.getAddress(), initial);

      // Vault withdraws half
      const withdrawAmt = ethers.parseUnits("5000", 18);
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddr]);
      const vaultSigner = await ethers.getSigner(vaultAddr);
      await ethers.provider.send("hardhat_setBalance", [vaultAddr, "0xDE0B6B3A7640000"]);
      await strategy.connect(vaultSigner).withdraw(withdrawAmt);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddr]);

      const limit = await strategy.availableWithdrawLimit();
      console.log("[DEBUG] limit after withdraw:", limit);
      expect(limit).to.equal(initial - withdrawAmt);
    });

    it("should match idle balance precisely across multiple operations", async function () {
      console.log("[DEBUG] test: availableWithdrawLimit multi-op");
      // Mint some idle
      await usdt.mint(await strategy.getAddress(), ethers.parseUnits("8000", 18));

      // Vault withdraws 3000
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddr]);
      const vaultSigner = await ethers.getSigner(vaultAddr);
      await ethers.provider.send("hardhat_setBalance", [vaultAddr, "0xDE0B6B3A7640000"]);
      await strategy.connect(vaultSigner).withdraw(ethers.parseUnits("3000", 18));
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddr]);

      // More idle arrives from emergency withdraw token (simulate)
      await usdt.mint(await strategy.getAddress(), ethers.parseUnits("2000", 18));

      const idle = await usdt.balanceOf(await strategy.getAddress());
      const limit = await strategy.availableWithdrawLimit();
      console.log("[DEBUG] idle:", idle, "limit:", limit);
      expect(limit).to.equal(idle);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // heldNftCount() & getHeldNftIds() — edge cases
  // ═══════════════════════════════════════════════════════════

  describe("heldNftCount & getHeldNftIds edge cases", function () {
    it("should return 0 and empty array initially", async function () {
      console.log("[DEBUG] test: initial state");
      expect(await strategy.heldNftCount()).to.equal(0);
      const ids = await strategy.getHeldNftIds();
      console.log("[DEBUG] ids:", ids);
      expect(ids.length).to.equal(0);
    });

    it("should track single NFT correctly", async function () {
      console.log("[DEBUG] test: single NFT");
      const tokenId = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
      await mockNFT.mintUnsafe(await strategy.getAddress());
      await strategy.connect(admin).addNftForTesting(tokenId);

      expect(await strategy.heldNftCount()).to.equal(1);
      const ids = await strategy.getHeldNftIds();
      console.log("[DEBUG] ids:", ids);
      expect(ids.length).to.equal(1);
      expect(ids[0]).to.equal(tokenId);
    });

    it("should track MAX_NFTS (50) correctly", async function () {
      console.log("[DEBUG] test: 50 NFTs");
      for (let i = 0; i < 50; i++) {
        const tokenId = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
        await mockNFT.mintUnsafe(await strategy.getAddress());
        await strategy.connect(admin).addNftForTesting(tokenId);
      }

      expect(await strategy.heldNftCount()).to.equal(50);
      const ids = await strategy.getHeldNftIds();
      console.log("[DEBUG] ids length:", ids.length);
      expect(ids.length).to.equal(50);
    });

    it("should return correct ids after swap-and-pop removal", async function () {
      console.log("[DEBUG] test: swap-and-pop");
      const tokenIds: bigint[] = [];
      for (let i = 0; i < 5; i++) {
        const tokenId = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
        await mockNFT.mintUnsafe(await strategy.getAddress());
        await strategy.connect(admin).addNftForTesting(tokenId);
        tokenIds.push(tokenId);
      }

      // Burn the middle one, then cleanup
      await mockNFT.burn(tokenIds[2]);
      await strategy.connect(admin).cleanupBurnedNfts();

      expect(await strategy.heldNftCount()).to.equal(4);
      const ids = await strategy.getHeldNftIds();
      console.log("[DEBUG] ids after removal:", ids);
      // tokenIds[2] should not be in the list
      for (const id of ids) {
        expect(id).to.not.equal(tokenIds[2]);
      }
    });

    it("should handle removing all NFTs via cleanup", async function () {
      console.log("[DEBUG] test: remove all via cleanup");
      const tokenIds: bigint[] = [];
      for (let i = 0; i < 5; i++) {
        const tokenId = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
        await mockNFT.mintUnsafe(await strategy.getAddress());
        await strategy.connect(admin).addNftForTesting(tokenId);
        tokenIds.push(tokenId);
      }

      // Burn all
      for (const id of tokenIds) {
        await mockNFT.burn(id);
      }
      await strategy.connect(admin).cleanupBurnedNfts();

      expect(await strategy.heldNftCount()).to.equal(0);
      expect((await strategy.getHeldNftIds()).length).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Fuzz: availableWithdrawLimit invariants
  // ═══════════════════════════════════════════════════════════

  describe("fuzz: availableWithdrawLimit invariants", function () {
    function randomBigInt(min: bigint, max: bigint): bigint {
      if (max <= min) return min;
      const range = max - min;
      const bits = range.toString(2).length;
      const bytes = Math.ceil(bits / 8);
      const randomBytes = ethers.randomBytes(bytes);
      let rand = BigInt("0x" + Buffer.from(randomBytes).toString("hex"));
      return min + (rand % (range + 1n));
    }

    const FUZZ_RUNS = 50;

    it(`availableWithdrawLimit == idle balance for ${FUZZ_RUNS} random states`, async function () {
      for (let i = 0; i < FUZZ_RUNS; i++) {
        await deployFixture();

        const idle = randomBigInt(0n, ethers.parseUnits("100000", 18));
        if (idle > 0n) {
          await usdt.mint(await strategy.getAddress(), idle);
        }

        // Also add some NFTs (should NOT affect availableWithdrawLimit)
        const numNfts = Number(randomBigInt(0n, 3n));
        for (let j = 0; j < numNfts; j++) {
          const tokenId = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
          await mockNFT.mintUnsafe(await strategy.getAddress());
          await strategy.connect(admin).addNftForTesting(tokenId);
          await mockNFT.setPosition(tokenId, {
            amountInvested: ethers.parseUnits("5000", 18),
            amountOwed: ethers.parseUnits("100", 18),
            totalClaimed: 0,
            yieldCapBps: 4000,
            propertyId: 1,
            trancheType: 0,
            isSplit: false,
            splitDepth: 0,
          });
        }

        const limit = await strategy.availableWithdrawLimit();
        const actualIdle = await usdt.balanceOf(await strategy.getAddress());

        if (i % 10 === 0) {
          console.log(`[DEBUG] fuzz availableWithdrawLimit run ${i}: idle=${ethers.formatUnits(actualIdle, 18)}, limit=${ethers.formatUnits(limit, 18)}, nfts=${numNfts}`);
        }

        expect(limit).to.equal(actualIdle, `Run ${i}: availableWithdrawLimit != idle balance`);
      }
    });

    it(`availableWithdrawLimit <= totalAssets always for ${FUZZ_RUNS} random states`, async function () {
      for (let i = 0; i < FUZZ_RUNS; i++) {
        await deployFixture();

        const idle = randomBigInt(0n, ethers.parseUnits("50000", 18));
        if (idle > 0n) {
          await usdt.mint(await strategy.getAddress(), idle);
        }

        const numNfts = Number(randomBigInt(0n, 5n));
        for (let j = 0; j < numNfts; j++) {
          const invested = randomBigInt(ethers.parseUnits("100", 18), ethers.parseUnits("10000", 18));
          const tokenId = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
          await mockNFT.mintUnsafe(await strategy.getAddress());
          await strategy.connect(admin).addNftForTesting(tokenId);
          await mockNFT.setPosition(tokenId, {
            amountInvested: invested,
            amountOwed: 0,
            totalClaimed: 0,
            yieldCapBps: 4000,
            propertyId: 1,
            trancheType: 0,
            isSplit: false,
            splitDepth: 0,
          });
        }

        const limit = await strategy.availableWithdrawLimit();
        const total = await strategy.totalAssets();

        if (i % 10 === 0) {
          console.log(`[DEBUG] fuzz limit<=total run ${i}: limit=${ethers.formatUnits(limit, 18)}, total=${ethers.formatUnits(total, 18)}`);
        }

        expect(limit).to.be.lte(total, `Run ${i}: availableWithdrawLimit > totalAssets`);
      }
    });
  });
});
