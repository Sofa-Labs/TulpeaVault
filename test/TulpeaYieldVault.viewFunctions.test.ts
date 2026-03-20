import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

/**
 * Tests for vault view functions and admin setters that were previously untested:
 * - setKeeper(): auth, events, zero address
 * - strategyListLength(): after add/remove cycles
 * - idleBalance(): with pending/claimable interactions
 */
describe("TulpeaYieldVault — View Functions & setKeeper", function () {
  let vault: Contract;
  let usdc: Contract;
  let mockStrategy: Contract;
  let mockStrategy2: Contract;
  let admin: Signer;
  let user1: Signer;
  let keeper: Signer;
  let randomUser: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let keeperAddr: string;
  let randomUserAddr: string;

  const ONE_DAY = 24 * 60 * 60;

  async function deployFixture() {
    console.log("[DEBUG] viewFunctions deployFixture: start");
    const signers = await ethers.getSigners();
    admin = signers[0];
    user1 = signers[1];
    keeper = signers[3];
    randomUser = signers[4];
    adminAddr = await admin.getAddress();
    user1Addr = await user1.getAddress();
    keeperAddr = await keeper.getAddress();
    randomUserAddr = await randomUser.getAddress();

    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

    const VaultFactory = await ethers.getContractFactory("TulpeaYieldVault");
    const vaultImpl = await VaultFactory.deploy();
    await vaultImpl.waitForDeployment();

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967ProxyWrapper");
    const initData = VaultFactory.interface.encodeFunctionData("initialize", [
      await usdc.getAddress(), adminAddr, 0, "Tulpea Yield Vault", "tyvUSDC",
      keeperAddr,
    ]);
    const proxy = await ERC1967Proxy.deploy(await vaultImpl.getAddress(), initData);
    await proxy.waitForDeployment();
    vault = VaultFactory.attach(await proxy.getAddress()) as Contract;

    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    mockStrategy = await MockStrategy.deploy(await usdc.getAddress());
    await mockStrategy.waitForDeployment();

    mockStrategy2 = await MockStrategy.deploy(await usdc.getAddress());
    await mockStrategy2.waitForDeployment();

    const mintAmount = ethers.parseUnits("500000", 18);
    await usdc.mint(user1Addr, mintAmount);
    await usdc.mint(adminAddr, mintAmount);
    await usdc.connect(user1).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(admin).approve(await vault.getAddress(), ethers.MaxUint256);

    console.log("[DEBUG] viewFunctions deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // ═══════════════════════════════════════════════════════════
  // setKeeper()
  // ═══════════════════════════════════════════════════════════

  describe("setKeeper", function () {
    it("should set keeper and read it back", async function () {
      console.log("[DEBUG] test: setKeeper basic");
      const newKeeper = randomUserAddr;
      await vault.connect(admin).setKeeper(newKeeper);
      const current = await vault.keeper();
      console.log("[DEBUG] keeper after set:", current);
      expect(current).to.equal(newKeeper);
    });

    it("should emit KeeperSet event with old and new", async function () {
      console.log("[DEBUG] test: setKeeper event");
      const newKeeper = randomUserAddr;
      await expect(vault.connect(admin).setKeeper(newKeeper))
        .to.emit(vault, "KeeperSet")
        .withArgs(keeperAddr, newKeeper);
    });

    it("should allow setting keeper to zero address (disable)", async function () {
      console.log("[DEBUG] test: setKeeper zero");
      await vault.connect(admin).setKeeper(ethers.ZeroAddress);
      const current = await vault.keeper();
      console.log("[DEBUG] keeper after disable:", current);
      expect(current).to.equal(ethers.ZeroAddress);
    });

    it("should revert when non-owner calls setKeeper", async function () {
      console.log("[DEBUG] test: setKeeper non-owner");
      await expect(
        vault.connect(user1).setKeeper(randomUserAddr)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("should allow keeper to call processReport after being set", async function () {
      console.log("[DEBUG] test: keeper can processReport");
      await vault.connect(admin).addStrategy(await mockStrategy.getAddress());

      // Deposit and deploy so strategy has debt
      await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);
      await vault.connect(admin).requestDeploy(await mockStrategy.getAddress(), ethers.parseUnits("5000", 18));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY + 1]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      // Fund strategy so processReport doesn't see 100% loss
      await usdc.mint(await mockStrategy.getAddress(), ethers.parseUnits("5000", 18));
      // Disable health check to avoid threshold issues
      await vault.connect(admin).setHealthCheck(10000, 10000, false);

      // Keeper should be able to processReport
      await vault.connect(keeper).processReport(await mockStrategy.getAddress());
      console.log("[DEBUG] keeper processReport succeeded");
    });

    it("should prevent old keeper from calling processReport after keeper change", async function () {
      console.log("[DEBUG] test: old keeper rejected");
      await vault.connect(admin).addStrategy(await mockStrategy.getAddress());
      await vault.connect(user1).deposit(ethers.parseUnits("10000", 18), user1Addr);
      await vault.connect(admin).requestDeploy(await mockStrategy.getAddress(), ethers.parseUnits("5000", 18));
      await ethers.provider.send("evm_increaseTime", [ONE_DAY + 1]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      // Change keeper to someone else
      await vault.connect(admin).setKeeper(randomUserAddr);

      // Old keeper should fail with NotKeeperOrOwner
      await expect(
        vault.connect(keeper).processReport(await mockStrategy.getAddress())
      ).to.be.revertedWithCustomError(vault, "NotKeeperOrOwner");
    });

    it("should emit two KeeperSet events on sequential changes", async function () {
      console.log("[DEBUG] test: setKeeper sequential");
      await expect(vault.connect(admin).setKeeper(randomUserAddr))
        .to.emit(vault, "KeeperSet")
        .withArgs(keeperAddr, randomUserAddr);

      await expect(vault.connect(admin).setKeeper(user1Addr))
        .to.emit(vault, "KeeperSet")
        .withArgs(randomUserAddr, user1Addr);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // strategyListLength()
  // ═══════════════════════════════════════════════════════════

  describe("strategyListLength", function () {
    it("should return 0 initially", async function () {
      console.log("[DEBUG] test: strategyListLength initial");
      const len = await vault.strategyListLength();
      console.log("[DEBUG] length:", len);
      expect(len).to.equal(0);
    });

    it("should return 1 after adding one strategy", async function () {
      console.log("[DEBUG] test: strategyListLength after add");
      await vault.connect(admin).addStrategy(await mockStrategy.getAddress());
      expect(await vault.strategyListLength()).to.equal(1);
    });

    it("should return 2 after adding two strategies", async function () {
      console.log("[DEBUG] test: strategyListLength after 2 adds");
      await vault.connect(admin).addStrategy(await mockStrategy.getAddress());
      await vault.connect(admin).addStrategy(await mockStrategy2.getAddress());
      expect(await vault.strategyListLength()).to.equal(2);
    });

    it("should return 0 after add then remove", async function () {
      console.log("[DEBUG] test: strategyListLength add+remove");
      await vault.connect(admin).addStrategy(await mockStrategy.getAddress());
      await vault.connect(admin).removeStrategy(await mockStrategy.getAddress());
      expect(await vault.strategyListLength()).to.equal(0);
    });

    it("should return 1 after add 2 remove 1", async function () {
      console.log("[DEBUG] test: strategyListLength add2 remove1");
      await vault.connect(admin).addStrategy(await mockStrategy.getAddress());
      await vault.connect(admin).addStrategy(await mockStrategy2.getAddress());
      await vault.connect(admin).removeStrategy(await mockStrategy.getAddress());
      const len = await vault.strategyListLength();
      console.log("[DEBUG] length after remove:", len);
      expect(len).to.equal(1);
    });

    it("should handle add-remove-add cycle correctly", async function () {
      console.log("[DEBUG] test: strategyListLength add-remove-add");
      await vault.connect(admin).addStrategy(await mockStrategy.getAddress());
      expect(await vault.strategyListLength()).to.equal(1);

      await vault.connect(admin).removeStrategy(await mockStrategy.getAddress());
      expect(await vault.strategyListLength()).to.equal(0);

      // Re-add same strategy
      await vault.connect(admin).addStrategy(await mockStrategy.getAddress());
      expect(await vault.strategyListLength()).to.equal(1);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // idleBalance()
  // ═══════════════════════════════════════════════════════════

  describe("idleBalance", function () {
    it("should return 0 with no deposits", async function () {
      console.log("[DEBUG] test: idleBalance empty");
      const idle = await vault.idleBalance();
      console.log("[DEBUG] idle:", idle);
      expect(idle).to.equal(0);
    });

    it("should equal deposit amount when no pending/claimable", async function () {
      console.log("[DEBUG] test: idleBalance after deposit");
      const depositAmt = ethers.parseUnits("10000", 18);
      await vault.connect(user1).deposit(depositAmt, user1Addr);
      const idle = await vault.idleBalance();
      console.log("[DEBUG] idle after deposit:", idle);
      expect(idle).to.equal(depositAmt);
    });

    it("should decrease after deploying to strategy", async function () {
      console.log("[DEBUG] test: idleBalance after deploy");
      const depositAmt = ethers.parseUnits("10000", 18);
      const deployAmt = ethers.parseUnits("6000", 18);

      await vault.connect(user1).deposit(depositAmt, user1Addr);
      await vault.connect(admin).addStrategy(await mockStrategy.getAddress());
      await vault.connect(admin).requestDeploy(await mockStrategy.getAddress(), deployAmt);
      await ethers.provider.send("evm_increaseTime", [ONE_DAY + 1]);
      await ethers.provider.send("evm_mine", []);
      await vault.connect(admin).executeDeploy(0);

      const idle = await vault.idleBalance();
      console.log("[DEBUG] idle after deploy:", idle);
      // idle should be depositAmt - deployAmt = 4000
      expect(idle).to.equal(depositAmt - deployAmt);
    });

    it("should decrease when pending withdrawals exist", async function () {
      console.log("[DEBUG] test: idleBalance with pending withdrawal");
      const depositAmt = ethers.parseUnits("10000", 18);
      await vault.connect(user1).deposit(depositAmt, user1Addr);

      // Request redeem half
      const shares = await vault.balanceOf(user1Addr);
      const halfShares = shares / 2n;
      await vault.connect(user1).requestRedeem(halfShares, user1Addr, user1Addr);

      const idle = await vault.idleBalance();
      console.log("[DEBUG] idle with pending:", idle);
      // idle should be less than depositAmt because pending reserves assets
      expect(idle).to.be.lt(depositAmt);
    });

    it("should decrease when claimable withdrawals exist", async function () {
      console.log("[DEBUG] test: idleBalance with claimable withdrawal");
      const depositAmt = ethers.parseUnits("10000", 18);
      await vault.connect(user1).deposit(depositAmt, user1Addr);

      // Request + fulfill
      const shares = await vault.balanceOf(user1Addr);
      const halfShares = shares / 2n;
      await vault.connect(user1).requestRedeem(halfShares, user1Addr, user1Addr);
      await vault.connect(admin).fulfillRedeem(user1Addr);

      const idle = await vault.idleBalance();
      const claimable = await vault.claimableWithdrawals(user1Addr);
      console.log("[DEBUG] idle with claimable:", idle, "claimable:", claimable);
      // idle = totalBalance - claimable
      expect(idle).to.be.lt(depositAmt);
      expect(claimable).to.be.gt(0);
    });

    it("should return 0 when balance <= reserved", async function () {
      console.log("[DEBUG] test: idleBalance zero when fully reserved");
      const depositAmt = ethers.parseUnits("10000", 18);
      await vault.connect(user1).deposit(depositAmt, user1Addr);

      // Request redeem ALL shares
      const shares = await vault.balanceOf(user1Addr);
      await vault.connect(user1).requestRedeem(shares, user1Addr, user1Addr);
      await vault.connect(admin).fulfillRedeem(user1Addr);

      const idle = await vault.idleBalance();
      console.log("[DEBUG] idle fully reserved:", idle);
      expect(idle).to.equal(0);
    });
  });
});
