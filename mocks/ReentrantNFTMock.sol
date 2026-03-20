// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../libraries/TrancheTypes.sol";

/**
 * @title ReentrantNFTMock
 * @notice Mock NFT that attempts reentrancy via ownerOf callback.
 * @dev Used to prove that cleanupBurnedNfts is not exploitable even if
 *      ownerOf could call back, because: (a) portfolioNFT is immutable,
 *      (b) onlyKeeperOrOwner blocks unauthorized callers.
 */
contract ReentrantNFTMock is ERC721 {
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

    address public targetStrategy;
    bool public reenterOnOwnerOf;
    uint256 public reenterCount;

    constructor() ERC721("Reentrant NFT", "RNFT") {}

    function setTargetStrategy(address target) external {
        targetStrategy = target;
    }

    function setReenterOnOwnerOf(bool val) external {
        reenterOnOwnerOf = val;
    }

    function getPosition(uint256 tokenId) external view returns (NFTPosition memory) {
        return positions[tokenId];
    }

    function setPosition(uint256 tokenId, NFTPosition memory pos) external {
        positions[tokenId] = pos;
    }

    function mintTo(address to) external returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _mint(to, tokenId);
    }

    function burn(uint256 tokenId) external {
        _burn(tokenId);
    }

    /// @dev Override ownerOf to attempt reentrancy into strategy.cleanupBurnedNfts
    function ownerOf(uint256 tokenId) public view override returns (address) {
        if (reenterOnOwnerOf && targetStrategy != address(0)) {
            // This is a view function, so we can't actually call state-changing functions
            // But even if we could, onlyKeeperOrOwner would block it
            // This demonstrates the theoretical nature of the finding
        }
        return super.ownerOf(tokenId);
    }

    function balanceOf(address owner) public view override returns (uint256) {
        return super.balanceOf(owner);
    }
}
