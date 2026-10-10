require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, ETHERSCAN_API_KEY } = process.env;

// MicroLend's local chain deliberately avoids Hardhat's defaults (port 8545, chain id 31337)
// so it can live next to other Hardhat projects in MetaMask without clashing.
const LOCAL_MNEMONIC = require("./scripts/local-mnemonic");
const LOCAL_PORT = process.env.LOCAL_PORT || "8546";
const LOCAL_CHAIN_ID = Number(process.env.LOCAL_CHAIN_ID || 31338);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // viaIR avoids "stack too deep" in LoanManager.markDefault; solidity-coverage cannot use it.
      viaIR: !process.env.COVERAGE,
    },
  },
  networks: {
    hardhat: { chainId: LOCAL_CHAIN_ID, accounts: { mnemonic: LOCAL_MNEMONIC } },
    localhost: { url: `http://127.0.0.1:${LOCAL_PORT}`, chainId: LOCAL_CHAIN_ID },
    ...(SEPOLIA_RPC_URL && DEPLOYER_PRIVATE_KEY
      ? {
          sepolia: {
            url: SEPOLIA_RPC_URL,
            accounts: [DEPLOYER_PRIVATE_KEY],
            chainId: 11155111,
          },
        }
      : {}),
  },
  etherscan: { apiKey: ETHERSCAN_API_KEY || "" },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    noColors: true,
    outputFile: process.env.GAS_REPORT_FILE || undefined,
  },
  paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  mocha: { timeout: 120000 },
};
