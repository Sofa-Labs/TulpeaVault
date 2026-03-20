// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockPortfolioMasterForStrategy
 * @notice Controllable yield claim mock for testing RealEstateStrategy.
 * @dev setClaimableAmount(tokenId, amount) controls what claimLenderYield returns.
 *      The mock must hold USDT to transfer on claims.
 */
contract MockPortfolioMasterForStrategy {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdt;
    mapping(uint256 => uint256) public claimableAmounts;
    mapping(uint256 => bool) public shouldRevert;

    constructor(address usdt_) {
        usdt = IERC20(usdt_);
    }

    /// @notice Set the claimable amount for a given tokenId
    function setClaimableAmount(uint256 tokenId, uint256 amount) external {
        claimableAmounts[tokenId] = amount;
    }

    /// @notice Set whether claimLenderYield should revert for a tokenId
    function setShouldRevert(uint256 tokenId, bool val) external {
        shouldRevert[tokenId] = val;
    }

    /// @notice Mock claimLenderYield — transfers set amount to caller
    function claimLenderYield(uint256 tokenId) external {
        if (shouldRevert[tokenId]) revert("claim reverted");
        uint256 amount = claimableAmounts[tokenId];
        if (amount > 0) {
            claimableAmounts[tokenId] = 0;
            usdt.safeTransfer(msg.sender, amount);
        }
    }
}
