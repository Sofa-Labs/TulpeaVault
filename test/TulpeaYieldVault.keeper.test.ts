import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

describe("TulpeaYieldVault — Keeper Role", function () {
  let vault: Contract;
  let usdc: Contract;
  let mockStrategy: Contract;
  let admin: Signer;
  let user1: Signer;
  let keeper: Signer;
  let randomUser: Signer;
  let adminAddr: string;
  let user1Addr: string;
  let keeperAddr: string;
  let randomUserAddr: string;
  let strategyAddr: string;

  const ONE_DAY = 24 * 60 * 60;

  async function deployFixture() {
    console.log("[DEBUG] keeper deployFixture: start");
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
      keeperAddr, // keeper
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
    await usdc.mint(adminAddr, mintAmount);

    const vaultAddr = await vault.getAddress();
    await usdc.connect(user1).approve(vaultAddr, ethers.MaxUint256);
    await usdc.connect(admin).approve(vaultAddr, ethers.MaxUint256);

    // Deposit and deploy to strategy
    await vault.connect(user1).deposit(ethers.parseUnits("100000", 18), user1Addr);
    await vault.connect(admin).requestDeploy(strategyAddr, ethers.parseUnits("50000", 18));
    await ethers.provider.send("evm_increaseTime", [ONE_DAY + 1]);
    await ethers.provider.send("evm_mine", []);
    await vault.connect(admin).executeDeploy(0);

    // Disable health check — keeper tests exercise losses > 1%
    await vault.connect(admin).setHealthCheck(10000, 10000, false);
    console.log("[DEBUG] keeper deployFixture: complete");
  }

  beforeEach(async function () {
    await deployFixture();
  });

  // ═══════════════════════════════════════════════════════════
  // setKeeper
  // ═══════════════════════════════════════════════════════════

  describe("setKeeper", function () {
    it("owner can set keeper address", async function () {
      console.log("[DEBUG] test: owner sets keeper");
      const newKeeper = await (await ethers.getSigners())[5].getAddress();
      await vault.connect(admin).setKeeper(newKeeper);
      expect(await vault.keeper()).to.equal(newKeeper);
    });

    it("owner can set keeper to address(0) (disables keeper)", async function () {
      console.log("[DEBUG] test: owner disables keeper");
      await vault.connect(admin).setKeeper(ethers.ZeroAddress);
      expect(await vault.keeper()).to.equal(ethers.ZeroAddress);
    });

    it("emits KeeperSet event with old and new addresses", async function () {
      console.log("[DEBUG] test: KeeperSet event");
      const newKeeper = await (await ethers.getSigners())[5].getAddress();
      await expect(vault.connect(admin).setKeeper(newKeeper))
        .to.emit(vault, "KeeperSet")
        .withArgs(keeperAddr, newKeeper);
    });

    it("non-owner cannot set keeper (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: non-owner cannot setKeeper");
      await expect(vault.connect(user1).setKeeper(randomUserAddr))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("keeper cannot set keeper (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper cannot setKeeper");
      await expect(vault.connect(keeper).setKeeper(randomUserAddr))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // processReport with keeper
  // ═══════════════════════════════════════════════════════════

  describe("processReport with keeper", function () {
    it("keeper can call processReport (detects profit correctly)", async function () {
      console.log("[DEBUG] test: keeper processReport profit");
      await mockStrategy.setTotalAssets(ethers.parseUnits("55000", 18));
      const tx = await vault.connect(keeper).processReport(strategyAddr);
      await expect(tx)
        .to.emit(vault, "StrategyReported")
        .withArgs(strategyAddr, ethers.parseUnits("5000", 18), 0, ethers.parseUnits("55000", 18));
    });

    it("keeper can call processReport (detects loss correctly)", async function () {
      console.log("[DEBUG] test: keeper processReport loss");
      await mockStrategy.setTotalAssets(ethers.parseUnits("45000", 18));
      const tx = await vault.connect(keeper).processReport(strategyAddr);
      await expect(tx)
        .to.emit(vault, "StrategyReported")
        .withArgs(strategyAddr, 0, ethers.parseUnits("5000", 18), ethers.parseUnits("45000", 18));
    });

    it("owner can still call processReport", async function () {
      console.log("[DEBUG] test: owner processReport");
      await mockStrategy.setTotalAssets(ethers.parseUnits("55000", 18));
      await expect(vault.connect(admin).processReport(strategyAddr))
        .to.emit(vault, "StrategyReported");
    });

    it("random user cannot call processReport (reverts NotKeeperOrOwner)", async function () {
      console.log("[DEBUG] test: random user processReport");
      await mockStrategy.setTotalAssets(ethers.parseUnits("55000", 18));
      await expect(vault.connect(randomUser).processReport(strategyAddr))
        .to.be.revertedWithCustomError(vault, "NotKeeperOrOwner");
    });

    it("after keeper is changed, old keeper cannot call processReport", async function () {
      console.log("[DEBUG] test: old keeper revoked");
      const newKeeper = (await ethers.getSigners())[5];
      await vault.connect(admin).setKeeper(await newKeeper.getAddress());

      await mockStrategy.setTotalAssets(ethers.parseUnits("55000", 18));
      await expect(vault.connect(keeper).processReport(strategyAddr))
        .to.be.revertedWithCustomError(vault, "NotKeeperOrOwner");

      // New keeper works
      await expect(vault.connect(newKeeper).processReport(strategyAddr))
        .to.emit(vault, "StrategyReported");
    });

    it("after keeper is set to address(0), only owner can call processReport", async function () {
      console.log("[DEBUG] test: keeper disabled");
      await vault.connect(admin).setKeeper(ethers.ZeroAddress);

      await mockStrategy.setTotalAssets(ethers.parseUnits("55000", 18));
      await expect(vault.connect(keeper).processReport(strategyAddr))
        .to.be.revertedWithCustomError(vault, "NotKeeperOrOwner");

      // Owner still works
      await expect(vault.connect(admin).processReport(strategyAddr))
        .to.emit(vault, "StrategyReported");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // keeper cannot call admin functions
  // ═══════════════════════════════════════════════════════════

  describe("keeper cannot call admin functions", function () {
    it("keeper cannot call addStrategy (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper addStrategy");
      await expect(vault.connect(keeper).addStrategy(randomUserAddr))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("keeper cannot call removeStrategy (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper removeStrategy");
      await expect(vault.connect(keeper).removeStrategy(strategyAddr))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("keeper cannot call requestDeploy (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper requestDeploy");
      await expect(vault.connect(keeper).requestDeploy(strategyAddr, ethers.parseUnits("1000", 18)))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("keeper cannot call executeDeploy (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper executeDeploy");
      await expect(vault.connect(keeper).executeDeploy(0))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("keeper cannot call cancelDeploy (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper cancelDeploy");
      await expect(vault.connect(keeper).cancelDeploy(0))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("keeper cannot call withdrawFromStrategy (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper withdrawFromStrategy");
      await expect(vault.connect(keeper).withdrawFromStrategy(strategyAddr, ethers.parseUnits("1000", 18)))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("keeper cannot call fulfillRedeem (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper fulfillRedeem");
      await expect(vault.connect(keeper).fulfillRedeem(user1Addr))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("keeper cannot call setDepositLimit (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper setDepositLimit");
      await expect(vault.connect(keeper).setDepositLimit(ethers.parseUnits("1000000", 18)))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("keeper cannot call pause (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper pause");
      await expect(vault.connect(keeper).pause())
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("keeper cannot call unpause (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper unpause");
      await expect(vault.connect(keeper).unpause())
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("keeper cannot call resolveEmergencyShutdown (reverts OwnableUnauthorizedAccount)", async function () {
      console.log("[DEBUG] test: keeper resolveEmergencyShutdown");
      await expect(vault.connect(keeper).resolveEmergencyShutdown())
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // initialization
  // ═══════════════════════════════════════════════════════════

  describe("initialization", function () {
    it("keeper is set correctly from initialize parameter", async function () {
      console.log("[DEBUG] test: keeper from initialize");
      expect(await vault.keeper()).to.equal(keeperAddr);
    });

    it("keeper can be address(0) at initialization (owner-only mode)", async function () {
      console.log("[DEBUG] test: zero keeper initialize");
      const VaultFactory = await ethers.getContractFactory("TulpeaYieldVault");
      const vaultImpl = await VaultFactory.deploy();
      await vaultImpl.waitForDeployment();

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967ProxyWrapper");
      const initData = VaultFactory.interface.encodeFunctionData("initialize", [
        await usdc.getAddress(), adminAddr, 0, "Test Vault", "tVault",
        ethers.ZeroAddress, // no keeper
      ]);
      const proxy = await ERC1967Proxy.deploy(await vaultImpl.getAddress(), initData);
      await proxy.waitForDeployment();
      const vaultNoKeeper = VaultFactory.attach(await proxy.getAddress()) as Contract;

      expect(await vaultNoKeeper.keeper()).to.equal(ethers.ZeroAddress);
    });
  });
});
