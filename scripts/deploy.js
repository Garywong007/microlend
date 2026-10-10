// Deploys the five contracts, wires up their roles and writes deployments/<network>.json.
//   npm run deploy:local     (needs `npm run node` running)
//   npm run deploy:sepolia   (needs SEPOLIA_RPC_URL + DEPLOYER_PRIVATE_KEY in .env)
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { exportAbis } = require("./export-abi");

const role = (name) => hre.ethers.id(name);

async function main() {
  const { ethers, network } = hre;
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const isLocal = ["localhost", "hardhat"].includes(network.name);

  // On a local chain use the well-known test accounts so the seed script and backend line up.
  const officer = process.env.OFFICER_ADDRESS || (isLocal ? signers[1].address : deployer.address);
  const auditor = process.env.AUDITOR_ADDRESS || (isLocal ? signers[2].address : deployer.address);
  const scorer = process.env.SCORER_ADDRESS || (isLocal ? signers[3].address : deployer.address);

  console.log(`Deploying to ${network.name} as ${deployer.address}`);

  const deploy = async (name, ...args) => {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    const receipt = await c.deploymentTransaction().wait();
    console.log(`  ${name.padEnd(16)} ${await c.getAddress()}  (block ${receipt.blockNumber})`);
    return { contract: c, block: receipt.blockNumber };
  };

  const usdc = await deploy("MockStablecoin", deployer.address);
  const usdcAddr = await usdc.contract.getAddress();
  const registry = await deploy("CreditRegistry", deployer.address);
  const pool = await deploy("LendingPool", usdcAddr, deployer.address);
  const vault = await deploy("CollateralVault", usdcAddr, deployer.address);
  const manager = await deploy(
    "LoanManager",
    usdcAddr,
    await registry.contract.getAddress(),
    await pool.contract.getAddress(),
    await vault.contract.getAddress(),
    deployer.address
  );

  const managerAddr = await manager.contract.getAddress();
  const grant = async (c, r, who) => (await c.grantRole(role(r), who)).wait();
  console.log("Granting roles ...");
  await grant(registry.contract, "LOAN_MANAGER_ROLE", managerAddr);
  await grant(pool.contract, "LOAN_MANAGER_ROLE", managerAddr);
  await grant(vault.contract, "LOAN_MANAGER_ROLE", managerAddr);
  await grant(registry.contract, "SCORER_ROLE", scorer);
  await grant(manager.contract, "OFFICER_ROLE", officer);
  await grant(manager.contract, "AUDITOR_ROLE", auditor);

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const deployment = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    startBlock: Math.min(usdc.block, registry.block, pool.block, vault.block, manager.block),
    contracts: {
      MockStablecoin: usdcAddr,
      CreditRegistry: await registry.contract.getAddress(),
      LendingPool: await pool.contract.getAddress(),
      CollateralVault: await vault.contract.getAddress(),
      LoanManager: managerAddr,
    },
    roles: { admin: deployer.address, officer, auditor, scorer },
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`Saved ${path.relative(process.cwd(), outFile)}`);

  exportAbis();

  // Optional: verify source on Etherscan for public networks.
  if (!isLocal && process.env.ETHERSCAN_API_KEY) {
    console.log("Waiting for confirmations before verification ...");
    await new Promise((r) => setTimeout(r, 30_000));
    const verify = async (address, constructorArguments) => {
      try {
        await hre.run("verify:verify", { address, constructorArguments });
      } catch (e) {
        console.warn(`  verify ${address} failed: ${e.message.split("\n")[0]}`);
      }
    };
    await verify(usdcAddr, [deployer.address]);
    await verify(deployment.contracts.CreditRegistry, [deployer.address]);
    await verify(deployment.contracts.LendingPool, [usdcAddr, deployer.address]);
    await verify(deployment.contracts.CollateralVault, [usdcAddr, deployer.address]);
    await verify(managerAddr, [
      usdcAddr,
      deployment.contracts.CreditRegistry,
      deployment.contracts.LendingPool,
      deployment.contracts.CollateralVault,
      deployer.address,
    ]);
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
