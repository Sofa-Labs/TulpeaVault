// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal mint interface for MockUSDT
interface IMintable {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockMegaVault
 * @notice Mock ERC-4626 vault for testing AvonStrategy (simulates Avon MegaVault)
 * @dev Uses MockUSDT as underlying asset (USDm). Call simulateYield() to increase share price.
 */
contract MockMegaVault is ERC4626 {
    /// @notice Custom max deposit limit (0 = use default unlimited)
    uint256 private _maxDepositOverride;
    bool private _hasMaxDepositOverride;

    constructor(IERC20 _asset) ERC4626(_asset) ERC20("Mock USDmY", "mUSDmY") {}

    /**
     * @notice Simulate yield by minting extra USDm to vault, increasing share price
     * @param amount Amount of extra USDm to add
     */
    function simulateYield(uint256 amount) external {
        IMintable(asset()).mint(address(this), amount);
    }

    /**
     * @notice Simulate a loss by burning USDm from vault (transfer out to zero-like address)
     * @dev Transfers USDm to msg.sender to reduce vault's total assets
     * @param amount Amount of USDm to remove
     */
    function simulateLoss(uint256 amount) external {
        IERC20(asset()).transfer(msg.sender, amount);
    }

    /**
     * @notice Set a custom max deposit limit for testing
     * @param limit The max deposit amount
     */
    function setMaxDeposit(uint256 limit) external {
        _maxDepositOverride = limit;
        _hasMaxDepositOverride = true;
    }

    /// @notice Clear the max deposit override (revert to default unlimited)
    function clearMaxDeposit() external {
        _hasMaxDepositOverride = false;
    }

    /// @inheritdoc ERC4626
    function maxDeposit(address receiver) public view override returns (uint256) {
        if (_hasMaxDepositOverride) {
            return _maxDepositOverride;
        }
        return super.maxDeposit(receiver);
    }
}
