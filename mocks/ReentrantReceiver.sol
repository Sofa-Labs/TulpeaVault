// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/**
 * @title ReentrantReceiver
 * @notice A contract that attempts reentrancy from onERC721Received callback.
 * @dev Used to prove emergencyTransferNft follows checks-effects-interactions:
 *      _removeNft is called BEFORE safeTransferFrom, so state is consistent
 *      when this callback fires.
 */
contract ReentrantReceiver is IERC721Receiver {
    address public targetStrategy;
    uint256 public reentrantNftId;
    bool public shouldReenter;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    function setTarget(address strategy, uint256 nftId) external {
        targetStrategy = strategy;
        reentrantNftId = nftId;
    }

    function setShouldReenter(bool val) external {
        shouldReenter = val;
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external override returns (bytes4) {
        if (shouldReenter && targetStrategy != address(0)) {
            reentryAttempted = true;

            // Try to call emergencyTransferNft again — should fail because:
            // 1. The NFT was already removed from tracking (_removeNft before transfer)
            // 2. The NFT is now owned by this contract, not the strategy
            // 3. Even if we bypass that, onlyOwner blocks us
            try IStrategyEmergency(targetStrategy).emergencyTransferNft(
                reentrantNftId,
                address(this)
            ) {
                reentrySucceeded = true;
            } catch {
                reentrySucceeded = false;
            }
        }

        return IERC721Receiver.onERC721Received.selector;
    }
}

interface IStrategyEmergency {
    function emergencyTransferNft(uint256 nftId, address to) external;
}
