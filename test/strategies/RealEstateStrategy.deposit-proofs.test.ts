import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

/**
 * RealEstateStrategy — Deposit Security Proof Tests
 *
 * PROOF 10: No PropertyVault Address Validation
 *   10a: Malicious vault steals USDT but no NFT → NoNftReceived reverts, USDT safe
 *   10b: Malicious vault mints from decoy NFT → onERC721Received ignores, NoNftReceived
 *   10c: EOA address as propertyVault → reverts on external call
 *
 * PROOF 11: Approval Fully Consumed After Deposit
 *   11a: Successful deposit → allowance == 0
 *   11b: Failed deposit → allowance == 0 (atomic rollback)
 *
 * PROOF 12: Multiple NFT Mints Event Accuracy
 *   12a: Double mint → both tracked, event reports only last ID
 *   12b: Single mint → correct event (baseline)
 */
describe("RealEstateStrategy — Deposit Security Proofs", function () {
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
    console.log("[DEBUG] deposit-proofs deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    adminAddr = await admin.getAddress();

    // Deploy USDT
    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdt = await MockERC20.deploy();
    await usdt.waitForDeployment();
    console.log("[DEBUG] USDT deployed at:", await usdt.getAddress());

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
    console.log("[DEBUG] MockNFT deployed at:", await mockNFT.getAddress());

    // Deploy mock master
    const MockMaster = await ethers.getContractFactory("MockPortfolioMasterForStrategy");
    mockMaster = await MockMaster.deploy(await usdt.getAddress());
    await mockMaster.waitForDeployment();
    console.log("[DEBUG] MockMaster deployed at:", await mockMaster.getAddress());

    // Deploy strategy harness
    const Strategy = await ethers.getContractFactory("RealEstateStrategyHarness");
    strategy = await Strategy.deploy(
      await usdt.getAddress(),
      await mockNFT.getAddress(),
      await mockMaster.getAddress(),
      vaultAddr,
      adminAddr,
    );
    await strategy.waitForDeployment();
    console.log("[DEBUG] Strategy deployed at:", await strategy.getAddress());
    console.log("[DEBUG] deposit-proofs deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PROOF 10: No PropertyVault Address Validation
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 10: No PropertyVault Address Validation", function () {
    it("10a: malicious vault steals USDT but no NFT → reverts NoNftReceived, USDT safe", async function () {
      console.log("[DEBUG] proof10a: testing malicious vault with no NFT mint");

      // Deploy MockPropertyVaultNoMint — takes USDT but doesn't mint NFT
      const MockVault = await ethers.getContractFactory("MockPropertyVaultNoMint");
      const maliciousVault = await MockVault.deploy(await usdt.getAddress());
      await maliciousVault.waitForDeployment();
      const maliciousVaultAddr = await maliciousVault.getAddress();
      console.log("[DEBUG] proof10a: MockPropertyVaultNoMint deployed at:", maliciousVaultAddr);

      // Fund strategy with USDT
      const amount = ethers.parseUnits("50000", 18);
      await usdt.mint(await strategy.getAddress(), amount);

      const balBefore = await usdt.balanceOf(await strategy.getAddress());
      console.log("[DEBUG] proof10a: strategy USDT balance before:", ethers.formatUnits(balBefore, 18));

      // PROOF: depositToProperty reverts with NoNftReceived
      await expect(
        strategy.connect(admin).depositToProperty(maliciousVaultAddr, amount, 0)
      ).to.be.revertedWithCustomError(strategy, "NoNftReceived");

      // PROOF: USDT is safe — atomic rollback restored balance
      const balAfter = await usdt.balanceOf(await strategy.getAddress());
      console.log("[DEBUG] proof10a: strategy USDT balance after:", ethers.formatUnits(balAfter, 18));
      expect(balAfter).to.equal(balBefore);

      // PROOF: no NFTs were tracked
      expect(await strategy.heldNftCount()).to.equal(0);

      console.log("[DEBUG] proof10a: PASSED — NoNftReceived reverts atomically, USDT safe");
    });

    it("10b: malicious vault mints from decoy NFT → onERC721Received ignores, NoNftReceived", async function () {
      console.log("[DEBUG] proof10b: testing malicious vault with decoy NFT mint");

      // Deploy DecoyNFT (wrong NFT contract)
      const DecoyNFT = await ethers.getContractFactory("DecoyNFT");
      const decoyNFT = await DecoyNFT.deploy();
      await decoyNFT.waitForDeployment();
      console.log("[DEBUG] proof10b: DecoyNFT deployed at:", await decoyNFT.getAddress());

      // Deploy MaliciousPropertyVault — takes USDT, mints from decoy NFT
      const MalVault = await ethers.getContractFactory("MaliciousPropertyVault");
      const malVault = await MalVault.deploy(await usdt.getAddress(), await decoyNFT.getAddress());
      await malVault.waitForDeployment();
      const malVaultAddr = await malVault.getAddress();
      console.log("[DEBUG] proof10b: MaliciousPropertyVault deployed at:", malVaultAddr);

      // Fund strategy
      const amount = ethers.parseUnits("50000", 18);
      await usdt.mint(await strategy.getAddress(), amount);

      const balBefore = await usdt.balanceOf(await strategy.getAddress());

      // PROOF: depositToProperty reverts — decoy NFT's onERC721Received doesn't set _lastMintedNftId
      // because msg.sender != portfolioNFT, so the if-branch is skipped
      await expect(
        strategy.connect(admin).depositToProperty(malVaultAddr, amount, 0)
      ).to.be.revertedWithCustomError(strategy, "NoNftReceived");

      // PROOF: USDT safe after atomic rollback
      const balAfter = await usdt.balanceOf(await strategy.getAddress());
      console.log("[DEBUG] proof10b: strategy USDT balance before=%s after=%s",
        ethers.formatUnits(balBefore, 18), ethers.formatUnits(balAfter, 18));
      expect(balAfter).to.equal(balBefore);

      // PROOF: no NFTs tracked (decoy was ignored by onERC721Received)
      expect(await strategy.heldNftCount()).to.equal(0);

      console.log("[DEBUG] proof10b: PASSED — decoy NFT ignored, NoNftReceived, USDT safe");
    });

    it("10c: EOA address as propertyVault → reverts on external call", async function () {
      console.log("[DEBUG] proof10c: testing EOA address as vault");

      const amount = ethers.parseUnits("10000", 18);
      await usdt.mint(await strategy.getAddress(), amount);

      // Use user1 address (an EOA, not a contract)
      const eoaAddr = await user1.getAddress();
      console.log("[DEBUG] proof10c: using EOA address:", eoaAddr);

      // PROOF: reverts when trying to call depositAsLender on an EOA
      await expect(
        strategy.connect(admin).depositToProperty(eoaAddr, amount, 0)
      ).to.be.reverted;

      // PROOF: USDT safe
      const bal = await usdt.balanceOf(await strategy.getAddress());
      expect(bal).to.equal(amount);

      console.log("[DEBUG] proof10c: PASSED — EOA address reverts, USDT safe");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PROOF 11: Approval Fully Consumed After Deposit
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 11: Approval Fully Consumed After Deposit", function () {
    it("11a: successful deposit → allowance == 0", async function () {
      console.log("[DEBUG] proof11a: testing approval cleanup on success");

      // Deploy a mock vault that actually works (takes USDT + mints real NFT)
      // Use MockPropertyVaultWithCallback pattern: takes USDT, calls portfolioNFT.mintTo
      const MockVaultFactory = await ethers.getContractFactory("MockPropertyVaultDoubleMint");
      // We need a single-mint vault. Let's deploy a proper working mock.
      // Actually, we can build a minimal one inline. But simpler: use the existing
      // approach from the test suite — deploy a mock that does full flow.

      // For 11a, we need a vault that consumes the full allowance and mints 1 NFT.
      // The simplest approach: create a contract that does safeTransferFrom + mintTo.
      // We already have MockPropertyVaultDoubleMint but it mints 2. Let's use a
      // different approach: manually simulate the full flow.

      // Deploy a simple working mock inline via the existing MockPropertyVaultNoMint pattern
      // but one that DOES mint. We can use the double-mint mock and just check the allowance.
      // Actually, the double-mint also consumes the full approval via safeTransferFrom.

      // Better: Let's just test with a single-mint vault. We need to create a mock that
      // takes USDT and mints ONE NFT from portfolioNFT.
      // But we don't have that exact mock. Let's repurpose MockPropertyVaultDoubleMint
      // for 12a and create a simple working vault here.

      // Actually we CAN test this without a new contract: if the depositToProperty succeeds,
      // the approval was consumed. Let me think about this differently.

      // The simplest approach: use a proper working PropertyVault mock.
      // We can create a minimal one using the MockPropertyVaultDoubleMint as template
      // but with one mint. OR we can just check the state after a real deposit.

      // For a clean test, let me build a temporary mock via hardhat artifact.
      // Actually, the cleanest way: the double-mint vault also consumes the full USDT
      // via safeTransferFrom(amount). The allowance goes to 0 after that.

      // Let's use the double mint vault — the allowance test is the same (full amount consumed).
      const vault = await (await ethers.getContractFactory("MockPropertyVaultDoubleMint")).deploy(
        await usdt.getAddress(),
        await mockNFT.getAddress()
      );
      await vault.waitForDeployment();
      const vaultAddress = await vault.getAddress();
      console.log("[DEBUG] proof11a: working vault deployed at:", vaultAddress);

      const amount = ethers.parseUnits("25000", 18);
      await usdt.mint(await strategy.getAddress(), amount);

      // Execute deposit
      await strategy.connect(admin).depositToProperty(vaultAddress, amount, 0);

      // PROOF: allowance is 0 after successful deposit (full amount consumed by safeTransferFrom)
      const allowance = await usdt.allowance(await strategy.getAddress(), vaultAddress);
      console.log("[DEBUG] proof11a: allowance after deposit:", allowance.toString());
      expect(allowance).to.equal(0n);

      console.log("[DEBUG] proof11a: PASSED — allowance == 0 after successful deposit");
    });

    it("11b: failed deposit → allowance == 0 (atomic rollback)", async function () {
      console.log("[DEBUG] proof11b: testing approval cleanup on revert");

      // Deploy a vault that takes USDT but doesn't mint (will cause NoNftReceived)
      const MockVault = await ethers.getContractFactory("MockPropertyVaultNoMint");
      const badVault = await MockVault.deploy(await usdt.getAddress());
      await badVault.waitForDeployment();
      const badVaultAddr = await badVault.getAddress();

      const amount = ethers.parseUnits("25000", 18);
      await usdt.mint(await strategy.getAddress(), amount);

      // Check allowance before (should be 0)
      const allowanceBefore = await usdt.allowance(await strategy.getAddress(), badVaultAddr);
      console.log("[DEBUG] proof11b: allowance before failed deposit:", allowanceBefore.toString());
      expect(allowanceBefore).to.equal(0n);

      // Attempt deposit — reverts
      await expect(
        strategy.connect(admin).depositToProperty(badVaultAddr, amount, 0)
      ).to.be.revertedWithCustomError(strategy, "NoNftReceived");

      // PROOF: allowance is still 0 — the forceApprove was rolled back atomically
      const allowanceAfter = await usdt.allowance(await strategy.getAddress(), badVaultAddr);
      console.log("[DEBUG] proof11b: allowance after failed deposit:", allowanceAfter.toString());
      expect(allowanceAfter).to.equal(0n);

      console.log("[DEBUG] proof11b: PASSED — atomic rollback zeroes allowance on revert");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PROOF 12: Multiple NFT Mints Event Accuracy
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 12: Multiple NFT Mints Event Accuracy", function () {
    it("12a: double mint → both tracked, event reports only last ID", async function () {
      console.log("[DEBUG] proof12a: testing double mint event accuracy");

      // Deploy MockPropertyVaultDoubleMint — mints 2 NFTs from real portfolioNFT
      const DoubleMintVault = await ethers.getContractFactory("MockPropertyVaultDoubleMint");
      const doubleMintVault = await DoubleMintVault.deploy(
        await usdt.getAddress(),
        await mockNFT.getAddress()
      );
      await doubleMintVault.waitForDeployment();
      const dmVaultAddr = await doubleMintVault.getAddress();
      console.log("[DEBUG] proof12a: MockPropertyVaultDoubleMint deployed at:", dmVaultAddr);

      const amount = ethers.parseUnits("30000", 18);
      await usdt.mint(await strategy.getAddress(), amount);

      // Execute deposit
      const tx = await strategy.connect(admin).depositToProperty(dmVaultAddr, amount, 0);
      const receipt = await tx.wait();

      // Find NftAdded events — should be 2 (both NFTs tracked via _addNft)
      const nftAddedEvents = receipt.logs.filter((log: any) => {
        try {
          const parsed = strategy.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "NftAdded";
        } catch { return false; }
      });
      console.log("[DEBUG] proof12a: NftAdded events count:", nftAddedEvents.length);
      expect(nftAddedEvents.length).to.equal(2);

      // Extract NFT IDs from NftAdded events
      const nftId1 = strategy.interface.parseLog({
        topics: nftAddedEvents[0].topics,
        data: nftAddedEvents[0].data
      })!.args[0];
      const nftId2 = strategy.interface.parseLog({
        topics: nftAddedEvents[1].topics,
        data: nftAddedEvents[1].data
      })!.args[0];
      console.log("[DEBUG] proof12a: nftId1=%s nftId2=%s", nftId1.toString(), nftId2.toString());

      // PROOF: Both NFTs are tracked in heldNftIds
      expect(await strategy.isHeldNft(nftId1)).to.be.true;
      expect(await strategy.isHeldNft(nftId2)).to.be.true;
      expect(await strategy.heldNftCount()).to.equal(2);
      console.log("[DEBUG] proof12a: both NFTs tracked in heldNftIds");

      // Find DepositedToProperty event — should report ALL minted NFT IDs
      const depositEvents = receipt.logs.filter((log: any) => {
        try {
          const parsed = strategy.interface.parseLog({ topics: log.topics, data: log.data });
          return parsed?.name === "DepositedToProperty";
        } catch { return false; }
      });
      expect(depositEvents.length).to.equal(1);

      const depositEvent = strategy.interface.parseLog({
        topics: depositEvents[0].topics,
        data: depositEvents[0].data
      })!;
      const reportedNftIds = depositEvent.args[2]; // third arg: nftIds[]
      console.log("[DEBUG] proof12a: DepositedToProperty reported nftIds:", reportedNftIds.map((id: any) => id.toString()));

      // PROOF (F12 fix): Event now reports ALL minted NFTs, not just the last
      expect(reportedNftIds.length).to.equal(2);
      expect(reportedNftIds[0]).to.equal(nftId1);
      expect(reportedNftIds[1]).to.equal(nftId2);

      console.log("[DEBUG] proof12a: PASSED — both NFTs tracked AND reported in event");
    });

    it("12b: double mint → all NFT IDs in event (F12 fix verified)", async function () {
      console.log("[DEBUG] proof12b: testing double mint reports all IDs");

      // Deploy double-mint vault and run the same deposit
      const DoubleMintVault = await ethers.getContractFactory("MockPropertyVaultDoubleMint");
      const dmVault = await DoubleMintVault.deploy(
        await usdt.getAddress(),
        await mockNFT.getAddress()
      );
      await dmVault.waitForDeployment();

      const amount = ethers.parseUnits("20000", 18);
      await usdt.mint(await strategy.getAddress(), amount);

      const tx = await strategy.connect(admin).depositToProperty(await dmVault.getAddress(), amount, 0);
      const receipt = await tx.wait();

      // Get all NftAdded events
      const nftAddedEvents = receipt.logs.filter((log: any) => {
        try {
          return strategy.interface.parseLog({ topics: log.topics, data: log.data })?.name === "NftAdded";
        } catch { return false; }
      });
      expect(nftAddedEvents.length).to.equal(2);

      const nftId1 = strategy.interface.parseLog({
        topics: nftAddedEvents[0].topics,
        data: nftAddedEvents[0].data
      })!.args[0];
      const nftId2 = strategy.interface.parseLog({
        topics: nftAddedEvents[1].topics,
        data: nftAddedEvents[1].data
      })!.args[0];

      // Get DepositedToProperty event
      const depositEvents = receipt.logs.filter((log: any) => {
        try {
          return strategy.interface.parseLog({ topics: log.topics, data: log.data })?.name === "DepositedToProperty";
        } catch { return false; }
      });
      expect(depositEvents.length).to.equal(1);

      const fullEvent = strategy.interface.parseLog({
        topics: depositEvents[0].topics,
        data: depositEvents[0].data
      })!;

      // PROOF (F12 fix): Event now reports ALL minted NFT IDs
      const reportedNftIds = fullEvent.args[2];
      console.log("[DEBUG] proof12b: nftIds in event:", reportedNftIds.map((id: any) => id.toString()));
      expect(reportedNftIds.length).to.equal(2);
      expect(reportedNftIds[0]).to.equal(nftId1);
      expect(reportedNftIds[1]).to.equal(nftId2);

      // PROOF: DepositedToProperty event contains correct vault address and amount
      expect(fullEvent.args[0]).to.equal(await dmVault.getAddress()); // propertyVault
      expect(fullEvent.args[1]).to.equal(amount); // amount

      console.log("[DEBUG] proof12b: PASSED — all NFT IDs reported in event");
    });
  });
});
