// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IStrategy.sol";
import "./interfaces/IERC7540.sol";

/**
 * @title TulpeaYieldVault
 * @notice ERC4626 vault with automated strategy-based yield via processReport().
 * @dev Vault balance is read via IERC20(asset()).balanceOf(address(this)).
 *      totalDebt tracks assets deployed to strategies (updated by processReport,
 *      executeDeploy, and withdrawFromStrategy).
 *
 *      3-step ERC-7540 withdrawal flow:
 *      1. User calls requestRedeem(shares, controller, owner) — escrows shares to vault, records pending
 *      2. Admin calls fulfillRedeem(controller) — converts shares at current price, moves pending → claimable
 *      3. Controller (or operator) calls redeem()/withdraw() — claims assets
 *
 *      Fund deployment uses a 24h timelock + strategy registry.
 */
contract TulpeaYieldVault is
    ERC4626Upgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    IERC7540Redeem,
    IERC7540Operator
{
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════

    /// @notice Maximum total assets the vault will accept (0 = unlimited)
    uint256 public depositLimit;

    /// @notice Assets deployed to strategies (updated by processReport, executeDeploy, withdrawFromStrategy)
    uint256 public totalDebt;

    /// @notice Timelock delay for fund deployments
    uint256 public constant DEPLOYMENT_DELAY = 24 hours;

    /// @notice Maximum basis points (100%)
    uint256 public constant MAX_BPS = 10000;

    /// @notice Loss threshold (50%) that triggers emergency shutdown
    uint256 public constant MAX_LOSS_BPS = 5000;

    /// @notice Virtual share offset for ERC4626 inflation protection (10^6 = 1M internal shares per asset unit)
    uint8 public constant DECIMALS_OFFSET = 6;

    /// @notice Counter for deployment IDs
    uint256 public nextDeploymentId;

    /// @notice Pending deployment requests (timelock)
    struct PendingDeployment {
        address strategy;
        uint256 amount;
        uint256 requestedAt;
        bool executed;
        bool cancelled;
    }

    mapping(uint256 => PendingDeployment) public pendingDeployments;

    // ── Cumulative Withdrawal Tracking ──────────────────────────
    /// @notice Cumulative assets withdrawn per user (never decremented)
    mapping(address => uint256) public totalWithdrawn;

    // ── ERC-7540 Async Withdrawal (Claimable) ────────────────
    /// @notice Assets claimable per user (fulfilled by admin, awaiting user claim)
    mapping(address => uint256) public claimableWithdrawals;

    /// @notice Total assets across all claimable withdrawals
    uint256 public totalClaimableWithdrawals;

    // ── ERC-7540 Share Tracking ────────────────
    /// @notice Original shares escrowed per user in requestRedeem (pending phase)
    mapping(address => uint256) public pendingWithdrawalShares;

    /// @notice Shares claimable per user (moved from pending on fulfillRedeem)
    mapping(address => uint256) public claimableWithdrawalShares;

    // ── Strategy Registry ────────────────────────────────────
    struct StrategyConfig {
        bool isActive;
        uint256 currentDebt; // assets deployed to this strategy
        uint256 lastTotalAssets; // last reading from processReport
    }

    mapping(address => StrategyConfig) public strategies;
    address[] public strategyList;

    // ── ERC-7540 Operator Permissions ────────────────────────
    /// @notice Operator approvals: controller => operator => approved
    mapping(address => mapping(address => bool)) private _isOperator;

    // ── F1 Fix: Track original share owner ────────────────────
    /// @notice Maps controller → original owner who escrowed shares
    mapping(address => address) public pendingWithdrawalOwner;

    // ── F2 Fix: Emergency shutdown on large loss ──────────────
    /// @notice Whether the vault is in emergency shutdown (blocks deposits)
    bool public emergencyShutdown;

    /// @notice Keeper address for automated operations (processReport)
    address public keeper;

    /// @notice Total shares escrowed for pending withdrawals (explicit accounting, Yearn V3 pattern)
    /// @dev Added post-upgrade — placed at end to preserve storage layout
    uint256 public totalEscrowedShares;

    /// @notice Max allowed profit per report as basis points of previous debt (default: 10000 = 100%)
    uint256 public maxProfitReportBps;

    /// @notice Max allowed loss per report as basis points of previous debt (default: 100 = 1%)
    uint256 public maxLossReportBps;

    /// @notice When true, health check is enforced on processReport
    bool public healthCheckEnabled;

    /// @dev Reserved storage gap for future upgrades
    uint256[27] private __gap;

    // ═══════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════

    // RedeemRequest event defined in IERC7540Redeem interface
    event WithdrawalCancelled(address indexed controller, uint256 shares);
    event RedeemFulfilled(address indexed controller, uint256 assets);
    event RedeemClaimed(address indexed controller, uint256 assets);
    event DepositLimitSet(uint256 oldLimit, uint256 newLimit);
    event DeploymentRequested(
        uint256 indexed deploymentId,
        address indexed strategy,
        uint256 amount,
        uint256 executeAfter
    );
    event DeploymentExecuted(uint256 indexed deploymentId, address indexed strategy, uint256 amount);
    event DeploymentCancelled(uint256 indexed deploymentId);
    event StrategyAdded(address indexed strategy);
    event StrategyRemoved(address indexed strategy);
    event StrategyReported(address indexed strategy, uint256 profit, uint256 loss, uint256 currentAssets);
    event FundsDeployedToStrategy(address indexed strategy, uint256 amount);
    event FundsWithdrawnFromStrategy(address indexed strategy, uint256 amount);
    event EmergencyShutdownTriggered(address indexed strategy, uint256 loss, uint256 previousDebt);
    event EmergencyShutdownResolved();
    event KeeperSet(address indexed oldKeeper, address indexed newKeeper);
    event HealthCheckConfigured(uint256 maxProfitBps, uint256 maxLossBps, bool enabled);

    // ═══════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════

    error NothingClaimable();
    error ExceedsClaimable(uint256 requested, uint256 available);
    error Unauthorized();
    error ZeroShares();
    error ZeroAssets();
    error NothingPending();
    error WithdrawalAlreadyPending();
    error InsufficientIdleBalance(uint256 required, uint256 available);
    error DepositLimitExceeded(uint256 attempted, uint256 limit);
    error DeploymentNotFound();
    error DeploymentAlreadyExecuted();
    error DeploymentAlreadyCancelled();
    error DeploymentTimelockNotMet(uint256 executeAfter, uint256 currentTime);
    error ZeroAddress();
    error SelfDeployNotAllowed();
    error ZeroAmount();
    error DebtOutstandingNoShares(uint256 totalDebt);
    error StrategyNotFound(address strategy);
    error StrategyAlreadyExists(address strategy);
    error StrategyHasDebt(address strategy, uint256 debt);
    error StrategyTotalAssetsReverted(address strategy);
    error EmergencyShutdownActive();
    error StrategyNotActive(address strategy);
    error StrategyNotInList(address strategy);
    error WithdrawExceedsDebt(uint256 amount, uint256 currentDebt);
    error NotKeeperOrOwner();
    error HealthCheckFailed(uint256 delta, uint256 maxAllowed, bool isLoss);
    error InvalidBpsValue(uint256 value);

    // ═══════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════

    modifier onlyKeeperOrOwner() {
        if (msg.sender != owner() && msg.sender != keeper) revert NotKeeperOrOwner();
        _;
    }

    // ═══════════════════════════════════════════════════════════
    // INITIALIZER
    // ═══════════════════════════════════════════════════════════

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the vault
     * @param asset_ Underlying asset token address (e.g. USDT0)
     * @param owner_ Initial owner address
     * @param depositLimit_ Maximum total deposits (0 = unlimited)
     * @param name_ ERC20 token name
     * @param symbol_ ERC20 token symbol
     * @param keeper_ Keeper address for automated operations (address(0) to disable)
     */
    function initialize(
        IERC20 asset_,
        address owner_,
        uint256 depositLimit_,
        string memory name_,
        string memory symbol_,
        address keeper_
    ) external initializer {
        if (address(asset_) == address(0)) revert ZeroAddress();
        if (owner_ == address(0)) revert ZeroAddress();

        __ERC4626_init(asset_);
        __ERC20_init(name_, symbol_);
        __Ownable_init(owner_);
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        depositLimit = depositLimit_;
        keeper = keeper_;

        maxProfitReportBps = 10000; // 100% — generous default
        maxLossReportBps = 100;     // 1% — tight default (Yearn V2 style)
        healthCheckEnabled = true;
    }

    // ═══════════════════════════════════════════════════════════
    // ERC4626 OVERRIDES
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Total assets backing active shares (excludes claimable withdrawals)
     * @dev After fulfillRedeem, shares are burned but assets haven't left the vault yet.
     *      We subtract totalClaimableWithdrawals so deposit pricing (convertToShares)
     *      doesn't count assets that are already "spoken for" by fulfilled withdrawals.
     */
    function totalAssets() public view override returns (uint256) {
        uint256 total = _vaultBalance() + totalDebt;
        if (totalClaimableWithdrawals >= total) return 0;
        return total - totalClaimableWithdrawals;
    }

    /**
     * @notice Gross total assets (vault balance + totalDebt, including claimable reserves)
     * @dev Useful for UI/TVL display showing all assets under management.
     */
    function grossTotalAssets() public view returns (uint256) {
        return _vaultBalance() + totalDebt;
    }

    /// @notice Returns claimable assets for the owner (ERC-7540 compliant)
    function maxWithdraw(address owner) public view override returns (uint256) {
        return claimableWithdrawals[owner];
    }

    /// @notice Returns claimable shares for the owner (ERC-7540 compliant)
    function maxRedeem(address owner) public view override returns (uint256) {
        return claimableWithdrawalShares[owner];
    }

    /// @notice Claim claimable assets by asset amount (partial claim supported)
    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        if (assets == 0) revert ZeroAssets();
        uint256 claimable = claimableWithdrawals[owner];
        if (claimable == 0) revert NothingClaimable();
        if (assets > claimable) revert ExceedsClaimable(assets, claimable);
        // Skip mulDiv when claiming all remaining — prevents rounding dust
        uint256 shares =
            (assets == claimable)
                ? claimableWithdrawalShares[owner]
                : Math.mulDiv(claimableWithdrawalShares[owner], assets, claimable);
        _claimWithdrawal(owner, receiver, assets, shares);
        return shares;
    }

    /// @notice Claim claimable assets by share amount (partial claim supported)
    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        if (shares == 0) revert ZeroShares();
        uint256 claimable = claimableWithdrawals[owner];
        uint256 claimShares = claimableWithdrawalShares[owner];
        if (claimable == 0) revert NothingClaimable();
        if (shares > claimShares) revert ExceedsClaimable(shares, claimShares);
        // Skip mulDiv when claiming all remaining — prevents rounding dust
        uint256 assets = (shares == claimShares) ? claimable : Math.mulDiv(claimable, shares, claimShares);
        if (assets == 0) revert ZeroAssets();
        _claimWithdrawal(owner, receiver, assets, shares);
        return assets;
    }

    /// @notice Max deposit respecting the deposit limit
    function maxDeposit(address) public view override returns (uint256) {
        if (paused()) return 0;
        if (emergencyShutdown) return 0;
        if (totalSupply() == 0 && totalDebt > 0) return 0;
        if (depositLimit == 0) return type(uint256).max;
        uint256 currentTotal = totalAssets();
        if (currentTotal >= depositLimit) return 0;
        return depositLimit - currentTotal;
    }

    /// @notice Max mint respecting the deposit limit
    function maxMint(address) public view override returns (uint256) {
        if (paused()) return 0;
        if (emergencyShutdown) return 0;
        if (totalSupply() == 0 && totalDebt > 0) return 0;
        if (depositLimit == 0) return type(uint256).max;
        uint256 currentTotal = totalAssets();
        if (currentTotal >= depositLimit) return 0;
        return convertToShares(depositLimit - currentTotal);
    }

    /// @notice MUST revert per ERC-7540 — async flow
    function previewWithdraw(uint256) public pure override returns (uint256) {
        revert("ERC7540: async-flow");
    }

    /// @notice MUST revert per ERC-7540 — async flow
    function previewRedeem(uint256) public pure override returns (uint256) {
        revert("ERC7540: async-flow");
    }

    /// @dev Reentrancy guard on deposit entry point
    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        return super.deposit(assets, receiver);
    }

    /// @dev Reentrancy guard on mint entry point
    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    /// @dev Hook to enforce deposit limit and pause
    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal override whenNotPaused {
        if (totalSupply() == 0 && totalDebt > 0) revert DebtOutstandingNoShares(totalDebt);
        if (depositLimit > 0 && totalAssets() + assets > depositLimit) {
            revert DepositLimitExceeded(totalAssets() + assets, depositLimit);
        }

        super._deposit(caller, receiver, assets, shares);
    }

    // ═══════════════════════════════════════════════════════════
    // WITHDRAWAL — USER FUNCTIONS (ERC-7540)
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Request a redemption by escrowing shares to the vault (ERC-7540 step 1)
     * @param shares Number of vault shares to escrow
     * @param controller Address that controls the request (can cancel/claim)
     * @param owner Address that owns the shares to escrow
     * @return requestId Always 0 (single request per controller)
     */
    function requestRedeem(
        uint256 shares,
        address controller,
        address owner
    ) external nonReentrant whenNotPaused returns (uint256 requestId) {
        if (shares == 0) revert ZeroShares();
        if (controller == address(0)) revert ZeroAddress();
        if (pendingWithdrawalShares[controller] > 0) revert WithdrawalAlreadyPending();

        // Auth: msg.sender must be owner or operator of owner
        if (msg.sender != owner && !isOperator(owner, msg.sender)) revert Unauthorized();

        // Estimate assets for informational event only — NOT stored
        uint256 estimatedAssets = _convertToAssetsEffective(shares);
        if (estimatedAssets == 0) revert ZeroAssets();

        _transfer(owner, address(this), shares);

        pendingWithdrawalShares[controller] = shares;
        pendingWithdrawalOwner[controller] = owner;
        totalEscrowedShares += shares;

        emit RedeemRequest(controller, owner, 0, msg.sender, estimatedAssets);
        return 0;
    }

    /**
     * @notice Cancel all pending withdrawals — returns escrowed shares to the original owner
     */
    function cancelWithdraw() external nonReentrant whenNotPaused {
        uint256 shares = pendingWithdrawalShares[msg.sender];
        if (shares == 0) revert NothingPending();

        address originalOwner = pendingWithdrawalOwner[msg.sender];

        pendingWithdrawalShares[msg.sender] = 0;
        pendingWithdrawalOwner[msg.sender] = address(0);
        totalEscrowedShares -= shares;

        // Shares returned to original owner who escrowed them (F1 fix)
        _transfer(address(this), originalOwner, shares);

        emit WithdrawalCancelled(msg.sender, shares);
    }

    // ═══════════════════════════════════════════════════════════
    // FULFILL — ADMIN FUNCTIONS (ERC-7540 step 2)
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Fulfill a redemption — moves pending → claimable
     * @param user Address of user to fulfill
     */
    function fulfillRedeem(address user) external onlyOwner nonReentrant {
        uint256 shares = pendingWithdrawalShares[user];
        if (shares == 0) revert NothingPending();

        // Convert shares → assets at CURRENT price (loss socialization)
        uint256 assets = _convertPendingSharesToAssets(shares);
        if (assets == 0) revert ZeroAssets();

        uint256 newTotalClaimable = totalClaimableWithdrawals + assets;
        uint256 vaultBal = _vaultBalance();
        if (vaultBal < newTotalClaimable) {
            revert InsufficientIdleBalance(newTotalClaimable, vaultBal);
        }

        pendingWithdrawalShares[user] = 0;
        pendingWithdrawalOwner[user] = address(0);
        totalEscrowedShares -= shares;
        _burn(address(this), shares);
        claimableWithdrawals[user] += assets;
        claimableWithdrawalShares[user] += shares;
        totalClaimableWithdrawals += assets;

        emit RedeemFulfilled(user, assets);
    }

    // ═══════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Set the deposit limit
     * @param newLimit New deposit limit (0 = unlimited)
     */
    function setDepositLimit(uint256 newLimit) external onlyOwner {
        uint256 oldLimit = depositLimit;
        depositLimit = newLimit;
        emit DepositLimitSet(oldLimit, newLimit);
    }

    /// @notice Pause the vault
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause the vault
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Resolve emergency shutdown to re-enable deposits
    function resolveEmergencyShutdown() external onlyOwner {
        if (!emergencyShutdown) revert EmergencyShutdownActive();
        emergencyShutdown = false;
        emit EmergencyShutdownResolved();
    }

    /// @notice Set the keeper address for automated operations
    /// @param newKeeper New keeper address (address(0) to disable keeper)
    function setKeeper(address newKeeper) external onlyOwner {
        address oldKeeper = keeper;
        keeper = newKeeper;
        emit KeeperSet(oldKeeper, newKeeper);
    }

    /**
     * @notice Configure health check bounds for processReport
     * @param _maxProfitBps Max profit as basis points of previous debt (10000 = 100%)
     * @param _maxLossBps Max loss as basis points of previous debt (100 = 1%)
     * @param _enabled Whether health check is enforced
     */
    function setHealthCheck(uint256 _maxProfitBps, uint256 _maxLossBps, bool _enabled) external onlyOwner {
        if (_maxProfitBps > MAX_BPS) revert InvalidBpsValue(_maxProfitBps);
        if (_maxLossBps > MAX_BPS) revert InvalidBpsValue(_maxLossBps);
        maxProfitReportBps = _maxProfitBps;
        maxLossReportBps = _maxLossBps;
        healthCheckEnabled = _enabled;
        emit HealthCheckConfigured(_maxProfitBps, _maxLossBps, _enabled);
    }

    // ═══════════════════════════════════════════════════════════
    // STRATEGY REGISTRY
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Add a strategy to the registry
     * @param strategy Address of the strategy contract (must implement IStrategy)
     */
    function addStrategy(address strategy) external onlyOwner {
        if (strategy == address(0)) revert ZeroAddress();
        if (strategy == address(this)) revert SelfDeployNotAllowed();
        if (strategies[strategy].isActive) revert StrategyAlreadyExists(strategy);

        // Validate strategy implements IStrategy by calling totalAssets()
        try IStrategy(strategy).totalAssets() returns (uint256) {
            // Valid strategy
        } catch {
            revert StrategyTotalAssetsReverted(strategy);
        }

        strategies[strategy] = StrategyConfig({isActive: true, currentDebt: 0, lastTotalAssets: 0});
        strategyList.push(strategy);

        emit StrategyAdded(strategy);
    }

    /**
     * @notice Remove a strategy from the registry
     * @param strategy Address of the strategy to remove
     */
    function removeStrategy(address strategy) external onlyOwner {
        if (!strategies[strategy].isActive) revert StrategyNotFound(strategy);
        if (strategies[strategy].currentDebt > 0) revert StrategyHasDebt(strategy, strategies[strategy].currentDebt);

        strategies[strategy].isActive = false;

        // Remove from strategyList array
        bool found = false;
        for (uint256 i = 0; i < strategyList.length; i++) {
            if (strategyList[i] == strategy) {
                strategyList[i] = strategyList[strategyList.length - 1];
                strategyList.pop();
                found = true;
                break;
            }
        }
        if (!found) revert StrategyNotInList(strategy);

        emit StrategyRemoved(strategy);
    }

    // ═══════════════════════════════════════════════════════════
    // PROCESS REPORT (AUTOMATED YIELD/LOSS)
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Read strategy's on-chain balance and recognize profit/loss
     * @dev Callable by owner or keeper — profit and loss are applied instantly to share price.
     * @param strategy Address of the strategy to report on
     */
    function processReport(address strategy) external onlyKeeperOrOwner nonReentrant returns (uint256 profit, uint256 loss) {
        StrategyConfig storage config = strategies[strategy];
        if (!config.isActive) revert StrategyNotActive(strategy);

        // Read strategy's current total assets
        uint256 currentAssets;
        try IStrategy(strategy).totalAssets() returns (uint256 assets) {
            currentAssets = assets;
        } catch {
            revert StrategyTotalAssetsReverted(strategy);
        }

        uint256 previousDebt = config.currentDebt;

        // Health check: validate deviation bounds before applying profit/loss
        if (healthCheckEnabled && previousDebt > 0) {
            if (currentAssets > previousDebt) {
                uint256 profitDelta = currentAssets - previousDebt;
                uint256 maxAllowed = (previousDebt * maxProfitReportBps) / MAX_BPS;
                if (profitDelta > maxAllowed) revert HealthCheckFailed(profitDelta, maxAllowed, false);
            } else if (currentAssets < previousDebt) {
                uint256 lossDelta = previousDebt - currentAssets;
                uint256 maxAllowed = (previousDebt * maxLossReportBps) / MAX_BPS;
                if (lossDelta > maxAllowed) revert HealthCheckFailed(lossDelta, maxAllowed, true);
            }
        }

        if (currentAssets > previousDebt) {
            // Profit detected — applied instantly to share price
            profit = currentAssets - previousDebt;
            config.currentDebt = currentAssets;
            config.lastTotalAssets = currentAssets;
            totalDebt += profit;
        } else if (currentAssets < previousDebt) {
            // Loss detected — applied instantly to share price
            loss = previousDebt - currentAssets;
            config.currentDebt = currentAssets;
            config.lastTotalAssets = currentAssets;
            totalDebt -= loss;

            // F2 fix: trigger emergency shutdown if loss >= 50% of previous debt
            if (previousDebt > 0 && (loss * MAX_BPS) / previousDebt >= MAX_LOSS_BPS) {
                emergencyShutdown = true;
                emit EmergencyShutdownTriggered(strategy, loss, previousDebt);
            }
        } else {
            // No change
            config.lastTotalAssets = currentAssets;
        }

        emit StrategyReported(strategy, profit, loss, currentAssets);
    }

    // ═══════════════════════════════════════════════════════════
    // FUND DEPLOYMENT (TIMELOCK)
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Request fund deployment to a strategy with timelock
     * @param strategy Active strategy address to deploy funds to
     * @param amount Amount of assets to deploy
     * @return deploymentId The unique ID for this deployment request
     */
    function requestDeploy(
        address strategy,
        uint256 amount
    ) external onlyOwner nonReentrant whenNotPaused returns (uint256 deploymentId) {
        if (amount == 0) revert ZeroAmount();
        if (strategy == address(0)) revert ZeroAddress();
        if (strategy == address(this)) revert SelfDeployNotAllowed();
        if (!strategies[strategy].isActive) revert StrategyNotActive(strategy);

        deploymentId = nextDeploymentId++;
        pendingDeployments[deploymentId] = PendingDeployment({
            strategy: strategy,
            amount: amount,
            requestedAt: block.timestamp,
            executed: false,
            cancelled: false
        });

        emit DeploymentRequested(deploymentId, strategy, amount, block.timestamp + DEPLOYMENT_DELAY);
    }

    /**
     * @notice Execute a fund deployment after timelock
     * @param deploymentId The deployment request ID to execute
     */
    function executeDeploy(uint256 deploymentId) external onlyOwner nonReentrant whenNotPaused {
        PendingDeployment storage pending = pendingDeployments[deploymentId];

        if (pending.requestedAt == 0) revert DeploymentNotFound();
        if (pending.executed) revert DeploymentAlreadyExecuted();
        if (pending.cancelled) revert DeploymentAlreadyCancelled();
        if (block.timestamp < pending.requestedAt + DEPLOYMENT_DELAY) {
            revert DeploymentTimelockNotMet(pending.requestedAt + DEPLOYMENT_DELAY, block.timestamp);
        }

        // Re-validate strategy still active
        if (!strategies[pending.strategy].isActive) revert StrategyNotActive(pending.strategy);

        // F3 fix: reserve both pending estimated assets AND claimable withdrawals
        uint256 reserved = _estimatePendingAssets() + totalClaimableWithdrawals;
        uint256 available = _vaultBalance() > reserved ? _vaultBalance() - reserved : 0;
        if (pending.amount > available) revert InsufficientIdleBalance(pending.amount, available);

        pending.executed = true;

        // Update accounting: debt increases, balance decreases after safeTransfer
        totalDebt += pending.amount;
        strategies[pending.strategy].currentDebt += pending.amount;

        IERC20(asset()).safeTransfer(pending.strategy, pending.amount);

        emit DeploymentExecuted(deploymentId, pending.strategy, pending.amount);
    }

    /**
     * @notice Cancel a pending deployment request
     * @param deploymentId The deployment request ID to cancel
     */
    function cancelDeploy(uint256 deploymentId) external onlyOwner nonReentrant {
        PendingDeployment storage pending = pendingDeployments[deploymentId];

        if (pending.requestedAt == 0) revert DeploymentNotFound();
        if (pending.executed) revert DeploymentAlreadyExecuted();
        if (pending.cancelled) revert DeploymentAlreadyCancelled();

        pending.cancelled = true;

        emit DeploymentCancelled(deploymentId);
    }

    // ═══════════════════════════════════════════════════════════
    // WITHDRAW FROM STRATEGY
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Pull assets back from a strategy into the vault
     * @dev Calls strategy.withdraw(), measures actual received amount, updates accounting.
     *      Strategy may send less than requested due to slippage or illiquidity.
     * @param strategy Address of the strategy to withdraw from
     * @param amount Amount of assets to withdraw
     */
    function withdrawFromStrategy(address strategy, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        StrategyConfig storage config = strategies[strategy];
        if (!config.isActive) revert StrategyNotFound(strategy);
        if (amount > config.currentDebt) revert WithdrawExceedsDebt(amount, config.currentDebt);

        uint256 balanceBefore = IERC20(asset()).balanceOf(address(this));

        // External call — reentrancy protected by nonReentrant
        IStrategy(strategy).withdraw(amount);

        uint256 balanceAfter = IERC20(asset()).balanceOf(address(this));
        uint256 received = balanceAfter - balanceBefore;

        // Use actual received amount (strategy may send less due to slippage)
        uint256 actualAmount = received < amount ? received : amount;

        totalDebt -= actualAmount;
        config.currentDebt -= actualAmount;

        emit FundsWithdrawnFromStrategy(strategy, actualAmount);
    }

    /**
     * @notice Returns the number of strategies in the registry
     */
    function strategyListLength() external view returns (uint256) {
        return strategyList.length;
    }

    // ═══════════════════════════════════════════════════════════
    // ERC-7540 OPERATOR FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    /// @notice Approve or revoke an operator for the caller
    function setOperator(address operator, bool approved) external returns (bool) {
        _isOperator[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
        return true;
    }

    /// @notice Check if an address is an operator for a controller
    function isOperator(address controller, address operator) public view returns (bool) {
        return _isOperator[controller][operator];
    }

    // ═══════════════════════════════════════════════════════════
    // ERC-7540 STANDARD VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    /// @notice Returns pending shares for a redeem request (ERC-7540)
    function pendingRedeemRequest(uint256 /* requestId */, address controller) external view returns (uint256) {
        return pendingWithdrawalShares[controller];
    }

    /// @notice Returns claimable shares for a redeem request (ERC-7540)
    function claimableRedeemRequest(uint256 /* requestId */, address controller) external view returns (uint256) {
        return claimableWithdrawalShares[controller];
    }

    // ═══════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    /// @notice Backward-compat view: total escrowed shares for pending withdrawals
    function totalPendingShares() external view returns (uint256) {
        return totalEscrowedShares;
    }

    /**
     * @notice Get idle asset balance (not reserved for pending or claimable withdrawals)
     */
    function idleBalance() external view returns (uint256) {
        uint256 reserved = _estimatePendingAssets() + totalClaimableWithdrawals;
        uint256 bal = _vaultBalance();
        if (bal <= reserved) return 0;
        return bal - reserved;
    }

    /**
     * @notice Get pending deployment details
     */
    function getDeploymentDetails(
        uint256 deploymentId
    )
        external
        view
        returns (
            address strategy,
            uint256 amount,
            uint256 requestedAt,
            uint256 executeAfter,
            bool executed,
            bool cancelled
        )
    {
        PendingDeployment storage d = pendingDeployments[deploymentId];
        return (d.strategy, d.amount, d.requestedAt, d.requestedAt + DEPLOYMENT_DELAY, d.executed, d.cancelled);
    }

    /**
     * @notice Get the vault share price (assets per share, in asset decimals)
     */
    function sharePrice() external view returns (uint256) {
        return _convertToAssetsEffective(10 ** decimals());
    }

    /**
     * @notice Effective assets available to shareholders
     */
    function effectiveAssets() external view returns (uint256) {
        return _effectiveAssets();
    }

    // ═══════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════

    /**
     * @dev Shared claim logic for withdraw() and redeem()
     */
    function _claimWithdrawal(address owner, address receiver, uint256 assets, uint256 shares) internal {
        if (msg.sender != owner && !isOperator(owner, msg.sender)) revert Unauthorized();

        claimableWithdrawals[owner] -= assets;
        claimableWithdrawalShares[owner] -= shares;
        totalClaimableWithdrawals -= assets;
        totalWithdrawn[owner] += assets;

        // Balance decreases naturally after safeTransfer
        IERC20(asset()).safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
        emit RedeemClaimed(owner, assets);
    }

    /**
     * @dev Asset balance held directly by the vault
     */
    function _vaultBalance() internal view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /**
     * @dev Effective assets for withdrawal/cancel conversions.
     *      Equivalent to totalAssets() since totalAssets() already excludes claimable reserves.
     */
    function _effectiveAssets() internal view returns (uint256) {
        return totalAssets();
    }

    /**
     * @dev Convert shares to assets using effective assets (for withdrawals)
     */
    function _convertToAssetsEffective(uint256 shares) internal view returns (uint256) {
        return
            Math.mulDiv(shares, _effectiveAssets() + 1, totalSupply() + 10 ** _decimalsOffset(), Math.Rounding.Floor);
    }

    /**
     * @dev Convert pending shares to assets at current effective price
     */
    function _convertPendingSharesToAssets(uint256 shares) internal view returns (uint256) {
        uint256 denom = totalSupply();
        if (denom == 0) return 0;
        return Math.mulDiv(shares, _effectiveAssets(), denom, Math.Rounding.Floor);
    }

    /**
     * @dev Estimate total pending assets for reservation calculations
     * @dev Uses explicit totalEscrowedShares (not balanceOf) to prevent orphaned share issues
     */
    function _estimatePendingAssets() internal view returns (uint256) {
        if (totalEscrowedShares == 0) return 0;
        return _convertPendingSharesToAssets(totalEscrowedShares);
    }

    // ═══════════════════════════════════════════════════════════
    // UUPS UPGRADE
    // ═══════════════════════════════════════════════════════════

    /// @dev Authorize upgrade — only owner can upgrade
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ═══════════════════════════════════════════════════════════
    // ERC4626 INFLATION PROTECTION
    // ═══════════════════════════════════════════════════════════

    /**
     * @dev Virtual share offset to prevent ERC4626 inflation/donation attacks.
     * With offset=6, 1 asset unit = 1,000,000 internal shares.
     */
    function _decimalsOffset() internal pure override returns (uint8) {
        return DECIMALS_OFFSET;
    }
}
