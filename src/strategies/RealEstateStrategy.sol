// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IStrategy.sol";
import "../interfaces/ITulpeaYieldVault.sol";
import "../interfaces/IPropertyVaultStrategy.sol";
import "../libraries/TrancheTypes.sol";

/**
 * @title IPortfolioNFTStrategy
 * @notice Minimal NFT interface for RealEstateStrategy
 */
interface IPortfolioNFTStrategy {
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

    function getPosition(uint256 tokenId) external view returns (NFTPosition memory);
    function balanceOf(address owner) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title IPortfolioMasterStrategy
 * @notice Minimal PortfolioMaster interface for RealEstateStrategy
 */
interface IPortfolioMasterStrategy {
    function claimLenderYield(uint256 tokenId) external;
}

/**
 * @title RealEstateStrategy
 * @notice Strategy that deposits assets into PropertyVaults as a lender, holds NFTs, and reports pro-rata yield.
 * @dev This strategy is inherently illiquid. withdraw() can only send idle assets (already harvested).
 *      Admin/keeper must call harvest() before the vault can pull funds via withdrawFromStrategy().
 *
 *      Pro-Rata Yield Math (per NFT):
 *        maxReturn = invested * (10000 + yieldCapBps) / 10000
 *        totalAllocated = totalClaimed + amountOwed
 *        lockedPrincipal = invested * (maxReturn - totalAllocated) / maxReturn
 *        nftValue = lockedPrincipal + amountOwed
 *
 *      totalAssets() = idle asset balance + sum(_nftValue(nftId)) for all held NFTs
 */
contract RealEstateStrategy is IStrategy, IERC721Receiver, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════

    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MAX_NFTS = 50;

    // ═══════════════════════════════════════════════════════════
    // IMMUTABLES
    // ═══════════════════════════════════════════════════════════

    /// @notice Underlying asset token (the vault's asset)
    IERC20 public immutable asset;

    /// @notice PortfolioNFT contract (ERC721 with getPosition)
    IPortfolioNFTStrategy public immutable portfolioNFT;

    /// @notice PortfolioMaster contract (for claimLenderYield)
    IPortfolioMasterStrategy public immutable portfolioMaster;

    /// @notice TulpeaYieldVault address (only caller for withdraw)
    address public immutable vault;

    // ═══════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════

    /// @notice Array of held NFT IDs
    uint256[] public heldNftIds;

    /// @notice Quick lookup: is this NFT held by strategy?
    mapping(uint256 => bool) public isHeldNft;

    /// @notice Index of NFT in heldNftIds array (for O(1) swap-and-pop removal)
    mapping(uint256 => uint256) public nftIndex;

    /// @notice Reentrancy-style flag for depositToProperty
    bool private _depositing;

    /// @notice Captures NFT IDs minted during depositToProperty (set by onERC721Received)
    uint256[] private _mintedNftIds;

    // ═══════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════

    error ZeroAddress();
    error OnlyVault();
    error ZeroAmount();
    error NftNotHeld(uint256 tokenId);
    error InsufficientBalance(uint256 requested, uint256 available);
    error MaxNftsReached();
    error UnsolicitedNftTransfer();
    error NotKeeperOrOwner();
    error NoNftReceived();

    // ═══════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════

    event DepositedToProperty(address indexed propertyVault, uint256 amount, uint256[] nftIds);
    event PartialWithdraw(uint256 requested, uint256 sent);
    event Harvested(uint256 totalClaimed);
    event HarvestedSingle(uint256 indexed nftId, uint256 claimed);
    event NftAdded(uint256 indexed nftId);
    event NftRemoved(uint256 indexed nftId);
    event EmergencyTokenWithdrawn(address token, uint256 amount);
    event EmergencyNftTransferred(uint256 indexed nftId, address to);
    event HarvestFailed(uint256 indexed nftId, bytes reason);
    event BurnedNftsCleaned(uint256 removedCount);

    // ═══════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════

