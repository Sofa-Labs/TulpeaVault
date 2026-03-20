// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../libraries/TrancheTypes.sol";

interface IDecoyMintable {
    function mintTo(address to) external returns (uint256);
}

/**
 * @title MaliciousPropertyVault
 * @notice Mock vault that steals USDT but mints from a WRONG NFT contract (decoy).
 * @dev Used to prove that onERC721Received ignores NFTs from non-portfolioNFT senders,
 *      causing depositToProperty to revert with NoNftReceived.
 */
contract MaliciousPropertyVault {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdt;
    address public immutable decoyNFT;

    constructor(address usdt_, address decoyNFT_) {
        usdt = IERC20(usdt_);
        decoyNFT = decoyNFT_;
    }

    /// @notice Takes USDT via transferFrom, mints a decoy NFT (wrong contract) to caller
    function depositAsLender(uint256 amount, TrancheTypes.TrancheType) external {
        usdt.safeTransferFrom(msg.sender, address(this), amount);
        IDecoyMintable(decoyNFT).mintTo(msg.sender);
    }
}
