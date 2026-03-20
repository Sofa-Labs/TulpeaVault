// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MockVaultForStrategy
/// @notice Minimal mock implementing keeper() for strategy tests
contract MockVaultForStrategy {
    address public keeper;

    function setKeeper(address _keeper) external {
        keeper = _keeper;
    }

    /// @notice Accept ETH for gas funding when impersonating this contract in tests
    receive() external payable {}
}
