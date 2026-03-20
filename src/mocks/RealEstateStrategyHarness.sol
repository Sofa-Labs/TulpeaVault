// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../strategies/RealEstateStrategy.sol";

/**
 * @title RealEstateStrategyHarness
 * @notice Test harness exposing internal _addNft for unit tests.
 * @dev Used by tests that need to manually track NFTs after F4 fix
 *      (unsolicited onERC721Received is now rejected).
 */
contract RealEstateStrategyHarness is RealEstateStrategy {
    constructor(
        address asset_,
        address portfolioNFT_,
        address portfolioMaster_,
        address vault_,
        address owner_
    ) RealEstateStrategy(asset_, portfolioNFT_, portfolioMaster_, vault_, owner_) {}

    /// @notice Public wrapper for _addNft (test-only harness)
    function addNftForTesting(uint256 nftId) external onlyOwner {
        _addNft(nftId);
    }

    /// @notice Public wrapper for _removeNft (test-only harness)
    function removeNftForTesting(uint256 nftId) external onlyOwner {
        _removeNft(nftId);
    }

    /// @notice Public wrapper for _nftValue (test-only harness)
    function nftValue(uint256 nftId) external view returns (uint256) {
        return _nftValue(nftId);
    }
}
