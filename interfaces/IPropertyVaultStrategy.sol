// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../libraries/TrancheTypes.sol";

/**
 * @title IPropertyVaultStrategy
 * @notice Minimal interface for PropertyVault used by RealEstateStrategy.
 */
interface IPropertyVaultStrategy {
    /// @notice Deposit assets as a lender into the property vault
    /// @param amount Amount of assets to deposit
    /// @param trancheType The tranche type for this deposit
    function depositAsLender(uint256 amount, TrancheTypes.TrancheType trancheType) external;
}
