import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

const DEPOSIT_LIMIT = ethers.parseUnits("1000000", 18);
const SHARE_SCALE = 1_000_000n;

describe("TulpeaYieldVault — ERC4626 Invariants", function () {
  let vault: Contract;
  let usdc: Contract;
  let mockStrategy: Contract;
  let admin: Signer;
  let user1: Signer;
  let user2: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let user2Addr: string;
  let vaultAddr: string;

  async function deployFixture() {
    console.log("[DEBUG] erc4626 invariants deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    user2 = signers[2];
    adminAddr = await admin.getAddress();
    user1Addr = await user1.getAddress();
    user2Addr = await user2.getAddress();

    // Deploy USDC
    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

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

    // Deploy MockStrategy
    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    mockStrategy = await MockStrategy.deploy(await usdc.getAddress());
    await mockStrategy.waitForDeployment();

    // Mint USDC and approve for users
    const mintAmount = ethers.parseUnits("500000", 18);
    await usdc.mint(user1Addr, mintAmount);
    await usdc.mint(user2Addr, mintAmount);
    await usdc.connect(user1).approve(vaultAddr, ethers.MaxUint256);
    await usdc.connect(user2).approve(vaultAddr, ethers.MaxUint256);

    // Disable health check — invariant tests exercise large losses
    await vault.connect(admin).setHealthCheck(10000, 10000, false);
    console.log("[DEBUG] erc4626 invariants deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // Helper: deploy funds to strategy via timelock
  async function deployToStrategy(amount: bigint) {
    console.log("[DEBUG] deployToStrategy:", ethers.formatUnits(amount, 18));
    await vault.connect(admin).addStrategy(await mockStrategy.getAddress());

    const deployId = await vault.connect(admin).requestDeploy.staticCall(
      await mockStrategy.getAddress(), amount
    );
    await vault.connect(admin).requestDeploy(await mockStrategy.getAddress(), amount);
    await ethers.provider.send("evm_increaseTime", [86401]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(deployId);

    // Sync mock strategy totalAssets
    await mockStrategy.setTotalAssets(amount);
    console.log("[DEBUG] deployed to strategy, totalDebt:", (await vault.totalDebt()).toString());
  }

  // ═══════════════════════════════════════════════════════════
  // INV: convertToShares(convertToAssets(shares)) <= shares
  // ═══════════════════════════════════════════════════════════

  it("convertToShares(convertToAssets(shares)) <= shares (roundtrip favors vault)", async function () {
    console.log("[DEBUG] test: shares roundtrip invariant");

    // Test at 1:1 price
    const dep1 = ethers.parseUnits("10000", 18);
    await vault.connect(user1).deposit(dep1, user1Addr);

    const testShares = ethers.parseUnits("1000", 18) * SHARE_SCALE;
    const assets1 = await vault.convertToAssets(testShares);
    const sharesBack1 = await vault.convertToShares(assets1);
    console.log("[DEBUG] 1:1 price — shares:", testShares.toString(), "→ assets:", assets1.toString(), "→ sharesBack:", sharesBack1.toString());
    expect(sharesBack1).to.be.lte(testShares);

    // Test after profit (share price > 1)
    await deployToStrategy(dep1);
    const profit = ethers.parseUnits("2000", 18);
    await mockStrategy.setTotalAssets(dep1 + profit);
    await vault.connect(admin).processReport(await mockStrategy.getAddress());

    const assets2 = await vault.convertToAssets(testShares);
    const sharesBack2 = await vault.convertToShares(assets2);
    console.log("[DEBUG] after profit — shares:", testShares.toString(), "→ assets:", assets2.toString(), "→ sharesBack:", sharesBack2.toString());
    expect(sharesBack2).to.be.lte(testShares);

    // Test after loss (share price < 1)
    const loss = ethers.parseUnits("5000", 18);
    await mockStrategy.setTotalAssets(dep1 + profit - loss);
    await vault.connect(admin).processReport(await mockStrategy.getAddress());

    const assets3 = await vault.convertToAssets(testShares);
    const sharesBack3 = await vault.convertToShares(assets3);
    console.log("[DEBUG] after loss — shares:", testShares.toString(), "→ assets:", assets3.toString(), "→ sharesBack:", sharesBack3.toString());
    expect(sharesBack3).to.be.lte(testShares);
  });

  // ═══════════════════════════════════════════════════════════
  // INV: convertToAssets(convertToShares(assets)) <= assets
  // ═══════════════════════════════════════════════════════════

  it("convertToAssets(convertToShares(assets)) <= assets (reverse roundtrip favors vault)", async function () {
    console.log("[DEBUG] test: assets roundtrip invariant");

    const dep1 = ethers.parseUnits("10000", 18);
    await vault.connect(user1).deposit(dep1, user1Addr);

    const testAssets = ethers.parseUnits("1000", 18);

    // At 1:1 price
    const shares1 = await vault.convertToShares(testAssets);
    const assetsBack1 = await vault.convertToAssets(shares1);
    console.log("[DEBUG] 1:1 — assets:", testAssets.toString(), "→ shares:", shares1.toString(), "→ assetsBack:", assetsBack1.toString());
    expect(assetsBack1).to.be.lte(testAssets);

    // After profit
    await deployToStrategy(dep1);
    const profit = ethers.parseUnits("2000", 18);
    await mockStrategy.setTotalAssets(dep1 + profit);
    await vault.connect(admin).processReport(await mockStrategy.getAddress());

    const shares2 = await vault.convertToShares(testAssets);
    const assetsBack2 = await vault.convertToAssets(shares2);
    console.log("[DEBUG] after profit — assets:", testAssets.toString(), "→ shares:", shares2.toString(), "→ assetsBack:", assetsBack2.toString());
    expect(assetsBack2).to.be.lte(testAssets);

    // After loss
    const loss = ethers.parseUnits("5000", 18);
    await mockStrategy.setTotalAssets(dep1 + profit - loss);
    await vault.connect(admin).processReport(await mockStrategy.getAddress());

    const shares3 = await vault.convertToShares(testAssets);
    const assetsBack3 = await vault.convertToAssets(shares3);
    console.log("[DEBUG] after loss — assets:", testAssets.toString(), "→ shares:", shares3.toString(), "→ assetsBack:", assetsBack3.toString());
    expect(assetsBack3).to.be.lte(testAssets);
  });

  // ═══════════════════════════════════════════════════════════
  // INV: totalSupply == 0 implies totalAssets == 0
  // ═══════════════════════════════════════════════════════════

  it("totalSupply == 0 implies totalAssets == 0 (initial + after full redemption)", async function () {
    console.log("[DEBUG] test: totalSupply=0 → totalAssets=0");

    // Initial state: no deposits
    const supplyBefore = await vault.totalSupply();
    const assetsBefore = await vault.totalAssets();
    console.log("[DEBUG] initial — supply:", supplyBefore.toString(), "assets:", assetsBefore.toString());
    expect(supplyBefore).to.equal(0);
    expect(assetsBefore).to.equal(0);

    // Deposit, then full redemption cycle
    const dep = ethers.parseUnits("10000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);
    const shares = await vault.balanceOf(user1Addr);
    console.log("[DEBUG] deposited, shares:", shares.toString());

    // Step 1: requestRedeem
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);

    // Step 2: fulfillRedeem
    await vault.connect(admin).fulfillRedeem(user1Addr);

    // Step 3: redeem/claim
    const claimableShares = await vault.claimableWithdrawalShares(user1Addr);
    await vault.connect(user1).redeem(claimableShares, user1Addr, user1Addr);

    const supplyAfter = await vault.totalSupply();
    const assetsAfter = await vault.totalAssets();
    console.log("[DEBUG] after full redeem — supply:", supplyAfter.toString(), "assets:", assetsAfter.toString());
    expect(supplyAfter).to.equal(0);
    expect(assetsAfter).to.equal(0);
  });

  // ═══════════════════════════════════════════════════════════
  // INV: share price monotonicity (only explicit loss decreases)
  // ═══════════════════════════════════════════════════════════

  it("share price only decreases on explicit loss report", async function () {
    console.log("[DEBUG] test: share price monotonicity");

    const dep = ethers.parseUnits("50000", 18);
    await vault.connect(user1).deposit(dep, user1Addr);

    // Record initial share price
    const price0 = await vault.sharePrice();
    console.log("[DEBUG] price0 (initial):", price0.toString());

    // Deploy to strategy
    await deployToStrategy(dep);

    // processReport with profit → price should increase
    const profit = ethers.parseUnits("5000", 18);
    await mockStrategy.setTotalAssets(dep + profit);
    await vault.connect(admin).processReport(await mockStrategy.getAddress());
    const price1 = await vault.sharePrice();
    console.log("[DEBUG] price1 (after profit):", price1.toString());
    expect(price1).to.be.gte(price0);

    // User2 deposits at new price
    const dep2 = ethers.parseUnits("20000", 18);
    await vault.connect(user2).deposit(dep2, user2Addr);
    const price2 = await vault.sharePrice();
    console.log("[DEBUG] price2 (after user2 deposit):", price2.toString());
    // Deposit should not decrease price (may increase slightly due to rounding)
    expect(price2).to.be.gte(price1 - 1n); // allow 1 wei rounding

    // requestRedeem + fulfillRedeem + claim → price should NOT decrease
    const user2Shares = await vault.balanceOf(user2Addr);
    await vault.connect(user2).requestRedeem(user2Shares, user2Addr, user2Addr);
    const price3 = await vault.sharePrice();
    console.log("[DEBUG] price3 (after requestRedeem):", price3.toString());
    expect(price3).to.be.gte(price2 - 1n);

    await vault.connect(admin).fulfillRedeem(user2Addr);
    const price4 = await vault.sharePrice();
    console.log("[DEBUG] price4 (after fulfillRedeem):", price4.toString());
    expect(price4).to.be.gte(price3 - 1n);

    const claimShares = await vault.claimableWithdrawalShares(user2Addr);
    await vault.connect(user2).redeem(claimShares, user2Addr, user2Addr);
    const price5 = await vault.sharePrice();
    console.log("[DEBUG] price5 (after claim):", price5.toString());
    expect(price5).to.be.gte(price4 - 1n);

    // processReport with loss → price SHOULD decrease
    const loss = ethers.parseUnits("10000", 18);
    const currentDebt = dep + profit; // strategy still holds deployed funds
    await mockStrategy.setTotalAssets(currentDebt - loss);
    await vault.connect(admin).processReport(await mockStrategy.getAddress());
    const price6 = await vault.sharePrice();
    console.log("[DEBUG] price6 (after loss):", price6.toString());
    expect(price6).to.be.lt(price5);
  });
});
