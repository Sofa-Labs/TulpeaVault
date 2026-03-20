// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title ERC1967ProxyWrapper
 * @notice Simple wrapper to make ERC1967Proxy available for Hardhat
 */
contract ERC1967ProxyWrapper is ERC1967Proxy {
    constructor(address implementation, bytes memory _data) ERC1967Proxy(implementation, _data) {}
}
