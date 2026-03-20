// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../TulpeaYieldVault.sol";

/**
 * @title TulpeaYieldVaultV2Mock
 * @notice Minimal V2 mock for upgrade safety tests.
 */
contract TulpeaYieldVaultV2Mock is TulpeaYieldVault {
    uint256 public v2NewVariable;

    function setV2NewVariable(uint256 value) external onlyOwner {
        v2NewVariable = value;
    }

    function vaultVersion() external pure returns (uint256) {
        return 2;
    }
}
