// File: daemon/src/config.ts
// Single source of runtime configuration. Everything tunable lives here.
// NOTE on .env loading: npm scripts pass --env-file=../.env to tsx; Docker
// injects env via compose env_file. Nothing here reads .env directly.
import { fileURLToPath } from "node:url";
import type { Hex } from "./types.js";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  // --- chain ---
  chainId: 677,
  rpcUrl: env("RPC_URL", "https://rpc.botchain.ai"),
  wssUrl: env("WSS_URL", "wss://ws-rpc.botchain.ai"),
  privateKey: (process.env.PRIVATE_KEY ?? "") as Hex, // required for daemon/spike, not for restore/api
  registryAddress: (process.env.REGISTRY_ADDRESS ?? "") as Hex, // set after Deploy.s.sol
  registryDeployBlock: Number(process.env.REGISTRY_DEPLOY_BLOCK ?? "0"), // set after deploy

  // --- known contracts (mainnet 677, official integration guide; probed 2026-07-05) ---
  wbot: "0xD5452816194a3784dBa983426cCe7c122F4abd30" as Hex,
  usdt: "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C" as Hex, // 6 decimals
  factory: "0x1C51c173323ec11BB4e3C4fD2314c225Dc4b5419" as Hex,
  mainPool: "0x64f418471a1a7932a190e10da5a8551db5abec05" as Hex, // WBOT/USDT fee-3000

  // --- indexing ---
  // module-relative default (daemon/data locally, /app/data in Docker) so the
  // DB never depends on the caller's cwd; DB_PATH env overrides (cwd-relative).
  dbPath: env("DB_PATH", fileURLToPath(new URL("../data/mirror.db", import.meta.url))),
  startBlock: Number(process.env.START_BLOCK ?? "1066273"), // first swap block (measured)
  confirmations: 3,          // canonical at depth 3 (~2.25s @ 0.75s blocks)
  tailIntervalMs: 1000,      // cursor loop cadence
  backfillChunkBlocks: 500_000, // measured reliable getLogs span
  backfillPaceMs: 1500,      // measured polite pacing between chunks
  indexUsdtTransfers: (process.env.INDEX_USDT ?? "1") === "1", // cut line #1: set 0 to disable

  // --- fees (measured: hard mempool floor 47.62 gwei; blob gas pinned 1 wei) ---
  maxFeePerGas: 60_000_000_000n,        // 60 gwei ceiling (floor is 47.62)
  maxPriorityFeePerGas: 48_000_000_000n, // 48 gwei > 47.62 floor
  maxFeePerBlobGas: 2n,                  // blob base fee pinned at 1 wei

  // --- checkpoints ---
  headCadenceBlocks: 400,       // ~5 min @ 0.75s
  segmentTargetBytes: 340_000,  // close a SEGMENT when pending payload nears 3-blob budget (380,925 usable)
  maxBlobsPerTx: 3,             // proven at mempool level on 677; do NOT raise without probe
  calldataMirrorEveryNHeads: 72, // mirror latest HEAD in calldata every ~6h (72 * 5min)

  // --- restore ---
  restorePaceMs: 250,           // ≤ 4 sidecar fetches/sec (AF-10 rate-limit reality)

  // --- api ---
  apiPort: Number(process.env.API_PORT ?? "3400"),
  explorerBase: "https://scan.botchain.ai",
  priceApiUrl:
    "https://dex-wallet.botchain.ai/api/graph/price?token=0xD5452816194a3784dBa983426cCe7c122F4abd30",
  browserUA:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
} as const;
