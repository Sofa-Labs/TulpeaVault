// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IBurnableNFT {
    function burn(uint256 tokenId) external;
}

/**
 * @title MockPortfolioMasterWithAutoBurn
 * @notice Simulates production YieldModule behavior: transfer yield THEN burn NFT.
 * @dev Used by PROOF 10-11 to test harvest() behavior when claimLenderYield auto-burns NFTs.
 *      In production: YieldModule.processYieldClaim → transfers USDT → recordClaim → _burn(tokenId)
 */
contract MockPortfolioMasterWithAutoBurn {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdt;
    IBurnableNFT public mockNFT;

    mapping(uint256 => uint256) public claimableAmounts;
    mapping(uint256 => bool) public autoBurnOnClaim;
    mapping(uint256 => bool) public shouldRevert;

    constructor(address usdt_) {
        usdt = IERC20(usdt_);
    }

    /// @notice Set the mock NFT contract (for auto-burn)
    function setMockNFT(address nft_) external {
        mockNFT = IBurnableNFT(nft_);
    }

    /// @notice Set the claimable amount for a given tokenId
    function setClaimableAmount(uint256 tokenId, uint256 amount) external {
        claimableAmounts[tokenId] = amount;
    }

    /// @notice Set whether claimLenderYield should auto-burn the NFT after transfer
    function setAutoBurn(uint256 tokenId, bool val) external {
        autoBurnOnClaim[tokenId] = val;
    }

    /// @notice Set whether claimLenderYield should revert for a tokenId
    function setShouldRevert(uint256 tokenId, bool val) external {
        shouldRevert[tokenId] = val;
    }

    /// @notice Mock claimLenderYield — transfers USDT first, THEN burns NFT (matches production order)
    function claimLenderYield(uint256 tokenId) external {
        if (shouldRevert[tokenId]) revert("claim reverted");

        uint256 amount = claimableAmounts[tokenId];

        if (amount > 0) {
            claimableAmounts[tokenId] = 0;
            usdt.safeTransfer(msg.sender, amount);
        }

        // Auto-burn AFTER transfer (matches production: processYieldClaim → transfer → recordClaim → _burn)
        if (autoBurnOnClaim[tokenId]) {
            mockNFT.burn(tokenId);
        }
    }
}
