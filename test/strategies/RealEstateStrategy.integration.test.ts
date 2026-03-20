import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

const DEPOSIT_LIMIT = ethers.parseUnits("1000000", 18);
const SHARE_SCALE = 1_000_000n;

describe("RealEstateStrategy — Vault Integration", function () {
  let vault: Contract;
  let usdc: Contract;
  let strategy: Contract;
  let mockNFT: Contract;
  let mockMaster: Contract;
  let admin: Signer;
  let user1: Signer;
  let user2: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let user2Addr: string;
  let vaultAddr: string;

  async function deployFixture() {
    console.log("[DEBUG] integration deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    user2 = signers[2];
    adminAddr = await admin.getAddress();
    user1Addr = await user1.getAddress();
    user2Addr = await user2.getAddress();

    // Deploy USDC (MockUSDT with 18 decimals)
    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();
    console.log("[DEBUG] USDC deployed at:", await usdc.getAddress());

    // Deploy vault proxy
    const VaultFactory = await ethers.getContractFactory("TulpeaYieldVault");
    const vaultImpl = await VaultFactory.deploy();
    await vaultImpl.waitForDeployment();

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967ProxyWrapper");
    const initData = VaultFactory.interface.encodeFunctionData("initialize", [
      await usdc.getAddress(), adminAddr, DEPOSIT_LIMIT, "Tulpea Yield Vault", "tyvUSDC", ethers.ZeroAddress,
    ]);
    const proxy = await ERC1967Proxy.deploy(await vaultImpl.getAddress(), initData);
    await proxy.waitForDeployment();
    vault = VaultFactory.attach(await proxy.getAddress()) as Contract;
    vaultAddr = await proxy.getAddress();
    console.log("[DEBUG] Vault proxy at:", vaultAddr);

    // Deploy mock NFT
    const MockNFT = await ethers.getContractFactory("MockPortfolioNFTForStrategy");
    mockNFT = await MockNFT.deploy();
    await mockNFT.waitForDeployment();

    // Deploy mock master (needs USDT for yield claims)
    const MockMaster = await ethers.getContractFactory("MockPortfolioMasterForStrategy");
    mockMaster = await MockMaster.deploy(await usdc.getAddress());
    await mockMaster.waitForDeployment();

    // Deploy RealEstateStrategyHarness with vault as the real vault address
    const Strategy = await ethers.getContractFactory("RealEstateStrategyHarness");
    strategy = await Strategy.deploy(
      await usdc.getAddress(),
      await mockNFT.getAddress(),
      await mockMaster.getAddress(),
      vaultAddr,
      adminAddr,
    );
    await strategy.waitForDeployment();
    console.log("[DEBUG] RealEstateStrategy deployed at:", await strategy.getAddress());

    // Register strategy in vault
    await vault.connect(admin).addStrategy(await strategy.getAddress());
    console.log("[DEBUG] Strategy registered in vault");

    // Mint USDC and approve
    const mintAmount = ethers.parseUnits("500000", 18);
    await usdc.mint(user1Addr, mintAmount);
    await usdc.mint(user2Addr, mintAmount);
    await usdc.connect(user1).approve(vaultAddr, ethers.MaxUint256);
    await usdc.connect(user2).approve(vaultAddr, ethers.MaxUint256);

    console.log("[DEBUG] integration deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // Helper: mint NFT to strategy and track + set position
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

  // Helper: deploy funds via timelock
  async function deployFundsToStrategy(amount: bigint) {
    console.log("[DEBUG] deployFundsToStrategy:", ethers.formatUnits(amount, 18));
    const deployId = await vault.connect(admin).requestDeploy.staticCall(
      await strategy.getAddress(), amount
    );
    await vault.connect(admin).requestDeploy(await strategy.getAddress(), amount);
    await ethers.provider.send("evm_increaseTime", [86401]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(deployId);
    console.log("[DEBUG] funds deployed, totalDebt:", (await vault.totalDebt()).toString());
  }

  // ═══════════════════════════════════════════════════════════
  // Test 1: vault deploys funds to strategy
  // ═══════════════════════════════════════════════════════════

  it("vault deploys funds to strategy via requestDeploy/executeDeploy", async function () {
    console.log("[DEBUG] test: deploy funds to strategy");
    const dep = ethers.parseUnits("50000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);

    const stratBalBefore = await usdc.balanceOf(await strategy.getAddress());
    await deployFundsToStrategy(dep);

    const stratBalAfter = await usdc.balanceOf(await strategy.getAddress());
    const totalDebt = await vault.totalDebt();
    console.log("[DEBUG] strategy balance:", ethers.formatUnits(stratBalAfter, 18));
    console.log("[DEBUG] totalDebt:", ethers.formatUnits(totalDebt, 18));

    expect(stratBalAfter - stratBalBefore).to.equal(dep);
    expect(totalDebt).to.equal(dep);
  });

  // ═══════════════════════════════════════════════════════════
  // Test 2: processReport reads strategy totalAssets (idle + NFT values)
  // ═══════════════════════════════════════════════════════════

  it("processReport reads strategy totalAssets (idle + NFT values)", async function () {
    console.log("[DEBUG] test: processReport with NFT values");
    const dep = ethers.parseUnits("50000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);
    await deployFundsToStrategy(dep);

    // Add NFTs via harness (simulating property deposits)
    const invested = ethers.parseUnits("30000", 18);
    await mintAndTrackNft(invested, 0n, 0n, 4000n);

    // totalAssets = idle (50000) + nftValue (30000) = 80000
    const stratTotal = await strategy.totalAssets();
    console.log("[DEBUG] strategy totalAssets:", ethers.formatUnits(stratTotal, 18));
    expect(stratTotal).to.equal(dep + invested);

    // processReport should detect profit of 30000 (NFT value added)
    const [profit, loss] = await vault.processReport.staticCall(await strategy.getAddress());
    console.log("[DEBUG] processReport profit:", ethers.formatUnits(profit, 18), "loss:", ethers.formatUnits(loss, 18));
    expect(profit).to.equal(invested); // 30000 profit from NFTs
    expect(loss).to.equal(0);
  });

  // ═══════════════════════════════════════════════════════════
  // Test 3: harvest → processReport detects profit
  // ═══════════════════════════════════════════════════════════

  it("harvest → processReport detects profit", async function () {
    console.log("[DEBUG] test: harvest + processReport profit");
    const dep = ethers.parseUnits("50000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);
    await deployFundsToStrategy(dep);

    // Add NFTs with yield (amountOwed > 0)
    const invested = ethers.parseUnits("30000", 18);
    const owed = ethers.parseUnits("2000", 18);
    const nftId = await mintAndTrackNft(invested, owed, 0n, 4000n);

    // Set claimable yield on mock master
    await mockMaster.setClaimableAmount(nftId, owed);
    await usdc.mint(await mockMaster.getAddress(), owed);

    // Harvest — yield becomes idle USDT in strategy
    const totalBefore = await strategy.totalAssets();
    await strategy.connect(admin).harvest();
    const totalAfter = await strategy.totalAssets();
    console.log("[DEBUG] totalAssets before harvest:", ethers.formatUnits(totalBefore, 18));
    console.log("[DEBUG] totalAssets after harvest:", ethers.formatUnits(totalAfter, 18));

    // processReport detects the overall increase (idle went up, NFT amountOwed went to 0 after claim)
    // Update NFT position to reflect claimed yield
    await mockNFT.setPosition(nftId, {
      amountInvested: invested,
      amountOwed: 0n,
      totalClaimed: owed,
      yieldCapBps: 4000n,
      propertyId: 1,
      trancheType: 0,
      isSplit: false,
      splitDepth: 0,
    });

    const [profit, loss] = await vault.processReport.staticCall(await strategy.getAddress());
    console.log("[DEBUG] profit:", ethers.formatUnits(profit, 18), "loss:", ethers.formatUnits(loss, 18));
    // Profit = current totalAssets - previousDebt (dep)
    expect(profit).to.be.gt(0);
    expect(loss).to.equal(0);

    // Actually apply the report
    await vault.connect(admin).processReport(await strategy.getAddress());
    const sharePrice = await vault.sharePrice();
    console.log("[DEBUG] sharePrice after report:", sharePrice.toString());
  });

  // ═══════════════════════════════════════════════════════════
  // Test 4: NFT value decrease → processReport detects loss
  // ═══════════════════════════════════════════════════════════

  it("NFT value decrease → processReport detects loss", async function () {
    console.log("[DEBUG] test: processReport loss");
    const dep = ethers.parseUnits("50000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);
    await deployFundsToStrategy(dep);

    // Add NFT worth 30k
    const invested = ethers.parseUnits("30000", 18);
    const nftId = await mintAndTrackNft(invested, 0n, 0n, 4000n);

    // First processReport to set baseline (dep + 30k NFT = 80k)
    await vault.connect(admin).processReport(await strategy.getAddress());
    const priceBefore = await vault.sharePrice();
    console.log("[DEBUG] sharePrice before loss:", priceBefore.toString());

    // Simulate NFT value drop — update position to show high totalClaimed
    // This reduces lockedPrincipal → nftValue drops
    const maxReturn = invested * 14000n / 10000n; // 42000
    // Set totalClaimed to most of maxReturn → lockedPrincipal ≈ 0
    await mockNFT.setPosition(nftId, {
      amountInvested: invested,
      amountOwed: 0n,
      totalClaimed: maxReturn, // fully repaid → nftValue ≈ 0
      yieldCapBps: 4000n,
      propertyId: 1,
      trancheType: 0,
      isSplit: false,
      splitDepth: 0,
    });

    // processReport now sees lower totalAssets → loss
    const [profit, loss] = await vault.processReport.staticCall(await strategy.getAddress());
    console.log("[DEBUG] profit:", ethers.formatUnits(profit, 18), "loss:", ethers.formatUnits(loss, 18));
    expect(loss).to.be.gt(0);
    expect(profit).to.equal(0);

    await vault.connect(admin).processReport(await strategy.getAddress());
    const priceAfter = await vault.sharePrice();
    console.log("[DEBUG] sharePrice after loss:", priceAfter.toString());
    expect(priceAfter).to.be.lt(priceBefore);
  });

  // ═══════════════════════════════════════════════════════════
  // Test 5: withdrawFromStrategy pulls harvested idle USDT
  // ═══════════════════════════════════════════════════════════

  it("withdrawFromStrategy pulls harvested idle USDT", async function () {
    console.log("[DEBUG] test: withdrawFromStrategy");
    const dep = ethers.parseUnits("50000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);
    await deployFundsToStrategy(dep);

    // The strategy now has 50k idle USDT. Withdraw it back.
    const vaultBalBefore = await usdc.balanceOf(vaultAddr);
    await vault.connect(admin).withdrawFromStrategy(await strategy.getAddress(), dep);
    const vaultBalAfter = await usdc.balanceOf(vaultAddr);

    console.log("[DEBUG] vault balance before:", ethers.formatUnits(vaultBalBefore, 18));
    console.log("[DEBUG] vault balance after:", ethers.formatUnits(vaultBalAfter, 18));
    expect(vaultBalAfter - vaultBalBefore).to.equal(dep);

    const totalDebt = await vault.totalDebt();
    console.log("[DEBUG] totalDebt after withdraw:", totalDebt.toString());
    expect(totalDebt).to.equal(0);
  });

  // ═══════════════════════════════════════════════════════════
  // Test 6: partial withdraw when strategy is illiquid
  // ═══════════════════════════════════════════════════════════

  it("partial withdraw when strategy is illiquid (NFTs lock funds)", async function () {
    console.log("[DEBUG] test: partial withdraw illiquid");
    const dep = ethers.parseUnits("50000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);
    await deployFundsToStrategy(dep);

    // "Spend" 40k into NFTs by removing USDT from strategy
    // Simulate: strategy sent 40k to property vault, got NFT back
    // We'll transfer USDT out and add NFT value
    const spent = ethers.parseUnits("40000", 18);
    const strategyAddr = await strategy.getAddress();

    // Impersonate strategy to transfer USDT out (simulating property deposit)
    await ethers.provider.send("hardhat_impersonateAccount", [strategyAddr]);
    const strategySigner = await ethers.getSigner(strategyAddr);
    await ethers.provider.send("hardhat_setBalance", [strategyAddr, "0xDE0B6B3A7640000"]);
    await usdc.connect(strategySigner).transfer(adminAddr, spent);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [strategyAddr]);

    // Add NFT worth 40k
    await mintAndTrackNft(spent, 0n, 0n, 4000n);

    // Strategy now has 10k idle + 40k in NFTs = 50k total
    const stratTotal = await strategy.totalAssets();
    console.log("[DEBUG] strategy totalAssets:", ethers.formatUnits(stratTotal, 18));
    expect(stratTotal).to.equal(dep);

    // Vault tries to withdraw full 50k, but only 10k is idle
    const vaultBalBefore = await usdc.balanceOf(vaultAddr);
    // RealEstateStrategy.withdraw caps at available balance
    await vault.connect(admin).withdrawFromStrategy(await strategy.getAddress(), dep);
    const vaultBalAfter = await usdc.balanceOf(vaultAddr);

    const received = vaultBalAfter - vaultBalBefore;
    const idle = dep - spent; // 10k
    console.log("[DEBUG] received:", ethers.formatUnits(received, 18), "idle was:", ethers.formatUnits(idle, 18));
    expect(received).to.equal(idle);
  });

  // ═══════════════════════════════════════════════════════════
  // Test 7: full lifecycle E2E
  // ═══════════════════════════════════════════════════════════

  it("full lifecycle: deposit → deploy → NFT yield → harvest → processReport → withdraw → redeem", async function () {
    console.log("[DEBUG] test: full lifecycle E2E");

    // 1. User deposits
    const dep = ethers.parseUnits("100000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);
    const sharesAfterDeposit = await vault.balanceOf(user1Addr);
    console.log("[DEBUG] 1. deposited, shares:", sharesAfterDeposit.toString());

    // 2. Deploy to strategy
    const deployAmount = ethers.parseUnits("80000", 18);
    await deployFundsToStrategy(deployAmount);
    console.log("[DEBUG] 2. deployed 80k to strategy");

    // 3. Add NFTs (simulating property deposits from strategy's idle funds)
    const invested = ethers.parseUnits("60000", 18);
    const nftId = await mintAndTrackNft(invested, 0n, 0n, 4000n);

    // 4. Simulate yield accrual on NFT
    const owed = ethers.parseUnits("5000", 18);
    await mockNFT.setPosition(nftId, {
      amountInvested: invested,
      amountOwed: owed,
      totalClaimed: 0n,
      yieldCapBps: 4000n,
      propertyId: 1,
      trancheType: 0,
      isSplit: false,
      splitDepth: 0,
    });

    // 5. Harvest yield
    await mockMaster.setClaimableAmount(nftId, owed);
    await usdc.mint(await mockMaster.getAddress(), owed);
    await strategy.connect(admin).harvest();
    console.log("[DEBUG] 5. harvested yield");

    // Update position after claim
    await mockNFT.setPosition(nftId, {
      amountInvested: invested,
      amountOwed: 0n,
      totalClaimed: owed,
      yieldCapBps: 4000n,
      propertyId: 1,
      trancheType: 0,
      isSplit: false,
      splitDepth: 0,
    });

    // 6. processReport — vault recognizes the yield
    const priceBefore = await vault.sharePrice();
    await vault.connect(admin).processReport(await strategy.getAddress());
    const priceAfter = await vault.sharePrice();
    console.log("[DEBUG] 6. processReport — price:", priceBefore.toString(), "→", priceAfter.toString());
    expect(priceAfter).to.be.gt(priceBefore);

    // 7. Withdraw ALL idle from strategy back to vault (needed for fulfillRedeem)
    const strategyAddr = await strategy.getAddress();
    const config = await vault.strategies(strategyAddr);
    const stratIdle = await usdc.balanceOf(strategyAddr);
    const withdrawable = stratIdle < config.currentDebt ? stratIdle : config.currentDebt;
    console.log("[DEBUG] 7. strategy idle:", ethers.formatUnits(stratIdle, 18), "currentDebt:", ethers.formatUnits(config.currentDebt, 18));
    if (withdrawable > 0n) {
      await vault.connect(admin).withdrawFromStrategy(strategyAddr, withdrawable);
      console.log("[DEBUG] 7. withdrew from strategy:", ethers.formatUnits(withdrawable, 18));
    }

    // 8. User redeems shares — only redeem what the vault can cover
    const userShares = await vault.balanceOf(user1Addr);
    // Estimate how much the vault can cover from idle
    const vaultBal = await usdc.balanceOf(vaultAddr);
    const totalClaimable = await vault.totalClaimableWithdrawals();
    const availableForFulfill = vaultBal > totalClaimable ? vaultBal - totalClaimable : 0n;
    console.log("[DEBUG] 8. vault balance:", ethers.formatUnits(vaultBal, 18), "available:", ethers.formatUnits(availableForFulfill, 18));

    // Request partial redeem — only what can be fulfilled
    const totalAssets = await vault.totalAssets();
    const totalSupply = await vault.totalSupply();
    // Calculate max shares that map to available assets
    const maxSharesForAvailable = totalSupply > 0n ? availableForFulfill * totalSupply / totalAssets : 0n;
    const sharesToRedeem = maxSharesForAvailable < userShares ? maxSharesForAvailable : userShares;
    console.log("[DEBUG] 8. redeeming shares:", sharesToRedeem.toString(), "of", userShares.toString());

    await vault.connect(user1).requestRedeem(sharesToRedeem, user1Addr, user1Addr);
    await vault.connect(admin).fulfillRedeem(user1Addr);
    const claimable = await vault.claimableWithdrawals(user1Addr);
    console.log("[DEBUG] 8. claimable:", ethers.formatUnits(claimable, 18));
    expect(claimable).to.be.gt(0);

    const claimShares = await vault.claimableWithdrawalShares(user1Addr);
    const user1BalBefore = await usdc.balanceOf(user1Addr);
    await vault.connect(user1).redeem(claimShares, user1Addr, user1Addr);
    const user1BalAfter = await usdc.balanceOf(user1Addr);
    console.log("[DEBUG] 8. user received:", ethers.formatUnits(user1BalAfter - user1BalBefore, 18));
  });

  // ═══════════════════════════════════════════════════════════
  // Test 8: multi-user profit sharing
  // ═══════════════════════════════════════════════════════════

  it("multi-user: profit shared proportionally via share price", async function () {
    console.log("[DEBUG] test: multi-user profit sharing");

    // User1 deposits first
    const dep1 = ethers.parseUnits("100000", 18);
    await vault.connect(user1).deposit(dep1, user1Addr);
    const shares1 = await vault.balanceOf(user1Addr);

    // Deploy to strategy
    await deployFundsToStrategy(dep1);

    // Add NFT profit
    const invested = ethers.parseUnits("80000", 18);
    await mintAndTrackNft(invested, 0n, 0n, 4000n);

    // processReport → share price goes up
    await vault.connect(admin).processReport(await strategy.getAddress());
    const priceAfterProfit = await vault.sharePrice();
    console.log("[DEBUG] price after profit:", priceAfterProfit.toString());

    // User2 deposits at higher price
    const dep2 = ethers.parseUnits("100000", 18);
    await vault.connect(user2).deposit(dep2, user2Addr);
    const shares2 = await vault.balanceOf(user2Addr);
    console.log("[DEBUG] user1 shares:", shares1.toString(), "user2 shares:", shares2.toString());

    // User2 got fewer shares because price is higher
    expect(shares2).to.be.lt(shares1);

    // More profit
    const moreInvested = ethers.parseUnits("50000", 18);
    await mintAndTrackNft(moreInvested, 0n, 0n, 4000n);
    await vault.connect(admin).processReport(await strategy.getAddress());

    // Both users benefit proportionally
    const user1Value = await vault.convertToAssets(shares1);
    const user2Value = await vault.convertToAssets(shares2);
    console.log("[DEBUG] user1 value:", ethers.formatUnits(user1Value, 18));
    console.log("[DEBUG] user2 value:", ethers.formatUnits(user2Value, 18));

    // User1 should have more value (deposited earlier, got more shares)
    expect(user1Value).to.be.gt(user2Value);
    // But both should have gained relative to their deposits
    expect(user1Value).to.be.gt(dep1);
  });

  // ═══════════════════════════════════════════════════════════
  // Test 9: large loss triggers emergency shutdown
  // ═══════════════════════════════════════════════════════════

  it("large loss triggers emergency shutdown via processReport", async function () {
    console.log("[DEBUG] test: emergency shutdown on large loss");
    const dep = ethers.parseUnits("100000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);

    // Deploy 80% to strategy
    const deployAmount = ethers.parseUnits("80000", 18);
    await deployFundsToStrategy(deployAmount);

    // Report >50% loss — remove most of the strategy's USDT
    const strategyAddr = await strategy.getAddress();
    const stratBal = await usdc.balanceOf(strategyAddr);

    // Transfer 90% of strategy funds away (simulating catastrophic loss)
    const lossAmount = stratBal * 90n / 100n;
    await ethers.provider.send("hardhat_impersonateAccount", [strategyAddr]);
    const strategySigner = await ethers.getSigner(strategyAddr);
    await ethers.provider.send("hardhat_setBalance", [strategyAddr, "0xDE0B6B3A7640000"]);
    await usdc.connect(strategySigner).transfer(adminAddr, lossAmount);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [strategyAddr]);

    // processReport → loss > 50% of currentDebt → emergency shutdown
    const shutdownBefore = await vault.emergencyShutdown();
    expect(shutdownBefore).to.be.false;

    await expect(vault.connect(admin).processReport(await strategy.getAddress()))
      .to.emit(vault, "EmergencyShutdownTriggered");

    const shutdownAfter = await vault.emergencyShutdown();
    console.log("[DEBUG] emergencyShutdown:", shutdownAfter);
    expect(shutdownAfter).to.be.true;

    // Deposits should be blocked
    await expect(vault.connect(user2).deposit(ethers.parseUnits("1000", 18), user2Addr))
      .to.be.reverted;

    console.log("[DEBUG] Emergency shutdown correctly triggered and blocks deposits");
  });
});
