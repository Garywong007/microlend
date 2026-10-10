// Generates backend/.env and frontend/.env for local development.
// The scorer key is Hardhat's well-known test account #3 (public - NEVER use it outside a local chain).
//   npm run local:env            (does not overwrite existing files)
//   npm run local:env -- --force
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { HDNodeWallet } = require("ethers");

const force = process.argv.includes("--force");
const LOCAL_MNEMONIC = require("./local-mnemonic");
const scorer = HDNodeWallet.fromPhrase(LOCAL_MNEMONIC, null, "m/44'/60'/0'/0/3");

function write(file, content) {
  const target = path.join(__dirname, "..", file);
  if (fs.existsSync(target) && !force) {
    console.log(`skip   ${file} (exists, use --force to overwrite)`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  console.log(`wrote  ${file}`);
}

write(
  "backend/.env",
  [
    "PORT=4000",
    "NODE_ENV=development",
    "NETWORK=localhost",
    "RPC_URL=http://127.0.0.1:8546",
    "CONFIRMATIONS=0",
    `JWT_SECRET=${crypto.randomBytes(32).toString("hex")}`,
    `SCORER_PRIVATE_KEY=${scorer.privateKey}`,
    "CORS_ORIGIN=http://localhost:5173",
    "# Leave DATABASE_URL empty to use a local SQLite file; set it to a postgres:// URL in the cloud.",
    "DATABASE_URL=",
    "",
  ].join("\n")
);
write("frontend/.env", "VITE_API_URL=http://localhost:4000\n");
console.log(`scorer address: ${scorer.address}`);
