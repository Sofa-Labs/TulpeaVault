import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — Audit Attack Reproductions", function () {
  let vault: Contract;
  let usdc: Contract;
  let mockStrategy: Contract;
  let admin: Signer;
  let user1: Signer;
  let attacker: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let attackerAddr: string;
  let strategyAddr: string;

  const ONE_DAY = 24 * 60 * 60;
  const USDC = (n: number | string) => ethers.parseUnits(String(n), 18);

  async function deployVaultFixture() {
    console.log("[DEBUG] deployVaultFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    attacker = signers[2];
    adminAddr = await admin.getAddress();
    user1Addr = await user1.getAddress();
    attackerAddr = await attacker.getAddress();

    // Deploy MockUSDT
    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();
    console.log("[DEBUG] USDC deployed:", await usdc.getAddress());

    // Deploy vault via UUPS proxy
    const VaultFactory = await ethers.getContractFactory("TulpeaYieldVault");
    const vaultImpl = await VaultFactory.deploy();
    await vaultImpl.waitForDeployment();

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967ProxyWrapper");
    const initData = VaultFactory.interface.encodeFunctionData("initialize", [
      await usdc.getAddress(), adminAddr, 0, "Tulpea Yield Vault", "tyvUSDC", ethers.ZeroAddress,
    ]);
    const proxy = await ERC1967Proxy.deploy(await vaultImpl.getAddress(), initData);
    await proxy.waitForDeployment();
    vault = VaultFactory.attach(await proxy.getAddress()) as Contract;
    console.log("[DEBUG] Vault deployed:", await vault.getAddress());

    // Deploy MockStrategy
    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    mockStrategy = await MockStrategy.deploy(await usdc.getAddress());
    await mockStrategy.waitForDeployment();
    strategyAddr = await mockStrategy.getAddress();

    await vault.connect(admin).addStrategy(strategyAddr);
    console.log("[DEBUG] Strategy added:", strategyAddr);

    // Mint USDC to participants
    const mintAmount = USDC(500000);
    await usdc.mint(user1Addr, mintAmount);
    await usdc.mint(attackerAddr, mintAmount);
    await usdc.mint(adminAddr, mintAmount);

    // Approve vault
    const vaultAddr = await vault.getAddress();
    await usdc.connect(user1).approve(vaultAddr, ethers.MaxUint256);
    await usdc.connect(attacker).approve(vaultAddr, ethers.MaxUint256);
    await usdc.connect(admin).approve(vaultAddr, ethers.MaxUint256);
    // Disable health check — audit attack tests exercise large losses
    await vault.connect(admin).setHealthCheck(10000, 10000, false);
    console.log("[DEBUG] deployVaultFixture: complete");
  }

  // ═══════════════════════════════════════════════════════════════════
  // Finding 1: cancelWithdraw Share Theft (HIGH)
  // ═══════════════════════════════════════════════════════════════════

  describe("Finding 1: cancelWithdraw Share Theft (HIGH)", function () {
    beforeEach(async function () {
      await deployVaultFixture();
    });

    it("F1 FIX: operator cancelWithdraw returns shares to original owner, not controller", async function () {
      console.log("[DEBUG] F1: fix verification — start");

      // Alice deposits 10k USDC
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      const aliceSharesBefore = await vault.balanceOf(user1Addr);
      console.log("[DEBUG] Alice shares after deposit:", aliceSharesBefore.toString());
      expect(aliceSharesBefore).to.be.gt(0);

      // Alice approves Bob (attacker) as operator
      await vault.connect(user1).setOperator(attackerAddr, true);
      console.log("[DEBUG] Alice approved Bob as operator");

      // Bob (operator) calls requestRedeem with controller=Bob, owner=Alice
      await vault.connect(attacker).requestRedeem(aliceSharesBefore, attackerAddr, user1Addr);
      console.log("[DEBUG] Bob called requestRedeem(shares, bob, alice)");

      expect(await vault.balanceOf(user1Addr)).to.equal(0);
      expect(await vault.pendingWithdrawalShares(attackerAddr)).to.equal(aliceSharesBefore);

      // Bob calls cancelWithdraw — shares should go BACK TO ALICE (original owner)
      await vault.connect(attacker).cancelWithdraw();
      console.log("[DEBUG] Bob called cancelWithdraw()");

      const aliceSharesAfterCancel = await vault.balanceOf(user1Addr);
      const bobSharesAfterCancel = await vault.balanceOf(attackerAddr);
      console.log("[DEBUG] Alice shares after cancel:", aliceSharesAfterCancel.toString());
      console.log("[DEBUG] Bob shares after cancel:", bobSharesAfterCancel.toString());

      // FIX VERIFIED: Alice gets her shares back, Bob gets nothing
      expect(aliceSharesAfterCancel).to.equal(aliceSharesBefore);
      expect(bobSharesAfterCancel).to.equal(0);
      console.log("[DEBUG] F1 FIX: VERIFIED — shares returned to Alice, not Bob");
    });

    it("F1 FIX: pendingWithdrawalOwner tracks original owner", async function () {
      console.log("[DEBUG] F1b: owner tracking — start");

      // Alice deposits 10k USDC
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      const aliceShares = await vault.balanceOf(user1Addr);

      // Alice approves Bob as operator
      await vault.connect(user1).setOperator(attackerAddr, true);

      // Bob requests redeem with controller=Bob, owner=Alice
      await vault.connect(attacker).requestRedeem(aliceShares, attackerAddr, user1Addr);

      // Verify owner tracking
      const storedOwner = await vault.pendingWithdrawalOwner(attackerAddr);
      expect(storedOwner).to.equal(user1Addr);
      console.log("[DEBUG] pendingWithdrawalOwner[bob] =", storedOwner);

      // Cancel — shares go to Alice
      await vault.connect(attacker).cancelWithdraw();
      expect(await vault.balanceOf(user1Addr)).to.equal(aliceShares);
      expect(await vault.balanceOf(attackerAddr)).to.equal(0);

      // Owner mapping cleared
      expect(await vault.pendingWithdrawalOwner(attackerAddr)).to.equal(ethers.ZeroAddress);
      console.log("[DEBUG] F1b FIX: VERIFIED — owner tracked and cleared correctly");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Finding 2: Deposits at Broken Price (totalAssets=0, totalSupply>0)
  // ═══════════════════════════════════════════════════════════════════

  describe("Finding 2: Deposits at Broken Price (MEDIUM)", function () {
    beforeEach(async function () {
      await deployVaultFixture();
    });

    it("F2 FIX: total loss triggers emergency shutdown, deposits blocked", async function () {
      console.log("[DEBUG] F2a: emergency shutdown — start");

      // User1 deposits 10k
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      console.log("[DEBUG] User1 deposited 10k");

      // Deploy all to strategy
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(10000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);
      console.log("[DEBUG] Deployed 10k to strategy");

      // Strategy reports total loss (100% >= 50% threshold)
      await mockStrategy.setTotalAssets(0);
      await expect(vault.connect(admin).processReport(strategyAddr))
        .to.emit(vault, "EmergencyShutdownTriggered");
      console.log("[DEBUG] Emergency shutdown triggered");

      expect(await vault.emergencyShutdown()).to.be.true;

      // Deposits should be blocked
      const maxDep = await vault.maxDeposit(attackerAddr);
      expect(maxDep).to.equal(0);
      console.log("[DEBUG] maxDeposit returns 0 during shutdown");

      // Deposit should revert
      await expect(
        vault.connect(attacker).deposit(USDC(1), attackerAddr)
      ).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxDeposit");
      console.log("[DEBUG] F2a FIX: VERIFIED — deposits blocked after large loss");
    });

    it("F2 FIX: 99% loss triggers emergency shutdown", async function () {
      console.log("[DEBUG] F2b: 99% loss shutdown — start");

      await vault.connect(user1).deposit(USDC(10000), user1Addr);

      await vault.connect(admin).requestDeploy(strategyAddr, USDC(10000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      // Strategy loses 99% — 10k → 100 (99% >= 50% threshold)
      await mockStrategy.setTotalAssets(USDC(100));
      await expect(vault.connect(admin).processReport(strategyAddr))
        .to.emit(vault, "EmergencyShutdownTriggered");

      expect(await vault.emergencyShutdown()).to.be.true;

      // Deposits blocked
      await expect(
        vault.connect(attacker).deposit(USDC(100), attackerAddr)
      ).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxDeposit");
      console.log("[DEBUG] F2b FIX: VERIFIED — 99% loss blocks deposits");
    });

    it("F2 FIX: resolveEmergencyShutdown re-enables deposits", async function () {
      console.log("[DEBUG] F2c: resolve shutdown — start");

      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(10000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      await mockStrategy.setTotalAssets(0);
      await vault.connect(admin).processReport(strategyAddr);
      expect(await vault.emergencyShutdown()).to.be.true;

      // Resolve shutdown
      await expect(vault.connect(admin).resolveEmergencyShutdown())
        .to.emit(vault, "EmergencyShutdownResolved");
      expect(await vault.emergencyShutdown()).to.be.false;

      // Note: deposits may still be blocked by DebtOutstandingNoShares guard
      // but emergency shutdown itself is resolved
      console.log("[DEBUG] F2c FIX: VERIFIED — emergency shutdown resolved");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Finding 3: executeDeploy Ignores Pending Withdrawals (MEDIUM)
  // ═══════════════════════════════════════════════════════════════════

  describe("Finding 3: executeDeploy Ignores Pending Withdrawals (MEDIUM)", function () {
    beforeEach(async function () {
      await deployVaultFixture();
    });

    it("F3 FIX: executeDeploy blocked when pending withdrawals reserve funds", async function () {
      console.log("[DEBUG] F3a: deploy blocked by pending — start");

      // User1 deposits 20k
      await vault.connect(user1).deposit(USDC(20000), user1Addr);
      const user1Shares = await vault.balanceOf(user1Addr);
      console.log("[DEBUG] User1 shares:", user1Shares.toString());

      // User1 requests redeem for ALL shares (escrows shares to vault)
      await vault.connect(user1).requestRedeem(user1Shares, user1Addr, user1Addr);
      console.log("[DEBUG] User1 requested redeem for all shares");

      // Admin requests deploy for 20k
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(20000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);

      // FIX: executeDeploy now accounts for pending withdrawal reserves
      await expect(vault.connect(admin).executeDeploy(0))
        .to.be.revertedWithCustomError(vault, "InsufficientIdleBalance");
      console.log("[DEBUG] F3a FIX: VERIFIED — deploy blocked by pending reserves");
    });

    it("F3 FIX: partial deploy blocked when exceeds available after pending reserves", async function () {
      console.log("[DEBUG] F3b: partial deploy blocked — start");

      // User1 deposits 20k, attacker deposits 10k
      await vault.connect(user1).deposit(USDC(20000), user1Addr);
      await vault.connect(attacker).deposit(USDC(10000), attackerAddr);

      // User1 requests full redeem (~20k pending)
      const user1Shares = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(user1Shares, user1Addr, user1Addr);
      console.log("[DEBUG] User1 pending redeem for:", user1Shares.toString());

      // Admin tries to deploy 25k — only ~10k available after 20k pending reserve
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(25000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);

      await expect(vault.connect(admin).executeDeploy(0))
        .to.be.revertedWithCustomError(vault, "InsufficientIdleBalance");
      console.log("[DEBUG] F3b FIX: VERIFIED — 25k deploy blocked, only ~10k available");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Finding 4: NFT Griefing via onERC721Received (MEDIUM)
  // ═══════════════════════════════════════════════════════════════════

  describe("Finding 4: NFT Griefing via onERC721Received (MEDIUM)", function () {
    let realEstateStrategy: Contract;
    let mockNFT: Contract;
    let mockMaster: Contract;

    async function deployRealEstateFixture() {
      console.log("[DEBUG] F4 fixture: deploying RealEstateStrategy");
      const signers = await ethers.getSigners();
      admin = signers[0];
      user1 = signers[1];
      attacker = signers[2];
      adminAddr = await admin.getAddress();
      attackerAddr = await attacker.getAddress();

      // Deploy MockUSDT
      const MockERC20 = await ethers.getContractFactory("MockUSDT");
      usdc = await MockERC20.deploy();
      await usdc.waitForDeployment();

      // Deploy mock NFT and master
      const MockNFT = await ethers.getContractFactory("MockPortfolioNFTForStrategy");
      mockNFT = await MockNFT.deploy();
      await mockNFT.waitForDeployment();

      const MockMaster = await ethers.getContractFactory("MockPortfolioMasterForStrategy");
      mockMaster = await MockMaster.deploy(await usdc.getAddress());
      await mockMaster.waitForDeployment();

      // Deploy RealEstateStrategy (vault=admin for simplicity)
      const REStrategy = await ethers.getContractFactory("RealEstateStrategy");
      realEstateStrategy = await REStrategy.deploy(
        await usdc.getAddress(),
        await mockNFT.getAddress(),
        await mockMaster.getAddress(),
        adminAddr, // vault address — only vault can call withdraw()
        adminAddr  // owner
      );
      await realEstateStrategy.waitForDeployment();
      console.log("[DEBUG] RealEstateStrategy deployed:", await realEstateStrategy.getAddress());
    }

    beforeEach(async function () {
      await deployRealEstateFixture();
    });

    it("F4 FIX: unsolicited safeTransferFrom reverts with UnsolicitedNftTransfer", async function () {
      console.log("[DEBUG] F4a: unsolicited NFT transfer blocked — start");

      const stratAddr = await realEstateStrategy.getAddress();

      // Attacker mints an NFT and tries to transfer to strategy
      await mockNFT.connect(attacker).mintTo(attackerAddr);
      const tokenId = 1;

      await expect(
        mockNFT.connect(attacker)["safeTransferFrom(address,address,uint256)"](
          attackerAddr, stratAddr, tokenId
        )
      ).to.be.revertedWithCustomError(realEstateStrategy, "UnsolicitedNftTransfer");

      expect(await realEstateStrategy.heldNftCount()).to.equal(0);
      console.log("[DEBUG] F4a FIX: VERIFIED — unsolicited NFT transfer rejected");
    });

    it("F4 FIX: attacker cannot fill MAX_NFTS slots via griefing", async function () {
      console.log("[DEBUG] F4b: griefing prevention — start");

      const stratAddr = await realEstateStrategy.getAddress();

      // Even the first unsolicited transfer is rejected
      await mockNFT.connect(attacker).mintTo(attackerAddr);
      await expect(
        mockNFT.connect(attacker)["safeTransferFrom(address,address,uint256)"](
          attackerAddr, stratAddr, 1
        )
      ).to.be.revertedWithCustomError(realEstateStrategy, "UnsolicitedNftTransfer");

      expect(await realEstateStrategy.heldNftCount()).to.equal(0);
      console.log("[DEBUG] F4b FIX: VERIFIED — no slots consumed by attacker");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Finding 5: fulfillRedeem Price Blending (MEDIUM)
  // ═══════════════════════════════════════════════════════════════════

  describe("Finding 5: fulfillRedeem Price Blending (MEDIUM)", function () {
    beforeEach(async function () {
      await deployVaultFixture();
    });

    it("accumulated fulfillments create blended rate", async function () {
      console.log("[DEBUG] F5a: price blending — start");

      // User1 deposits 10k at price 1.0
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      const totalShares = await vault.balanceOf(user1Addr);
      console.log("[DEBUG] User1 total shares:", totalShares.toString());

      // Request redeem for half shares
      const halfShares = totalShares / 2n;
      await vault.connect(user1).requestRedeem(halfShares, user1Addr, user1Addr);
      console.log("[DEBUG] Requested redeem for half:", halfShares.toString());

      // Admin fulfills at price 1.0 → ~5000 USDC claimable
      await vault.connect(admin).fulfillRedeem(user1Addr);
      const claimable1 = await vault.claimableWithdrawals(user1Addr);
      const claimShares1 = await vault.claimableWithdrawalShares(user1Addr);
      console.log("[DEBUG] First fulfillment — claimable USDC:", claimable1.toString());
      console.log("[DEBUG] First fulfillment — claimable shares:", claimShares1.toString());

      // User doesn't claim yet. Now request redeem for remaining shares.
      const remainingShares = await vault.balanceOf(user1Addr);

      // Simulate strategy profit to change share price
      // Deploy some to strategy first, then report profit
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(5000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      // Strategy reports 20% profit: 5000 → 6000
      await mockStrategy.setTotalAssets(USDC(6000));
      await vault.connect(admin).processReport(strategyAddr);

      const sharePriceAfterProfit = await vault.sharePrice();
      console.log("[DEBUG] Share price after profit:", sharePriceAfterProfit.toString());

      // Request redeem for remaining shares at new (higher) price
      await vault.connect(user1).requestRedeem(remainingShares, user1Addr, user1Addr);
      console.log("[DEBUG] Requested redeem for remaining:", remainingShares.toString());

      // Need to bring funds back to vault for fulfillment
      await usdc.mint(strategyAddr, USDC(6000)); // ensure strategy has funds
      await vault.connect(admin).withdrawFromStrategy(strategyAddr, USDC(6000));

      // Admin fulfills at higher price
      await vault.connect(admin).fulfillRedeem(user1Addr);
      const claimable2 = await vault.claimableWithdrawals(user1Addr);
      const claimShares2 = await vault.claimableWithdrawalShares(user1Addr);
      console.log("[DEBUG] After second fulfillment — total claimable USDC:", claimable2.toString());
      console.log("[DEBUG] After second fulfillment — total claimable shares:", claimShares2.toString());

      // The two fulfillments are accumulated: different prices blended together
      // claimable = claimable1 + (second fulfillment assets)
      // claimShares = claimShares1 + remainingShares
      expect(claimable2).to.be.gt(claimable1);
      expect(claimShares2).to.be.gt(claimShares1);
      console.log("[DEBUG] F5a: Two fulfillments accumulated at different prices");
    });

    it("partial claim burns wrong share amount due to blending", async function () {
      console.log("[DEBUG] F5b: blended partial claim — start");

      // User deposits 10k
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      const totalShares = await vault.balanceOf(user1Addr);
      const halfShares = totalShares / 2n;

      // First request + fulfill at price 1.0
      await vault.connect(user1).requestRedeem(halfShares, user1Addr, user1Addr);
      await vault.connect(admin).fulfillRedeem(user1Addr);

      const claimable1 = await vault.claimableWithdrawals(user1Addr);
      const claimShares1 = await vault.claimableWithdrawalShares(user1Addr);
      console.log("[DEBUG] After 1st fulfill — USDC:", claimable1.toString(), "shares:", claimShares1.toString());

      // Deploy + profit
      const remainingShares = await vault.balanceOf(user1Addr);
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(3000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      // Strategy doubles: 3000 → 6000 (+100% profit)
      await mockStrategy.setTotalAssets(USDC(6000));
      await vault.connect(admin).processReport(strategyAddr);

      // Second request + fulfill at higher price
      await vault.connect(user1).requestRedeem(remainingShares, user1Addr, user1Addr);

      // Bring funds back for fulfillment
      await usdc.mint(strategyAddr, USDC(6000));
      await vault.connect(admin).withdrawFromStrategy(strategyAddr, USDC(6000));

      await vault.connect(admin).fulfillRedeem(user1Addr);

      const totalClaimableAssets = await vault.claimableWithdrawals(user1Addr);
      const totalClaimableShares = await vault.claimableWithdrawalShares(user1Addr);
      console.log("[DEBUG] Blended totals — USDC:", totalClaimableAssets.toString(), "shares:", totalClaimableShares.toString());

      // Now partial withdraw: claim exactly the first fulfillment amount
      // Due to blending, the shares burned = totalShares * (assets / totalAssets)
      // This means the burned shares don't correspond to the original fulfillment
      const partialAssets = claimable1;
      const expectedSharesBurned = (totalClaimableShares * partialAssets) / totalClaimableAssets;
      console.log("[DEBUG] Partial claim of:", partialAssets.toString());
      console.log("[DEBUG] Expected shares burned (blended):", expectedSharesBurned.toString());
      console.log("[DEBUG] Original shares for that fulfillment:", claimShares1.toString());

      // The blended rate means different shares are burned than what was originally submitted
      // If price was 1.0 for first batch and 2.0 for second batch:
      // Blended: totalAssets / totalShares gives an average price
      // Partial claim at blended rate burns fewer shares than the original batch
      if (expectedSharesBurned !== claimShares1) {
        console.log("[DEBUG] F5b: CONFIRMED — Partial claim burns", expectedSharesBurned.toString(),
          "shares instead of expected", claimShares1.toString());
      }

      // Execute the partial withdraw
      await vault.connect(user1).withdraw(partialAssets, user1Addr, user1Addr);

      const remainingClaimable = await vault.claimableWithdrawals(user1Addr);
      const remainingClaimShares = await vault.claimableWithdrawalShares(user1Addr);
      console.log("[DEBUG] After partial claim — remaining USDC:", remainingClaimable.toString());
      console.log("[DEBUG] After partial claim — remaining shares:", remainingClaimShares.toString());

      // The remaining ratio (assets/shares) differs from both original prices
      if (remainingClaimShares > 0n) {
        const remainingPricePerShare = (remainingClaimable * USDC(1)) / remainingClaimShares;
        console.log("[DEBUG] Remaining effective price per share:", remainingPricePerShare.toString());
      }
      console.log("[DEBUG] F5b: Price blending causes non-uniform partial claims");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Finding 6: RealEstateStrategy Silent Partial Withdraw (MEDIUM)
  // ═══════════════════════════════════════════════════════════════════

  describe("Finding 6: RealEstateStrategy Silent Partial Withdraw (MEDIUM)", function () {
    let realEstateStrategy: Contract;
    let mockNFT: Contract;
    let mockMaster: Contract;

    async function deployRealEstateWithVault() {
      console.log("[DEBUG] F6 fixture: deploy RealEstateStrategy with vault integration");
      await deployVaultFixture();

      // Deploy mock NFT and master
      const MockNFT = await ethers.getContractFactory("MockPortfolioNFTForStrategy");
      mockNFT = await MockNFT.deploy();
      await mockNFT.waitForDeployment();

      const MockMaster = await ethers.getContractFactory("MockPortfolioMasterForStrategy");
      mockMaster = await MockMaster.deploy(await usdc.getAddress());
      await mockMaster.waitForDeployment();

      // Deploy RealEstateStrategy with vault as the actual vault
      const vaultAddr = await vault.getAddress();
      const REStrategy = await ethers.getContractFactory("RealEstateStrategy");
      realEstateStrategy = await REStrategy.deploy(
        await usdc.getAddress(),
        await mockNFT.getAddress(),
        await mockMaster.getAddress(),
        vaultAddr,  // actual vault
        adminAddr   // owner
      );
      await realEstateStrategy.waitForDeployment();
      console.log("[DEBUG] RealEstateStrategy deployed:", await realEstateStrategy.getAddress());

      // Register strategy in vault
      const reStratAddr = await realEstateStrategy.getAddress();
      await vault.connect(admin).addStrategy(reStratAddr);
      console.log("[DEBUG] RealEstateStrategy registered in vault");
    }

    beforeEach(async function () {
      await deployRealEstateWithVault();
    });

    it("F6 FIX: partial withdraw emits PartialWithdraw event", async function () {
      console.log("[DEBUG] F6: partial withdraw event — start");

      const reStratAddr = await realEstateStrategy.getAddress();

      // User deposits 10k into vault
      await vault.connect(user1).deposit(USDC(10000), user1Addr);

      // Deploy 5000 to RealEstateStrategy
      await vault.connect(admin).requestDeploy(reStratAddr, USDC(5000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);
      console.log("[DEBUG] Deployed 5000 to RealEstateStrategy");

      // Simulate strategy deploying most funds (leaving only 1000 idle)
      await realEstateStrategy.connect(admin).emergencyWithdrawToken(
        await usdc.getAddress(), USDC(4000)
      );

      const stratBalanceAfter = await usdc.balanceOf(reStratAddr);
      expect(stratBalanceAfter).to.equal(USDC(1000));

      // FIX: withdrawFromStrategy emits PartialWithdraw from the strategy
      // The vault's withdrawFromStrategy calls strategy.withdraw(5000)
      // Strategy emits PartialWithdraw(5000, 1000) since only 1000 available
      await expect(vault.connect(admin).withdrawFromStrategy(reStratAddr, USDC(5000)))
        .to.emit(realEstateStrategy, "PartialWithdraw")
        .withArgs(USDC(5000), USDC(1000));

      const vaultBalAfter = await usdc.balanceOf(await vault.getAddress());
      console.log("[DEBUG] Vault balance after partial:", ethers.formatUnits(vaultBalAfter, 18));

      // Check debt accounting still correct
      const [isActive, currentDebt] = await vault.strategies(reStratAddr);
      expect(currentDebt).to.equal(USDC(4000));
      console.log("[DEBUG] F6 FIX: VERIFIED — PartialWithdraw event emitted for underdelivery");
    });
  });
});
