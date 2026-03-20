// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../libraries/TrancheTypes.sol";

interface IPortfolioNFTMintable {
    function mintTo(address to) external returns (uint256);
}

/**
 * @title MockPropertyVaultDoubleMint
 * @notice Mock PropertyVault that takes USDT and mints TWO NFTs from the real portfolioNFT.
 * @dev Proves that when two NFTs are minted during depositToProperty, both are tracked
 *      via _addNft in onERC721Received, but the event only reports the last one.
 */
contract MockPropertyVaultDoubleMint {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdt;
    address public immutable portfolioNFT;

    constructor(address usdt_, address portfolioNFT_) {
        usdt = IERC20(usdt_);
        portfolioNFT = portfolioNFT_;
    }

    /// @notice Takes USDT, mints TWO NFTs from the real portfolioNFT to the caller
    function depositAsLender(uint256 amount, TrancheTypes.TrancheType) external {
        usdt.safeTransferFrom(msg.sender, address(this), amount);
        IPortfolioNFTMintable(portfolioNFT).mintTo(msg.sender);
        IPortfolioNFTMintable(portfolioNFT).mintTo(msg.sender);
    }
}