    constructor(
        address asset_,
        address portfolioNFT_,
        address portfolioMaster_,
        address vault_,
        address owner_
    ) Ownable(owner_) {
        if (asset_ == address(0)) revert ZeroAddress();
        if (portfolioNFT_ == address(0)) revert ZeroAddress();
        if (portfolioMaster_ == address(0)) revert ZeroAddress();
        if (vault_ == address(0)) revert ZeroAddress();
        if (owner_ == address(0)) revert ZeroAddress();

        asset = IERC20(asset_);
        portfolioNFT = IPortfolioNFTStrategy(portfolioNFT_);
        portfolioMaster = IPortfolioMasterStrategy(portfolioMaster_);
        vault = vault_;
    }

    // ═══════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════

    modifier onlyKeeperOrOwner() {
        if (msg.sender != owner() && msg.sender != ITulpeaYieldVault(vault).keeper()) revert NotKeeperOrOwner();
        _;
    }

    // ═══════════════════════════════════════════════════════════
    // IStrategy IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Total asset value: idle balance + sum of all held NFT values
     * @dev Iterates heldNftIds. Gas limit: cap at ~50 NFTs per strategy instance.
     *      - Skips burned/transferred NFTs
     *      - try-catch on _nftValue prevents single-token DoS
     */
    function totalAssets() external view override returns (uint256) {
        uint256 total = asset.balanceOf(address(this));

        for (uint256 i = 0; i < heldNftIds.length; i++) {
            uint256 nftId = heldNftIds[i];

            try portfolioNFT.ownerOf(nftId) returns (address nftOwner) {
                if (nftOwner != address(this)) continue;
            } catch {
                // NFT burned — ownerOf reverts for nonexistent tokens
                continue;
            }

            try this.nftValueExternal(nftId) returns (uint256 val) {
                total += val;
            } catch {
                // Skip tokens whose getPosition reverts — they'll be cleaned up later
            }
        }

        return total;
    }

    /**
     * @notice External wrapper for _nftValue — used by totalAssets() try-catch
     * @dev Internal functions cannot be called with try-catch; this provides the external call target.
     */
    function nftValueExternal(uint256 nftId) external view returns (uint256) {
        require(msg.sender == address(this), "only self");
        return _nftValue(nftId);
    }

    /// @notice Maximum amount that can be withdrawn right now (only idle assets — NFTs are illiquid)
    function availableWithdrawLimit() external view override returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /**
     * @notice Withdraw idle assets to the vault
     * @dev Only sends assets already in the strategy (harvested yield or un-deployed funds).
     *      Does NOT liquidate NFT positions. Admin must harvest() first.
     * @param amount Amount of assets to withdraw
     */
    function withdraw(uint256 amount) external override {
        if (msg.sender != vault) revert OnlyVault();
        if (amount == 0) revert ZeroAmount();

        uint256 balance = asset.balanceOf(address(this));
        uint256 toSend = amount < balance ? amount : balance;
        if (toSend == 0) revert InsufficientBalance(amount, balance);

        if (toSend < amount) emit PartialWithdraw(amount, toSend);

        asset.safeTransfer(vault, toSend);
    }

    // ═══════════════════════════════════════════════════════════
    // STRATEGY-SPECIFIC: DEPOSIT TO PROPERTY
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Deposit assets into a PropertyVault as a lender
     * @dev Approves asset, calls depositAsLender. Minted NFTs are captured via onERC721Received callback.
     * @param propertyVault Address of the PropertyVault
     * @param amount Amount of assets to deposit
     * @param trancheType Tranche type for the deposit
     */
    function depositToProperty(
        address propertyVault,
        uint256 amount,
        TrancheTypes.TrancheType trancheType
    ) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();

        _depositing = true;
        delete _mintedNftIds;

        // Approve and deposit — _safeMint triggers onERC721Received which appends to _mintedNftIds
        asset.forceApprove(propertyVault, amount);
        IPropertyVaultStrategy(propertyVault).depositAsLender(amount, trancheType);

        _depositing = false;

        // onERC721Received must have captured at least one NFT during _safeMint
        if (_mintedNftIds.length == 0) revert NoNftReceived();

