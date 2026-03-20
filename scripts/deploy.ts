/**
 * Deploy TulpeaYieldVault (UUPS proxy) to MegaETH Mainnet
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --config hardhat.config.cjs --network megaethMainnet
 */

import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

// ─── MegaETH Mainnet external addresses ─────────────────────────────────────
const USDT0_ADDRESS = "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // Check deployer balance
  const ethBalance = await ethers.provider.getBalance(deployer.address);
  console.log("ETH balance:", ethers.formatEther(ethBalance));
  if (ethBalance === 0n) throw new Error("Deployer has 0 ETH");

  // Read USDT0 decimals on-chain
  const usdt0 = new ethers.Contract(
    USDT0_ADDRESS,
    ["function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"],
    deployer
  );
  const decimals = await usdt0.decimals();
  console.log("USDT0 decimals:", decimals);

  // 1. Deploy implementation
  const VaultFactory = await ethers.getContractFactory("TulpeaYieldVault");
  const impl = await VaultFactory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("Implementation:", implAddr);

  // 2. Deploy UUPS proxy
  const depositLimit = ethers.parseUnits("10000", decimals);
  const initData = VaultFactory.interface.encodeFunctionData("initialize", [
    USDT0_ADDRESS,
    deployer.address,
    depositLimit,
    "Tulpea Yield Vault",
    "tyvUSDT",
    deployer.address, // keeper
  ]);

  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await ProxyFactory.deploy(implAddr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log("Proxy:", proxyAddr);

  // 3. Verify
  const vault = VaultFactory.attach(proxyAddr) as any;
  console.log("asset():", await vault.asset());
  console.log("owner():", await vault.owner());
  console.log("depositLimit():", ethers.formatUnits(await vault.depositLimit(), decimals));

  // 4. Save addresses
  const addresses = {
    network: "megaethMainnet",
    chainId: 4326,
    deployedAt: new Date().toISOString(),
    yieldVault: { proxy: proxyAddr, implementation: implAddr },
  };
  fs.writeFileSync(
    path.join(__dirname, "..", "deployed-addresses.json"),
    JSON.stringify(addresses, null, 2)
  );
  console.log("\nDeployment complete!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
