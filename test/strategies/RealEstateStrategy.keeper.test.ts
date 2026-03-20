import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

/**
 * RealEstateStrategy — Vault-Based Keeper Tests
 *
 * The strategy reads the keeper address from ITulpeaYieldVault(vault).keeper().
 * There is no addKeeper/removeKeeper on the strategy itself.
 *
 * Tests:
 *   - When vault.keeper() == someAddress, that address can call keeper-gated functions
 *   - When vault.keeper() is changed, the new keeper works and the old one is rejected
 *   - Non-keeper non-owner is rejected with NotKeeperOrOwner
 *   - Owner can always call keeper-gated functions regardless of vault.keeper()
 *   - Keeper cannot call admin-only (onlyOwner) functions
 */
describe("RealEstateStrategy — Vault-Based Keeper", function () {
  let strategy: Contract;
  let mockNFT: Contract;
  let mockMaster: Contract;
  let mockVault: Contract;
  let usdt: Contract;
  let admin: Signer;
  let user1: Signer;
  let keeper1: Signer;
  let keeper2: Signer;
  let randomUser: Signer;
  let adminAddr: string;
  let keeper1Addr: string;
  let keeper2Addr: string;
  let randomUserAddr: string;
  let vaultAddr: string;

  async function deployFixture() {
    console.log("[DEBUG] vault-keeper deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    keeper1 = signers[3];
    keeper2 = signers[4];
    randomUser = signers[5];
    adminAddr = await admin.getAddress();
    keeper1Addr = await keeper1.getAddress();
    keeper2Addr = await keeper2.getAddress();
    randomUserAddr = await randomUser.getAddress();

    // Deploy USDT
    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdt = await MockERC20.deploy();
    await usdt.waitForDeployment();
    console.log("[DEBUG] USDT deployed at:", await usdt.getAddress());

    // Deploy mock vault (implements keeper() + setKeeper())
    const MockVault = await ethers.getContractFactory("MockVaultForStrategy");
    mockVault = await MockVault.deploy();
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

    // Deploy strategy (no keepers param — keeper comes from vault)
    const Strategy = await ethers.getContractFactory("RealEstateStrategyHarness");
    strategy = await Strategy.deploy(
      await usdt.getAddress(),
      await mockNFT.getAddress(),
      await mockMaster.getAddress(),
      vaultAddr,
      adminAddr,
    );
    await strategy.waitForDeployment();
    console.log("[DEBUG] vault-keeper deployFixture: complete");
  }

  // Helper: mint NFT to strategy and track + set position
  async function mintAndTrackNft(
    invested: bigint,
    owed: bigint = 0n,
    claimed: bigint = 0n,
    yieldCapBps: bigint = 4000n
  ): Promise<bigint> {
    console.log("[DEBUG] mintAndTrackNft: invested=%s owed=%s", invested, owed);
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

  // ═══════════════════════════════════════════════════════════
  // keeper set on vault
  // ═══════════════════════════════════════════════════════════

  describe("keeper set on vault", function () {
    beforeEach(async function () {
      await deployFixture();
      // Set keeper1 as the vault keeper
      await mockVault.setKeeper(keeper1Addr);
      console.log("[DEBUG] vault keeper set to:", keeper1Addr);
    });

    it("vault.keeper() returns the correct address", async function () {
      console.log("[DEBUG] test: vault.keeper() check");
      expect(await mockVault.keeper()).to.equal(keeper1Addr);
    });

    it("keeper can call harvest()", async function () {
      console.log("[DEBUG] test: keeper harvest");
      await expect(strategy.connect(keeper1).harvest())
        .to.emit(strategy, "Harvested");
    });

    it("keeper can call harvestSingle()", async function () {
      console.log("[DEBUG] test: keeper harvestSingle");
      const invested = ethers.parseUnits("10000", 18);
      const nftId = await mintAndTrackNft(invested, ethers.parseUnits("500", 18));
      await usdt.mint(await mockMaster.getAddress(), ethers.parseUnits("500", 18));

      await expect(strategy.connect(keeper1).harvestSingle(nftId))
        .to.emit(strategy, "HarvestedSingle");
    });

    it("keeper can call cleanupBurnedNfts()", async function () {
      console.log("[DEBUG] test: keeper cleanupBurnedNfts");
      await expect(strategy.connect(keeper1).cleanupBurnedNfts())
        .to.emit(strategy, "BurnedNftsCleaned");
    });

    it("owner can still call harvest() when keeper is set", async function () {
      console.log("[DEBUG] test: owner harvest with keeper set");
      await expect(strategy.connect(admin).harvest())
        .to.emit(strategy, "Harvested");
    });

    it("random user cannot call harvest() (reverts NotKeeperOrOwner)", async function () {
      console.log("[DEBUG] test: random user harvest");
      await expect(strategy.connect(randomUser).harvest())
        .to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");
    });

    it("random user cannot call harvestSingle() (reverts NotKeeperOrOwner)", async function () {
      console.log("[DEBUG] test: random user harvestSingle");
      const nftId = await mintAndTrackNft(ethers.parseUnits("10000", 18));
      await expect(strategy.connect(randomUser).harvestSingle(nftId))
        .to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");
    });

    it("random user cannot call cleanupBurnedNfts() (reverts NotKeeperOrOwner)", async function () {
      console.log("[DEBUG] test: random user cleanupBurnedNfts");
      await expect(strategy.connect(randomUser).cleanupBurnedNfts())
        .to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // changing the vault keeper
  // ═══════════════════════════════════════════════════════════

  describe("changing the vault keeper", function () {
    beforeEach(async function () {
      await deployFixture();
      await mockVault.setKeeper(keeper1Addr);
    });

    it("new keeper works after setKeeper", async function () {
      console.log("[DEBUG] test: change keeper to keeper2");
      await mockVault.setKeeper(keeper2Addr);
      expect(await mockVault.keeper()).to.equal(keeper2Addr);

      await expect(strategy.connect(keeper2).harvest())
        .to.emit(strategy, "Harvested");
    });

    it("old keeper is rejected after setKeeper changes", async function () {
      console.log("[DEBUG] test: old keeper rejected after change");
      await mockVault.setKeeper(keeper2Addr);

      await expect(strategy.connect(keeper1).harvest())
        .to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");
    });

    it("setting keeper to zero address means no keeper (only owner works)", async function () {
      console.log("[DEBUG] test: zero keeper — only owner works");
      await mockVault.setKeeper(ethers.ZeroAddress);

      // keeper1 is no longer keeper
      await expect(strategy.connect(keeper1).harvest())
        .to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");

      // owner still works
      await expect(strategy.connect(admin).harvest())
        .to.emit(strategy, "Harvested");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // no keeper set (default zero address)
  // ═══════════════════════════════════════════════════════════

  describe("no keeper set (default)", function () {
    beforeEach(async function () {
      await deployFixture();
      // vault.keeper() returns address(0) by default
    });

    it("vault.keeper() returns zero address", async function () {
      console.log("[DEBUG] test: default keeper is zero");
      expect(await mockVault.keeper()).to.equal(ethers.ZeroAddress);
    });

    it("owner can call harvest() with no keeper set", async function () {
      console.log("[DEBUG] test: owner harvest, no keeper");
      await expect(strategy.connect(admin).harvest())
        .to.emit(strategy, "Harvested");
    });

    it("any non-owner is rejected with NotKeeperOrOwner", async function () {
      console.log("[DEBUG] test: non-owner rejected, no keeper");
      await expect(strategy.connect(keeper1).harvest())
        .to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // keeper cannot call admin (onlyOwner) functions
  // ═══════════════════════════════════════════════════════════

  describe("keeper cannot call admin functions", function () {
    beforeEach(async function () {
      await deployFixture();
      await mockVault.setKeeper(keeper1Addr);
    });

    it("keeper cannot call depositToProperty (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper depositToProperty");
      await expect(strategy.connect(keeper1).depositToProperty(randomUserAddr, ethers.parseUnits("1000", 18), 0))
        .to.be.revertedWithCustomError(strategy, "OwnableUnauthorizedAccount");
    });

    it("keeper cannot call emergencyWithdrawToken (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper emergencyWithdrawToken");
      await expect(strategy.connect(keeper1).emergencyWithdrawToken(await usdt.getAddress(), ethers.parseUnits("100", 18)))
        .to.be.revertedWithCustomError(strategy, "OwnableUnauthorizedAccount");
    });

    it("keeper cannot call emergencyTransferNft (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper emergencyTransferNft");
      await expect(strategy.connect(keeper1).emergencyTransferNft(1, adminAddr))
        .to.be.revertedWithCustomError(strategy, "OwnableUnauthorizedAccount");
    });

    it("keeper cannot call emergencyRecoverNft (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper emergencyRecoverNft");
      await expect(strategy.connect(keeper1).emergencyRecoverNft(await mockNFT.getAddress(), 1, adminAddr))
        .to.be.revertedWithCustomError(strategy, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // keeper with real operations
  // ═══════════════════════════════════════════════════════════

  describe("keeper with real harvest operations", function () {
    beforeEach(async function () {
      await deployFixture();
      await mockVault.setKeeper(keeper1Addr);
    });

    it("keeper can harvest yield from NFTs", async function () {
      console.log("[DEBUG] test: keeper harvest with yield");
      const invested = ethers.parseUnits("10000", 18);
      const yieldAmount = ethers.parseUnits("500", 18);
      const nftId = await mintAndTrackNft(invested, yieldAmount);
      await mockMaster.setClaimableAmount(nftId, yieldAmount);
      await usdt.mint(await mockMaster.getAddress(), yieldAmount);

      const balBefore = await usdt.balanceOf(await strategy.getAddress());
      await strategy.connect(keeper1).harvest();
      const balAfter = await usdt.balanceOf(await strategy.getAddress());

      console.log("[DEBUG] keeper harvested:", ethers.formatUnits(balAfter - balBefore, 18));
      expect(balAfter - balBefore).to.equal(yieldAmount);
    });

    it("keeper can harvest multiple NFTs", async function () {
      console.log("[DEBUG] test: keeper harvest multiple NFTs");
      const invested = ethers.parseUnits("10000", 18);
      const yield1 = ethers.parseUnits("500", 18);
      const yield2 = ethers.parseUnits("300", 18);
      const nft1 = await mintAndTrackNft(invested, yield1);
      const nft2 = await mintAndTrackNft(invested, yield2);

      await mockMaster.setClaimableAmount(nft1, yield1);
      await mockMaster.setClaimableAmount(nft2, yield2);
      await usdt.mint(await mockMaster.getAddress(), yield1 + yield2);

      await expect(strategy.connect(keeper1).harvestSingle(nft1)).to.emit(strategy, "HarvestedSingle");
      await expect(strategy.connect(keeper1).harvestSingle(nft2)).to.emit(strategy, "HarvestedSingle");
    });

    it("keeper cleanup after NFT burn", async function () {
      console.log("[DEBUG] test: keeper cleanup burned");
      const nftId = await mintAndTrackNft(ethers.parseUnits("50000", 18));
      expect(await strategy.heldNftCount()).to.equal(1);

      await mockNFT.burn(nftId);

      await strategy.connect(keeper1).cleanupBurnedNfts();
      expect(await strategy.heldNftCount()).to.equal(0);
      console.log("[DEBUG] keeper cleanup complete, heldNftCount=0");
    });
  });
});
