// Copies the ABI of every contract from Hardhat's artifacts to shared/abis/<Name>.json.
// The backend (indexer + scorer) and the frontend both import these files, so there is one source of truth.
// Run automatically by `npm run build:contracts` and by scripts/deploy.js.
const fs = require("fs");
const path = require("path");

const CONTRACTS = ["MockStablecoin", "CreditRegistry", "LendingPool", "CollateralVault", "LoanManager"];
const OUT_DIR = path.join(__dirname, "..", "shared", "abis");

function exportAbis() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const name of CONTRACTS) {
    const artifact = path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
    if (!fs.existsSync(artifact)) {
      throw new Error(`Artifact for ${name} not found. Run "npx hardhat compile" first.`);
    }
    const { abi } = JSON.parse(fs.readFileSync(artifact, "utf8"));
    fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), JSON.stringify(abi, null, 2) + "\n");
  }
  console.log(`Exported ${CONTRACTS.length} ABIs to ${path.relative(process.cwd(), OUT_DIR)}`);
}

module.exports = { exportAbis, CONTRACTS };

if (require.main === module) exportAbis();
