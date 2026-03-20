// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../libraries/TrancheTypes.sol";

/**
 * @title MockPropertyVaultNoMint
 * @notice A mock PropertyVault that accepts deposits but does NOT mint any NFT.
 * @dev Used to test that RealEstateStrategy.depositToProperty reverts with
 *      NoNftReceived when the vault fails to mint.
 */
contract MockPropertyVaultNoMint {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdt;

    constructor(address usdt_) {
        usdt = IERC20(usdt_);
    }

    /// @notice Accept USDT deposit but do NOT mint any NFT
    function depositAsLender(uint256 amount, TrancheTypes.TrancheType) external {
        usdt.safeTransferFrom(msg.sender, address(this), amount);
        // Intentionally does NOT mint any NFT
    }
}
