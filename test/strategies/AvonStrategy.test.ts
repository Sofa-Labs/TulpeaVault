import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("AvonStrategy — Unit Tests", function () {
  let strategy: Contract;
  let usdt: Contract;
  let usdm: Contract;
  let router: Contract;
  let megaVault: Contract;
  let mockVault: Contract;
  let admin: Signer;
  let user1: Signer;
  let keeper: Signer;
  let adminAddr: string;
  let vaultAddr: string;
  let keeperAddr: string;

  async function deployFixture() {
    console.log("[DEBUG] AvonStrategy deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    keeper = signers[2];
    adminAddr = await admin.getAddress();
    keeperAddr = await keeper.getAddress();

    // Deploy USDT (asset)
    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdt = await MockERC20.deploy();
    await usdt.waitForDeployment();
    console.log("[DEBUG] USDT deployed at:", await usdt.getAddress());

    // Deploy USDm (second MockUSDT instance)
    usdm = await MockERC20.deploy();
    await usdm.waitForDeployment();
    console.log("[DEBUG] USDm deployed at:", await usdm.getAddress());

    // Deploy MockSwapRouter
    const RouterFactory = await ethers.getContractFactory("MockSwapRouter");
    router = await RouterFactory.deploy();
    await router.waitForDeployment();
    console.log("[DEBUG] MockSwapRouter deployed at:", await router.getAddress());

    // No need to fund router — MockSwapRouter mints output tokens
    console.log("[DEBUG] Router ready (mint-based)");

    // Deploy MockMegaVault with USDm as underlying
    const VaultFactory = await ethers.getContractFactory("MockMegaVault");
    megaVault = await VaultFactory.deploy(await usdm.getAddress());
    await megaVault.waitForDeployment();
    console.log("[DEBUG] MockMegaVault deployed at:", await megaVault.getAddress());

    // Deploy MockVaultForStrategy (provides keeper() view)
    const MockVaultFactory = await ethers.getContractFactory("MockVaultForStrategy");
    mockVault = await MockVaultFactory.deploy();
    await mockVault.waitForDeployment();
    vaultAddr = await mockVault.getAddress();
    console.log("[DEBUG] MockVaultForStrategy deployed at:", vaultAddr);

    // Deploy AvonStrategy
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

    // Mint USDT to strategy (simulating vault deploy)
    const initialFunding = ethers.parseUnits("100000", 18);
    await usdt.mint(await strategy.getAddress(), initialFunding);
    console.log("[DEBUG] AvonStrategy deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // ═══════════════════════════════════════════════════════════
  // Constructor
  // ═══════════════════════════════════════════════════════════

  it("constructor sets immutables correctly", async function () {
    console.log("[DEBUG] test: constructor immutables");
    expect(await strategy.asset()).to.equal(await usdt.getAddress());
    expect(await strategy.usdm()).to.equal(await usdm.getAddress());
    expect(await strategy.megaVault()).to.equal(await megaVault.getAddress());
    expect(await strategy.swapRouter()).to.equal(await router.getAddress());
    expect(await strategy.vault()).to.equal(vaultAddr);
    expect(await strategy.owner()).to.equal(adminAddr);
  });

  it("constants are set correctly", async function () {
    console.log("[DEBUG] test: constants");
    expect(await strategy.MAX_SLIPPAGE_BPS()).to.equal(50);
    expect(await strategy.SWAP_FEE_TIER()).to.equal(100);
    expect(await strategy.SWAP_DEADLINE_BUFFER()).to.equal(300);
  });

  it("constructor rejects zero addresses", async function () {
    console.log("[DEBUG] test: constructor zero addresses");
    const StrategyFactory = await ethers.getContractFactory("AvonStrategy");
    const addrs = [
      await usdt.getAddress(),
      await usdm.getAddress(),
      await megaVault.getAddress(),
      await router.getAddress(),
      vaultAddr,
      adminAddr,
    ];

    for (let i = 0; i < addrs.length; i++) {
      const args = [...addrs];
      args[i] = ethers.ZeroAddress;
      console.log("[DEBUG] testing zero address at index", i);
      if (i === 5) {
        // owner_ zero address hits OZ's OwnableInvalidOwner before our ZeroAddress check
        await expect(StrategyFactory.deploy(...args)).to.be.revertedWithCustomError(
          strategy,
          "OwnableInvalidOwner"
        );
      } else {
        await expect(StrategyFactory.deploy(...args)).to.be.revertedWithCustomError(
          strategy,
          "ZeroAddress"
        );
      }
    }
  });

  it("constructor rejects asset == usdm", async function () {
    console.log("[DEBUG] test: constructor asset == usdm");
    const StrategyFactory = await ethers.getContractFactory("AvonStrategy");
    const usdmAddr = await usdm.getAddress();
    await expect(
      StrategyFactory.deploy(
        usdmAddr, // asset = usdm (same address!)
        usdmAddr,
        await megaVault.getAddress(),
        await router.getAddress(),
        vaultAddr,
        adminAddr
      )
    ).to.be.revertedWithCustomError(strategy, "InvalidConfiguration");
  });

  it("constructor rejects megaVault.asset() != usdm", async function () {
    console.log("[DEBUG] test: constructor megaVault asset mismatch");
    const StrategyFactory = await ethers.getContractFactory("AvonStrategy");
    // Deploy a MegaVault backed by USDT (not USDm)
    const VaultFactory = await ethers.getContractFactory("MockMegaVault");
    const wrongVault = await VaultFactory.deploy(await usdt.getAddress());
    await wrongVault.waitForDeployment();
    console.log("[DEBUG] wrongVault asset:", await wrongVault.asset());

    await expect(
      StrategyFactory.deploy(
        await usdt.getAddress(),
        await usdm.getAddress(),
        await wrongVault.getAddress(), // asset = USDT, not USDm
        await router.getAddress(),
        vaultAddr,
        adminAddr
      )
    ).to.be.revertedWithCustomError(strategy, "InvalidConfiguration");
  });

  it("constructor sets owner from owner_ param (not msg.sender)", async function () {
    console.log("[DEBUG] test: constructor owner_ param");
    const signers = await ethers.getSigners();
    const otherOwner = signers[3];
    const otherOwnerAddr = await otherOwner.getAddress();

    const StrategyFactory = await ethers.getContractFactory("AvonStrategy");
    const newStrategy = await StrategyFactory.connect(admin).deploy(
      await usdt.getAddress(),
      await usdm.getAddress(),
      await megaVault.getAddress(),
      await router.getAddress(),
      vaultAddr,
      otherOwnerAddr
    );
    await newStrategy.waitForDeployment();

    // Owner should be otherOwner, NOT admin (msg.sender)
    expect(await newStrategy.owner()).to.equal(otherOwnerAddr);
  });

  // ═══════════════════════════════════════════════════════════
  // totalAssets
  // ═══════════════════════════════════════════════════════════

  it("totalAssets returns idle USDT when no deposits", async function () {
    console.log("[DEBUG] test: totalAssets idle only");
    const idle = await usdt.balanceOf(await strategy.getAddress());
    const total = await strategy.totalAssets();
    console.log("[DEBUG] idle USDT:", ethers.formatUnits(idle, 18), "totalAssets:", ethers.formatUnits(total, 18));
    expect(total).to.equal(idle);
  });

  it("totalAssets includes USDmY value after deposit", async function () {
    console.log("[DEBUG] test: totalAssets after deposit");
    const depositAmt = ethers.parseUnits("50000", 18);
    await strategy.connect(admin).deposit(depositAmt);

    const total = await strategy.totalAssets();
    const idle = await usdt.balanceOf(await strategy.getAddress());
    console.log("[DEBUG] totalAssets after deposit:", ethers.formatUnits(total, 18));
    console.log("[DEBUG] idle USDT after deposit:", ethers.formatUnits(idle, 18));

    // Total should be ~100k: 50k idle USDT + 50k in MegaVault
    expect(total).to.be.closeTo(ethers.parseUnits("100000", 18), ethers.parseUnits("1", 18));
  });

  it("totalAssets increases after MegaVault yield", async function () {
    console.log("[DEBUG] test: totalAssets with yield");
    const depositAmt = ethers.parseUnits("50000", 18);
    await strategy.connect(admin).deposit(depositAmt);

    const totalBefore = await strategy.totalAssets();

    // Simulate 5% yield
    const yieldAmt = ethers.parseUnits("2500", 18);
    await megaVault.simulateYield(yieldAmt);

    const totalAfter = await strategy.totalAssets();
    console.log("[DEBUG] before yield:", ethers.formatUnits(totalBefore, 18));
    console.log("[DEBUG] after yield:", ethers.formatUnits(totalAfter, 18));
    expect(totalAfter).to.be.gt(totalBefore);
    expect(totalAfter - totalBefore).to.be.closeTo(yieldAmt, ethers.parseUnits("1", 18));
  });

  it("totalAssets includes idle USDm", async function () {
    console.log("[DEBUG] test: totalAssets with idle USDm");
    const usdmAmount = ethers.parseUnits("5000", 18);
    await usdm.mint(await strategy.getAddress(), usdmAmount);

    const total = await strategy.totalAssets();
    const idleUsdt = await usdt.balanceOf(await strategy.getAddress());
    console.log("[DEBUG] totalAssets:", ethers.formatUnits(total, 18));
    expect(total).to.equal(idleUsdt + usdmAmount);
  });

  it("totalAssets is ~0 after full withdrawal", async function () {
    console.log("[DEBUG] test: totalAssets after full withdrawal");
    const depositAmt = ethers.parseUnits("100000", 18);
    await strategy.connect(admin).deposit(depositAmt);

    // Withdraw all via vault impersonation
    await ethers.provider.send("hardhat_impersonateAccount", [vaultAddr]);
    const vaultSigner = await ethers.getSigner(vaultAddr);
    await admin.sendTransaction({ to: vaultAddr, value: ethers.parseEther("1") });

    await strategy.connect(vaultSigner).withdraw(depositAmt);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddr]);

    const total = await strategy.totalAssets();
    console.log("[DEBUG] totalAssets after full withdraw:", ethers.formatUnits(total, 18));
    // Should be near 0 (might have tiny dust)
    expect(total).to.be.lt(ethers.parseUnits("1", 18));
  });

  // ═══════════════════════════════════════════════════════════
  // Deposit
  // ═══════════════════════════════════════════════════════════

  it("deposit swaps USDT→USDm and deposits into MegaVault", async function () {
    console.log("[DEBUG] test: deposit flow");
    const depositAmt = ethers.parseUnits("10000", 18);
    const usdtBefore = await usdt.balanceOf(await strategy.getAddress());

    const tx = await strategy.connect(admin).deposit(depositAmt);
    const receipt = await tx.wait();
    console.log("[DEBUG] deposit gas used:", receipt.gasUsed.toString());

    const usdtAfter = await usdt.balanceOf(await strategy.getAddress());
    const shares = await megaVault.balanceOf(await strategy.getAddress());

    console.log("[DEBUG] USDT before:", ethers.formatUnits(usdtBefore, 18));
    console.log("[DEBUG] USDT after:", ethers.formatUnits(usdtAfter, 18));
    console.log("[DEBUG] USDmY shares:", ethers.formatUnits(shares, 18));

    expect(usdtBefore - usdtAfter).to.equal(depositAmt);
    expect(shares).to.be.gt(0);
  });

  it("deposit emits Deposited event", async function () {
    console.log("[DEBUG] test: deposit event");
    const depositAmt = ethers.parseUnits("5000", 18);
    await expect(strategy.connect(admin).deposit(depositAmt))
      .to.emit(strategy, "Deposited");
  });

  it("deposit reverts for non-owner non-keeper", async function () {
    console.log("[DEBUG] test: deposit only keeper/owner");
    const depositAmt = ethers.parseUnits("1000", 18);
    await expect(
      strategy.connect(user1).deposit(depositAmt)
    ).to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");
  });

  it("deposit reverts on zero amount", async function () {
    console.log("[DEBUG] test: deposit zero");
    await expect(
      strategy.connect(admin).deposit(0)
    ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
  });

  it("multiple deposits accumulate USDmY shares", async function () {
    console.log("[DEBUG] test: multiple deposits");
    const amt = ethers.parseUnits("10000", 18);

    await strategy.connect(admin).deposit(amt);
    const shares1 = await megaVault.balanceOf(await strategy.getAddress());
    console.log("[DEBUG] shares after 1st deposit:", ethers.formatUnits(shares1, 18));

    await strategy.connect(admin).deposit(amt);
    const shares2 = await megaVault.balanceOf(await strategy.getAddress());
    console.log("[DEBUG] shares after 2nd deposit:", ethers.formatUnits(shares2, 18));

    expect(shares2).to.be.gt(shares1);
  });

  it("deposit reverts when MegaVault deposit limit exceeded — uses USDm units post-swap", async function () {
    console.log("[DEBUG] test: deposit limit exceeded, verify atomicity + USDm-denominated check");
    const strategyAddr = await strategy.getAddress();

    // Set MegaVault max deposit to a small USDm value (post-swap limit)
    await megaVault.setMaxDeposit(ethers.parseUnits("100", 18));

    const depositAmt = ethers.parseUnits("10000", 18);
    const usdtBefore = await usdt.balanceOf(strategyAddr);
    console.log("[DEBUG] USDT balance before failed deposit:", ethers.formatUnits(usdtBefore, 18));

    // The check now happens AFTER the swap, comparing usdmReceived vs maxDeposit (both in USDm)
    await expect(
      strategy.connect(admin).deposit(depositAmt)
    ).to.be.revertedWithCustomError(strategy, "MegaVaultDepositLimitExceeded");

    // Verify USDT balance is fully preserved (atomic revert undoes the swap)
    const usdtAfter = await usdt.balanceOf(strategyAddr);
    console.log("[DEBUG] USDT balance after failed deposit:", ethers.formatUnits(usdtAfter, 18));
    expect(usdtAfter).to.equal(usdtBefore, "USDT balance must be unchanged after revert");
  });

  it("keeper can deposit", async function () {
    console.log("[DEBUG] test: keeper deposit via vault.keeper()");
    // Set keeper on the mock vault
    await mockVault.setKeeper(keeperAddr);
    console.log("[DEBUG] vault keeper set to:", keeperAddr);

    // Fund strategy with more USDT for keeper to deposit
    await usdt.mint(await strategy.getAddress(), ethers.parseUnits("10000", 18));

    const depositAmt = ethers.parseUnits("5000", 18);
    await expect(strategy.connect(keeper).deposit(depositAmt))
      .to.emit(strategy, "Deposited");
  });

  // ═══════════════════════════════════════════════════════════
  // Withdraw
  // ═══════════════════════════════════════════════════════════

  async function impersonateVault() {
    await ethers.provider.send("hardhat_impersonateAccount", [vaultAddr]);
    await admin.sendTransaction({ to: vaultAddr, value: ethers.parseEther("1") });
    return ethers.getSigner(vaultAddr);
  }

  async function stopImpersonatingVault() {
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddr]);
  }

  it("withdraw sends idle USDT without swapping", async function () {
    console.log("[DEBUG] test: withdraw idle shortcut");
    const withdrawAmt = ethers.parseUnits("10000", 18);
    const vaultSigner = await impersonateVault();

    const vaultBalBefore = await usdt.balanceOf(vaultAddr);
    await strategy.connect(vaultSigner).withdraw(withdrawAmt);
    const vaultBalAfter = await usdt.balanceOf(vaultAddr);
    await stopImpersonatingVault();

    console.log("[DEBUG] vault received:", ethers.formatUnits(vaultBalAfter - vaultBalBefore, 18));
    expect(vaultBalAfter - vaultBalBefore).to.equal(withdrawAmt);
  });

  it("withdraw redeems USDmY and swaps when idle insufficient", async function () {
    console.log("[DEBUG] test: withdraw redeem+swap path");
    // Deposit all idle USDT
    const depositAmt = ethers.parseUnits("100000", 18);
    await strategy.connect(admin).deposit(depositAmt);

    const idleAfterDeposit = await usdt.balanceOf(await strategy.getAddress());
    console.log("[DEBUG] idle after deposit:", ethers.formatUnits(idleAfterDeposit, 18));
    expect(idleAfterDeposit).to.equal(0);

    // Withdraw should redeem from MegaVault + swap
    const withdrawAmt = ethers.parseUnits("50000", 18);
    const vaultSigner = await impersonateVault();
    const vaultBalBefore = await usdt.balanceOf(vaultAddr);
    await strategy.connect(vaultSigner).withdraw(withdrawAmt);
    const vaultBalAfter = await usdt.balanceOf(vaultAddr);
    await stopImpersonatingVault();

    console.log("[DEBUG] vault received:", ethers.formatUnits(vaultBalAfter - vaultBalBefore, 18));
    expect(vaultBalAfter - vaultBalBefore).to.be.closeTo(withdrawAmt, ethers.parseUnits("500", 18));
  });

  it("withdraw partial — sends max available when requested > available", async function () {
    console.log("[DEBUG] test: withdraw partial");
    const requestAmt = ethers.parseUnits("200000", 18);
    const vaultSigner = await impersonateVault();

    const vaultBalBefore = await usdt.balanceOf(vaultAddr);
    await expect(strategy.connect(vaultSigner).withdraw(requestAmt))
      .to.emit(strategy, "Withdrawn");
    const vaultBalAfter = await usdt.balanceOf(vaultAddr);
    await stopImpersonatingVault();

    const received = vaultBalAfter - vaultBalBefore;
    console.log("[DEBUG] received:", ethers.formatUnits(received, 18));
    expect(received).to.be.gt(0);
    expect(received).to.be.lt(requestAmt);
  });

  it("withdraw reverts for non-vault caller", async function () {
    console.log("[DEBUG] test: withdraw only vault");
    await expect(
      strategy.connect(admin).withdraw(ethers.parseUnits("100", 18))
    ).to.be.revertedWithCustomError(strategy, "OnlyVault");
  });

  it("withdraw reverts on zero amount", async function () {
    console.log("[DEBUG] test: withdraw zero");
    const vaultSigner = await impersonateVault();
    await expect(
      strategy.connect(vaultSigner).withdraw(0)
    ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
    await stopImpersonatingVault();
  });

  it("withdraw emits Withdrawn event", async function () {
    console.log("[DEBUG] test: withdraw event");
    const vaultSigner = await impersonateVault();
    await expect(
      strategy.connect(vaultSigner).withdraw(ethers.parseUnits("1000", 18))
    ).to.emit(strategy, "Withdrawn");
    await stopImpersonatingVault();
  });

  it("full withdrawal empties all positions", async function () {
    console.log("[DEBUG] test: full withdrawal");
    // Deposit 50k into megavault, keep 50k idle
    await strategy.connect(admin).deposit(ethers.parseUnits("50000", 18));

    // Withdraw everything
    const totalBefore = await strategy.totalAssets();
    const vaultSigner = await impersonateVault();
    await strategy.connect(vaultSigner).withdraw(totalBefore);
    await stopImpersonatingVault();

    const totalAfter = await strategy.totalAssets();
    console.log("[DEBUG] totalAssets after full withdraw:", ethers.formatUnits(totalAfter, 18));
    expect(totalAfter).to.be.lt(ethers.parseUnits("1", 18));
  });

  it("BUG: withdraw reverts instead of sending idle USDT when MegaVault is empty", async function () {
    console.log("[DEBUG] test: withdraw with idle USDT but 0 MegaVault shares");
    const strategyAddr = await strategy.getAddress();

    // Fixture starts with 100k idle USDT, 0 MegaVault shares
    // Transfer out 95k via impersonation, leaving 5k idle
    const keepAmount = ethers.parseUnits("5000", 18);
    const burnAmount = ethers.parseUnits("95000", 18);

    await ethers.provider.send("hardhat_impersonateAccount", [strategyAddr]);
    // Fund strategy with ETH for gas (hardhat_setBalance avoids receive() issue)
    await ethers.provider.send("hardhat_setBalance", [strategyAddr, "0xDE0B6B3A7640000"]);
    const strategySigner = await ethers.getSigner(strategyAddr);
    await usdt.connect(strategySigner).transfer(adminAddr, burnAmount);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [strategyAddr]);

    const idleFinal = await usdt.balanceOf(strategyAddr);
    const sharesHeld = await megaVault.balanceOf(strategyAddr);
    console.log("[DEBUG] idle USDT:", ethers.formatUnits(idleFinal, 18), "MegaVault shares:", sharesHeld.toString());
    expect(idleFinal).to.equal(keepAmount);
    expect(sharesHeld).to.equal(0);

    // Withdraw 10k — strategy has 5k idle, 0 MegaVault shares
    // Should send 5k (partial), NOT revert
    const withdrawAmt = ethers.parseUnits("10000", 18);
    const vaultSigner = await impersonateVault();
    const vaultBalBefore = await usdt.balanceOf(vaultAddr);
    await strategy.connect(vaultSigner).withdraw(withdrawAmt);
    const vaultBalAfter = await usdt.balanceOf(vaultAddr);
    await stopImpersonatingVault();

    const received = vaultBalAfter - vaultBalBefore;
    console.log("[DEBUG] vault received:", ethers.formatUnits(received, 18));
    expect(received).to.equal(keepAmount); // Got the 5k that was available
  });

  // ═══════════════════════════════════════════════════════════
  // Admin
  // ═══════════════════════════════════════════════════════════

  it("swap parameters are hardcoded constants (no setters)", async function () {
    console.log("[DEBUG] test: swap params are constants");
    // Verify constants are accessible but not mutable
    expect(await strategy.MAX_SLIPPAGE_BPS()).to.equal(50);
    expect(await strategy.SWAP_FEE_TIER()).to.equal(100);
    expect(await strategy.SWAP_DEADLINE_BUFFER()).to.equal(300);
    // No setMaxSlippage, setSwapFeeTier, setSwapDeadlineBuffer functions exist
  });

  // ═══════════════════════════════════════════════════════════
  // Vault-Based Keeper Integration
  // ═══════════════════════════════════════════════════════════

  it("vault keeper can call deposit", async function () {
    console.log("[DEBUG] test: vault keeper can deposit");
    await mockVault.setKeeper(keeperAddr);

    await usdt.mint(await strategy.getAddress(), ethers.parseUnits("10000", 18));
    const depositAmt = ethers.parseUnits("5000", 18);
    await expect(strategy.connect(keeper).deposit(depositAmt))
      .to.emit(strategy, "Deposited");
    console.log("[DEBUG] vault keeper deposited successfully");
  });

  it("non-keeper non-owner cannot call deposit", async function () {
    console.log("[DEBUG] test: non-keeper cannot deposit");
    const depositAmt = ethers.parseUnits("1000", 18);
    // user1 is neither owner nor vault keeper
    await expect(
      strategy.connect(user1).deposit(depositAmt)
    ).to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");
  });

  it("changing vault keeper updates access", async function () {
    console.log("[DEBUG] test: changing vault keeper updates access");
    const signers = await ethers.getSigners();
    const newKeeper = signers[4];
    const newKeeperAddr = await newKeeper.getAddress();

    // Set keeper to keeper signer
    await mockVault.setKeeper(keeperAddr);
    await usdt.mint(await strategy.getAddress(), ethers.parseUnits("10000", 18));

    // keeper can deposit
    await strategy.connect(keeper).deposit(ethers.parseUnits("1000", 18));
    console.log("[DEBUG] original keeper deposited OK");

    // Change keeper to newKeeper
    await mockVault.setKeeper(newKeeperAddr);

    // Old keeper can no longer deposit
    await expect(
      strategy.connect(keeper).deposit(ethers.parseUnits("1000", 18))
    ).to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");
    console.log("[DEBUG] old keeper correctly rejected");

    // New keeper can deposit
    await expect(strategy.connect(newKeeper).deposit(ethers.parseUnits("1000", 18)))
      .to.emit(strategy, "Deposited");
    console.log("[DEBUG] new keeper deposited OK");
  });

  it("removing keeper (setting to zero) blocks keeper access", async function () {
    console.log("[DEBUG] test: removing keeper blocks access");
    await mockVault.setKeeper(keeperAddr);

    await usdt.mint(await strategy.getAddress(), ethers.parseUnits("10000", 18));
    // keeper can deposit
    await strategy.connect(keeper).deposit(ethers.parseUnits("1000", 18));

    // Remove keeper by setting to zero address
    await mockVault.setKeeper(ethers.ZeroAddress);

    // keeper can no longer deposit
    await expect(
      strategy.connect(keeper).deposit(ethers.parseUnits("1000", 18))
    ).to.be.revertedWithCustomError(strategy, "NotKeeperOrOwner");
    console.log("[DEBUG] keeper correctly blocked after removal");
  });

  it("owner can always deposit regardless of vault keeper", async function () {
    console.log("[DEBUG] test: owner always has access");
    // No keeper set (default zero address)
    const depositAmt = ethers.parseUnits("5000", 18);
    await expect(strategy.connect(admin).deposit(depositAmt))
      .to.emit(strategy, "Deposited");
    console.log("[DEBUG] owner deposited without any keeper set");
  });

  // ═══════════════════════════════════════════════════════════
  // Emergency
  // ═══════════════════════════════════════════════════════════

  it("emergencyWithdrawToken sends tokens to vault", async function () {
    console.log("[DEBUG] test: emergencyWithdrawToken");
    const amount = ethers.parseUnits("5000", 18);
    const vaultBalBefore = await usdt.balanceOf(vaultAddr);
    await strategy.connect(admin).emergencyWithdrawToken(await usdt.getAddress(), amount);
    const vaultBalAfter = await usdt.balanceOf(vaultAddr);

    console.log("[DEBUG] vault received:", ethers.formatUnits(vaultBalAfter - vaultBalBefore, 18));
    expect(vaultBalAfter - vaultBalBefore).to.equal(amount);
  });

  it("emergencyWithdrawToken emits event", async function () {
    console.log("[DEBUG] test: emergencyWithdrawToken event");
    const amount = ethers.parseUnits("1000", 18);
    await expect(strategy.connect(admin).emergencyWithdrawToken(await usdt.getAddress(), amount))
      .to.emit(strategy, "EmergencyTokenWithdrawn")
      .withArgs(await usdt.getAddress(), amount);
  });

  it("emergencyWithdrawToken reverts on zero amount", async function () {
    console.log("[DEBUG] test: emergencyWithdrawToken zero");
    await expect(
      strategy.connect(admin).emergencyWithdrawToken(await usdt.getAddress(), 0)
    ).to.be.revertedWithCustomError(strategy, "ZeroAmount");
  });

  it("emergencyWithdrawToken reverts for non-owner", async function () {
    console.log("[DEBUG] test: emergencyWithdrawToken non-owner");
    await expect(
      strategy.connect(user1).emergencyWithdrawToken(await usdt.getAddress(), 100)
    ).to.be.revertedWithCustomError(strategy, "OwnableUnauthorizedAccount");
  });

  // ═══════════════════════════════════════════════════════════
  // Edge Cases
  // ═══════════════════════════════════════════════════════════

  it("slippage revert when exchange rate is bad", async function () {
    console.log("[DEBUG] test: slippage revert");
    // Set exchange rate to 90% (10% slippage > 0.5% max)
    await router.setExchangeRate(9000); // 9000 bps = 90%

    await expect(
      strategy.connect(admin).deposit(ethers.parseUnits("10000", 18))
    ).to.be.revertedWith("Too little received");
  });

  it("re-deposit after full withdrawal works", async function () {
    console.log("[DEBUG] test: re-deposit after withdrawal");
    const amt = ethers.parseUnits("50000", 18);

    // Deposit
    await strategy.connect(admin).deposit(amt);

    // Withdraw all
    const vaultSigner = await impersonateVault();
    await strategy.connect(vaultSigner).withdraw(amt);
    await stopImpersonatingVault();

    // Fund strategy again
    await usdt.mint(await strategy.getAddress(), amt);

    // Re-deposit
    await strategy.connect(admin).deposit(amt);
    const shares = await megaVault.balanceOf(await strategy.getAddress());
    console.log("[DEBUG] shares after re-deposit:", ethers.formatUnits(shares, 18));
    expect(shares).to.be.gt(0);
  });

  it("strategy with only idle USDm reports correctly", async function () {
    console.log("[DEBUG] test: idle USDm only");
    // Remove all USDT, add USDm
    const stratAddr = await strategy.getAddress();
    const usdtBal = await usdt.balanceOf(stratAddr);

    // Emergency withdraw all USDT
    await strategy.connect(admin).emergencyWithdrawToken(await usdt.getAddress(), usdtBal);

    // Add some USDm
    const usdmAmt = ethers.parseUnits("25000", 18);
    await usdm.mint(stratAddr, usdmAmt);

    const total = await strategy.totalAssets();
    console.log("[DEBUG] totalAssets with only USDm:", ethers.formatUnits(total, 18));
    expect(total).to.equal(usdmAmt);
  });
});
