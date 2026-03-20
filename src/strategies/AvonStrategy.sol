// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../interfaces/IStrategy.sol";
import "../interfaces/ITulpeaYieldVault.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Uniswap V3 SwapRouter02 interface (IV3SwapRouter)
/// @dev SwapRouter02 does NOT have deadline in ExactInputSingleParams.
///      Deadline protection is via multicall(uint256 deadline, bytes[] data).
interface IV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    /// @notice Executes multiple calls with deadline protection
    /// @dev Reverts if block.timestamp > deadline. All swap calls should be wrapped in this.
    function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory results);
}

/**
 * @title AvonStrategy
 * @notice Strategy that swaps asset→USDm via Kumbaya DEX, then deposits into Avon MegaVault for lending yield
 * @dev Flow: asset → USDm (Kumbaya swap) → MegaVault deposit → hold USDmY
 *      Reverse: USDmY → USDm (MegaVault redeem) → asset (Kumbaya swap) → vault
 *      totalAssets() uses 1:1 stablecoin approximation (USDm ≈ asset)
 */
contract AvonStrategy is IStrategy, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════
    // IMMUTABLES
    // ═══════════════════════════════════════════════════════════

    /// @notice Underlying asset token (input/output token)
    IERC20 public immutable asset;

    /// @notice USDm token (intermediate token)
    IERC20 public immutable usdm;

    /// @notice Avon MegaVault (ERC-4626, returns USDmY shares)
    IERC4626 public immutable megaVault;

    /// @notice Kumbaya SwapRouter02
    IV3SwapRouter public immutable swapRouter;

    /// @notice TulpeaYieldVault address (only caller for withdraw)
    address public immutable vault;

    // ═══════════════════════════════════════════════════════════
    // CONSTANTS — Hardcoded for stablecoin-only swaps (asset↔USDm)
    // ═══════════════════════════════════════════════════════════

    /// @notice Decimal scaling factor between USDm and asset
    /// @dev WARNING: If both USDm and asset use the same decimals, this must be 1 (no scaling).
    ///      Current value assumes USDm(18 dec) → asset(6 dec). Verify before deployment.
    uint256 private constant DECIMAL_SCALE = 1e12;

    /// @notice Swap fee tier for asset/USDm pool on Kumbaya (100 = 0.01%)
    uint24 public constant SWAP_FEE_TIER = 100;

    /// @notice Maximum slippage tolerance in basis points (50 = 0.5%)
    /// @dev Generous for stable↔stable; if exceeded, likely a depeg — swap should fail
    uint256 public constant MAX_SLIPPAGE_BPS = 50;

    /// @notice Deadline buffer in seconds for swap transactions (300 = 5 min)
    uint256 public constant SWAP_DEADLINE_BUFFER = 300;

    // ═══════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════

    error ZeroAddress();
    error ZeroAmount();
    error OnlyVault();
    error InsufficientOutput(uint256 expected, uint256 actual);
    error MegaVaultDepositLimitExceeded(uint256 usdmReceived, uint256 maxDeposit);

    error NotKeeperOrOwner();
    error NoUsdtReceived();
    error InvalidConfiguration();


    // ═══════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════

    event Deposited(uint256 usdtAmount, uint256 usdmReceived, uint256 sharesReceived);
    event Withdrawn(uint256 sharesRedeemed, uint256 usdmReceived, uint256 usdtReturned);
    event EmergencyTokenWithdrawn(address token, uint256 amount);

    // ═══════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════

    modifier onlyKeeperOrOwner() {
        if (msg.sender != owner() && msg.sender != ITulpeaYieldVault(vault).keeper()) revert NotKeeperOrOwner();
        _;
    }

    // ═══════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════

    constructor(
        address _asset,
        address _usdm,
        address _megaVault,
        address _swapRouter,
        address _vault,
        address owner_
    ) Ownable(owner_) {
        if (_asset == address(0)) revert ZeroAddress();
        if (_usdm == address(0)) revert ZeroAddress();
        if (_megaVault == address(0)) revert ZeroAddress();
        if (_swapRouter == address(0)) revert ZeroAddress();
        if (_vault == address(0)) revert ZeroAddress();
        if (owner_ == address(0)) revert ZeroAddress();
        if (_asset == _usdm) revert InvalidConfiguration();
        if (IERC4626(_megaVault).asset() != _usdm) revert InvalidConfiguration();

        asset = IERC20(_asset);
        usdm = IERC20(_usdm);
        megaVault = IERC4626(_megaVault);
        swapRouter = IV3SwapRouter(_swapRouter);
        vault = _vault;
    }

    // ═══════════════════════════════════════════════════════════
    // IStrategy — CORE FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    /// @notice Total value of assets managed by this strategy, denominated in asset decimals
    /// @dev USDm ≈ asset at 1:1. Scales USDm values by DECIMAL_SCALE before summing.
    function totalAssets() external view override returns (uint256) {
        // USDmY shares held → USDm value (18 dec, includes accrued yield)
        uint256 shares = megaVault.balanceOf(address(this));
        uint256 usdmValue = shares > 0 ? megaVault.convertToAssets(shares) : 0;

        // Idle balances
        uint256 idleUsdt = asset.balanceOf(address(this));
        uint256 idleUsdm = usdm.balanceOf(address(this));

        // Scale USDm values to asset decimals
        return (usdmValue / DECIMAL_SCALE) + (idleUsdm / DECIMAL_SCALE) + idleUsdt;
    }

    /// @notice Maximum amount that can be withdrawn right now (in asset decimals)
    /// @dev idle assets + MegaVault redeemable value (1:1 approximation, actual may differ due to swap slippage)
    function availableWithdrawLimit() external view override returns (uint256) {
        uint256 idleUsdt = asset.balanceOf(address(this));
        uint256 shares = megaVault.balanceOf(address(this));
        uint256 redeemableUsdm = shares > 0 ? megaVault.convertToAssets(shares) : 0;
        // Conservative: apply slippage discount, then scale to asset decimals
        uint256 redeemableUsdt = (redeemableUsdm * (10000 - MAX_SLIPPAGE_BPS)) / 10000 / DECIMAL_SCALE;
        return idleUsdt + redeemableUsdt;
    }

    /// @notice Withdraw assets from strategy back to vault
    /// @dev Redeems USDmY → USDm → swaps to asset → sends to vault
    function withdraw(uint256 amount) external override nonReentrant {
        if (msg.sender != vault) revert OnlyVault();
        if (amount == 0) revert ZeroAmount();

        uint256 idleUsdt = asset.balanceOf(address(this));

        if (idleUsdt >= amount) {
            // Enough idle assets — just send it
            asset.safeTransfer(vault, amount);
            emit Withdrawn(0, 0, amount);
            return;
        }

        // Need to pull from MegaVault
        uint256 needed = amount - idleUsdt;
        uint256 sharesToRedeem;
        uint256 usdmRedeemed;

        // Only try MegaVault redeem if we hold shares
        uint256 maxShares = megaVault.balanceOf(address(this));
        if (maxShares > 0) {
            // Scale needed from asset decimals (6) to USDm decimals (18) for MegaVault
            uint256 neededUsdm = needed * DECIMAL_SCALE;
            sharesToRedeem = megaVault.convertToShares(neededUsdm);
            if (sharesToRedeem > maxShares) sharesToRedeem = maxShares;
            if (sharesToRedeem > 0) {
                usdmRedeemed = megaVault.redeem(sharesToRedeem, address(this), address(this));
                if (usdmRedeemed > 0) {
                    _swapUsdmToUsdt(usdmRedeemed);
                }
            }
        }

        // Send whatever assets we have to vault (may be less due to slippage or empty vault)
        uint256 usdtBalance = asset.balanceOf(address(this));
        uint256 toSend = usdtBalance < amount ? usdtBalance : amount;
        if (toSend > 0) {
            asset.safeTransfer(vault, toSend);
        }

        emit Withdrawn(sharesToRedeem, usdmRedeemed, toSend);
    }

    // ═══════════════════════════════════════════════════════════
    // DEPOSIT — Keeper/Owner deploys USDT into MegaVault
    // ═══════════════════════════════════════════════════════════

    /// @notice Deposit assets into Avon MegaVault
    /// @dev Swaps asset → USDm via Kumbaya DEX, then deposits USDm into MegaVault
    function deposit(uint256 amount) external onlyKeeperOrOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();

        // Step 1: Swap asset → USDm via Kumbaya
        uint256 usdmReceived = _swapUsdtToUsdm(amount);

        // Step 2: Check MegaVault deposit limit (post-swap, in USDm units)
        uint256 maxDep = megaVault.maxDeposit(address(this));
        if (usdmReceived > maxDep) revert MegaVaultDepositLimitExceeded(usdmReceived, maxDep);

        // Step 3: Deposit USDm into MegaVault → receive USDmY shares
        usdm.forceApprove(address(megaVault), usdmReceived);
        uint256 shares = megaVault.deposit(usdmReceived, address(this));

        emit Deposited(amount, usdmReceived, shares);
    }

    // ═══════════════════════════════════════════════════════════
    // EMERGENCY
    // ═══════════════════════════════════════════════════════════

    /// @notice Emergency: recover any ERC20 stuck in this contract
    function emergencyWithdrawToken(address token, uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(vault, amount);
        emit EmergencyTokenWithdrawn(token, amount);
    }

    // ═══════════════════════════════════════════════════════════
    // INTERNAL — Swap helpers
    // ═══════════════════════════════════════════════════════════

    /// @dev Swap asset → USDm via Kumbaya SwapRouter02 with deadline protection
    function _swapUsdtToUsdm(uint256 amountIn) internal returns (uint256 amountOut) {
        asset.forceApprove(address(swapRouter), amountIn);

        // Scale minOut from asset decimals → USDm decimals, then apply slippage
        uint256 minOut = (amountIn * DECIMAL_SCALE * (10000 - MAX_SLIPPAGE_BPS)) / 10000;

        // Encode the swap call for multicall deadline wrapping
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(
            swapRouter.exactInputSingle,
            (
                IV3SwapRouter.ExactInputSingleParams({
                    tokenIn: address(asset),
                    tokenOut: address(usdm),
                    fee: SWAP_FEE_TIER,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            )
        );

        bytes[] memory results = swapRouter.multicall(block.timestamp + SWAP_DEADLINE_BUFFER, calls);
        amountOut = abi.decode(results[0], (uint256));
    }

    /// @dev Swap USDm → asset via Kumbaya SwapRouter02 with deadline protection
    function _swapUsdmToUsdt(uint256 amountIn) internal returns (uint256 amountOut) {
        usdm.forceApprove(address(swapRouter), amountIn);

        // Scale minOut from USDm decimals → asset decimals, then apply slippage
        uint256 minOut = (amountIn * (10000 - MAX_SLIPPAGE_BPS)) / 10000 / DECIMAL_SCALE;

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(
            swapRouter.exactInputSingle,
            (
                IV3SwapRouter.ExactInputSingleParams({
                    tokenIn: address(usdm),
                    tokenOut: address(asset),
                    fee: SWAP_FEE_TIER,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            )
        );

        bytes[] memory results = swapRouter.multicall(block.timestamp + SWAP_DEADLINE_BUFFER, calls);
        amountOut = abi.decode(results[0], (uint256));
    }
}
