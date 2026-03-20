// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../libraries/TrancheTypes.sol";

/**
 * @title MockPortfolioNFTForStrategy
 * @notice Controllable NFT mock for unit-testing RealEstateStrategy pro-rata math.
 * @dev Supports getPosition(), balanceOf(), ownerOf(), tokenOfOwnerByIndex().
 *      Positions are set via setPosition(). Minting/burning is manual.
 */
contract MockPortfolioNFTForStrategy is ERC721 {
    struct NFTPosition {
        uint256 amountInvested;
        uint256 amountOwed;
        uint256 totalClaimed;
        uint256 yieldCapBps;
        uint256 propertyId;
        TrancheTypes.TrancheType trancheType;
        bool isSplit;
        uint8 splitDepth;
    }

    mapping(uint256 => NFTPosition) public positions;
    uint256 private _nextTokenId = 1;
    bool public revertOnGetPosition;

    /// @notice Per-token revert control for getPosition
    mapping(uint256 => bool) public revertForToken;

    // Track tokens per owner for tokenOfOwnerByIndex
    mapping(address => uint256[]) private _ownedTokens;
    mapping(uint256 => uint256) private _ownedTokensIndex;

    constructor() ERC721("Mock Portfolio NFT", "MPNFT") {}

    /// @notice Set a position for a given tokenId (for testing)
    function setPosition(uint256 tokenId, NFTPosition memory pos) external {
        positions[tokenId] = pos;
    }

    /// @notice Set whether getPosition should revert
    function setRevertOnGetPosition(bool val) external {
        revertOnGetPosition = val;
    }

    /// @notice Set per-token revert control for getPosition
    function setRevertForToken(uint256 tokenId, bool val) external {
        revertForToken[tokenId] = val;
    }

    /// @notice Get position data
    function getPosition(uint256 tokenId) external view returns (NFTPosition memory) {
        if (revertForToken[tokenId]) revert("getPosition reverted for token");
        if (revertOnGetPosition) revert("getPosition reverted");
        return positions[tokenId];
    }

    /// @notice Mint a token to an address (safe — triggers onERC721Received)
    function mintTo(address to) external returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
    }

    /// @notice Mint a token without triggering onERC721Received (for test setup)
    function mintUnsafe(address to) external returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _mint(to, tokenId);
    }

    /// @notice Burn a token (simulates auto-burn on full repayment)
    function burn(uint256 tokenId) external {
        _burn(tokenId);
    }

    /// @notice Returns the token at a given index for an owner
    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256) {
        require(index < _ownedTokens[owner].length, "index out of bounds");
        return _ownedTokens[owner][index];
    }

    /// @dev Override _update to track owned tokens
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);

        // Remove from previous owner
        if (from != address(0)) {
            _removeTokenFromOwnerEnumeration(from, tokenId);
        }

        // Add to new owner
        if (to != address(0)) {
            _ownedTokens[to].push(tokenId);
            _ownedTokensIndex[tokenId] = _ownedTokens[to].length - 1;
        }
    }

    function _removeTokenFromOwnerEnumeration(address owner, uint256 tokenId) private {
        uint256 lastIndex = _ownedTokens[owner].length - 1;
        uint256 tokenIndex = _ownedTokensIndex[tokenId];

        if (tokenIndex != lastIndex) {
            uint256 lastTokenId = _ownedTokens[owner][lastIndex];
            _ownedTokens[owner][tokenIndex] = lastTokenId;
            _ownedTokensIndex[lastTokenId] = tokenIndex;
        }

        _ownedTokens[owner].pop();
        delete _ownedTokensIndex[tokenId];
    }
}
