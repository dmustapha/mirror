// File: daemon/scripts/hour0-spike.ts
// HOUR-0 FUNDED SPIKE — the first thing that runs after funding arrives.
// Sequence (PRD Day 0): fee re-confirm → 1-blob tx → read-back → 3-blob tx →
// read-back → seed submission/proof.md → print MODE LOCK.
// Exit code 0 = blob mode locked. Exit code 2 = promote CalldataSink.
import { writeFileSync, mkdirSync } from "node:fs";
import { toBlobs, fromBlobs, bytesToHex, hexToBytes } from "viem";
import { writeClient, getWalletClient, getKzg, getBlobsByTxHash, sleep } from "../src/chain.js";
import { config } from "../src/config.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`SPIKE ASSERT FAILED: ${msg}`);
}

async function roundTrip(label: string, payload: Uint8Array): Promise<`0x${string}`> {
  const wallet = getWalletClient();
  const blobs = toBlobs({ data: bytesToHex(payload) });
  console.log(`[spike] ${label}: ${payload.length}B → ${blobs.length} blob(s), sending...`);
  const hash = await wallet.sendTransaction({
    to: wallet.account.address, // self-send: registry does not exist yet
    blobs,
    kzg: getKzg(),
    maxFeePerBlobGas: config.maxFeePerBlobGas,
    maxFeePerGas: config.maxFeePerGas,
    maxPriorityFeePerGas: config.maxPriorityFeePerGas,
  });
  console.log(`[spike] ${label}: tx ${hash} — waiting for inclusion (120s timeout)...`);
  const receipt = await writeClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  assert(receipt.status === "success", `${label} tx reverted`);
  assert((receipt.blobGasUsed ?? 0n) > 0n, `${label} receipt has no blobGasUsed`);
  console.log(
    `[spike] ${label}: INCLUDED block ${receipt.blockNumber}, blobGasUsed ${receipt.blobGasUsed}, ` +
      `blobGasPrice ${(receipt as { blobGasPrice?: bigint }).blobGasPrice ?? "?"}`
  );
  // Read-back: the sidecar leg. Retry briefly — sidecars are queryable on block
  // insert per bsc source, but we allow the RPC a few seconds of slack.
  let blobsBack: `0x${string}`[] | null = null;
  for (let i = 0; i < 10 && !blobsBack; i++) {
    blobsBack = await getBlobsByTxHash(hash);
    if (!blobsBack) await sleep(1_000);
  }
  assert(blobsBack !== null, `${label}: eth_getBlobSidecarByTxHash returned null for mined tx`);
  const roundTripped = fromBlobs({ blobs: blobsBack, to: "bytes" });
  const match =
    roundTripped.length >= payload.length &&
    Buffer.compare(Buffer.from(roundTripped.subarray(0, payload.length)), Buffer.from(payload)) === 0;
  assert(match, `${label}: read-back bytes do not match sent payload`);
  console.log(`[spike] ${label}: READ-BACK OK (${blobsBack.length} blob(s), bytes match)`);
  return hash;
}

// --- 0. balance + fee re-confirm ---
const wallet = getWalletClient();
const balance = await writeClient.getBalance({ address: wallet.account.address });
console.log(`[spike] wallet ${wallet.account.address} balance ${Number(balance) / 1e18} BOT`);
assert(balance > 10n ** 16n, "need ≥0.01 BOT for the spike");
const gasPrice = await writeClient.getGasPrice();
const blobBaseFee = await writeClient
  .request({ method: "eth_blobBaseFee" as never, params: [] as never })
  .then((v: unknown) => BigInt(v as string))
  .catch(() => null); // method missing on the fork = non-fatal (fee is pinned in config)
console.log(
  `[spike] gasPrice ${Number(gasPrice) / 1e9} gwei (floor is 47.62), blobBaseFee ${blobBaseFee ?? "unavailable"} wei`
);
assert(config.maxPriorityFeePerGas >= 47_620_000_000n, "priority fee config below the measured floor");

try {
  // --- 1. one-blob probe (potentially the first blob tx in chain history) ---
  const h1 = await roundTrip("1-blob", new TextEncoder().encode(`MIRROR SPIKE ${wallet.account.address}`));

  // --- 2. three-blob probe at production shape (~370KB) ---
  const big = new Uint8Array(370_000);
  for (let i = 0; i < big.length; i++) big[i] = i % 251; // incompressible-ish, deterministic
  const h3 = await roundTrip("3-blob", big);

  // --- 3. seed the proof file (checkpoint engine appends to this table later) ---
  const proofDir = new URL("../submission/", import.meta.url);
  mkdirSync(proofDir, { recursive: true });
  writeFileSync(
    new URL("proof.md", proofDir),
    [
      `# Mirror — On-Chain Proof`,
      ``,
      `## First blob transactions on BOT Chain (hour-0 spike, ${new Date().toISOString()})`,
      ``,
      `- 1-blob probe: [\`${h1}\`](${config.writeExplorerBase}/tx/${h1})`,
      `- 3-blob probe: [\`${h3}\`](${config.writeExplorerBase}/tx/${h3})`,
      ``,
      `## Checkpoints`,
      ``,
      `| epoch | kind | blocks | rows | mode | tx |`,
      `|-------|------|--------|------|------|-----|`,
      ``,
    ].join("\n")
  );
  console.log(`[spike] proof.md seeded.`);
  console.log(`[spike] ✅ MODE LOCK: blob — BlobSink is GO. Record both hashes in PULSE.`);
} catch (err) {
  console.error(`[spike] ❌ blob path failed:`, err);
  console.error(`[spike] DECISION TREE: promote CalldataSink (CHECKPOINT_MODE=calldata),`);
  console.error(`[spike] re-pitch as "chain-anchored checkpoints", strip "first blob tx" claim.`);
  process.exit(2);
}
