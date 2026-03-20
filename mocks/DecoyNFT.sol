// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/**
 * @title DecoyNFT
 * @notice Simple ERC721 that mints via _safeMint. Used to test that
 *         RealEstateStrategy.onERC721Received ignores NFTs from non-portfolioNFT contracts.
 */
contract DecoyNFT is ERC721 {
    uint256 private _nextTokenId = 1;

    constructor() ERC721("Decoy NFT", "DECOY") {}

    /// @notice Mint a token to an address (safe — triggers onERC721Received)
    function mintTo(address to) external returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
    }
}
