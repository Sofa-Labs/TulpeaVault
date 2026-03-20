import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

const DEPOSIT_LIMIT = ethers.parseUnits("1000000", 6);

describe("AvonStrategy — E2E with TulpeaYieldVault", function () {
  let vault: Contract;
  let usdt: Contract;
  let usdm: Contract;
  let router: Contract;
  let megaVault: Contract;
  let strategy: Contract;
  let admin: Signer;
  let user1: Signer;
  let user2: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let user2Addr: string;
  let vaultAddr: string;

  // Asset (USDT) = 6 decimals, _decimalsOffset = 6, so shares = 12 decimals
  const ASSET_DECIMALS = 6;
  const SHARE_DECIMALS = 12; // 6 + DECIMALS_OFFSET(6)

  async function deployFixture() {
    console.log("[DEBUG] e2e deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    user2 = signers[2];
    adminAddr = await admin.getAddress();
    user1Addr = await user1.getAddress();
    user2Addr = await user2.getAddress();

    // Deploy USDT (asset for vault and strategy) — 6 decimals
    const MockERC20 = await ethers.getContractFactory("MockUSDT6");
    usdt = await MockERC20.deploy();
    await usdt.waitForDeployment();
    console.log("[DEBUG] USDT deployed at:", await usdt.getAddress(), "decimals: 6");

    // Deploy USDm — 18 decimals
    const MockUSDm = await ethers.getContractFactory("MockUSDm");
    usdm = await MockUSDm.deploy();
    await usdm.waitForDeployment();
    console.log("[DEBUG] USDm deployed at:", await usdm.getAddress(), "decimals: 18");

    // Deploy MockSwapRouter + fund with reserves
    const RouterFactory = await ethers.getContractFactory("MockSwapRouter");
    router = await RouterFactory.deploy();
    await router.waitForDeployment();
    // No need to fund router — MockSwapRouter mints output tokens
    console.log("[DEBUG] MockSwapRouter deployed (mint-based)");

    // Deploy MockMegaVault
    const MegaVaultFactory = await ethers.getContractFactory("MockMegaVault");
    megaVault = await MegaVaultFactory.deploy(await usdm.getAddress());
    await megaVault.waitForDeployment();
    console.log("[DEBUG] MockMegaVault deployed at:", await megaVault.getAddress());

    // Deploy TulpeaYieldVault via proxy
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
    console.log("[DEBUG] Vault proxy at:", vaultAddr);

    // Deploy AvonStrategy with vault as the real vault address
    // The real TulpeaYieldVault implements keeper() so no mock needed here
    const StrategyFactory = await ethers.getContractFactory("AvonStrategy");
    strategy = await StrategyFactory.deploy(
      await usdt.getAddress(),
      await usdm.getAddress(),
      await megaVault.getAddress(),
      await router.getAddress(),
      vaultAddr,
      adminAddr
    );
    await strategy.waitForDeployment();
    console.log("[DEBUG] AvonStrategy deployed at:", await strategy.getAddress());

    // Register strategy in vault
    await vault.connect(admin).addStrategy(await strategy.getAddress());
    console.log("[DEBUG] Strategy registered in vault");

    // Relax vault health check — e2e tests simulate large 5-10% yield/loss swings
    await vault.connect(admin).setHealthCheck(10000, 10000, true);
    console.log("[DEBUG] Vault health check relaxed for e2e tests");

    // Mint USDT to users and approve vault (6 decimals)
    const mintAmount = ethers.parseUnits("500000", ASSET_DECIMALS);
    await usdt.mint(user1Addr, mintAmount);
    await usdt.mint(user2Addr, mintAmount);
    await usdt.connect(user1).approve(vaultAddr, ethers.MaxUint256);
    await usdt.connect(user2).approve(vaultAddr, ethers.MaxUint256);
    console.log("[DEBUG] Minted", ethers.formatUnits(mintAmount, ASSET_DECIMALS), "USDT to each user");

    console.log("[DEBUG] e2e deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // Helper: deploy funds via timelock
  async function deployFundsToStrategy(amount: bigint) {
    console.log("[DEBUG] deployFundsToStrategy:", ethers.formatUnits(amount, ASSET_DECIMALS), "USDT");
    const deployId = await vault.connect(admin).requestDeploy.staticCall(
      await strategy.getAddress(), amount
    );
    await vault.connect(admin).requestDeploy(await strategy.getAddress(), amount);
    await ethers.provider.send("evm_increaseTime", [86401]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(deployId);
    console.log("[DEBUG] funds deployed to strategy, totalDebt:", ethers.formatUnits(await vault.totalDebt(), ASSET_DECIMALS));
  }

  // ═══════════════════════════════════════════════════════════
  // Test 1: Vault deploys funds to strategy
  // ═══════════════════════════════════════════════════════════

  it("vault deploys funds to strategy via requestDeploy/executeDeploy", async function () {
    console.log("[DEBUG] test: vault deploys funds");
    const dep = ethers.parseUnits("50000", ASSET_DECIMALS);
    await vault.connect(user1).deposit(dep, user1Addr);
    console.log("[DEBUG] user1 deposited:", ethers.formatUnits(dep, ASSET_DECIMALS), "USDT");

    const stratBalBefore = await usdt.balanceOf(await strategy.getAddress());
    await deployFundsToStrategy(dep);
    const stratBalAfter = await usdt.balanceOf(await strategy.getAddress());

    console.log("[DEBUG] strategy received:", ethers.formatUnits(stratBalAfter - stratBalBefore, ASSET_DECIMALS), "USDT");
    expect(stratBalAfter - stratBalBefore).to.equal(dep);
    expect(await vault.totalDebt()).to.equal(dep);
  });

  // ═══════════════════════════════════════════════════════════
  // Test 2: Admin deposits strategy funds into MegaVault
  // ═══════════════════════════════════════════════════════════

  it("admin deposits into MegaVault via strategy.deposit()", async function () {
    console.log("[DEBUG] test: admin deposits into MegaVault");
    const dep = ethers.parseUnits("50000", ASSET_DECIMALS);
    await vault.connect(user1).deposit(dep, user1Addr);
    await deployFundsToStrategy(dep);

    // Admin triggers deposit into MegaVault
    await strategy.connect(admin).deposit(dep);

    const shares = await megaVault.balanceOf(await strategy.getAddress());
    const totalAssets = await strategy.totalAssets();
    console.log("[DEBUG] USDmY shares:", ethers.formatUnits(shares, 18));
    console.log("[DEBUG] strategy totalAssets:", ethers.formatUnits(totalAssets, ASSET_DECIMALS), "USDT");
    expect(shares).to.be.gt(0);
    // totalAssets is in USDT (6 decimals), allow 1 USDT tolerance
    expect(totalAssets).to.be.closeTo(dep, ethers.parseUnits("1", ASSET_DECIMALS));
  });

  // ═══════════════════════════════════════════════════════════
  // Test 3: Yield accrues → processReport detects profit
  // ═══════════════════════════════════════════════════════════

  it("yield accrues → processReport increases share price", async function () {
    console.log("[DEBUG] test: yield → processReport profit");
    const dep = ethers.parseUnits("100000", ASSET_DECIMALS);
    await vault.connect(user1).deposit(dep, user1Addr);
    await deployFundsToStrategy(dep);
    await strategy.connect(admin).deposit(dep);

    // 1 share in 12-decimal terms
    const oneShare = ethers.parseUnits("1", SHARE_DECIMALS);
    const priceBefore = await vault.convertToAssets(oneShare);
    console.log("[DEBUG] share price before yield:", ethers.formatUnits(priceBefore, ASSET_DECIMALS), "USDT/share");

    // Simulate 5% yield in MegaVault (USDm is 18 decimals)
    const yieldAmt = ethers.parseUnits("5000", 18);
    await megaVault.simulateYield(yieldAmt);
    console.log("[DEBUG] simulated yield:", ethers.formatUnits(yieldAmt, 18), "USDm");

    // processReport should detect profit
    await vault.connect(admin).processReport(await strategy.getAddress());

    const priceAfter = await vault.convertToAssets(oneShare);
    console.log("[DEBUG] share price after processReport:", ethers.formatUnits(priceAfter, ASSET_DECIMALS), "USDT/share");
    expect(priceAfter).to.be.gt(priceBefore);
  });

  // ═══════════════════════════════════════════════════════════
  // Test 4: Loss scenario → processReport detects loss
  // ═══════════════════════════════════════════════════════════

  it("loss scenario → processReport decreases share price", async function () {
    console.log("[DEBUG] test: loss → processReport");
    const dep = ethers.parseUnits("100000", ASSET_DECIMALS);
    await vault.connect(user1).deposit(dep, user1Addr);
    await deployFundsToStrategy(dep);
    await strategy.connect(admin).deposit(dep);

    const oneShare = ethers.parseUnits("1", SHARE_DECIMALS);
    const priceBefore = await vault.convertToAssets(oneShare);
    console.log("[DEBUG] share price before loss:", ethers.formatUnits(priceBefore, ASSET_DECIMALS), "USDT/share");

    // Simulate loss in MegaVault (USDm is 18 decimals)
    const lossAmt = ethers.parseUnits("5000", 18);
    await megaVault.simulateLoss(lossAmt);
    console.log("[DEBUG] simulated loss:", ethers.formatUnits(lossAmt, 18), "USDm");

    await vault.connect(admin).processReport(await strategy.getAddress());

    const priceAfter = await vault.convertToAssets(oneShare);
    console.log("[DEBUG] share price after loss:", ethers.formatUnits(priceAfter, ASSET_DECIMALS), "USDT/share");
    expect(priceAfter).to.be.lt(priceBefore);
  });

  // ═══════════════════════════════════════════════════════════
  // Test 5: withdrawFromStrategy pulls funds back
  // ═══════════════════════════════════════════════════════════

  it("withdrawFromStrategy pulls funds back through full chain", async function () {
    console.log("[DEBUG] test: withdrawFromStrategy");
    const dep = ethers.parseUnits("50000", ASSET_DECIMALS);
    await vault.connect(user1).deposit(dep, user1Addr);
    await deployFundsToStrategy(dep);
    await strategy.connect(admin).deposit(dep);

    const vaultBalBefore = await usdt.balanceOf(vaultAddr);
    const debtBefore = await vault.totalDebt();
    console.log("[DEBUG] vault balance before:", ethers.formatUnits(vaultBalBefore, ASSET_DECIMALS), "USDT");
    console.log("[DEBUG] debt before:", ethers.formatUnits(debtBefore, ASSET_DECIMALS), "USDT");

    // Pull funds back to vault (USDT amount, 6 decimals)
    const withdrawAmt = ethers.parseUnits("25000", ASSET_DECIMALS);
    await vault.connect(admin).withdrawFromStrategy(await strategy.getAddress(), withdrawAmt);

    const vaultBalAfter = await usdt.balanceOf(vaultAddr);
    const debtAfter = await vault.totalDebt();
    console.log("[DEBUG] vault balance change:", ethers.formatUnits(vaultBalAfter - vaultBalBefore, ASSET_DECIMALS), "USDT");
    console.log("[DEBUG] debt change:", ethers.formatUnits(debtBefore - debtAfter, ASSET_DECIMALS), "USDT");

    expect(vaultBalAfter).to.be.gt(vaultBalBefore);
    expect(debtAfter).to.be.lt(debtBefore);
  });

  // ═══════════════════════════════════════════════════════════
  // Test 6: Full user lifecycle
  // ═══════════════════════════════════════════════════════════

  it("full lifecycle: deposit → deploy → deposit → yield → processReport → requestRedeem → fulfillRedeem → redeem with profit", async function () {
    console.log("[DEBUG] test: full lifecycle");
    const dep = ethers.parseUnits("100000", ASSET_DECIMALS);

    // 1. User deposits into vault
    await vault.connect(user1).deposit(dep, user1Addr);
    const sharesBefore = await vault.balanceOf(user1Addr);
    console.log("[DEBUG] user1 vault shares:", ethers.formatUnits(sharesBefore, SHARE_DECIMALS));
    console.log("[DEBUG] user1 deposit:", ethers.formatUnits(dep, ASSET_DECIMALS), "USDT");

    // 2. Admin deploys funds to strategy
    await deployFundsToStrategy(dep);

    // 3. Admin deposits strategy funds into MegaVault
    await strategy.connect(admin).deposit(dep);

    // 4. Yield accrues (USDm is 18 decimals)
    const yieldAmt = ethers.parseUnits("10000", 18); // 10% yield
    await megaVault.simulateYield(yieldAmt);
    console.log("[DEBUG] simulated yield:", ethers.formatUnits(yieldAmt, 18), "USDm (10%)");

    // 5. processReport detects profit
    await vault.connect(admin).processReport(await strategy.getAddress());
    const userSharesNow = await vault.balanceOf(user1Addr);
    const userValue = await vault.convertToAssets(userSharesNow);
    console.log("[DEBUG] user value after yield:", ethers.formatUnits(userValue, ASSET_DECIMALS), "USDT");
    expect(userValue).to.be.gt(dep);

    // 6. User requests redeem
    const userShares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(userShares, user1Addr, user1Addr);
    console.log("[DEBUG] redeem requested for shares:", ethers.formatUnits(userShares, SHARE_DECIMALS));

    // 7. Admin pulls funds from strategy back to vault for fulfillment
    const totalAssetsInStrategy = await strategy.totalAssets();
    console.log("[DEBUG] totalAssetsInStrategy:", ethers.formatUnits(totalAssetsInStrategy, ASSET_DECIMALS), "USDT");
    await vault.connect(admin).withdrawFromStrategy(await strategy.getAddress(), totalAssetsInStrategy);

    // 8. Admin fulfills the redeem
    await vault.connect(admin).fulfillRedeem(user1Addr);

    // 9. User claims withdrawal via claimableWithdrawalShares
    const claimShares = await vault.claimableWithdrawalShares(user1Addr);
    const claimable = await vault.claimableWithdrawals(user1Addr);
    console.log("[DEBUG] claimable assets:", ethers.formatUnits(claimable, ASSET_DECIMALS), "USDT");
    console.log("[DEBUG] claimable shares:", ethers.formatUnits(claimShares, SHARE_DECIMALS));
    expect(claimable).to.be.gt(0);

    const user1BalBefore = await usdt.balanceOf(user1Addr);
    await vault.connect(user1).redeem(claimShares, user1Addr, user1Addr);
    const user1BalAfter = await usdt.balanceOf(user1Addr);

    const received = user1BalAfter - user1BalBefore;
    console.log("[DEBUG] user1 received:", ethers.formatUnits(received, ASSET_DECIMALS), "USDT");

    // User should have received more than they deposited (profit from yield)
    expect(received).to.be.gt(dep);
  });

  // ═══════════════════════════════════════════════════════════
  // Test 7: Multiple users share yield proportionally
  // ═══════════════════════════════════════════════════════════

  it("multiple users share yield proportionally", async function () {
    console.log("[DEBUG] test: proportional yield");
    const dep1 = ethers.parseUnits("100000", ASSET_DECIMALS);
    const dep2 = ethers.parseUnits("50000", ASSET_DECIMALS);

    // Both users deposit
    await vault.connect(user1).deposit(dep1, user1Addr);
    await vault.connect(user2).deposit(dep2, user2Addr);
    console.log("[DEBUG] user1 deposited:", ethers.formatUnits(dep1, ASSET_DECIMALS), "USDT");
    console.log("[DEBUG] user2 deposited:", ethers.formatUnits(dep2, ASSET_DECIMALS), "USDT");

    const totalDep = dep1 + dep2;

    // Deploy all to strategy
    await deployFundsToStrategy(totalDep);
    await strategy.connect(admin).deposit(totalDep);

    // Yield accrues (USDm is 18 decimals)
    const yieldAmt = ethers.parseUnits("15000", 18); // 10% of 150k
    await megaVault.simulateYield(yieldAmt);
    console.log("[DEBUG] simulated yield:", ethers.formatUnits(yieldAmt, 18), "USDm");
    await vault.connect(admin).processReport(await strategy.getAddress());

    // Check share prices are equal (both users benefit equally per share)
    const user1Shares = await vault.balanceOf(user1Addr);
    const user2Shares = await vault.balanceOf(user2Addr);
    const user1Value = await vault.convertToAssets(user1Shares);
    const user2Value = await vault.convertToAssets(user2Shares);

    console.log("[DEBUG] user1 value:", ethers.formatUnits(user1Value, ASSET_DECIMALS), "USDT");
    console.log("[DEBUG] user2 value:", ethers.formatUnits(user2Value, ASSET_DECIMALS), "USDT");
    console.log("[DEBUG] user1 shares:", ethers.formatUnits(user1Shares, SHARE_DECIMALS));
    console.log("[DEBUG] user2 shares:", ethers.formatUnits(user2Shares, SHARE_DECIMALS));

    // User1 deposited 2x, should have ~2x value
    const ratio = (user1Value * 100n) / user2Value;
    console.log("[DEBUG] value ratio (should be ~200):", ratio.toString());
    expect(ratio).to.be.closeTo(200n, 2n);
  });

  // ═══════════════════════════════════════════════════════════
  // Test 8: Keeper deposit integration via vault.keeper()
  // ═══════════════════════════════════════════════════════════

  it("vault keeper can deposit into MegaVault via strategy", async function () {
    console.log("[DEBUG] test: keeper deposit integration via vault.keeper()");
    const signers = await ethers.getSigners();
    const keeperSigner = signers[3];
    const keeperAddr = await keeperSigner.getAddress();

    // Set keeper on the real TulpeaYieldVault
    await vault.connect(admin).setKeeper(keeperAddr);
    console.log("[DEBUG] vault keeper set to:", keeperAddr);

    // Deposit as user, deploy to strategy
    const dep = ethers.parseUnits("50000", ASSET_DECIMALS);
    await vault.connect(user1).deposit(dep, user1Addr);
    await deployFundsToStrategy(dep);

    // Keeper triggers deposit into MegaVault
    await strategy.connect(keeperSigner).deposit(dep);

    const shares = await megaVault.balanceOf(await strategy.getAddress());
    console.log("[DEBUG] USDmY shares after keeper deposit:", ethers.formatUnits(shares, 18));
    expect(shares).to.be.gt(0);
  });

  it("non-keeper non-owner cannot deposit into strategy", async function () {
    console.log("[DEBUG] test: non-keeper rejected in e2e");
    const dep = ethers.parseUnits("50000", ASSET_DECIMALS);
    await vault.connect(user1).deposit(dep, user1Addr);
    await deployFundsToStrategy(dep);

    // user2 is neither owner nor keeper
    await expect(
      strategy.connect(user2).deposit(dep)
    ).to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");
    console.log("[DEBUG] non-keeper correctly rejected");
  });
});
