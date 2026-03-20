import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — E2E", function () {
  let vault: Contract;
  let usdc: Contract;
  let mockStrategy: Contract;
  let admin: Signer;
  let user1: Signer;
  let user2: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let user2Addr: string;
  let strategyAddr: string;

  const ONE_DAY = 24 * 60 * 60;

  async function deployFixture() {
    console.log("[DEBUG] deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    user2 = signers[2];
    adminAddr = await admin.getAddress();
    user1Addr = await user1.getAddress();
    user2Addr = await user2.getAddress();

    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory("TulpeaYieldVault");
    const vaultImpl = await VaultFactory.deploy();
    await vaultImpl.waitForDeployment();

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967ProxyWrapper");
    const initData = VaultFactory.interface.encodeFunctionData("initialize", [
      await usdc.getAddress(), adminAddr, ethers.parseUnits("1000000", 18), "Tulpea Yield Vault", "tyvUSDC", ethers.ZeroAddress,
    ]);
    const proxy = await ERC1967Proxy.deploy(await vaultImpl.getAddress(), initData);
    await proxy.waitForDeployment();
    vault = VaultFactory.attach(await proxy.getAddress()) as Contract;

    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    mockStrategy = await MockStrategy.deploy(await usdc.getAddress());
    await mockStrategy.waitForDeployment();
    strategyAddr = await mockStrategy.getAddress();

    await vault.connect(admin).addStrategy(strategyAddr);

    const mintAmount = ethers.parseUnits("200000", 18);
    await usdc.mint(user1Addr, mintAmount);
    await usdc.mint(user2Addr, mintAmount);
    await usdc.mint(adminAddr, mintAmount);

    const vaultAddr = await vault.getAddress();
    await usdc.connect(user1).approve(vaultAddr, ethers.MaxUint256);
    await usdc.connect(user2).approve(vaultAddr, ethers.MaxUint256);
    await usdc.connect(admin).approve(vaultAddr, ethers.MaxUint256);

    // Disable health check — E2E tests exercise large losses that exceed default 1% limit
    await vault.connect(admin).setHealthCheck(10000, 10000, false);
    console.log("[DEBUG] deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  it("full lifecycle: deposit → deploy → yield → withdraw → claim", async function () {
    console.log("[DEBUG] === E2E: Full Lifecycle ===");

    // 1. Users deposit
    console.log("[DEBUG] Step 1: Deposits");
    await vault.connect(user1).deposit(ethers.parseUnits("50000", 18), user1Addr);
    await vault.connect(user2).deposit(ethers.parseUnits("50000", 18), user2Addr);
    expect(await vault.totalAssets()).to.equal(ethers.parseUnits("100000", 18));
    const vaultAddr = await vault.getAddress();
    expect(await usdc.balanceOf(vaultAddr)).to.equal(ethers.parseUnits("100000", 18));

    // 2. Deploy to strategy
    console.log("[DEBUG] Step 2: Deploy to strategy");
    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("80000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);

    expect(await usdc.balanceOf(vaultAddr)).to.equal(ethers.parseUnits("20000", 18));
    expect(await vault.totalDebt()).to.equal(ethers.parseUnits("80000", 18));

    // 3. Strategy earns yield
    console.log("[DEBUG] Step 3: Process report (5% yield)");
    await mockStrategy.setTotalAssets(ethers.parseUnits("84000", 18)); // +4k profit (5%)
    await vault.processReport(strategyAddr);

    expect(await vault.totalDebt()).to.equal(ethers.parseUnits("84000", 18));
    expect(await vault.totalAssets()).to.equal(ethers.parseUnits("104000", 18));

    const sharePrice = await vault.sharePrice();
    console.log("[DEBUG] Share price after yield:", sharePrice.toString());
    expect(sharePrice).to.be.gt(ethers.parseUnits("1", 18)); // > 1.0

    // 4. Withdraw funds from strategy for liquidity
    // Mint the profit amount to strategy so it can transfer the full 84k
    console.log("[DEBUG] Step 4: Withdraw from strategy");
    await usdc.mint(strategyAddr, ethers.parseUnits("4000", 18)); // simulate real profit earned
    await vault.connect(admin).withdrawFromStrategy(strategyAddr, ethers.parseUnits("84000", 18));
    expect(await usdc.balanceOf(vaultAddr)).to.equal(ethers.parseUnits("104000", 18));
    expect(await vault.totalDebt()).to.equal(0);

    // 5. User1 requests redeem
    console.log("[DEBUG] Step 5: User1 requestRedeem");
    const user1Shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(user1Shares, user1Addr, user1Addr);
    const user1PendingEstimate = await vault.convertToAssets(await vault.pendingRedeemRequest(0, user1Addr));
    console.log("[DEBUG] User1 pending estimate:", user1PendingEstimate.toString());
    expect(user1PendingEstimate).to.be.gt(ethers.parseUnits("50000", 18)); // > original deposit

    // 6. Admin fulfills
    console.log("[DEBUG] Step 6: Fulfill redeem");
    await vault.connect(admin).fulfillRedeem(user1Addr);
    const user1Pending = await vault.claimableWithdrawals(user1Addr);
    expect(user1Pending).to.be.gt(ethers.parseUnits("50000", 18));

    // 7. User1 claims
    console.log("[DEBUG] Step 7: User1 claims");
    const balBefore = await usdc.balanceOf(user1Addr);
    await vault.connect(user1).withdraw(user1Pending, user1Addr, user1Addr);
    const balAfter = await usdc.balanceOf(user1Addr);
    console.log("[DEBUG] User1 received:", (balAfter - balBefore).toString());
    expect(balAfter - balBefore).to.equal(user1Pending);

    // 8. User2 also redeems
    console.log("[DEBUG] Step 8: User2 full cycle");
    const user2Shares = await vault.balanceOf(user2Addr);
    await vault.connect(user2).requestRedeem(user2Shares, user2Addr, user2Addr);
    await vault.connect(admin).fulfillRedeem(user2Addr);
    const user2Claimable = await vault.claimableWithdrawals(user2Addr);
    await vault.connect(user2).withdraw(user2Claimable, user2Addr, user2Addr);

    // Vault should be empty
    console.log("[DEBUG] Final state:");
    console.log("[DEBUG] totalAssets:", (await vault.totalAssets()).toString());
    console.log("[DEBUG] totalSupply:", (await vault.totalSupply()).toString());
    // Small dust may remain due to rounding
    expect(await vault.totalSupply()).to.be.lt(ethers.parseUnits("1", 18));
  });

  it("lifecycle with loss: deposit → deploy → loss → withdraw", async function () {
    console.log("[DEBUG] === E2E: Loss Lifecycle ===");

    // Deposit
    await vault.connect(user1).deposit(ethers.parseUnits("50000", 18), user1Addr);

    // Deploy
    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("40000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);
    await mockStrategy.setTotalAssets(ethers.parseUnits("40000", 18));

    // Loss
    await mockStrategy.setTotalAssets(ethers.parseUnits("30000", 18)); // -10k loss
    await vault.processReport(strategyAddr);

    expect(await vault.totalAssets()).to.equal(ethers.parseUnits("40000", 18)); // 10k idle + 30k debt

    // Withdraw from strategy
    await vault.connect(admin).withdrawFromStrategy(strategyAddr, ethers.parseUnits("30000", 18));

    // Redeem
    const shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
    const pendingEstimate = await vault.convertToAssets(await vault.pendingRedeemRequest(0, user1Addr));
    console.log("[DEBUG] pending estimate after loss:", pendingEstimate.toString());
    expect(pendingEstimate).to.be.lt(ethers.parseUnits("50000", 18)); // Less than deposited

    await vault.connect(admin).fulfillRedeem(user1Addr);
    const claimable = await vault.claimableWithdrawals(user1Addr);
    await vault.connect(user1).withdraw(claimable, user1Addr, user1Addr);
  });

  it("multiple deploy-report cycles", async function () {
    console.log("[DEBUG] === E2E: Multiple Cycles ===");

    await vault.connect(user1).deposit(ethers.parseUnits("100000", 18), user1Addr);

    // Cycle 1: Deploy, profit, withdraw
    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("50000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);
    await mockStrategy.setTotalAssets(ethers.parseUnits("52500", 18)); // +5% profit
    await vault.processReport(strategyAddr);
    // Mint the profit amount to strategy so it can transfer the full 52.5k
    await usdc.mint(strategyAddr, ethers.parseUnits("2500", 18)); // simulate real profit earned
    await vault.connect(admin).withdrawFromStrategy(strategyAddr, ethers.parseUnits("52500", 18));

    const ta1 = await vault.totalAssets();
    console.log("[DEBUG] totalAssets after cycle 1:", ta1.toString());

    // Cycle 2: Deploy again, more profit
    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("60000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(1);
    await mockStrategy.setTotalAssets(ethers.parseUnits("63000", 18)); // +5% profit
    await vault.processReport(strategyAddr);

    const ta2 = await vault.totalAssets();
    console.log("[DEBUG] totalAssets after cycle 2:", ta2.toString());
    expect(ta2).to.be.gt(ta1);
  });

  it("deposit after processReport should use new share price", async function () {
    console.log("[DEBUG] === E2E: Post-Profit Deposit ===");

    await vault.connect(user1).deposit(ethers.parseUnits("50000", 18), user1Addr);

    // Deploy and profit
    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("40000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);
    await mockStrategy.setTotalAssets(ethers.parseUnits("44000", 18)); // +10%
    await vault.processReport(strategyAddr);

    // User2 deposits after profit — should get fewer shares per USDC
    const user1Shares = await vault.balanceOf(user1Addr);
    await vault.connect(user2).deposit(ethers.parseUnits("50000", 18), user2Addr);
    const user2Shares = await vault.balanceOf(user2Addr);

    console.log("[DEBUG] user1 shares:", user1Shares.toString());
    console.log("[DEBUG] user2 shares:", user2Shares.toString());
    // User2 should get fewer shares than user1 (share price increased)
    expect(user2Shares).to.be.lt(user1Shares);
  });

  it("loss socialization E2E: pending user shares loss proportionally", async function () {
    console.log("[DEBUG] === E2E: Loss Socialization ===");

    // Two equal depositors
    await vault.connect(user1).deposit(ethers.parseUnits("50000", 18), user1Addr);
    await vault.connect(user2).deposit(ethers.parseUnits("50000", 18), user2Addr);

    // Deploy to strategy
    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("60000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);

    // User1 requests redeem
    const user1Shares = await vault.balanceOf(user1Addr);
    await vault.connect(user1).requestRedeem(user1Shares, user1Addr, user1Addr);

    // Loss occurs AFTER request but BEFORE fulfill
    await mockStrategy.setTotalAssets(ethers.parseUnits("48000", 18)); // -12k loss (20%)
    await vault.processReport(strategyAddr);

    // Withdraw from strategy to have idle
    await vault.connect(admin).withdrawFromStrategy(strategyAddr, ethers.parseUnits("48000", 18));

    // Fulfill — user1 should get ~40k (50k - 20% loss), NOT the original 50k
    await vault.connect(admin).fulfillRedeem(user1Addr);
    const user1Claimable = await vault.claimableWithdrawals(user1Addr);
    console.log("[DEBUG] user1 claimable:", user1Claimable.toString());
    expect(user1Claimable).to.be.lt(ethers.parseUnits("50000", 18));
    expect(user1Claimable).to.be.gt(ethers.parseUnits("35000", 18)); // Reasonable range

    // User2 also redeems — should also get reduced amount
    const user2Shares = await vault.balanceOf(user2Addr);
    await vault.connect(user2).requestRedeem(user2Shares, user2Addr, user2Addr);
    await vault.connect(admin).fulfillRedeem(user2Addr);
    const user2Claimable = await vault.claimableWithdrawals(user2Addr);
    console.log("[DEBUG] user2 claimable:", user2Claimable.toString());
    expect(user2Claimable).to.be.lt(ethers.parseUnits("50000", 18));

    // Both users should get approximately equal amounts (equal deposits, equal loss)
    const diff = user1Claimable > user2Claimable
      ? user1Claimable - user2Claimable
      : user2Claimable - user1Claimable;
    console.log("[DEBUG] diff between users:", diff.toString());
    // Allow small rounding difference
    expect(diff).to.be.lt(ethers.parseUnits("1", 18));
  });
});
