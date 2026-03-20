// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMockMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Mock SwapRouter02 with multicall deadline support and decimal-aware scaling
contract MockSwapRouter {
    using SafeERC20 for IERC20;

    /// @notice Exchange rate in basis points (10000 = 1:1)
    uint256 public exchangeRateBps = 10000;

    function setExchangeRate(uint256 _bps) external {
        exchangeRateBps = _bps;
    }

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        // Pull tokenIn from caller
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        // Calculate output with exchange rate + decimal scaling
        uint8 decimalsIn = IERC20Metadata(params.tokenIn).decimals();
        uint8 decimalsOut = IERC20Metadata(params.tokenOut).decimals();

        amountOut = params.amountIn * exchangeRateBps / 10000;

        if (decimalsOut > decimalsIn) {
            amountOut = amountOut * (10 ** (decimalsOut - decimalsIn));
        } else if (decimalsIn > decimalsOut) {
            amountOut = amountOut / (10 ** (decimalsIn - decimalsOut));
        }

        require(amountOut >= params.amountOutMinimum, "Too little received");

        // Mint tokenOut to recipient (mock routers hold infinite liquidity)
        IMockMintable(params.tokenOut).mint(params.recipient, amountOut);

        return amountOut;
    }

    /// @notice SwapRouter02-style multicall with deadline
    /// @dev Reverts if block.timestamp > deadline, then delegatecalls each data element
    function multicall(uint256 deadline, bytes[] calldata data)
        external
        payable
        returns (bytes[] memory results)
    {
        require(block.timestamp <= deadline, "Transaction too old");

        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool success, bytes memory result) = address(this).delegatecall(data[i]);
            if (!success) {
                // Bubble up the revert reason
                if (result.length > 0) {
                    assembly {
                        revert(add(result, 32), mload(result))
                    }
                }
                revert("Multicall failed");
            }
            results[i] = result;
        }
    }
}
