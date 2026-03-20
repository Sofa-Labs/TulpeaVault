// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ITulpeaYieldVault
/// @notice Minimal interface for strategies to read the vault's keeper address
interface ITulpeaYieldVault {
    /// @notice Returns the keeper address set on the vault
    function keeper() external view returns (address);
}
