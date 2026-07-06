// File: daemon/scripts/create-demo-pool.ts
// Flow 5, two-stage (PRD §6 seed table): MIRD is deployed BEFORE recording day
// (--deploy-only), and factory.createPool runs ON CAMERA (--pool-only).
// No flag = both stages back-to-back (rehearsal). Mirror's ingestor must log
// "pool discovered" within seconds of createPool — THAT is the beat.
import { readFileSync } from "node:fs";
import { publicClient, getWalletClient } from "../src/chain.js";
import { factoryAbi } from "../src/abi.js";
import { config } from "../src/config.js";
import type { Hex } from "../src/types.js";

const deployOnly = process.argv.includes("--deploy-only");
const poolOnly = process.argv.includes("--pool-only");

const wallet = getWalletClient();
const feeOpts = {
  maxFeePerGas: config.maxFeePerGas,
  maxPriorityFeePerGas: config.maxPriorityFeePerGas,
};

let mird: Hex;
if (poolOnly) {
  mird = (process.env.DEMO_TOKEN_ADDRESS ?? "") as Hex;
  if (!mird) throw new Error("--pool-only needs DEMO_TOKEN_ADDRESS in .env (from the --deploy-only run)");
} else {
  const artifact = JSON.parse(
    readFileSync(new URL("../../contracts/out/DemoToken.sol/DemoToken.json", import.meta.url), "utf8")
  ) as { abi: unknown[]; bytecode: { object: Hex } };
  console.log(`[demo-pool] deploying DemoToken (MIRD)...`);
  const deployHash = await wallet.deployContract({
    abi: artifact.abi as [],
    bytecode: artifact.bytecode.object,
    ...feeOpts,
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash, timeout: 120_000 });
  mird = deployReceipt.contractAddress!;
  console.log(`[demo-pool] MIRD deployed: ${mird} (${config.explorerBase}/address/${mird})`);
  console.log(`[demo-pool] save to .env: DEMO_TOKEN_ADDRESS=${mird}`);
  if (deployOnly) process.exit(0);
}

console.log(`[demo-pool] factory.createPool(MIRD, USDT, 3000)...`);
const createHash = await wallet.writeContract({
  address: config.factory,
  abi: factoryAbi,
  functionName: "createPool",
  args: [mird, config.usdt, 3000],
  ...feeOpts,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash, timeout: 120_000 });
console.log(`[demo-pool] PoolCreated in block ${receipt.blockNumber} — tx ${createHash}`);
console.log(`[demo-pool] watch the mirrord log: "[ingest] pool discovered" fires within ~5s.`);
