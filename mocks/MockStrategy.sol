// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategy.sol";

/**
 * @title MockStrategy
 * @notice Test-only strategy with controllable totalAssets for simulating yield/loss.
 * @dev Holds real USDC so withdraw() works. Use setTotalAssets() to simulate profit/loss.
 */
contract MockStrategy is IStrategy {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    uint256 private _totalAssets;
    bool private _revertOnTotalAssets;

    constructor(address asset_) {
        asset = IERC20(asset_);
    }

    /// @notice Set the totalAssets return value (simulates yield/loss)
    function setTotalAssets(uint256 amount) external {
        _totalAssets = amount;
    }

    /// @notice Make totalAssets() revert (for testing try/catch)
    function setRevertOnTotalAssets(bool shouldRevert) external {
        _revertOnTotalAssets = shouldRevert;
    }

    /// @notice Returns the controllable total assets value
    function totalAssets() external view override returns (uint256) {
        require(!_revertOnTotalAssets, "MockStrategy: totalAssets reverted");
        return _totalAssets;
    }

    /// @notice Returns idle balance (all withdrawable in mock)
    function availableWithdrawLimit() external view override returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /// @notice Transfers USDC from strategy to msg.sender (the vault)
    function withdraw(uint256 amount) external override {
        asset.safeTransfer(msg.sender, amount);
    }

    /// @notice Receive USDC (called when vault deploys funds)
    /// @dev No-op, just accepts the tokens
}
