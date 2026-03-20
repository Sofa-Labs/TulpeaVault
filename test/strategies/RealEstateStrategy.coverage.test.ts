import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("RealEstateStrategy — Coverage Gaps", function () {
  let strategy: Contract;
  let mockNFT: Contract;
  let mockMaster: Contract;
  let mockVault: Contract;
  let usdt: Contract;
  let admin: Signer;
  let user1: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let vaultAddr: string;

  async function deployFixture() {
    console.log("[DEBUG] coverage deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    adminAddr = await admin.getAddress();
    user1Addr = await user1.getAddress();

    // Deploy USDT
    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdt = await MockERC20.deploy();
    await usdt.waitForDeployment();

    // Deploy mock vault (implements keeper() for onlyKeeperOrOwner)
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
    console.log("[DEBUG] coverage deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // Helper: mint NFT to strategy and track
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

  // ═══════════════════════════════════════════════════════════
  // Constructor — specific zero address checks
  // ═══════════════════════════════════════════════════════════

  it("constructor rejects zero vault", async function () {
    console.log("[DEBUG] test: constructor zero vault");
    const Strategy = await ethers.getContractFactory("RealEstateStrategy");
    await expect(Strategy.deploy(
      await usdt.getAddress(),
      await mockNFT.getAddress(),
      await mockMaster.getAddress(),
      ethers.ZeroAddress,  // vault = 0
      adminAddr,
      []
    )).to.be.revertedWithCustomError(strategy, "ZeroAddress");
  });

  it("constructor rejects zero owner (OZ Ownable fires first)", async function () {
    console.log("[DEBUG] test: constructor zero owner");
    const Strategy = await ethers.getContractFactory("RealEstateStrategy");
    await expect(Strategy.deploy(
      await usdt.getAddress(),
      await mockNFT.getAddress(),
      await mockMaster.getAddress(),
      vaultAddr,
      ethers.ZeroAddress,  // owner = 0
      []
    )).to.be.revertedWithCustomError(strategy, "OwnableInvalidOwner");
  });

  // ═══════════════════════════════════════════════════════════
  // MaxNftsReached after 50 NFTs
  // ═══════════════════════════════════════════════════════════

  it("MaxNftsReached after 50 NFTs", async function () {
    this.timeout(120000);
    console.log("[DEBUG] test: MaxNftsReached cap at 50");

    // Mint and track 50 NFTs
    for (let i = 0; i < 50; i++) {
      const tokenId = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
      await mockNFT.mintUnsafe(await strategy.getAddress());
      await strategy.connect(admin).addNftForTesting(tokenId);
    }
    console.log("[DEBUG] heldNftCount after 50:", (await strategy.heldNftCount()).toString());
    expect(await strategy.heldNftCount()).to.equal(50);

    // 51st should revert with MaxNftsReached
    const tokenId51 = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
    await mockNFT.mintUnsafe(await strategy.getAddress());
    await expect(strategy.connect(admin).addNftForTesting(tokenId51))
      .to.be.revertedWithCustomError(strategy, "MaxNftsReached");
    console.log("[DEBUG] 51st NFT correctly rejected");
  });

  // ═══════════════════════════════════════════════════════════
  // cleanupBurnedNfts — mixed burned/alive
  // ═══════════════════════════════════════════════════════════

  it("cleanupBurnedNfts with mixed burned/alive NFTs", async function () {
    console.log("[DEBUG] test: cleanupBurnedNfts mixed");
    const invested = ethers.parseUnits("10000", 18);

    // Mint 5 NFTs
    const nftIds: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      nftIds.push(await mintAndTrackNft(invested));
    }
    expect(await strategy.heldNftCount()).to.equal(5);
    console.log("[DEBUG] 5 NFTs tracked, ids:", nftIds.map(String));

    // Burn 2 NFTs (index 1 and 3)
    await mockNFT.burn(nftIds[1]);
    await mockNFT.burn(nftIds[3]);
    console.log("[DEBUG] Burned NFTs:", nftIds[1].toString(), nftIds[3].toString());

    // Cleanup
    await strategy.cleanupBurnedNfts();
    console.log("[DEBUG] heldNftCount after cleanup:", (await strategy.heldNftCount()).toString());
    expect(await strategy.heldNftCount()).to.equal(3);

    // Verify remaining are alive
    expect(await strategy.isHeldNft(nftIds[0])).to.be.true;
    expect(await strategy.isHeldNft(nftIds[1])).to.be.false;
    expect(await strategy.isHeldNft(nftIds[2])).to.be.true;
    expect(await strategy.isHeldNft(nftIds[3])).to.be.false;
    expect(await strategy.isHeldNft(nftIds[4])).to.be.true;
  });

  it("cleanupBurnedNfts removes transferred-away NFTs", async function () {
    console.log("[DEBUG] test: cleanupBurnedNfts transferred away");
    const invested = ethers.parseUnits("10000", 18);

    // Mint 3 NFTs
    const nftIds: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      nftIds.push(await mintAndTrackNft(invested));
    }
    expect(await strategy.heldNftCount()).to.equal(3);

    // Transfer 1 NFT away via emergencyTransferNft (so it leaves strategy ownership)
    // But we want to test cleanup detecting owner != strategy
    // Use mockNFT to transfer away from strategy directly (simulating ownership change)
    // We need to impersonate the strategy to transfer
    const strategyAddr = await strategy.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [strategyAddr]);
    const strategySigner = await ethers.getSigner(strategyAddr);
    await ethers.provider.send("hardhat_setBalance", [strategyAddr, "0xDE0B6B3A7640000"]);

    // Transfer NFT[1] from strategy to admin — but strategy still tracks it
    // We need to bypass _removeNft. Use mock NFT's transferFrom directly.
    await mockNFT.connect(strategySigner)["safeTransferFrom(address,address,uint256)"](
      strategyAddr, adminAddr, nftIds[1]
    );
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [strategyAddr]);

    // NFT is still tracked but owned by admin now
    expect(await strategy.isHeldNft(nftIds[1])).to.be.true;
    expect(await mockNFT.ownerOf(nftIds[1])).to.equal(adminAddr);

    // Cleanup should detect it's not owned by strategy
    await strategy.cleanupBurnedNfts();
    console.log("[DEBUG] heldNftCount after cleanup:", (await strategy.heldNftCount()).toString());
    expect(await strategy.heldNftCount()).to.equal(2);
    expect(await strategy.isHeldNft(nftIds[1])).to.be.false;
  });

  // ═══════════════════════════════════════════════════════════
  // emergencyRecoverNft — non-portfolio ERC721
  // ═══════════════════════════════════════════════════════════

  it("emergencyRecoverNft for non-portfolio ERC721", async function () {
    console.log("[DEBUG] test: emergencyRecoverNft non-portfolio");
    // Deploy a separate ERC721
    const OtherNFT = await ethers.getContractFactory("MockPortfolioNFTForStrategy");
    const otherNft = await OtherNFT.deploy();
    await otherNft.waitForDeployment();

    // Mint to strategy (accepted, not tracked since different contract)
    await otherNft.mintTo(await strategy.getAddress());
    const tokenId = 1n; // first mint

    // Recover to admin
    await strategy.connect(admin).emergencyRecoverNft(
      await otherNft.getAddress(), tokenId, adminAddr
    );

    const owner = await otherNft.ownerOf(tokenId);
    expect(owner).to.equal(adminAddr);
    // No change in tracked NFTs
    expect(await strategy.heldNftCount()).to.equal(0);
    console.log("[DEBUG] Non-portfolio NFT recovered successfully");
  });

  it("emergencyRecoverNft for tracked portfolio NFT", async function () {
    console.log("[DEBUG] test: emergencyRecoverNft tracked portfolio NFT");
    const invested = ethers.parseUnits("50000", 18);
    const nftId = await mintAndTrackNft(invested);
    expect(await strategy.heldNftCount()).to.equal(1);
    expect(await strategy.isHeldNft(nftId)).to.be.true;

    // Recover tracked portfolio NFT
    await strategy.connect(admin).emergencyRecoverNft(
      await mockNFT.getAddress(), nftId, adminAddr
    );

    expect(await mockNFT.ownerOf(nftId)).to.equal(adminAddr);
    expect(await strategy.heldNftCount()).to.equal(0);
    expect(await strategy.isHeldNft(nftId)).to.be.false;
    console.log("[DEBUG] Tracked portfolio NFT recovered and removed from tracking");
  });

  // ═══════════════════════════════════════════════════════════
  // emergencyTransferNft for untracked NFT
  // ═══════════════════════════════════════════════════════════

  it("emergencyTransferNft for untracked NFT", async function () {
    console.log("[DEBUG] test: emergencyTransferNft untracked");
    // Mint via mintUnsafe but DON'T track
    const tokenId = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
    await mockNFT.mintUnsafe(await strategy.getAddress());
    // Not tracked
    expect(await strategy.isHeldNft(tokenId)).to.be.false;

    // Transfer should still succeed (sends NFT out, no tracking change)
    await strategy.connect(admin).emergencyTransferNft(tokenId, adminAddr);

    expect(await mockNFT.ownerOf(tokenId)).to.equal(adminAddr);
    expect(await strategy.heldNftCount()).to.equal(0);
    console.log("[DEBUG] Untracked NFT transferred successfully");
  });

  // ═══════════════════════════════════════════════════════════
  // Ownable2Step — ownership transfer
  // ═══════════════════════════════════════════════════════════

  it("transferOwnership sets pendingOwner", async function () {
    console.log("[DEBUG] test: transferOwnership");
    await strategy.connect(admin).transferOwnership(user1Addr);
    const pending = await strategy.pendingOwner();
    console.log("[DEBUG] pendingOwner:", pending);
    expect(pending).to.equal(user1Addr);
    expect(await strategy.owner()).to.equal(adminAddr);
  });

  it("acceptOwnership completes transfer", async function () {
    console.log("[DEBUG] test: acceptOwnership");
    await strategy.connect(admin).transferOwnership(user1Addr);
    await strategy.connect(user1).acceptOwnership();
    console.log("[DEBUG] new owner:", await strategy.owner());
    expect(await strategy.owner()).to.equal(user1Addr);
  });

  it("non-pendingOwner cannot acceptOwnership", async function () {
    console.log("[DEBUG] test: acceptOwnership unauthorized");
    await strategy.connect(admin).transferOwnership(user1Addr);
    const signers = await ethers.getSigners();
    const random = signers[3];
    await expect(strategy.connect(random).acceptOwnership())
      .to.be.revertedWithCustomError(strategy, "OwnableUnauthorizedAccount");
  });
});
