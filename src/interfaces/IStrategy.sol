// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IStrategy
 * @notice Minimal strategy interface for TulpeaYieldVault.
 * @dev Strategies hold the vault's underlying asset and report their total assets.
 *      The vault reads on-chain balances via totalAssets() and pulls funds via withdraw().
 */
interface IStrategy {
    /// @notice Returns the total assets managed by this strategy (principal + yield - losses)
    function totalAssets() external view returns (uint256);

    /// @notice Withdraws assets from the strategy back to msg.sender (the vault)
    /// @param amount Amount of assets to withdraw
    function withdraw(uint256 amount) external;

    /// @notice Returns the maximum amount that can be withdrawn right now
    /// @dev Vault calls this before withdraw() to prevent failed transactions
    function availableWithdrawLimit() external view returns (uint256);
}
