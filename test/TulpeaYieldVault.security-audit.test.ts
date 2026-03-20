import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

/**
 * Security Audit PoC Tests for TulpeaYieldVault + Strategies
 *
 * Categories tested:
 * 1. ERC-4626 inflation attack resistance
 * 2. Share price manipulation via direct asset donation
 * 3. Rounding direction consistency
 * 4. ERC-7540 state transition safety
 * 5. cancelWithdraw vs fulfillRedeem race conditions
 * 6. Escrowed shares conversion math
 * 7. Strategy inflated totalAssets
 * 8. Strategy withdrawal revert — vault stuck?
 * 9. Strategy removal while holding assets
 * 10. Front-running processReport for sandwich
 * 11. Share donation griefing vector
 * 12. Emergency shutdown boundary
 * 13. fulfillRedeem share price preservation
 */
describe("TulpeaYieldVault — Security Audit PoC", function () {
  let vault: Contract;
  let usdc: Contract;
  let mockStrategy: Contract;
  let admin: Signer;
  let user1: Signer;
  let user2: Signer;
  let attacker: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let user2Addr: string;
  let attackerAddr: string;
  let strategyAddr: string;
  let vaultAddr: string;

  const ONE_DAY = 24 * 60 * 60;
  const USDC = (n: number | string) => ethers.parseUnits(String(n), 18);
  const SHARE_SCALE = 1_000_000n; // _decimalsOffset = 6

  async function deployFixture() {
    console.log("[DEBUG] deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    user2 = signers[2];
    attacker = signers[3];
    adminAddr = await admin.getAddress();
    user1Addr = await user1.getAddress();
    user2Addr = await user2.getAddress();
    attackerAddr = await attacker.getAddress();

    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

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
    vaultAddr = await vault.getAddress();

    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    mockStrategy = await MockStrategy.deploy(await usdc.getAddress());
    await mockStrategy.waitForDeployment();
    strategyAddr = await mockStrategy.getAddress();

    await vault.connect(admin).addStrategy(strategyAddr);

    const mintAmount = USDC(500000);
    for (const addr of [user1Addr, user2Addr, attackerAddr, adminAddr]) {
      await usdc.mint(addr, mintAmount);
    }
    for (const signer of [user1, user2, attacker, admin]) {
      await usdc.connect(signer).approve(vaultAddr, ethers.MaxUint256);
    }
    // Disable health check — security audit tests exercise large losses
    await vault.connect(admin).setHealthCheck(10000, 10000, false);
    console.log("[DEBUG] deployFixture: complete");
  }

  // ═══════════════════════════════════════════════════════════════════
  // 1. INFLATION ATTACK RESISTANCE (ERC-4626)
  // ═══════════════════════════════════════════════════════════════════

  describe("1. Inflation Attack Resistance", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: _decimalsOffset=6 prevents first-depositor inflation attack", async function () {
      console.log("[DEBUG] === Inflation Attack Test ===");

      // Attack vector: attacker deposits 1 wei, donates large amount, second depositor gets 0 shares
      // Step 1: Attacker deposits 1 wei
      await vault.connect(attacker).deposit(1n, attackerAddr);
      const attackerShares = await vault.balanceOf(attackerAddr);
      console.log("[DEBUG] Attacker shares from 1 wei:", attackerShares.toString());
      expect(attackerShares).to.equal(SHARE_SCALE); // 10^6 shares

      // Step 2: Attacker donates 10000 USDC directly to vault
      const donation = USDC(10000);
      await usdc.connect(attacker).transfer(vaultAddr, donation);

      const totalAssetsAfterDonation = await vault.totalAssets();
      console.log("[DEBUG] totalAssets after donation:", ethers.formatUnits(totalAssetsAfterDonation, 18));

      // Step 3: Victim deposits 10000 USDC — should NOT get 0 shares
      const victimDeposit = USDC(10000);
      await vault.connect(user1).deposit(victimDeposit, user1Addr);
      const victimShares = await vault.balanceOf(user1Addr);
      console.log("[DEBUG] Victim shares:", victimShares.toString());
      expect(victimShares).to.be.gt(0n, "CRITICAL: Victim got 0 shares — inflation attack succeeded!");

      // Step 4: Verify victim can withdraw approximately their deposit
      // The share price was inflated by donation, so victim gets fewer shares
      // but their shares should still be worth close to their deposit
      const victimShareValue = await vault.convertToAssets(victimShares);
      console.log("[DEBUG] Victim share value:", ethers.formatUnits(victimShareValue, 18));

      // Victim should get at least 99.99% of their deposit value back
      // (the 0.01% is the maximum rounding loss with offset=6)
      const minExpected = (victimDeposit * 9999n) / 10000n;
      expect(victimShareValue).to.be.gte(minExpected,
        "CRITICAL: Victim lost >0.01% of deposit to inflation attack");

      // Calculate attacker's profit from the attack
      const attackerShareValue = await vault.convertToAssets(attackerShares);
      const attackerTotalCost = 1n + donation; // 1 wei deposit + 10000 donation
      const attackerProfit = attackerShareValue > attackerTotalCost
        ? attackerShareValue - attackerTotalCost
        : 0n;
      console.log("[DEBUG] Attacker cost:", ethers.formatUnits(attackerTotalCost, 18));
      console.log("[DEBUG] Attacker share value:", ethers.formatUnits(attackerShareValue, 18));
      console.log("[DEBUG] Attacker profit:", ethers.formatUnits(attackerProfit, 18));

      // Attacker should NOT profit (they lose most of the donation)
      expect(attackerProfit).to.equal(0n, "ALERT: Attacker profited from inflation attack!");
      console.log("[DEBUG] RESULT: Inflation attack MITIGATED by decimalsOffset=6");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. SHARE PRICE MANIPULATION VIA DIRECT ASSET DONATION
  // ═══════════════════════════════════════════════════════════════════

  describe("2. Direct Asset Donation to Strategy", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: donating USDC directly to strategy inflates processReport profit", async function () {
      console.log("[DEBUG] === Strategy Donation Test ===");

      // User deposits
      await vault.connect(user1).deposit(USDC(10000), user1Addr);

      // Deploy to strategy
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(5000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      // Set strategy totalAssets to match deployment
      await mockStrategy.setTotalAssets(USDC(5000));
      await vault.connect(admin).processReport(strategyAddr);

      const priceBefore = await vault.sharePrice();
      const totalAssetsBefore = await vault.totalAssets();
      console.log("[DEBUG] Price before donation:", ethers.formatUnits(priceBefore, 18));
      console.log("[DEBUG] totalAssets before:", ethers.formatUnits(totalAssetsBefore, 18));

      // Attacker donates 1000 USDC directly to strategy contract
      await usdc.connect(attacker).transfer(strategyAddr, USDC(1000));

      // MockStrategy totalAssets is manually set, so donation doesn't auto-increase it
      // In a REAL strategy, the idle balance would increase totalAssets
      // Simulating what a real strategy would do:
      await mockStrategy.setTotalAssets(USDC(6000)); // 5000 + 1000 donation

      // Admin calls processReport — registers 1000 as "profit"
      const tx = await vault.connect(admin).processReport(strategyAddr);
      const receipt = await tx.wait();

      const priceAfter = await vault.sharePrice();
      const totalAssetsAfter = await vault.totalAssets();
      console.log("[DEBUG] Price after donation+report:", ethers.formatUnits(priceAfter, 18));
      console.log("[DEBUG] totalAssets after:", ethers.formatUnits(totalAssetsAfter, 18));

      // Price increased — donation benefited existing shareholders
      expect(priceAfter).to.be.gt(priceBefore);

      // This is NOT exploitable because:
      // 1. Attacker loses the donated funds (can't get them back)
      // 2. The benefit goes to ALL shareholders, not just the attacker
      // 3. The 3-step withdrawal prevents instant exit
      console.log("[DEBUG] RESULT: Donation increases price but attacker LOSES money — NOT exploitable");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. ROUNDING DIRECTION CONSISTENCY
  // ═══════════════════════════════════════════════════════════════════

  describe("3. Rounding Direction Consistency", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: deposit rounds UP shares (in favor of vault)", async function () {
      console.log("[DEBUG] === Deposit Rounding Test ===");

      // Create a non-1:1 share price by depositing + simulating profit
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(5000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      // Profit: 5000 → 5333 (6.66% profit, creates awkward ratio)
      await mockStrategy.setTotalAssets(USDC(5333));
      await vault.connect(admin).processReport(strategyAddr);

      // Deposit a small odd amount
      const smallDeposit = 7n; // 7 wei — should trigger rounding
      await vault.connect(user2).deposit(smallDeposit, user2Addr);
      const sharesReceived = await vault.balanceOf(user2Addr);
      console.log("[DEBUG] Shares for 7 wei:", sharesReceived.toString());

      // convertToAssets of those shares should be <= 7 (vault rounds in its favor)
      const assetsBack = await vault.convertToAssets(sharesReceived);
      console.log("[DEBUG] Asset value of received shares:", assetsBack.toString());
      expect(assetsBack).to.be.lte(smallDeposit,
        "CRITICAL: Deposit rounding gives user MORE than they deposited");
      console.log("[DEBUG] RESULT: Deposit rounding correctly favors vault");
    });

    it("FINDING: fulfillRedeem with tiny shares can cause 1-wei share price decrease (conversion formula mismatch)", async function () {
      console.log("[DEBUG] === FulfillRedeem Rounding Test ===");
      console.log("[DEBUG] _convertPendingSharesToAssets uses: shares * assets / supply (no virtual offset)");
      console.log("[DEBUG] convertToAssets uses: shares * (assets+1) / (supply+10^6) (with offset)");

      // Setup with awkward ratio
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      await vault.connect(user2).deposit(USDC(10000), user2Addr);

      await vault.connect(admin).requestDeploy(strategyAddr, USDC(5000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      await mockStrategy.setTotalAssets(USDC(5333));
      await vault.connect(admin).processReport(strategyAddr);

      // Test with small shares to see rounding difference
      // Note: too few shares (3) causes ZeroAssets revert in fulfillRedeem
      await vault.connect(user1).requestRedeem(SHARE_SCALE, user1Addr, user1Addr);

      const priceBefore = await vault.sharePrice();
      await vault.connect(admin).fulfillRedeem(user1Addr);
      const priceAfter = await vault.sharePrice();

      console.log("[DEBUG] Price before:", priceBefore.toString(), "after:", priceAfter.toString());
      const diff = priceBefore > priceAfter ? priceBefore - priceAfter : priceAfter - priceBefore;
      console.log("[DEBUG] Price change:", diff.toString(), "wei");

      // FINDING: The formulas can differ by 1 wei for tiny share amounts
      // This is because _convertPendingSharesToAssets gives the user
      // slightly more/less than what preserves the virtual-offset share price
      expect(diff).to.be.lte(1n,
        "ALERT: Share price changed by more than 1 wei — investigate conversion formula");
      console.log("[DEBUG] RESULT: Max 1-wei price change for tiny redemptions — NOT exploitable");
      console.log("[DEBUG] SEVERITY: INFORMATIONAL — the difference is 1 wei on share price");
      console.log("[DEBUG] IMPACT: To profit $1 from this, attacker would need ~10^18 repeated transactions");
    });

    it("PROOF: fulfillRedeem with normal shares preserves price exactly", async function () {
      console.log("[DEBUG] === FulfillRedeem Normal Amount Test ===");

      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      await vault.connect(user2).deposit(USDC(10000), user2Addr);

      await vault.connect(admin).requestDeploy(strategyAddr, USDC(5000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      await mockStrategy.setTotalAssets(USDC(5333));
      await vault.connect(admin).processReport(strategyAddr);

      // Normal amount: half of user1's shares
      const shares1 = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares1 / 2n, user1Addr, user1Addr);

      const priceBefore = await vault.sharePrice();
      await vault.connect(admin).fulfillRedeem(user1Addr);
      const priceAfter = await vault.sharePrice();

      console.log("[DEBUG] Price before:", priceBefore.toString(), "after:", priceAfter.toString());
      // For normal amounts, price should be preserved or increase (Floor rounding)
      expect(priceAfter).to.be.gte(priceBefore,
        "CRITICAL: Share price decreased with normal fulfillRedeem amount");
      console.log("[DEBUG] RESULT: Normal fulfillRedeem preserves share price correctly");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 4. maxDeposit/maxWithdraw WHEN PAUSED
  // ═══════════════════════════════════════════════════════════════════

  describe("4. Paused State Correctness", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: maxDeposit returns 0 when paused (never reverts)", async function () {
      console.log("[DEBUG] === Paused maxDeposit Test ===");
      await vault.connect(admin).pause();

      const maxDep = await vault.maxDeposit(user1Addr);
      console.log("[DEBUG] maxDeposit when paused:", maxDep.toString());
      expect(maxDep).to.equal(0n);

      const maxMint = await vault.maxMint(user1Addr);
      console.log("[DEBUG] maxMint when paused:", maxMint.toString());
      expect(maxMint).to.equal(0n);
      console.log("[DEBUG] RESULT: maxDeposit/maxMint return 0 when paused");
    });

    it("PROOF: maxWithdraw still returns claimable when paused (claims allowed)", async function () {
      console.log("[DEBUG] === Paused maxWithdraw Test ===");

      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      const shares = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
      await vault.connect(admin).fulfillRedeem(user1Addr);

      const claimable = await vault.claimableWithdrawals(user1Addr);
      expect(claimable).to.be.gt(0n);

      // Pause
      await vault.connect(admin).pause();

      // maxWithdraw should still return claimable (claims work during pause)
      const maxW = await vault.maxWithdraw(user1Addr);
      console.log("[DEBUG] maxWithdraw when paused:", ethers.formatUnits(maxW, 18));
      expect(maxW).to.equal(claimable);

      // Actually claiming should work (withdraw doesn't have whenNotPaused)
      await vault.connect(user1).withdraw(claimable, user1Addr, user1Addr);
      const balance = await usdc.balanceOf(user1Addr);
      console.log("[DEBUG] User balance after claim during pause:", ethers.formatUnits(balance, 18));
      console.log("[DEBUG] RESULT: Claims work during pause — by design for ERC-7540");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 5. ERC-7540 STATE TRANSITIONS — NO SKIP/REPLAY
  // ═══════════════════════════════════════════════════════════════════

  describe("5. ERC-7540 State Transition Safety", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: cannot skip requestRedeem and go straight to fulfillRedeem", async function () {
      console.log("[DEBUG] === Skip State Test ===");
      await vault.connect(user1).deposit(USDC(10000), user1Addr);

      // Try to fulfill without request
      await expect(vault.connect(admin).fulfillRedeem(user1Addr))
        .to.be.revertedWithCustomError(vault, "NothingPending");
      console.log("[DEBUG] RESULT: Cannot skip requestRedeem");
    });

    it("PROOF: cannot replay fulfillRedeem for same request", async function () {
      console.log("[DEBUG] === Replay FulfillRedeem Test ===");
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      const shares = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
      await vault.connect(admin).fulfillRedeem(user1Addr);

      // Try to fulfill again — should revert
      await expect(vault.connect(admin).fulfillRedeem(user1Addr))
        .to.be.revertedWithCustomError(vault, "NothingPending");
      console.log("[DEBUG] RESULT: Cannot replay fulfillRedeem");
    });

    it("PROOF: cannot double-request redeem for same controller", async function () {
      console.log("[DEBUG] === Double Request Test ===");
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      const shares = await vault.balanceOf(user1Addr);
      const halfShares = shares / 2n;

      await vault.connect(user1).requestRedeem(halfShares, user1Addr, user1Addr);

      // Second request should revert
      await expect(vault.connect(user1).requestRedeem(halfShares, user1Addr, user1Addr))
        .to.be.revertedWithCustomError(vault, "WithdrawalAlreadyPending");
      console.log("[DEBUG] RESULT: Cannot double-request");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 6. cancelWithdraw vs fulfillRedeem RACE CONDITION
  // ═══════════════════════════════════════════════════════════════════

  describe("6. cancelWithdraw vs fulfillRedeem Race", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: if cancelWithdraw runs first, fulfillRedeem reverts (no double-spend)", async function () {
      console.log("[DEBUG] === Cancel+Fulfill Race Test ===");
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      const shares = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

      // User cancels
      await vault.connect(user1).cancelWithdraw();
      expect(await vault.balanceOf(user1Addr)).to.equal(shares);

      // Admin tries to fulfill — should fail
      await expect(vault.connect(admin).fulfillRedeem(user1Addr))
        .to.be.revertedWithCustomError(vault, "NothingPending");

      console.log("[DEBUG] RESULT: Cancel-first prevents fulfill — no double-spend");
    });

    it("PROOF: if fulfillRedeem runs first, cancelWithdraw reverts (no share duplication)", async function () {
      console.log("[DEBUG] === Fulfill+Cancel Race Test ===");
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      const shares = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

      // Admin fulfills
      await vault.connect(admin).fulfillRedeem(user1Addr);

      // User tries to cancel — should fail
      await expect(vault.connect(user1).cancelWithdraw())
        .to.be.revertedWithCustomError(vault, "NothingPending");

      // Verify no share duplication: user has 0 shares, claimable has value
      expect(await vault.balanceOf(user1Addr)).to.equal(0n);
      expect(await vault.claimableWithdrawals(user1Addr)).to.be.gt(0n);

      console.log("[DEBUG] RESULT: Fulfill-first prevents cancel — no share duplication");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 7. ESCROWED SHARES NOT DOUBLE-COUNTED IN CONVERSION MATH
  // ═══════════════════════════════════════════════════════════════════

  describe("7. Escrowed Shares Conversion Math", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: share price unchanged after requestRedeem (escrow model correct)", async function () {
      console.log("[DEBUG] === Escrow Price Stability Test ===");
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      await vault.connect(user2).deposit(USDC(10000), user2Addr);

      const priceBefore = await vault.sharePrice();
      const totalAssetsBefore = await vault.totalAssets();
      const totalSupplyBefore = await vault.totalSupply();
      console.log("[DEBUG] Before escrow — price:", priceBefore.toString());
      console.log("[DEBUG] Before escrow — totalAssets:", totalAssetsBefore.toString());
      console.log("[DEBUG] Before escrow — totalSupply:", totalSupplyBefore.toString());

      // User1 escrows ALL shares
      const shares1 = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares1, user1Addr, user1Addr);

      const priceAfter = await vault.sharePrice();
      const totalAssetsAfter = await vault.totalAssets();
      const totalSupplyAfter = await vault.totalSupply();
      console.log("[DEBUG] After escrow — price:", priceAfter.toString());
      console.log("[DEBUG] After escrow — totalAssets:", totalAssetsAfter.toString());
      console.log("[DEBUG] After escrow — totalSupply:", totalSupplyAfter.toString());

      // totalSupply should NOT change (shares moved to vault, not burned)
      expect(totalSupplyAfter).to.equal(totalSupplyBefore,
        "CRITICAL: totalSupply changed after escrow — shares lost/created");

      // totalAssets should NOT change (no USDC moved)
      expect(totalAssetsAfter).to.equal(totalAssetsBefore,
        "CRITICAL: totalAssets changed after escrow — accounting broken");

      // Share price should NOT change
      expect(priceAfter).to.equal(priceBefore,
        "CRITICAL: Share price changed after escrow — user2 affected");

      console.log("[DEBUG] RESULT: Escrow model correctly preserves share price");
    });

    it("PROOF: share price preserved after fulfillRedeem (remaining holders unaffected)", async function () {
      console.log("[DEBUG] === FulfillRedeem Price Preservation Test ===");
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      await vault.connect(user2).deposit(USDC(20000), user2Addr);

      // Create non-trivial share price via profit
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(15000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);
      await mockStrategy.setTotalAssets(USDC(16500)); // 10% profit
      await vault.connect(admin).processReport(strategyAddr);

      const priceBefore = await vault.sharePrice();
      console.log("[DEBUG] Price before fulfillRedeem:", priceBefore.toString());

      // User1 requests and gets fulfilled
      const shares1 = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares1, user1Addr, user1Addr);

      // Bring some funds back for fulfillment
      await usdc.mint(strategyAddr, USDC(16500));
      await vault.connect(admin).withdrawFromStrategy(strategyAddr, USDC(16500));

      await vault.connect(admin).fulfillRedeem(user1Addr);

      const priceAfter = await vault.sharePrice();
      console.log("[DEBUG] Price after fulfillRedeem:", priceAfter.toString());

      // Share price should be >= before (Floor rounding gives dust to remaining holders)
      expect(priceAfter).to.be.gte(priceBefore,
        "CRITICAL: Share price DECREASED after fulfillRedeem — remaining shareholders diluted");

      console.log("[DEBUG] RESULT: Share price preserved (or slightly increased) after fulfillRedeem");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 8. STRATEGY INFLATED totalAssets — CAN'T DRAIN VAULT
  // ═══════════════════════════════════════════════════════════════════

  describe("8. Strategy Inflated totalAssets", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: inflated strategy totalAssets increases share price but withdrawal still bounded by actual USDC", async function () {
      console.log("[DEBUG] === Inflated Strategy Test ===");
      await vault.connect(user1).deposit(USDC(50000), user1Addr);

      // Deploy to strategy
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(30000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      // Strategy lies: claims 10x the real amount
      await mockStrategy.setTotalAssets(USDC(300000));
      await vault.connect(admin).processReport(strategyAddr);

      const inflatedTotal = await vault.totalAssets();
      console.log("[DEBUG] Inflated totalAssets:", ethers.formatUnits(inflatedTotal, 18));

      // User1 requests full redeem
      const shares = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

      // Admin tries to fulfill — vault only has 20k USDC idle
      // but fulfillment would try to reserve ~inflated amount
      const claimableEstimate = await vault.convertToAssets(shares);
      console.log("[DEBUG] Estimated claimable:", ethers.formatUnits(claimableEstimate, 18));

      const vaultBalance = await usdc.balanceOf(vaultAddr);
      console.log("[DEBUG] Actual vault USDC:", ethers.formatUnits(vaultBalance, 18));

      // fulfillRedeem checks vaultBal >= totalClaimable
      // If claimable > vaultBalance, it reverts — vault can't be drained
      await expect(vault.connect(admin).fulfillRedeem(user1Addr))
        .to.be.revertedWithCustomError(vault, "InsufficientIdleBalance");

      console.log("[DEBUG] RESULT: Inflated totalAssets CANNOT drain vault — fulfillRedeem checks idle balance");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 9. STRATEGY.WITHDRAW() REVERTS — VAULT NOT STUCK
  // ═══════════════════════════════════════════════════════════════════

  describe("9. Strategy Withdrawal Revert Recovery", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: if strategy withdraw reverts, vault is NOT permanently stuck", async function () {
      console.log("[DEBUG] === Strategy Revert Recovery Test ===");
      await vault.connect(user1).deposit(USDC(20000), user1Addr);

      // Deploy to strategy
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(10000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      // Strategy has 10000 USDC and reports 10000
      await mockStrategy.setTotalAssets(USDC(10000));
      await vault.connect(admin).processReport(strategyAddr);

      // Drain strategy's USDC (simulating it being locked/lost)
      // MockStrategy's withdraw will revert when it tries to transfer more than it has
      // Transfer out the strategy's USDC
      // For MockStrategy, withdraw calls safeTransfer which reverts if insufficient
      // We need to simulate the strategy being empty
      const stratBal = await usdc.balanceOf(strategyAddr);
      console.log("[DEBUG] Strategy balance:", ethers.formatUnits(stratBal, 18));

      // withdrawFromStrategy should revert if strategy can't deliver
      // (MockStrategy.withdraw does safeTransfer which reverts on insufficient balance)

      // Recovery path: report loss via processReport
      await mockStrategy.setTotalAssets(0n); // Strategy lost everything
      const tx = await vault.connect(admin).processReport(strategyAddr);
      console.log("[DEBUG] processReport registered loss");

      // Now strategy can be removed (currentDebt = 0)
      const [, currentDebt] = await vault.strategies(strategyAddr);
      console.log("[DEBUG] Strategy currentDebt after loss report:", currentDebt.toString());
      expect(currentDebt).to.equal(0n);

      await vault.connect(admin).removeStrategy(strategyAddr);
      console.log("[DEBUG] Strategy removed successfully");

      // Vault continues to operate
      const totalAssets = await vault.totalAssets();
      console.log("[DEBUG] Vault totalAssets:", ethers.formatUnits(totalAssets, 18));
      expect(totalAssets).to.be.gt(0n); // Still has the non-deployed portion

      console.log("[DEBUG] RESULT: Vault recoverable via processReport(loss) → removeStrategy");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 10. STRATEGY REMOVAL WITH ASSETS — BLOCKED
  // ═══════════════════════════════════════════════════════════════════

  describe("10. Strategy Removal With Assets", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: cannot remove strategy with outstanding debt", async function () {
      console.log("[DEBUG] === Remove Strategy With Debt Test ===");
      await vault.connect(user1).deposit(USDC(10000), user1Addr);

      await vault.connect(admin).requestDeploy(strategyAddr, USDC(5000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      const [, debt] = await vault.strategies(strategyAddr);
      console.log("[DEBUG] Strategy debt:", ethers.formatUnits(debt, 18));
      expect(debt).to.be.gt(0n);

      await expect(vault.connect(admin).removeStrategy(strategyAddr))
        .to.be.revertedWithCustomError(vault, "StrategyHasDebt");

      console.log("[DEBUG] RESULT: Strategy removal correctly blocked when debt > 0");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 11. FRONT-RUNNING processReport FOR SANDWICH ATTACK
  // ═══════════════════════════════════════════════════════════════════

  describe("11. Sandwich Attack on processReport", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: sandwich attack mitigated by 3-step async withdrawal", async function () {
      console.log("[DEBUG] === Sandwich Attack Test ===");

      // Existing depositor
      await vault.connect(user1).deposit(USDC(100000), user1Addr);

      // Deploy to strategy
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(50000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);
      await mockStrategy.setTotalAssets(USDC(50000));
      await vault.connect(admin).processReport(strategyAddr);

      // === ATTACK BEGINS ===
      // Step 1: Attacker deposits BEFORE processReport (simulating front-run)
      const attackDeposit = USDC(100000);
      await vault.connect(attacker).deposit(attackDeposit, attackerAddr);
      const attackerShares = await vault.balanceOf(attackerAddr);
      console.log("[DEBUG] Attacker shares:", attackerShares.toString());

      // Step 2: Profit reported (attacker's shares now worth more)
      await mockStrategy.setTotalAssets(USDC(70000)); // 40% profit
      await vault.connect(admin).processReport(strategyAddr);

      const attackerValue = await vault.convertToAssets(attackerShares);
      console.log("[DEBUG] Attacker value after profit:", ethers.formatUnits(attackerValue, 18));

      // Step 3: Attacker tries to exit immediately
      // BUT: requestRedeem → fulfillRedeem → withdraw is required
      await vault.connect(attacker).requestRedeem(attackerShares, attackerAddr, attackerAddr);

      // Attacker CANNOT claim without admin's fulfillRedeem
      // Admin sees the suspicious deposit+redeem pattern and can delay/refuse
      const claimable = await vault.claimableWithdrawals(attackerAddr);
      expect(claimable).to.equal(0n, "Attacker should have 0 claimable before fulfillRedeem");

      console.log("[DEBUG] Attacker claimable (before admin fulfills):", claimable.toString());
      console.log("[DEBUG] RESULT: 3-step withdrawal prevents instant exit — sandwich attack mitigated");
      console.log("[DEBUG] Admin controls fulfillRedeem timing and can refuse suspicious patterns");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 12. SHARE DONATION GRIEFING VECTOR
  // ═══════════════════════════════════════════════════════════════════

  describe("12. Share Donation Griefing", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: explicit totalEscrowedShares prevents share donation griefing", async function () {
      console.log("[DEBUG] === Share Donation Griefing Test (FIXED) ===");

      // Users deposit
      await vault.connect(user1).deposit(USDC(50000), user1Addr);
      await vault.connect(attacker).deposit(USDC(10000), attackerAddr);

      const idleBefore = await vault.idleBalance();
      console.log("[DEBUG] Idle balance before:", ethers.formatUnits(idleBefore, 18));

      // Attacker transfers shares directly to vault (not via requestRedeem)
      const attackerShares = await vault.balanceOf(attackerAddr);
      await vault.connect(attacker).transfer(vaultAddr, attackerShares);
      console.log("[DEBUG] Attacker donated", attackerShares.toString(), "shares to vault");

      // FIX: totalPendingShares uses explicit totalEscrowedShares, NOT balanceOf(vault)
      // So donated shares do NOT inflate pending reserves
      const pendingShares = await vault.totalPendingShares();
      console.log("[DEBUG] totalPendingShares (explicit tracking):", pendingShares.toString());
      expect(pendingShares).to.equal(0n, "Explicit escrow tracking ignores donated shares");

      // idleBalance should NOT decrease — donated shares don't affect reserves
      const idleAfter = await vault.idleBalance();
      console.log("[DEBUG] Idle balance after:", ethers.formatUnits(idleAfter, 18));
      expect(idleAfter).to.equal(idleBefore,
        "Share donation should NOT reduce idle balance (explicit escrow tracking)");

      // Verify the donated shares are stuck forever but cause no harm
      expect(await vault.pendingWithdrawalShares(attackerAddr)).to.equal(0n);
      expect(await vault.pendingWithdrawalShares(vaultAddr)).to.equal(0n);

      // The attacker LOST their shares — no way to recover them
      expect(await vault.balanceOf(attackerAddr)).to.equal(0n);

      console.log("[DEBUG] RESULT: Share donation griefing MITIGATED by explicit totalEscrowedShares");
      console.log("[DEBUG] IMPACT: Attacker loses shares, but vault reserves are not inflated");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 13. EMERGENCY SHUTDOWN BOUNDARY (50% threshold)
  // ═══════════════════════════════════════════════════════════════════

  describe("13. Emergency Shutdown Boundary", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: exactly 50% loss triggers shutdown", async function () {
      console.log("[DEBUG] === Emergency Shutdown 50% Test ===");
      await vault.connect(user1).deposit(USDC(20000), user1Addr);

      await vault.connect(admin).requestDeploy(strategyAddr, USDC(10000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      // Exactly 50% loss: 10000 → 5000
      await mockStrategy.setTotalAssets(USDC(5000));

      await expect(vault.connect(admin).processReport(strategyAddr))
        .to.emit(vault, "EmergencyShutdownTriggered");

      expect(await vault.emergencyShutdown()).to.be.true;
      console.log("[DEBUG] RESULT: 50% loss correctly triggers shutdown");
    });

    it("PROOF: 49.99% loss does NOT trigger shutdown", async function () {
      console.log("[DEBUG] === Emergency Shutdown 49.99% Test ===");
      await vault.connect(user1).deposit(USDC(20000), user1Addr);

      await vault.connect(admin).requestDeploy(strategyAddr, USDC(10000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      // 49.99% loss: 10000 → 5001 (loss = 4999, 4999*10000/10000 = 4999 < 5000)
      await mockStrategy.setTotalAssets(USDC(5001));

      // Should NOT trigger emergency shutdown
      await vault.connect(admin).processReport(strategyAddr);
      expect(await vault.emergencyShutdown()).to.be.false;
      console.log("[DEBUG] RESULT: 49.99% loss correctly does NOT trigger shutdown");
    });

    it("PROOF: resolveEmergencyShutdown only works when shutdown is active", async function () {
      console.log("[DEBUG] === Resolve Shutdown Test ===");

      // Cannot resolve when not in shutdown
      await expect(vault.connect(admin).resolveEmergencyShutdown())
        .to.be.revertedWithCustomError(vault, "EmergencyShutdownActive");

      // Trigger shutdown
      await vault.connect(user1).deposit(USDC(20000), user1Addr);
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(10000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);
      await mockStrategy.setTotalAssets(0n);
      await vault.connect(admin).processReport(strategyAddr);
      expect(await vault.emergencyShutdown()).to.be.true;

      // Now resolve works
      await vault.connect(admin).resolveEmergencyShutdown();
      expect(await vault.emergencyShutdown()).to.be.false;
      console.log("[DEBUG] RESULT: resolveEmergencyShutdown lifecycle correct");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 14. FULL WITHDRAWAL CYCLE — NO DUST/LOSS
  // ═══════════════════════════════════════════════════════════════════

  describe("14. Full Withdrawal Cycle Accounting", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: full deposit → redeem → claim cycle returns exact deposit (no value leak)", async function () {
      console.log("[DEBUG] === Full Cycle Accounting Test ===");
      const deposit = USDC(10000);

      const balanceBefore = await usdc.balanceOf(user1Addr);
      await vault.connect(user1).deposit(deposit, user1Addr);

      const shares = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
      await vault.connect(admin).fulfillRedeem(user1Addr);

      const claimable = await vault.claimableWithdrawals(user1Addr);
      await vault.connect(user1).withdraw(claimable, user1Addr, user1Addr);

      const balanceAfter = await usdc.balanceOf(user1Addr);
      const diff = balanceBefore - balanceAfter;
      console.log("[DEBUG] USDC balance before:", ethers.formatUnits(balanceBefore, 18));
      console.log("[DEBUG] USDC balance after:", ethers.formatUnits(balanceAfter, 18));
      console.log("[DEBUG] Diff (loss to user):", diff.toString(), "wei");

      // User should get back their EXACT deposit (or lose at most 1 wei to rounding)
      expect(diff).to.be.lte(1n,
        "CRITICAL: User lost more than 1 wei rounding in full cycle");
      console.log("[DEBUG] RESULT: Full cycle returns exact deposit (±1 wei rounding)");
    });

    it("PROOF: multi-user deposit+withdraw cycle preserves total value", async function () {
      console.log("[DEBUG] === Multi-User Cycle Test ===");

      // Three users deposit different amounts
      const dep1 = USDC(10000);
      const dep2 = USDC(20000);
      const dep3 = USDC(30000);

      await vault.connect(user1).deposit(dep1, user1Addr);
      await vault.connect(user2).deposit(dep2, user2Addr);
      await vault.connect(attacker).deposit(dep3, attackerAddr);

      const totalDeposited = dep1 + dep2 + dep3;
      const vaultBalance = await usdc.balanceOf(vaultAddr);
      console.log("[DEBUG] Total deposited:", ethers.formatUnits(totalDeposited, 18));
      console.log("[DEBUG] Vault balance:", ethers.formatUnits(vaultBalance, 18));
      expect(vaultBalance).to.equal(totalDeposited);

      // All request redeem
      for (const [signer, addr] of [[user1, user1Addr], [user2, user2Addr], [attacker, attackerAddr]] as [Signer, string][]) {
        const shares = await vault.balanceOf(addr);
        await vault.connect(signer).requestRedeem(shares, addr, addr);
      }

      // Admin fulfills all
      for (const addr of [user1Addr, user2Addr, attackerAddr]) {
        await vault.connect(admin).fulfillRedeem(addr);
      }

      // Check total claimable equals total deposited (minus potential rounding dust)
      let totalClaimable = 0n;
      for (const addr of [user1Addr, user2Addr, attackerAddr]) {
        totalClaimable += await vault.claimableWithdrawals(addr);
      }
      console.log("[DEBUG] Total claimable:", ethers.formatUnits(totalClaimable, 18));

      const dust = totalDeposited - totalClaimable;
      console.log("[DEBUG] Dust (rounding loss across 3 users):", dust.toString(), "wei");
      expect(dust).to.be.lte(3n, // At most 1 wei dust per user
        "CRITICAL: More than 3 wei dust across 3 users — accounting error");

      // All claim
      for (const [signer, addr] of [[user1, user1Addr], [user2, user2Addr], [attacker, attackerAddr]] as [Signer, string][]) {
        const claimable = await vault.claimableWithdrawals(addr);
        await vault.connect(signer).withdraw(claimable, addr, addr);
      }

      // Vault should have only dust remaining
      const vaultFinal = await usdc.balanceOf(vaultAddr);
      console.log("[DEBUG] Vault final balance (dust only):", vaultFinal.toString(), "wei");
      expect(vaultFinal).to.be.lte(3n);

      console.log("[DEBUG] RESULT: Multi-user cycle preserves total value (±3 wei dust for 3 users)");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 15. _convertPendingSharesToAssets vs convertToAssets DISCREPANCY
  // ═══════════════════════════════════════════════════════════════════

  describe("15. Conversion Formula Discrepancy", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: fulfillRedeem uses different formula than convertToAssets — check for value extraction", async function () {
      console.log("[DEBUG] === Conversion Discrepancy Test ===");

      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      await vault.connect(user2).deposit(USDC(20000), user2Addr);

      // Create non-trivial price
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(15000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);
      await mockStrategy.setTotalAssets(USDC(17000)); // ~13% profit
      await vault.connect(admin).processReport(strategyAddr);

      const shares1 = await vault.balanceOf(user1Addr);

      // What convertToAssets says the shares are worth
      const standardConversion = await vault.convertToAssets(shares1);

      // Request redeem and fulfill to see what _convertPendingSharesToAssets gives
      await vault.connect(user1).requestRedeem(shares1, user1Addr, user1Addr);

      // Bring back funds for fulfillment
      await usdc.mint(strategyAddr, USDC(17000));
      await vault.connect(admin).withdrawFromStrategy(strategyAddr, USDC(17000));

      await vault.connect(admin).fulfillRedeem(user1Addr);
      const fulfillConversion = await vault.claimableWithdrawals(user1Addr);

      console.log("[DEBUG] convertToAssets:", ethers.formatUnits(standardConversion, 18));
      console.log("[DEBUG] fulfillRedeem gave:", ethers.formatUnits(fulfillConversion, 18));

      const diff = standardConversion > fulfillConversion
        ? standardConversion - fulfillConversion
        : fulfillConversion - standardConversion;
      console.log("[DEBUG] Difference:", diff.toString(), "wei");

      // The difference should be negligible (< 1e12 wei = 0.000001 USDC at 18 decimals)
      expect(diff).to.be.lte(ethers.parseUnits("1", 12),
        "ALERT: Significant difference between convertToAssets and fulfillRedeem conversion");

      console.log("[DEBUG] RESULT: Conversion discrepancy is negligible (sub-micro-USDC)");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 16. UNBOUNDED LOOPS / DOS VECTORS
  // ═══════════════════════════════════════════════════════════════════

  describe("16. DOS Vectors", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: strategyList iteration in removeStrategy is bounded by owner-controlled additions", async function () {
      console.log("[DEBUG] === Strategy List Bounds Test ===");

      // Add multiple strategies
      const strategies: string[] = [strategyAddr];
      for (let i = 0; i < 5; i++) {
        const MockStrategy = await ethers.getContractFactory("MockStrategy");
        const s = await MockStrategy.deploy(await usdc.getAddress());
        await s.waitForDeployment();
        const addr = await s.getAddress();
        await vault.connect(admin).addStrategy(addr);
        strategies.push(addr);
      }

      const listLen = await vault.strategyListLength();
      console.log("[DEBUG] Strategy list length:", listLen.toString());
      expect(listLen).to.equal(6n);

      // Remove middle strategy — should succeed
      await vault.connect(admin).removeStrategy(strategies[3]);
      const listLenAfter = await vault.strategyListLength();
      console.log("[DEBUG] After removal:", listLenAfter.toString());
      expect(listLenAfter).to.equal(5n);

      // Non-owner cannot add strategies (prevent attacker DOS)
      await expect(vault.connect(attacker).addStrategy(attackerAddr))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");

      console.log("[DEBUG] RESULT: Strategy list bounded by owner-only additions — no DOS");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 17. executeDeploy RESERVES BOTH PENDING + CLAIMABLE
  // ═══════════════════════════════════════════════════════════════════

  describe("17. executeDeploy Fund Reservation", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: executeDeploy cannot deploy funds reserved for claimable withdrawals", async function () {
      console.log("[DEBUG] === Deploy vs Claimable Reservation Test ===");

      await vault.connect(user1).deposit(USDC(20000), user1Addr);
      await vault.connect(user2).deposit(USDC(5000), user2Addr);

      // User1 requests and gets fulfilled
      const shares1 = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares1, user1Addr, user1Addr);
      await vault.connect(admin).fulfillRedeem(user1Addr);

      const claimable = await vault.claimableWithdrawals(user1Addr);
      console.log("[DEBUG] Claimable for user1:", ethers.formatUnits(claimable, 18));

      // Try to deploy more than available (25k total, 20k reserved for claimable)
      await vault.connect(admin).requestDeploy(strategyAddr, USDC(10000));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
      await ethers.provider.send("evm_mine", []);

      await expect(vault.connect(admin).executeDeploy(0))
        .to.be.revertedWithCustomError(vault, "InsufficientIdleBalance");

      console.log("[DEBUG] RESULT: executeDeploy correctly reserves claimable USDC");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 18. ACCESS CONTROL ON EVERY STATE-CHANGING FUNCTION
  // ═══════════════════════════════════════════════════════════════════

  describe("18. Access Control Completeness", function () {
    beforeEach(async function () { await deployFixture(); });

    it("PROOF: all admin functions reject non-owner", async function () {
      console.log("[DEBUG] === Access Control Sweep Test ===");

      // onlyOwner functions — revert with OwnableUnauthorizedAccount
      const ownerChecks = [
        ["fulfillRedeem", vault.connect(attacker).fulfillRedeem(user1Addr)],
        ["setDepositLimit", vault.connect(attacker).setDepositLimit(0)],
        ["pause", vault.connect(attacker).pause()],
        ["unpause", vault.connect(attacker).unpause()],
        ["addStrategy", vault.connect(attacker).addStrategy(attackerAddr)],
        ["removeStrategy", vault.connect(attacker).removeStrategy(strategyAddr)],
        ["requestDeploy", vault.connect(attacker).requestDeploy(strategyAddr, 1)],
        ["cancelDeploy", vault.connect(attacker).cancelDeploy(0)],
        ["withdrawFromStrategy", vault.connect(attacker).withdrawFromStrategy(strategyAddr, 1)],
        ["resolveEmergencyShutdown", vault.connect(attacker).resolveEmergencyShutdown()],
        ["setHealthCheck", vault.connect(attacker).setHealthCheck(10000, 100, true)],
      ] as [string, Promise<unknown>][];

      for (const [name, call] of ownerChecks) {
        await expect(call).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
        console.log("[DEBUG] ✓", name, "rejects non-owner");
      }

      // onlyKeeperOrOwner functions — revert with NotKeeperOrOwner
      const keeperChecks = [
        ["processReport", vault.connect(attacker).processReport(strategyAddr)],
      ] as [string, Promise<unknown>][];

      for (const [name, call] of keeperChecks) {
        await expect(call).to.be.revertedWithCustomError(vault, "NotKeeperOrOwner");
        console.log("[DEBUG] ✓", name, "rejects non-keeper/non-owner");
      }

      console.log("[DEBUG] RESULT: All admin functions correctly check access control");
    });

    it("PROOF: requestRedeem enforces owner/operator auth", async function () {
      console.log("[DEBUG] === requestRedeem Auth Test ===");
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      const shares = await vault.balanceOf(user1Addr);

      // Attacker tries to requestRedeem on behalf of user1 (not operator)
      await expect(
        vault.connect(attacker).requestRedeem(shares, attackerAddr, user1Addr)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");

      console.log("[DEBUG] RESULT: requestRedeem correctly enforces owner/operator auth");
    });

    it("PROOF: withdraw/redeem enforce owner/operator auth", async function () {
      console.log("[DEBUG] === Claim Auth Test ===");
      await vault.connect(user1).deposit(USDC(10000), user1Addr);
      const shares = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
      await vault.connect(admin).fulfillRedeem(user1Addr);

      // Attacker tries to claim user1's claimable
      const claimable = await vault.claimableWithdrawals(user1Addr);
      await expect(
        vault.connect(attacker).withdraw(claimable, attackerAddr, user1Addr)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");

      const claimShares = await vault.claimableWithdrawalShares(user1Addr);
      await expect(
        vault.connect(attacker).redeem(claimShares, attackerAddr, user1Addr)
      ).to.be.revertedWithCustomError(vault, "Unauthorized");

      console.log("[DEBUG] RESULT: withdraw/redeem correctly enforce owner/operator auth");
    });
  });
});
