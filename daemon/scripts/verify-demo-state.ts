// File: daemon/scripts/verify-demo-state.ts
// Pre-recording gate (PRD §7.5). Asserts the demo can only show real state:
//   1. ≥ MIN_EPOCHS checkpoints registered on-chain
//   2. a random checkpoint's blob payload matches its on-chain contentHash
//   3. local DB row counts clear the demo threshold
//   4. the API answers /status and lag is sane
// Exit 0 = safe to record. Any failure = fix the pipeline, never the demo.
import { existsSync } from "node:fs";
import { fromBlobs, keccak256, bytesToHex, getAbiItem } from "viem";
import { publicClient, getBlobsByTxHash } from "../src/chain.js";
import { registryAbi } from "../src/abi.js";
import { config } from "../src/config.js";
import { Store } from "../src/store.js";

if (!config.registryAddress || !config.registryDeployBlock) {
  console.log("FAIL  config — REGISTRY_ADDRESS / REGISTRY_DEPLOY_BLOCK not set");
  process.exit(1);
}

const MIN_EPOCHS = Number(process.env.MIN_EPOCHS ?? "10");
const MIN_SWAPS = Number(process.env.MIN_SWAPS ?? "1000");
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!ok) failures++;
};

// 1. on-chain checkpoint count
const beacon = await publicClient.readContract({
  address: config.registryAddress, abi: registryAbi, functionName: "beacon",
});
const latestEpoch = Number(beacon.latestEpoch);
check("on-chain epochs", latestEpoch >= MIN_EPOCHS, `latestEpoch=${latestEpoch} (need ≥${MIN_EPOCHS})`);

// 2. spot-verify one mid-chain epoch: blob payload vs on-chain contentHash.
//    Epoch choice is derived from the head (deterministic, not cherry-picked).
const spotEpoch = Math.max(1, Math.floor(latestEpoch / 2));
const cp = await publicClient.readContract({
  address: config.registryAddress, abi: registryAbi, functionName: "checkpoints",
  args: [BigInt(spotEpoch)],
});
// Chunked (the deploy->latest span outgrows one getLogs call within days) and
// event-filtered (HeadMirrored shares the epoch topic — matching it would pull
// a sidecar-less tx and false-FAIL).
let carrier: `0x${string}` | undefined;
{
  const latestBlock = Number(await publicClient.getBlockNumber());
  for (let from = config.registryDeployBlock; from <= latestBlock && !carrier; from += config.backfillChunkBlocks) {
    const to = Math.min(from + config.backfillChunkBlocks - 1, latestBlock);
    const logs = await publicClient.getLogs({
      address: config.registryAddress,
      event: getAbiItem({ abi: registryAbi, name: "CheckpointRegistered" }),
      args: { epoch: BigInt(spotEpoch) },
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
    });
    carrier = logs[0]?.transactionHash;
  }
}
if (carrier) {
  const blobs = await getBlobsByTxHash(carrier);
  if (blobs) {
    const payload = fromBlobs({ blobs, to: "bytes" });
    const hash = keccak256(bytesToHex(payload) as `0x${string}`);
    check("spot contentHash", hash === cp.contentHash, `epoch ${spotEpoch} blob keccak vs chain`);
  } else {
    check("spot contentHash", false, `epoch ${spotEpoch}: sidecar unavailable`);
  }
} else {
  check("spot contentHash", false, `epoch ${spotEpoch}: no CheckpointRegistered log found`);
}

// 3. local rows — a verifier writes NOTHING: never create the DB by opening it
if (!existsSync(config.dbPath)) {
  check("local swaps", false, `no DB at ${config.dbPath}`);
  check("local checkpoints", false, "no DB");
} else {
  const store = new Store();
  const counts = store.counts();
  check("local swaps", counts.swaps >= MIN_SWAPS, `${counts.swaps} swaps (need ≥${MIN_SWAPS})`);
  check("local checkpoints", counts.checkpoints >= MIN_EPOCHS, `${counts.checkpoints} rows`);
  store.close();
}

// 4. API alive + lag sane
try {
  const res = await fetch(`http://localhost:${config.apiPort}/status`);
  const status = (await res.json()) as { lagBlocks: number | null };
  check("api /status", res.ok && (status.lagBlocks ?? 9e9) < 100, `lag=${status.lagBlocks} blocks`);
} catch {
  check("api /status", false, "API not reachable — is mirrord running?");
}

console.log(failures === 0 ? "\n✅ demo state VERIFIED — safe to record" : `\n❌ ${failures} check(s) failed — fix the pipeline, not the demo`);
process.exit(failures === 0 ? 0 : 1);
