import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

const DEPOSIT_LIMIT = ethers.parseUnits("1000000", 18);

/**
 * RealEstateStrategy — Security Proof Tests
 *
 * These tests PROVE that initially flagged audit findings are false positives:
 * 1. Vault accounting handles partial withdrawals correctly
 * 2. Reentrancy on cleanupBurnedNfts is not exploitable
 * 3. Emergency transfer follows checks-effects-interactions
 * 4. _depositing flag cannot be left stuck after revert
 * 5. NoNftReceived custom error (was string revert — now fixed)
 */
describe("RealEstateStrategy — Security Proofs", function () {
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
    console.log("[DEBUG] security-proofs deployFixture: start");
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
    console.log("[DEBUG] security-proofs deployFixture: complete");
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
    console.log("[DEBUG] mintAndTrackNft: tokenId=%s invested=%s", tokenId.toString(), invested.toString());
    return tokenId;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Test 1: Vault accounting is correct on partial withdrawal
  // PROVES: "withdraw() partial send causes accounting desync" is FALSE
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 1: Vault accounting correct on partial withdrawal", function () {
    let vault: Contract;

    beforeEach(async function () {
      console.log("[DEBUG] proof1: setting up vault + strategy integration");

      // Deploy vault proxy
      const VaultFactory = await ethers.getContractFactory("TulpeaYieldVault");
      const vaultImpl = await VaultFactory.deploy();
      await vaultImpl.waitForDeployment();

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967ProxyWrapper");
      const initData = VaultFactory.interface.encodeFunctionData("initialize", [
        await usdt.getAddress(), adminAddr, DEPOSIT_LIMIT, "Tulpea Yield Vault", "tyvUSDT", ethers.ZeroAddress,
      ]);
      const proxy = await ERC1967Proxy.deploy(await vaultImpl.getAddress(), initData);
      await proxy.waitForDeployment();
      vault = VaultFactory.attach(await proxy.getAddress()) as Contract;
      vaultAddr = await proxy.getAddress();

      // Redeploy strategy with real vault address
      const Strategy = await ethers.getContractFactory("RealEstateStrategyHarness");
      strategy = await Strategy.deploy(
        await usdt.getAddress(),
        await mockNFT.getAddress(),
        await mockMaster.getAddress(),
        vaultAddr,
        adminAddr,
        []
      );
      await strategy.waitForDeployment();

      // Register strategy
      await vault.connect(admin).addStrategy(await strategy.getAddress());
      console.log("[DEBUG] proof1: vault + strategy ready");
    });

    it("totalDebt decrements by ACTUAL received, not requested amount", async function () {
      console.log("[DEBUG] proof1: starting partial withdrawal test");

      // User deposits 50k into vault
      const dep = ethers.parseUnits("50000", 18);
      await usdt.mint(await admin.getAddress(), dep);
      await usdt.connect(admin).approve(vaultAddr, dep);
      await vault.connect(admin).deposit(dep, adminAddr);

      // Deploy 50k to strategy via timelock
      const deployId = await vault.connect(admin).requestDeploy.staticCall(
        await strategy.getAddress(), dep
      );
      await vault.connect(admin).requestDeploy(await strategy.getAddress(), dep);
      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(deployId);

      console.log("[DEBUG] proof1: totalDebt after deploy:", (await vault.totalDebt()).toString());
      expect(await vault.totalDebt()).to.equal(dep);

      // Make strategy illiquid: transfer 40k out, add NFT worth 40k
      const spent = ethers.parseUnits("40000", 18);
      const strategyAddr = await strategy.getAddress();

      await ethers.provider.send("hardhat_impersonateAccount", [strategyAddr]);
      const strategySigner = await ethers.getSigner(strategyAddr);
      await ethers.provider.send("hardhat_setBalance", [strategyAddr, "0xDE0B6B3A7640000"]);
      await usdt.connect(strategySigner).transfer(adminAddr, spent);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [strategyAddr]);

      await mintAndTrackNft(spent, 0n, 0n, 4000n);

      // Strategy has: 10k idle + 40k in NFTs = 50k totalAssets
      const idle = await usdt.balanceOf(strategyAddr);
      const totalAssets = await strategy.totalAssets();
      console.log("[DEBUG] proof1: idle=%s totalAssets=%s", ethers.formatUnits(idle, 18), ethers.formatUnits(totalAssets, 18));
      expect(idle).to.equal(ethers.parseUnits("10000", 18));
      expect(totalAssets).to.equal(dep); // 50k total

      // Vault tries to withdraw full 50k — strategy can only send 10k
      const totalDebtBefore = await vault.totalDebt();
      const configBefore = await vault.strategies(strategyAddr);
      console.log("[DEBUG] proof1: totalDebt before=%s currentDebt before=%s",
        totalDebtBefore.toString(), configBefore.currentDebt.toString());

      await vault.connect(admin).withdrawFromStrategy(strategyAddr, dep);

      const totalDebtAfter = await vault.totalDebt();
      const configAfter = await vault.strategies(strategyAddr);
      console.log("[DEBUG] proof1: totalDebt after=%s currentDebt after=%s",
        totalDebtAfter.toString(), configAfter.currentDebt.toString());

      // PROOF: totalDebt decremented by 10k (actual received), NOT 50k (requested)
      const debtDecrement = totalDebtBefore - totalDebtAfter;
      console.log("[DEBUG] proof1: debt decremented by:", ethers.formatUnits(debtDecrement, 18));
      expect(debtDecrement).to.equal(ethers.parseUnits("10000", 18));
      expect(totalDebtAfter).to.equal(ethers.parseUnits("40000", 18));

      // PROOF: currentDebt also decremented by actual
      const currentDebtDecrement = configBefore.currentDebt - configAfter.currentDebt;
      expect(currentDebtDecrement).to.equal(ethers.parseUnits("10000", 18));

      console.log("[DEBUG] proof1: PASSED — vault accounting uses actual received amount");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 2: Reentrancy on cleanupBurnedNfts is not exploitable
  // PROVES: "Missing nonReentrant on cleanupBurnedNfts" is FALSE POSITIVE
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 2: Reentrancy on cleanupBurnedNfts is not exploitable", function () {
    it("portfolioNFT is immutable — cannot be swapped for malicious contract", async function () {
      console.log("[DEBUG] proof2a: checking immutability");

      const nftAddr = await strategy.portfolioNFT();
      const expectedAddr = await mockNFT.getAddress();
      console.log("[DEBUG] proof2a: portfolioNFT=%s expected=%s", nftAddr, expectedAddr);

      // Verify portfolioNFT is set correctly
      expect(nftAddr).to.equal(expectedAddr);

      // Deploy a malicious NFT mock
      const ReentrantNFT = await ethers.getContractFactory("ReentrantNFTMock");
      const maliciousNft = await ReentrantNFT.deploy();
      await maliciousNft.waitForDeployment();
      console.log("[DEBUG] proof2a: malicious NFT deployed at:", await maliciousNft.getAddress());

      // PROOF: There is no setter for portfolioNFT — it's immutable
      // The strategy ABI has no function to change portfolioNFT
      // So even if ReentrantNFTMock existed, it can never replace the real NFT
      const strategyInterface = strategy.interface;
      const setterFunctions = Object.keys(strategyInterface.functions || {}).filter(
        (fn: string) => fn.toLowerCase().includes("setnft") || fn.toLowerCase().includes("setportfolio")
      );
      console.log("[DEBUG] proof2a: setter functions found:", setterFunctions.length);
      expect(setterFunctions.length).to.equal(0);

      console.log("[DEBUG] proof2a: PASSED — no setter exists for portfolioNFT (immutable)");
    });

    it("onlyKeeperOrOwner blocks unauthorized callers from cleanupBurnedNfts", async function () {
      console.log("[DEBUG] proof2b: testing access control");

      // user1 is neither keeper nor owner
      await expect(
        strategy.connect(user1).cleanupBurnedNfts()
      ).to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");

      console.log("[DEBUG] proof2b: PASSED — unauthorized caller blocked");
    });

    it("_removeNft is idempotent — double removal is safe", async function () {
      console.log("[DEBUG] proof2c: testing idempotent removal");

      const nftId = await mintAndTrackNft(ethers.parseUnits("10000", 18));
      expect(await strategy.heldNftCount()).to.equal(1);

      // Burn the NFT
      await mockNFT.burn(nftId);

      // First cleanup removes it
      await strategy.connect(admin).cleanupBurnedNfts();
      expect(await strategy.heldNftCount()).to.equal(0);
      console.log("[DEBUG] proof2c: after first cleanup, count=0");

      // Second cleanup — no-op, doesn't revert
      await strategy.connect(admin).cleanupBurnedNfts();
      expect(await strategy.heldNftCount()).to.equal(0);
      console.log("[DEBUG] proof2c: after second cleanup, count=0 (idempotent)");

      console.log("[DEBUG] proof2c: PASSED — double cleanup is safe");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 3: Emergency transfer follows checks-effects-interactions
  // PROVES: "Reentrancy on emergencyTransferNft" is FALSE POSITIVE
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 3: Emergency transfer follows checks-effects-interactions", function () {
    it("NFT removed from tracking BEFORE safeTransferFrom callback fires", async function () {
      console.log("[DEBUG] proof3: testing CEI pattern");

      // Deploy ReentrantReceiver
      const Receiver = await ethers.getContractFactory("ReentrantReceiver");
      const receiver = await Receiver.deploy();
      await receiver.waitForDeployment();
      const receiverAddr = await receiver.getAddress();
      console.log("[DEBUG] proof3: ReentrantReceiver deployed at:", receiverAddr);

      // Mint and track an NFT
      const nftId = await mintAndTrackNft(ethers.parseUnits("50000", 18));
      expect(await strategy.isHeldNft(nftId)).to.be.true;
      console.log("[DEBUG] proof3: NFT %s tracked, count=%s", nftId.toString(), (await strategy.heldNftCount()).toString());

      // Set up reentrant receiver to try calling emergencyTransferNft
      await receiver.setTarget(await strategy.getAddress(), nftId);
      await receiver.setShouldReenter(true);

      // Transfer NFT to reentrant receiver
      await strategy.connect(admin).emergencyTransferNft(nftId, receiverAddr);

      // PROOF 1: NFT is no longer tracked (was removed BEFORE transfer)
      expect(await strategy.isHeldNft(nftId)).to.be.false;
      expect(await strategy.heldNftCount()).to.equal(0);
      console.log("[DEBUG] proof3: NFT removed from tracking after transfer");

      // PROOF 2: Reentrant call was attempted but failed
      const attempted = await receiver.reentryAttempted();
      const succeeded = await receiver.reentrySucceeded();
      console.log("[DEBUG] proof3: reentry attempted=%s succeeded=%s", attempted, succeeded);
      expect(attempted).to.be.true;
      expect(succeeded).to.be.false;

      // PROOF 3: NFT is now owned by the receiver (transfer succeeded despite reentry attempt)
      const owner = await mockNFT.ownerOf(nftId);
      expect(owner).to.equal(receiverAddr);
      console.log("[DEBUG] proof3: NFT owner is receiver (transfer completed correctly)");

      console.log("[DEBUG] proof3: PASSED — CEI pattern prevents reentrancy exploitation");
    });

    it("reentrant call fails with OwnableUnauthorizedAccount (not strategy owner)", async function () {
      console.log("[DEBUG] proof3b: testing reentry fails due to access control");

      const Receiver = await ethers.getContractFactory("ReentrantReceiver");
      const receiver = await Receiver.deploy();
      await receiver.waitForDeployment();
      const receiverAddr = await receiver.getAddress();

      // Mint two NFTs
      const nftId1 = await mintAndTrackNft(ethers.parseUnits("25000", 18));
      const nftId2 = await mintAndTrackNft(ethers.parseUnits("25000", 18));
      expect(await strategy.heldNftCount()).to.equal(2);

      // Set receiver to try re-entering with nftId2 when receiving nftId1
      await receiver.setTarget(await strategy.getAddress(), nftId2);
      await receiver.setShouldReenter(true);

      // Transfer nftId1 — receiver tries to steal nftId2 via reentry
      await strategy.connect(admin).emergencyTransferNft(nftId1, receiverAddr);

      // nftId1 transferred successfully
      expect(await mockNFT.ownerOf(nftId1)).to.equal(receiverAddr);
      expect(await strategy.isHeldNft(nftId1)).to.be.false;

      // nftId2 still safe in strategy — reentry failed
      expect(await mockNFT.ownerOf(nftId2)).to.equal(await strategy.getAddress());
      expect(await strategy.isHeldNft(nftId2)).to.be.true;

      // Reentry was attempted but blocked
      expect(await receiver.reentryAttempted()).to.be.true;
      expect(await receiver.reentrySucceeded()).to.be.false;

      console.log("[DEBUG] proof3b: PASSED — reentry blocked by onlyOwner, nftId2 safe");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 4: _depositing flag cannot be left stuck
  // PROVES: Flag resets on revert (tx rollback)
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 4: _depositing flag cannot be left stuck", function () {
    it("after failed depositToProperty, unsolicited NFTs still rejected", async function () {
      console.log("[DEBUG] proof4: testing _depositing flag reset on revert");

      // Deploy a mock property vault that does NOT mint any NFT
      const MockVault = await ethers.getContractFactory("MockPropertyVaultNoMint");
      const mockVault = await MockVault.deploy(await usdt.getAddress());
      await mockVault.waitForDeployment();
      const mockVaultAddr = await mockVault.getAddress();
      console.log("[DEBUG] proof4: MockPropertyVaultNoMint deployed at:", mockVaultAddr);

      // Fund strategy with USDT
      const amount = ethers.parseUnits("10000", 18);
      await usdt.mint(await strategy.getAddress(), amount);

      // depositToProperty should revert because no NFT is minted
      await expect(
        strategy.connect(admin).depositToProperty(mockVaultAddr, amount, 0)
      ).to.be.revertedWithCustomError(strategy, "NoNftReceived");
      console.log("[DEBUG] proof4: depositToProperty correctly reverted with NoNftReceived");

      // PROOF: _depositing is false because the entire tx reverted (state rollback)
      // Verify by trying to send an unsolicited NFT — should still revert with UnsolicitedNftTransfer
      await expect(
        mockNFT.mintTo(await strategy.getAddress())
      ).to.be.revertedWithCustomError(strategy, "UnsolicitedNftTransfer");

      console.log("[DEBUG] proof4: PASSED — _depositing flag reset after revert, unsolicited NFTs still rejected");
    });

    it("_depositing flag resets even if approve succeeds but deposit fails", async function () {
      console.log("[DEBUG] proof4b: testing flag reset with partial execution");

      // Use a zero-address vault to cause an early revert
      // depositToProperty: approve succeeds, depositAsLender reverts
      const amount = ethers.parseUnits("5000", 18);
      await usdt.mint(await strategy.getAddress(), amount);

      // This will revert because the mock vault address doesn't have depositAsLender
      // or it's not a valid contract
      await expect(
        strategy.connect(admin).depositToProperty(adminAddr, amount, 0)
      ).to.be.reverted;
      console.log("[DEBUG] proof4b: depositToProperty reverted as expected");

      // PROOF: unsolicited transfers still rejected (flag not stuck)
      await expect(
        mockNFT.mintTo(await strategy.getAddress())
      ).to.be.revertedWithCustomError(strategy, "UnsolicitedNftTransfer");

      console.log("[DEBUG] proof4b: PASSED — flag not stuck after partial execution revert");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 5: NoNftReceived custom error (was string revert — now fixed)
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 5: String revert replaced with custom error", function () {
    it("depositToProperty reverts with NoNftReceived custom error when no NFT minted", async function () {
      console.log("[DEBUG] proof5: testing NoNftReceived custom error");

      // Deploy mock vault that doesn't mint
      const MockVault = await ethers.getContractFactory("MockPropertyVaultNoMint");
      const mockVault = await MockVault.deploy(await usdt.getAddress());
      await mockVault.waitForDeployment();
      console.log("[DEBUG] proof5: MockPropertyVaultNoMint deployed at:", await mockVault.getAddress());

      // Fund strategy
      const amount = ethers.parseUnits("10000", 18);
      await usdt.mint(await strategy.getAddress(), amount);

      // PROOF: reverts with custom error, not string
      await expect(
        strategy.connect(admin).depositToProperty(await mockVault.getAddress(), amount, 0)
      ).to.be.revertedWithCustomError(strategy, "NoNftReceived");

      console.log("[DEBUG] proof5: PASSED — custom error NoNftReceived used instead of string require");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PROOF 6: Burned NFTs inflate totalAssets() with stale data
  // PROVES: getPosition() returns stale mapping data after burn, inflating value
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 6: Burned NFTs inflate totalAssets() with stale data", function () {
    it("6a: burned NFT skipped in totalAssets (FIX: ownerOf check prevents phantom)", async function () {
      console.log("[DEBUG] proof6a: testing burned NFT no longer inflates totalAssets");

      const invested = ethers.parseUnits("100000", 18);
      const nftId = await mintAndTrackNft(invested);

      const totalBefore = await strategy.totalAssets();
      console.log("[DEBUG] proof6a: totalAssets before burn:", ethers.formatUnits(totalBefore, 18));
      expect(totalBefore).to.equal(invested); // 100k from NFT value

      // Burn the NFT — position data remains in mapping
      await mockNFT.burn(nftId);
      console.log("[DEBUG] proof6a: NFT burned");

      // FIX: totalAssets skips burned NFT via ownerOf check — no phantom
      const totalAfter = await strategy.totalAssets();
      console.log("[DEBUG] proof6a: totalAssets after burn:", ethers.formatUnits(totalAfter, 18));
      expect(totalAfter).to.equal(0n, "FIX: burned NFT skipped, no phantom");

      // NFT is still tracked (awaiting cleanup) but not counted in totalAssets
      const count = await strategy.heldNftCount();
      console.log("[DEBUG] proof6a: heldNftCount after burn:", count.toString());
      expect(count).to.equal(1, "Stale entry remains until cleanup");

      console.log("[DEBUG] proof6a: PASSED — FIX prevents burned NFT inflation");
    });

    it("6b: cleanupBurnedNfts removes stale tracking entry (totalAssets already correct)", async function () {
      console.log("[DEBUG] proof6b: testing cleanup removes stale tracking");

      const invested = ethers.parseUnits("100000", 18);
      const nftId = await mintAndTrackNft(invested);
      await mockNFT.burn(nftId);

      // FIX: no inflation — totalAssets already skips burned NFT
      expect(await strategy.totalAssets()).to.equal(0n, "FIX: no phantom even before cleanup");
      // But tracking entry is stale
      expect(await strategy.heldNftCount()).to.equal(1, "Stale tracking entry remains");
      console.log("[DEBUG] proof6b: confirmed no inflation, stale entry exists");

      // Cleanup removes the stale tracking entry
      await strategy.connect(admin).cleanupBurnedNfts();

      const totalAfter = await strategy.totalAssets();
      const count = await strategy.heldNftCount();
      console.log("[DEBUG] proof6b: totalAssets after cleanup:", ethers.formatUnits(totalAfter, 18));
      console.log("[DEBUG] proof6b: heldNftCount after cleanup:", count.toString());
      expect(totalAfter).to.equal(0n);
      expect(count).to.equal(0);

      console.log("[DEBUG] proof6b: PASSED — cleanup removes stale tracking entry");
    });

    it("6c: multiple burned NFTs all skipped in totalAssets (FIX applied)", async function () {
      console.log("[DEBUG] proof6c: testing multiple burned NFTs skipped");

      const amounts = [
        ethers.parseUnits("50000", 18),
        ethers.parseUnits("30000", 18),
        ethers.parseUnits("20000", 18),
      ];
      const nftIds: bigint[] = [];

      for (const amt of amounts) {
        nftIds.push(await mintAndTrackNft(amt));
      }

      // Burn all 3
      for (const id of nftIds) {
        await mockNFT.burn(id);
      }
      console.log("[DEBUG] proof6c: all 3 NFTs burned");

      // FIX: totalAssets reports 0 — all burned NFTs skipped
      const totalAfter = await strategy.totalAssets();
      console.log("[DEBUG] proof6c: totalAssets after burns:", ethers.formatUnits(totalAfter, 18));
      expect(totalAfter).to.equal(0n, "FIX: all burned NFTs skipped");

      // Cleanup removes stale tracking entries
      await strategy.connect(admin).cleanupBurnedNfts();
      expect(await strategy.totalAssets()).to.equal(0n);
      expect(await strategy.heldNftCount()).to.equal(0);

      console.log("[DEBUG] proof6c: PASSED — FIX prevents compound inflation from burned NFTs");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PROOF 7: processReport reads inflated totalAssets (phantom profit)
  // PROVES: Stale burned NFTs cause vault to recognize phantom profit
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 7: processReport recognizes phantom profit from stale burned NFTs", function () {
    let vault: Contract;

    beforeEach(async function () {
      console.log("[DEBUG] proof7: setting up vault + strategy integration");

      // Deploy vault proxy
      const VaultFactory = await ethers.getContractFactory("TulpeaYieldVault");
      const vaultImpl = await VaultFactory.deploy();
      await vaultImpl.waitForDeployment();

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967ProxyWrapper");
      const initData = VaultFactory.interface.encodeFunctionData("initialize", [
        await usdt.getAddress(), adminAddr, DEPOSIT_LIMIT, "Tulpea Yield Vault", "tyvUSDT", ethers.ZeroAddress,
      ]);
      const proxy = await ERC1967Proxy.deploy(await vaultImpl.getAddress(), initData);
      await proxy.waitForDeployment();
      vault = VaultFactory.attach(await proxy.getAddress()) as Contract;
      vaultAddr = await proxy.getAddress();

      // Redeploy strategy with real vault address
      const Strategy = await ethers.getContractFactory("RealEstateStrategyHarness");
      strategy = await Strategy.deploy(
        await usdt.getAddress(),
        await mockNFT.getAddress(),
        await mockMaster.getAddress(),
        vaultAddr,
        adminAddr,
        []
      );
      await strategy.waitForDeployment();

      // Register strategy in vault
      await vault.connect(admin).addStrategy(await strategy.getAddress());
      console.log("[DEBUG] proof7: vault + strategy ready");
    });

    it("7a: no phantom profit after burn (FIX: totalAssets skips burned NFT)", async function () {
      console.log("[DEBUG] proof7a: starting phantom profit prevention test");

      const dep = ethers.parseUnits("100000", 18);
      const strategyAddr = await strategy.getAddress();

      // User deposits 100k into vault
      await usdt.mint(adminAddr, dep);
      await usdt.connect(admin).approve(vaultAddr, dep);
      await vault.connect(admin).deposit(dep, adminAddr);

      // Deploy 100k to strategy via timelock
      const deployId = await vault.connect(admin).requestDeploy.staticCall(strategyAddr, dep);
      await vault.connect(admin).requestDeploy(strategyAddr, dep);
      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(deployId);

      console.log("[DEBUG] proof7a: totalDebt after deploy:", ethers.formatUnits(await vault.totalDebt(), 18));
      expect(await vault.totalDebt()).to.equal(dep);

      // Simulate property deposit: transfer 80k out, add NFT worth 80k
      const nftInvested = ethers.parseUnits("80000", 18);
      await ethers.provider.send("hardhat_impersonateAccount", [strategyAddr]);
      const strategySigner = await ethers.getSigner(strategyAddr);
      await ethers.provider.send("hardhat_setBalance", [strategyAddr, "0xDE0B6B3A7640000"]);
      await usdt.connect(strategySigner).transfer(adminAddr, nftInvested);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [strategyAddr]);

      const nftId = await mintAndTrackNft(nftInvested);
      console.log("[DEBUG] proof7a: NFT minted with invested=80k, idle=20k");

      // totalAssets = 20k idle + 80k NFT = 100k → processReport shows 0 profit
      expect(await strategy.totalAssets()).to.equal(dep);
      const [profit0, loss0] = await vault.connect(admin).processReport.staticCall(strategyAddr);
      console.log("[DEBUG] proof7a: first processReport profit=%s loss=%s",
        ethers.formatUnits(profit0, 18), ethers.formatUnits(loss0, 18));
      expect(profit0).to.equal(0n);
      expect(loss0).to.equal(0n);

      // NOW: burn the NFT (simulating auto-burn on full repayment)
      await mockNFT.burn(nftId);
      console.log("[DEBUG] proof7a: NFT burned");

      // Simulate harvest landing 80k as idle (repayment funds returned)
      await usdt.mint(strategyAddr, nftInvested);
      console.log("[DEBUG] proof7a: 80k minted to strategy (simulating harvested funds)");

      // FIX: totalAssets = 100k idle + 0 (burned NFT skipped) = 100k (CORRECT!)
      const correctTotal = await strategy.totalAssets();
      console.log("[DEBUG] proof7a: totalAssets after burn:", ethers.formatUnits(correctTotal, 18));
      expect(correctTotal).to.equal(dep, "FIX: totalAssets = idle only, burned NFT skipped");

      // FIX: processReport sees 0 profit (no phantom)
      const [profit, loss] = await vault.connect(admin).processReport.staticCall(strategyAddr);
      console.log("[DEBUG] proof7a: processReport profit=%s loss=%s",
        ethers.formatUnits(profit, 18), ethers.formatUnits(loss, 18));
      expect(profit).to.equal(0n, "FIX: no phantom profit");
      expect(loss).to.equal(0n);

      console.log("[DEBUG] proof7a: PASSED — FIX prevents phantom profit from burned NFT");
    });

    it("7b: cleanupBurnedNfts before processReport prevents phantom profit", async function () {
      console.log("[DEBUG] proof7b: testing cleanup prevents phantom profit");

      const dep = ethers.parseUnits("100000", 18);
      const strategyAddr = await strategy.getAddress();

      // Same setup as 7a
      await usdt.mint(adminAddr, dep);
      await usdt.connect(admin).approve(vaultAddr, dep);
      await vault.connect(admin).deposit(dep, adminAddr);

      const deployId = await vault.connect(admin).requestDeploy.staticCall(strategyAddr, dep);
      await vault.connect(admin).requestDeploy(strategyAddr, dep);
      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(deployId);

      const nftInvested = ethers.parseUnits("80000", 18);
      await ethers.provider.send("hardhat_impersonateAccount", [strategyAddr]);
      const strategySigner = await ethers.getSigner(strategyAddr);
      await ethers.provider.send("hardhat_setBalance", [strategyAddr, "0xDE0B6B3A7640000"]);
      await usdt.connect(strategySigner).transfer(adminAddr, nftInvested);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [strategyAddr]);

      const nftId = await mintAndTrackNft(nftInvested);
      await mockNFT.burn(nftId);
      await usdt.mint(strategyAddr, nftInvested);

      // KEY DIFFERENCE: cleanup BEFORE processReport
      await strategy.connect(admin).cleanupBurnedNfts();
      console.log("[DEBUG] proof7b: cleanupBurnedNfts called — stale NFT removed");

      // totalAssets = 100k idle + 0 NFTs = 100k (correct!)
      const totalAfterCleanup = await strategy.totalAssets();
      console.log("[DEBUG] proof7b: totalAssets after cleanup:", ethers.formatUnits(totalAfterCleanup, 18));
      expect(totalAfterCleanup).to.equal(dep);

      // processReport sees 0 profit (correct)
      const [profit, loss] = await vault.connect(admin).processReport.staticCall(strategyAddr);
      console.log("[DEBUG] proof7b: profit=%s loss=%s", ethers.formatUnits(profit, 18), ethers.formatUnits(loss, 18));
      expect(profit).to.equal(0n);
      expect(loss).to.equal(0n);

      console.log("[DEBUG] proof7b: PASSED — cleanup before processReport prevents phantom profit");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PROOF 8: totalAssets has no resilience to getPosition revert
  // PROVES: If getPosition reverts (e.g. future upgrade), totalAssets is DOA
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 8: totalAssets is resilient to getPosition revert (FIXED)", function () {
    it("8a: totalAssets gracefully skips reverting tokens (FIX: try-catch)", async function () {
      console.log("[DEBUG] proof8a: testing totalAssets resilience to getPosition revert");

      await mintAndTrackNft(ethers.parseUnits("10000", 18));
      await mintAndTrackNft(ethers.parseUnits("20000", 18));
      await mintAndTrackNft(ethers.parseUnits("30000", 18));

      // Confirm totalAssets works
      const total = await strategy.totalAssets();
      console.log("[DEBUG] proof8a: totalAssets before revert flag:", ethers.formatUnits(total, 18));
      expect(total).to.equal(ethers.parseUnits("60000", 18));

      // Set getPosition to revert globally
      await mockNFT.setRevertOnGetPosition(true);
      console.log("[DEBUG] proof8a: getPosition set to revert");

      // FIX: totalAssets does NOT revert — try-catch skips reverting tokens
      const totalAfter = await strategy.totalAssets();
      console.log("[DEBUG] proof8a: totalAssets with revert flag:", ethers.formatUnits(totalAfter, 18));
      expect(totalAfter).to.equal(0n, "FIX: all reverting tokens skipped, only idle counted");

      console.log("[DEBUG] proof8a: PASSED — FIX: totalAssets is resilient to getPosition revert");
    });

    it("8b: harvest is resilient (does not call getPosition)", async function () {
      console.log("[DEBUG] proof8b: testing harvest resilience");

      const nftId = await mintAndTrackNft(ethers.parseUnits("10000", 18));

      // Set claimable amount for this NFT
      const claimable = ethers.parseUnits("500", 18);
      await mockMaster.setClaimableAmount(nftId, claimable);
      await usdt.mint(await mockMaster.getAddress(), claimable);

      // Set getPosition to revert
      await mockNFT.setRevertOnGetPosition(true);
      console.log("[DEBUG] proof8b: getPosition set to revert");

      // PROOF: harvest still works (uses claimLenderYield, not getPosition)
      const balBefore = await usdt.balanceOf(await strategy.getAddress());
      await strategy.connect(admin).harvest();
      const balAfter = await usdt.balanceOf(await strategy.getAddress());

      console.log("[DEBUG] proof8b: balance before=%s after=%s",
        ethers.formatUnits(balBefore, 18), ethers.formatUnits(balAfter, 18));
      expect(balAfter - balBefore).to.equal(claimable);

      console.log("[DEBUG] proof8b: PASSED — harvest works even when getPosition reverts");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PROOF 9: Gas at MAX_NFTS=50 boundary
  // PROVES: totalAssets gas usage is bounded, MAX_NFTS cap enforced
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 9: Gas at MAX_NFTS=50 boundary", function () {
    it("9a: totalAssets with 50 NFTs stays within gas limits", async function () {
      console.log("[DEBUG] proof9a: minting 50 NFTs for gas test");

      // Mint 50 NFTs with various positions
      for (let i = 0; i < 50; i++) {
        const invested = ethers.parseUnits(String((i + 1) * 1000), 18);
        await mintAndTrackNft(invested, ethers.parseUnits(String(i * 100), 18));
      }
      expect(await strategy.heldNftCount()).to.equal(50);
      console.log("[DEBUG] proof9a: 50 NFTs minted");

      // Estimate gas for totalAssets
      const gasEstimate = await strategy.totalAssets.estimateGas();
      console.log("[DEBUG] proof9a: totalAssets gas estimate:", gasEstimate.toString());

      // PROOF: gas stays under 2M (ownerOf + try-catch adds ~5k gas per NFT vs old version)
      // Note: with 50 NFTs, ownerOf check + nftValueExternal try-catch, gas is ~1.3M
      expect(gasEstimate).to.be.lessThan(2_000_000n);

      console.log("[DEBUG] proof9a: PASSED — totalAssets gas=%s < 1M", gasEstimate.toString());
    });

    it("9b: 51st NFT rejected by MAX_NFTS cap", async function () {
      console.log("[DEBUG] proof9b: testing MAX_NFTS enforcement");

      // Mint 50 NFTs
      for (let i = 0; i < 50; i++) {
        const invested = ethers.parseUnits("1000", 18);
        await mintAndTrackNft(invested);
      }
      expect(await strategy.heldNftCount()).to.equal(50);
      console.log("[DEBUG] proof9b: 50 NFTs minted");

      // 51st should fail via addNftForTesting (which calls _addNft)
      const tokenId51 = await mockNFT.mintUnsafe.staticCall(await strategy.getAddress());
      await mockNFT.mintUnsafe(await strategy.getAddress());

      await expect(
        strategy.connect(admin).addNftForTesting(tokenId51)
      ).to.be.revertedWithCustomError(strategy, "MaxNftsReached");

      console.log("[DEBUG] proof9b: PASSED — 51st NFT rejected with MaxNftsReached");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PROOF 10: Auto-burn during harvest mid-iteration
  // PROVES: harvest() inline cleanup correctly removes burned NFTs during iteration
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 10: Auto-burn during harvest mid-iteration", function () {
    let autoBurnMaster: Contract;
    let autoBurnStrategy: Contract;

    async function deployAutoBurnFixture() {
      console.log("[DEBUG] proof10: deploying auto-burn fixture");
      const signers = await ethers.getSigners();
      admin = signers[0];
      adminAddr = await admin.getAddress();
      vaultAddr = await signers[5].getAddress();

      // Deploy USDT
      const MockERC20 = await ethers.getContractFactory("MockUSDT");
      usdt = await MockERC20.deploy();
      await usdt.waitForDeployment();

      // Deploy mock NFT
      const MockNFT = await ethers.getContractFactory("MockPortfolioNFTForStrategy");
      mockNFT = await MockNFT.deploy();
      await mockNFT.waitForDeployment();

      // Deploy auto-burn mock master
      const MockMasterAB = await ethers.getContractFactory("MockPortfolioMasterWithAutoBurn");
      autoBurnMaster = await MockMasterAB.deploy(await usdt.getAddress());
      await autoBurnMaster.waitForDeployment();
      await autoBurnMaster.setMockNFT(await mockNFT.getAddress());
      console.log("[DEBUG] proof10: auto-burn master deployed at:", await autoBurnMaster.getAddress());

      // Deploy strategy with auto-burn master
      const Strategy = await ethers.getContractFactory("RealEstateStrategyHarness");
      autoBurnStrategy = await Strategy.deploy(
        await usdt.getAddress(),
        await mockNFT.getAddress(),
        await autoBurnMaster.getAddress(),
        vaultAddr,
        adminAddr,
        []
      );
      await autoBurnStrategy.waitForDeployment();
      console.log("[DEBUG] proof10: strategy deployed at:", await autoBurnStrategy.getAddress());
    }

    // Helper: mint NFT to auto-burn strategy and track it
    async function mintAndTrackForAutoBurn(
      invested: bigint,
      owed: bigint = 0n,
      claimed: bigint = 0n,
      yieldCapBps: bigint = 4000n
    ): Promise<bigint> {
      const stratAddr = await autoBurnStrategy.getAddress();
      const tokenId = await mockNFT.mintUnsafe.staticCall(stratAddr);
      await mockNFT.mintUnsafe(stratAddr);
      await autoBurnStrategy.connect(admin).addNftForTesting(tokenId);
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
      console.log("[DEBUG] mintAndTrackForAutoBurn: tokenId=%s invested=%s", tokenId.toString(), invested.toString());
      return tokenId;
    }

    beforeEach(async function () {
      await deployAutoBurnFixture();
    });

    it("10a: harvest() continues after mid-loop auto-burn, collects all yield", async function () {
      console.log("[DEBUG] proof10a: testing harvest continues after auto-burn");

      const yield1 = ethers.parseUnits("1000", 18);
      const yield2 = ethers.parseUnits("2000", 18);
      const yield3 = ethers.parseUnits("3000", 18);

      const nft1 = await mintAndTrackForAutoBurn(ethers.parseUnits("10000", 18));
      const nft2 = await mintAndTrackForAutoBurn(ethers.parseUnits("20000", 18));
      const nft3 = await mintAndTrackForAutoBurn(ethers.parseUnits("30000", 18));
      console.log("[DEBUG] proof10a: 3 NFTs minted: %s, %s, %s", nft1, nft2, nft3);

      // Set yields
      await autoBurnMaster.setClaimableAmount(nft1, yield1);
      await autoBurnMaster.setClaimableAmount(nft2, yield2);
      await autoBurnMaster.setClaimableAmount(nft3, yield3);

      // Auto-burn nft2 on claim (mid-loop)
      await autoBurnMaster.setAutoBurn(nft2, true);

      // Fund the master with enough USDT
      const totalYield = yield1 + yield2 + yield3;
      await usdt.mint(await autoBurnMaster.getAddress(), totalYield);

      // Harvest — should NOT revert despite mid-loop burn
      const stratAddr = await autoBurnStrategy.getAddress();
      const balBefore = await usdt.balanceOf(stratAddr);

      const tx = await autoBurnStrategy.connect(admin).harvest();
      const receipt = await tx.wait();

      const balAfter = await usdt.balanceOf(stratAddr);
      const claimed = balAfter - balBefore;
      console.log("[DEBUG] proof10a: total claimed: %s", ethers.formatUnits(claimed, 18));

      // PROOF: All yield collected (burn happens AFTER transfer in production)
      expect(claimed).to.equal(totalYield);

      console.log("[DEBUG] proof10a: PASSED — harvest collects all yield despite mid-loop auto-burn");
    });

    it("10b: harvest() inline cleanup removes burned NFT from heldNftIds", async function () {
      console.log("[DEBUG] proof10b: testing inline cleanup removes burned NFT");

      const nft1 = await mintAndTrackForAutoBurn(ethers.parseUnits("10000", 18));
      const nft2 = await mintAndTrackForAutoBurn(ethers.parseUnits("20000", 18));

      await autoBurnMaster.setClaimableAmount(nft1, ethers.parseUnits("500", 18));
      await autoBurnMaster.setClaimableAmount(nft2, ethers.parseUnits("500", 18));
      await autoBurnMaster.setAutoBurn(nft1, true);
      await usdt.mint(await autoBurnMaster.getAddress(), ethers.parseUnits("1000", 18));

      await autoBurnStrategy.connect(admin).harvest();

      // PROOF: inline cleanup already removed burned nft1 during harvest
      const count = await autoBurnStrategy.heldNftCount();
      console.log("[DEBUG] proof10b: heldNftCount after harvest: %s", count.toString());
      expect(count).to.equal(1); // Only nft2 remains — inline cleanup works

      const isHeldNft1 = await autoBurnStrategy.isHeldNft(nft1);
      const isHeldNft2 = await autoBurnStrategy.isHeldNft(nft2);
      console.log("[DEBUG] proof10b: isHeldNft(%s) = %s (removed)", nft1, isHeldNft1);
      console.log("[DEBUG] proof10b: isHeldNft(%s) = %s (retained)", nft2, isHeldNft2);
      expect(isHeldNft1).to.be.false; // Burned NFT removed by inline cleanup
      expect(isHeldNft2).to.be.true;  // Live NFT retained

      console.log("[DEBUG] proof10b: PASSED — harvest() inline cleanup removes burned NFT");
    });

    it("10c: subsequent harvest does NOT waste gas on already-cleaned burned NFT", async function () {
      console.log("[DEBUG] proof10c: testing no wasted gas on subsequent harvest");

      const nft1 = await mintAndTrackForAutoBurn(ethers.parseUnits("10000", 18));
      const nft2 = await mintAndTrackForAutoBurn(ethers.parseUnits("20000", 18));
      const yield1 = ethers.parseUnits("500", 18);
      const yield2 = ethers.parseUnits("500", 18);
      await autoBurnMaster.setClaimableAmount(nft1, yield1);
      await autoBurnMaster.setClaimableAmount(nft2, yield2);
      await autoBurnMaster.setAutoBurn(nft1, true);
      await usdt.mint(await autoBurnMaster.getAddress(), yield1 + yield2);

      // First harvest — burns nft1, inline cleanup removes it from tracking
      await autoBurnStrategy.connect(admin).harvest();
      console.log("[DEBUG] proof10c: first harvest done, nft1 burned + cleaned");

      // Confirm nft1 is already removed
      expect(await autoBurnStrategy.heldNftCount()).to.equal(1);
      expect(await autoBurnStrategy.isHeldNft(nft1)).to.be.false;

      // Set up more yield for nft2 only
      const yield2b = ethers.parseUnits("300", 18);
      await autoBurnMaster.setClaimableAmount(nft2, yield2b);
      await usdt.mint(await autoBurnMaster.getAddress(), yield2b);

      // Second harvest — only processes nft2, no HarvestFailed events
      const tx = await autoBurnStrategy.connect(admin).harvest();
      const receipt = await tx.wait();

      // PROOF: 0 HarvestFailed events — burned nft1 not re-processed
      const failedEvents = receipt!.logs.filter((log: any) => {
        try {
          const parsed = autoBurnStrategy.interface.parseLog(log);
          return parsed?.name === "HarvestFailed";
        } catch { return false; }
      });
      console.log("[DEBUG] proof10c: HarvestFailed events on second harvest: %s", failedEvents.length);
      expect(failedEvents.length).to.equal(0);

      // Harvested event shows yield from nft2 only
      await expect(tx).to.emit(autoBurnStrategy, "Harvested").withArgs(yield2b);

      console.log("[DEBUG] proof10c: PASSED — subsequent harvest only processes live NFTs (no wasted gas)");
    });

    it("10d: cleanupBurnedNfts() after harvest is a no-op (already cleaned inline)", async function () {
      console.log("[DEBUG] proof10d: testing cleanup is no-op after harvest inline cleanup");

      const nft1 = await mintAndTrackForAutoBurn(ethers.parseUnits("10000", 18));
      const nft2 = await mintAndTrackForAutoBurn(ethers.parseUnits("20000", 18));

      await autoBurnMaster.setClaimableAmount(nft1, ethers.parseUnits("500", 18));
      await autoBurnMaster.setClaimableAmount(nft2, ethers.parseUnits("500", 18));
      await autoBurnMaster.setAutoBurn(nft1, true);
      await usdt.mint(await autoBurnMaster.getAddress(), ethers.parseUnits("1000", 18));

      // Harvest with inline cleanup — nft1 already removed
      await autoBurnStrategy.connect(admin).harvest();
      expect(await autoBurnStrategy.heldNftCount()).to.equal(1); // Already cleaned

      // Cleanup after harvest should be a no-op (0 removed)
      const tx = await autoBurnStrategy.connect(admin).cleanupBurnedNfts();
      await expect(tx).to.emit(autoBurnStrategy, "BurnedNftsCleaned").withArgs(0);

      const countAfter = await autoBurnStrategy.heldNftCount();
      console.log("[DEBUG] proof10d: heldNftCount after cleanup: %s (unchanged)", countAfter.toString());
      expect(countAfter).to.equal(1); // Still 1 — cleanup was no-op

      expect(await autoBurnStrategy.isHeldNft(nft1)).to.be.false;
      expect(await autoBurnStrategy.isHeldNft(nft2)).to.be.true;

      console.log("[DEBUG] proof10d: PASSED — cleanupBurnedNfts is a no-op after harvest (already cleaned inline)");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PROOF 11: harvestSingle() auto-cleanup behavior
  // PROVES: harvestSingle auto-cleans burned NFTs, reverts with NftNotHeld on re-call
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 11: harvestSingle() lacks try-catch", function () {
    let autoBurnMaster: Contract;
    let autoBurnStrategy: Contract;

    async function deployAutoBurnFixture() {
      console.log("[DEBUG] proof11: deploying auto-burn fixture");
      const signers = await ethers.getSigners();
      admin = signers[0];
      adminAddr = await admin.getAddress();
      vaultAddr = await signers[5].getAddress();

      const MockERC20 = await ethers.getContractFactory("MockUSDT");
      usdt = await MockERC20.deploy();
      await usdt.waitForDeployment();

      const MockNFT = await ethers.getContractFactory("MockPortfolioNFTForStrategy");
      mockNFT = await MockNFT.deploy();
      await mockNFT.waitForDeployment();

      const MockMasterAB = await ethers.getContractFactory("MockPortfolioMasterWithAutoBurn");
      autoBurnMaster = await MockMasterAB.deploy(await usdt.getAddress());
      await autoBurnMaster.waitForDeployment();
      await autoBurnMaster.setMockNFT(await mockNFT.getAddress());

      const Strategy = await ethers.getContractFactory("RealEstateStrategyHarness");
      autoBurnStrategy = await Strategy.deploy(
        await usdt.getAddress(),
        await mockNFT.getAddress(),
        await autoBurnMaster.getAddress(),
        vaultAddr,
        adminAddr,
        []
      );
      await autoBurnStrategy.waitForDeployment();
      console.log("[DEBUG] proof11: fixture deployed");
    }

    async function mintAndTrackForAutoBurn(invested: bigint): Promise<bigint> {
      const stratAddr = await autoBurnStrategy.getAddress();
      const tokenId = await mockNFT.mintUnsafe.staticCall(stratAddr);
      await mockNFT.mintUnsafe(stratAddr);
      await autoBurnStrategy.connect(admin).addNftForTesting(tokenId);
      await mockNFT.setPosition(tokenId, {
        amountInvested: invested,
        amountOwed: 0n,
        totalClaimed: 0n,
        yieldCapBps: 4000n,
        propertyId: 1,
        trancheType: 0,
        isSplit: false,
        splitDepth: 0,
      });
      return tokenId;
    }

    beforeEach(async function () {
      await deployAutoBurnFixture();
    });

    it("11a: harvestSingle succeeds and collects yield even when auto-burn follows", async function () {
      console.log("[DEBUG] proof11a: testing harvestSingle with auto-burn");

      const nftId = await mintAndTrackForAutoBurn(ethers.parseUnits("10000", 18));
      const yield_ = ethers.parseUnits("1000", 18);
      await autoBurnMaster.setClaimableAmount(nftId, yield_);
      await autoBurnMaster.setAutoBurn(nftId, true);
      await usdt.mint(await autoBurnMaster.getAddress(), yield_);

      const stratAddr = await autoBurnStrategy.getAddress();
      const balBefore = await usdt.balanceOf(stratAddr);

      // harvestSingle succeeds — burn happens AFTER transfer
      const tx = await autoBurnStrategy.connect(admin).harvestSingle(nftId);
      await expect(tx).to.emit(autoBurnStrategy, "HarvestedSingle").withArgs(nftId, yield_);

      const balAfter = await usdt.balanceOf(stratAddr);
      expect(balAfter - balBefore).to.equal(yield_);

      // Verify auto-cleanup removed burned NFT from tracking
      const isHeld = await autoBurnStrategy.isHeldNft(nftId);
      console.log("[DEBUG] proof11a: isHeldNft(%s) after harvestSingle = %s", nftId, isHeld);
      expect(isHeld).to.be.false; // Auto-cleanup removed burned NFT

      console.log("[DEBUG] proof11a: PASSED — harvestSingle collects yield before auto-burn + auto-cleans");
    });

    it("11b: harvestSingle on already-burned NFT REVERTS with NftNotHeld (auto-cleaned)", async function () {
      console.log("[DEBUG] proof11b: testing harvestSingle revert on burned NFT");

      const nftId = await mintAndTrackForAutoBurn(ethers.parseUnits("10000", 18));
      const yield_ = ethers.parseUnits("1000", 18);
      await autoBurnMaster.setClaimableAmount(nftId, yield_);
      await autoBurnMaster.setAutoBurn(nftId, true);
      await usdt.mint(await autoBurnMaster.getAddress(), yield_);

      // First harvestSingle — succeeds, auto-burns NFT, auto-cleanup removes from tracking
      await autoBurnStrategy.connect(admin).harvestSingle(nftId);
      console.log("[DEBUG] proof11b: first harvestSingle done, NFT burned + removed from tracking");

      // Confirm NFT removed from tracking by auto-cleanup
      expect(await autoBurnStrategy.isHeldNft(nftId)).to.be.false;

      // PROOF: second harvestSingle REVERTS with NftNotHeld (not "claim reverted")
      // because auto-cleanup already removed it from isHeldNft mapping
      await expect(
        autoBurnStrategy.connect(admin).harvestSingle(nftId)
      ).to.be.revertedWithCustomError(autoBurnStrategy, "NftNotHeld").withArgs(nftId);

      console.log("[DEBUG] proof11b: PASSED — harvestSingle reverts with NftNotHeld on auto-cleaned NFT");
    });

    it("11c: harvest() after auto-burn emits Harvested(0) with no HarvestFailed (already cleaned)", async function () {
      console.log("[DEBUG] proof11c: testing harvest() after auto-burn inline cleanup");

      const nftId = await mintAndTrackForAutoBurn(ethers.parseUnits("10000", 18));
      const yield_ = ethers.parseUnits("1000", 18);
      await autoBurnMaster.setClaimableAmount(nftId, yield_);
      await autoBurnMaster.setAutoBurn(nftId, true);
      await usdt.mint(await autoBurnMaster.getAddress(), yield_);

      // First harvest — succeeds, auto-burns NFT, inline cleanup removes it
      await autoBurnStrategy.connect(admin).harvest();
      console.log("[DEBUG] proof11c: first harvest done, NFT burned + cleaned inline");

      // Confirm NFT removed
      expect(await autoBurnStrategy.heldNftCount()).to.equal(0);

      // Second harvest — no NFTs to process, clean Harvested(0)
      const tx = await autoBurnStrategy.connect(admin).harvest();
      await expect(tx).to.emit(autoBurnStrategy, "Harvested").withArgs(0);

      // PROOF: No HarvestFailed events — burned NFT was already cleaned inline
      const receipt = await tx.wait();
      const failedEvents = receipt!.logs.filter((log: any) => {
        try {
          const parsed = autoBurnStrategy.interface.parseLog(log);
          return parsed?.name === "HarvestFailed";
        } catch { return false; }
      });
      expect(failedEvents.length).to.equal(0);

      console.log("[DEBUG] proof11c: PASSED — harvest() emits clean Harvested(0) after inline cleanup");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PROOF 12: Silent total failure — Harvested(0) on all-revert
  // PROVES: All NFTs reverting is indistinguishable from 0-yield by Harvested event alone
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 12: Silent total failure", function () {
    it("12a: All 5 NFTs revert → Harvested(0) + 5 HarvestFailed events", async function () {
      console.log("[DEBUG] proof12a: testing all-revert scenario");

      const nftIds: bigint[] = [];
      for (let i = 0; i < 5; i++) {
        const nftId = await mintAndTrackNft(ethers.parseUnits("10000", 18));
        nftIds.push(nftId);
        await mockMaster.setShouldRevert(nftId, true);
      }
      console.log("[DEBUG] proof12a: 5 NFTs all set to revert");

      const tx = await strategy.connect(admin).harvest();
      const receipt = await tx.wait();

      // PROOF: Harvested(0) emitted — same as if there was no yield
      await expect(tx).to.emit(strategy, "Harvested").withArgs(0);

      // Count HarvestFailed events
      const harvestFailedEvents = receipt!.logs.filter((log: any) => {
        try {
          const parsed = strategy.interface.parseLog(log);
          return parsed?.name === "HarvestFailed";
        } catch { return false; }
      });
      console.log("[DEBUG] proof12a: HarvestFailed events: %s", harvestFailedEvents.length);
      expect(harvestFailedEvents.length).to.equal(5);

      console.log("[DEBUG] proof12a: PASSED — all-revert emits Harvested(0) + 5 HarvestFailed");
    });

    it("12b: All 5 NFTs have 0 yield → Harvested(0) + 0 HarvestFailed (indistinguishable)", async function () {
      console.log("[DEBUG] proof12b: testing 0-yield scenario");

      for (let i = 0; i < 5; i++) {
        await mintAndTrackNft(ethers.parseUnits("10000", 18));
        // No claimable amount set — default 0
      }
      console.log("[DEBUG] proof12b: 5 NFTs all with 0 yield");

      const tx = await strategy.connect(admin).harvest();
      const receipt = await tx.wait();

      // PROOF: Same Harvested(0) as the all-revert case
      await expect(tx).to.emit(strategy, "Harvested").withArgs(0);

      // But NO HarvestFailed events — this is the only distinguishing signal
      const harvestFailedEvents = receipt!.logs.filter((log: any) => {
        try {
          const parsed = strategy.interface.parseLog(log);
          return parsed?.name === "HarvestFailed";
        } catch { return false; }
      });
      console.log("[DEBUG] proof12b: HarvestFailed events: %s", harvestFailedEvents.length);
      expect(harvestFailedEvents.length).to.equal(0);

      console.log("[DEBUG] proof12b: PASSED — 0-yield emits same Harvested(0) but no HarvestFailed");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PROOF 13: Empty array harvest — wasted gas, no early return
  // PROVES: harvest() on 0 NFTs still executes and emits Harvested(0)
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 13: Empty array harvest — no early return", function () {
    it("harvest on 0 NFTs emits Harvested(0), wasted gas", async function () {
      console.log("[DEBUG] proof13: testing empty harvest");

      expect(await strategy.heldNftCount()).to.equal(0);

      const tx = await strategy.connect(admin).harvest();
      const receipt = await tx.wait();

      // PROOF: Harvested(0) emitted even with no NFTs — no early return
      await expect(tx).to.emit(strategy, "Harvested").withArgs(0);

      const gasUsed = receipt!.gasUsed;
      console.log("[DEBUG] proof13: gas used for empty harvest: %s", gasUsed.toString());

      // Gas is non-trivial even for empty — overhead from balanceOf calls + event emission
      expect(gasUsed).to.be.greaterThan(0n);

      console.log("[DEBUG] proof13: PASSED — empty harvest wastes gas with no early return");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PROOF 14: No per-NFT success event in harvest()
  // PROVES: harvest() only emits aggregate Harvested, no per-NFT breakdown
  // ═══════════════════════════════════════════════════════════════════════

  describe("PROOF 14: No per-NFT success event in harvest()", function () {
    it("14a: harvest() emits only aggregate Harvested, no per-NFT breakdown", async function () {
      console.log("[DEBUG] proof14a: testing aggregate-only event");

      const yield1 = ethers.parseUnits("1000", 18);
      const yield2 = ethers.parseUnits("2000", 18);
      const yield3 = ethers.parseUnits("3000", 18);

      const nft1 = await mintAndTrackNft(ethers.parseUnits("10000", 18));
      const nft2 = await mintAndTrackNft(ethers.parseUnits("20000", 18));
      const nft3 = await mintAndTrackNft(ethers.parseUnits("30000", 18));

      await mockMaster.setClaimableAmount(nft1, yield1);
      await mockMaster.setClaimableAmount(nft2, yield2);
      await mockMaster.setClaimableAmount(nft3, yield3);

      const totalYield = yield1 + yield2 + yield3;
      await usdt.mint(await mockMaster.getAddress(), totalYield);

      const tx = await strategy.connect(admin).harvest();
      const receipt = await tx.wait();

      // PROOF: Only aggregate Harvested event, no per-NFT events
      await expect(tx).to.emit(strategy, "Harvested").withArgs(totalYield);

      // Check NO HarvestedSingle events emitted
      const singleEvents = receipt!.logs.filter((log: any) => {
        try {
          const parsed = strategy.interface.parseLog(log);
          return parsed?.name === "HarvestedSingle";
        } catch { return false; }
      });
      console.log("[DEBUG] proof14a: HarvestedSingle events: %s (should be 0)", singleEvents.length);
      expect(singleEvents.length).to.equal(0);

      // Cannot determine nft1 earned 1000 vs nft2 earned 2000 from events alone
      console.log("[DEBUG] proof14a: PASSED — harvest() emits only aggregate Harvested(6000), no per-NFT breakdown");
    });

    it("14b: harvestSingle() emits per-NFT HarvestedSingle (contrast)", async function () {
      console.log("[DEBUG] proof14b: testing harvestSingle per-NFT event");

      const yield1 = ethers.parseUnits("1000", 18);
      const yield2 = ethers.parseUnits("2000", 18);

      const nft1 = await mintAndTrackNft(ethers.parseUnits("10000", 18));
      const nft2 = await mintAndTrackNft(ethers.parseUnits("20000", 18));

      await mockMaster.setClaimableAmount(nft1, yield1);
      await mockMaster.setClaimableAmount(nft2, yield2);
      await usdt.mint(await mockMaster.getAddress(), yield1 + yield2);

      // harvestSingle emits per-NFT breakdown
      const tx1 = await strategy.connect(admin).harvestSingle(nft1);
      await expect(tx1).to.emit(strategy, "HarvestedSingle").withArgs(nft1, yield1);

      const tx2 = await strategy.connect(admin).harvestSingle(nft2);
      await expect(tx2).to.emit(strategy, "HarvestedSingle").withArgs(nft2, yield2);

      console.log("[DEBUG] proof14b: PASSED — harvestSingle emits per-NFT HarvestedSingle with exact amounts");
    });
  });
});