        emit DepositedToProperty(propertyVault, amount, _mintedNftIds);
    }

    // ═══════════════════════════════════════════════════════════
    // STRATEGY-SPECIFIC: HARVEST YIELD
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Harvest yield from all held NFTs
     * @dev Iterates all heldNftIds and calls claimLenderYield on each.
     *      Claimed assets land in this contract as idle balance.
     *      Auto-cleans burned/transferred NFTs via swap-and-pop.
     */
    function harvest() external onlyKeeperOrOwner nonReentrant {
        uint256 balBefore = asset.balanceOf(address(this));

        uint256 i = 0;
        while (i < heldNftIds.length) {
            uint256 nftId = heldNftIds[i];
            try portfolioMaster.claimLenderYield(nftId) {} catch (bytes memory reason) {
                emit HarvestFailed(nftId, reason);
            }

            // Auto-cleanup: if claimLenderYield triggered auto-burn, remove ghost entry.
            // _removeNft does swap-and-pop, so do NOT increment i when an entry is removed.
            bool removed = false;
            try portfolioNFT.ownerOf(nftId) returns (address nftOwner) {
                if (nftOwner != address(this)) {
                    _removeNft(nftId);
                    removed = true;
                }
            } catch {
                _removeNft(nftId);
                removed = true;
            }
            if (!removed) i++;
        }

        uint256 totalClaimed = asset.balanceOf(address(this)) - balBefore;
        emit Harvested(totalClaimed);
    }

    /**
     * @notice Harvest yield from a single NFT
     * @param nftId The NFT to harvest from
     */
    function harvestSingle(uint256 nftId) external onlyKeeperOrOwner nonReentrant {
        if (!isHeldNft[nftId]) revert NftNotHeld(nftId);

        uint256 balBefore = asset.balanceOf(address(this));
        portfolioMaster.claimLenderYield(nftId);
        uint256 claimed = asset.balanceOf(address(this)) - balBefore;

        // Auto-cleanup: if claimLenderYield triggered auto-burn (fully repaid),
        // remove the ghost entry from tracking to avoid stale iteration in totalAssets()
        try portfolioNFT.ownerOf(nftId) returns (address nftOwner) {
            if (nftOwner != address(this)) _removeNft(nftId);
        } catch {
            _removeNft(nftId);
        }

        emit HarvestedSingle(nftId, claimed);
    }

    // ═══════════════════════════════════════════════════════════
    // MAINTENANCE
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Remove auto-burned NFTs from tracking
     * @dev Checks each held NFT via ownerOf. If it reverts (burned), remove from tracking.
     */
    function cleanupBurnedNfts() external onlyKeeperOrOwner {
        uint256 startLen = heldNftIds.length;
        uint256 i = 0;
        while (i < heldNftIds.length) {
            uint256 nftId = heldNftIds[i];
            try portfolioNFT.ownerOf(nftId) returns (address owner) {
                if (owner != address(this)) {
                    _removeNft(nftId);
                } else {
                    i++;
                }
            } catch {
                _removeNft(nftId);
            }
        }
        emit BurnedNftsCleaned(startLen - heldNftIds.length);
    }

    // ═══════════════════════════════════════════════════════════
    // EMERGENCY RECOVERY
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Emergency recover any ERC20 token to the vault
     * @param token Token address to recover
     * @param amount Amount to recover
     */
    function emergencyWithdrawToken(address token, uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(vault, amount);
        emit EmergencyTokenWithdrawn(token, amount);
    }

    /**
     * @notice Emergency transfer a tracked portfolio NFT out of the strategy
     * @param nftId NFT to transfer
     * @param to Recipient address
     */
    function emergencyTransferNft(uint256 nftId, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();

        if (isHeldNft[nftId]) {
            _removeNft(nftId);
        }

        IERC721(address(portfolioNFT)).safeTransferFrom(address(this), to, nftId);
        emit EmergencyNftTransferred(nftId, to);
    }

    /**
     * @notice Emergency recover any ERC721 token (non-portfolio NFTs that got sent here)
     * @param nftContract The ERC721 contract address
     * @param nftId NFT to transfer
     * @param to Recipient address
     */
    function emergencyRecoverNft(address nftContract, uint256 nftId, address to) external onlyOwner {
        if (nftContract == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();

        if (nftContract == address(portfolioNFT) && isHeldNft[nftId]) {
            _removeNft(nftId);
        }

        IERC721(nftContract).safeTransferFrom(address(this), to, nftId);
        emit EmergencyNftTransferred(nftId, to);
    }

    // ═══════════════════════════════════════════════════════════
    // IERC721Receiver
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice ERC721 receiver callback. Portfolio NFTs are accepted only during active
     *         depositToProperty() calls and tracked in heldNftIds. Unsolicited portfolio
     *         NFT transfers revert. Non-portfolio NFTs are silently accepted but not tracked.
     */
    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external override returns (bytes4) {
        if (msg.sender == address(portfolioNFT)) {
            if (!_depositing) revert UnsolicitedNftTransfer();
            _addNft(tokenId);
            _mintedNftIds.push(tokenId);
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    // ═══════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    /// @notice Number of NFTs currently held
    function heldNftCount() external view returns (uint256) {
        return heldNftIds.length;
    }

    /// @notice Get all held NFT IDs
    function getHeldNftIds() external view returns (uint256[] memory) {
        return heldNftIds;
    }

    // ═══════════════════════════════════════════════════════════
    // INTERNAL: PRO-RATA VALUE MATH
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Calculate the current value of an NFT position
     * @dev Formula:
     *   maxReturn = invested * (10000 + yieldCapBps) / 10000
     *   totalAllocated = totalClaimed + amountOwed
     *   lockedPrincipal = invested * (maxReturn - totalAllocated) / maxReturn
     *   nftValue = lockedPrincipal + amountOwed
     *
     *   When totalAllocated >= maxReturn, lockedPrincipal = 0, nftValue = amountOwed
     *
     * @param nftId The NFT to value
     * @return value The USDT value of this NFT position
     */
    function _nftValue(uint256 nftId) internal view returns (uint256 value) {
        try portfolioNFT.ownerOf(nftId) returns (address nftOwner) {
            if (nftOwner != address(this)) return 0;
        } catch {
            return 0;
        }

        IPortfolioNFTStrategy.NFTPosition memory pos = portfolioNFT.getPosition(nftId);

        if (pos.amountInvested == 0) return 0;

        uint256 maxReturn = (pos.amountInvested * (BPS_DENOMINATOR + pos.yieldCapBps)) / BPS_DENOMINATOR;
        uint256 totalAllocated = pos.totalClaimed + pos.amountOwed;

        uint256 lockedPrincipal;
        if (totalAllocated >= maxReturn) {
            lockedPrincipal = 0;
        } else {
            lockedPrincipal = (pos.amountInvested * (maxReturn - totalAllocated)) / maxReturn;
        }

        value = lockedPrincipal + pos.amountOwed;
        if (value > maxReturn) value = maxReturn;
    }

    // ═══════════════════════════════════════════════════════════
    // INTERNAL: NFT TRACKING (O(1) add/remove)
    // ═══════════════════════════════════════════════════════════

    function _addNft(uint256 nftId) internal {
        if (!isHeldNft[nftId]) {
            if (heldNftIds.length >= MAX_NFTS) revert MaxNftsReached();
            nftIndex[nftId] = heldNftIds.length;
            heldNftIds.push(nftId);
            isHeldNft[nftId] = true;
            emit NftAdded(nftId);
        }
    }

    function _removeNft(uint256 nftId) internal {
        if (isHeldNft[nftId]) {
            uint256 idx = nftIndex[nftId];
            uint256 lastIdx = heldNftIds.length - 1;

            if (idx != lastIdx) {
                uint256 lastNftId = heldNftIds[lastIdx];
                heldNftIds[idx] = lastNftId;
                nftIndex[lastNftId] = idx;
            }

            heldNftIds.pop();
            delete nftIndex[nftId];
            delete isHeldNft[nftId];
            emit NftRemoved(nftId);
        }
    }
}
