require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
require("ts-node").register({ transpileOnly: true });

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: true,
      blockGasLimit: 30000000,
      initialBaseFeePerGas: 0,
    },
    megaethMainnet: {
      url: process.env.MEGAETH_MAINNET_RPC_URL || "https://mainnet.megaeth.com/rpc",
      chainId: 4326,
      accounts: process.env.MEGAETH_PRIVATE_KEY ? [process.env.MEGAETH_PRIVATE_KEY] : [],
      gasPrice: 1000000,
      gas: 10000000000,
      timeout: 120000,
    },
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    spec: "test/**/*.test.ts",
    timeout: 60000,
  },
};
