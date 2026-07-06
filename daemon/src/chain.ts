// File: daemon/src/chain.ts
import * as cKzgNs from "c-kzg";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  webSocket,
  setupKzg,
  type Kzg,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnetTrustedSetupPath } from "viem/node";
import { config } from "./config.js";
import type { Hex } from "./types.js";

export const botChain = defineChain({
  id: config.chainId,
  name: "BOT Chain",
  nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  rpcUrls: {
    default: { http: [config.rpcUrl], webSocket: [config.wssUrl] },
  },
  blockExplorers: {
    default: { name: "BOT Chain Explorer", url: config.explorerBase },
  },
});

// HTTP client is the source of truth for ALL reads (rate-limit friendly:
// viem batches nothing here, retries with backoff).
export const publicClient = createPublicClient({
  chain: botChain,
  transport: http(config.rpcUrl, { timeout: 60_000, retryCount: 3, retryDelay: 2_000 }),
});

// WSS client is used ONLY as a low-latency nudge (newHeads). Correctness never
// depends on it — the cursor loop is authoritative (AF-10: WSS can die silently).
export function makeWsClient() {
  return createPublicClient({
    chain: botChain,
    transport: webSocket(config.wssUrl, { reconnect: { attempts: 20, delay: 2_000 } }),
  });
}

export function getWalletClient() {
  if (!config.privateKey) throw new Error("PRIVATE_KEY not set");
  const account = privateKeyToAccount(config.privateKey);
  return createWalletClient({
    account,
    chain: botChain,
    transport: http(config.rpcUrl, { timeout: 120_000, retryCount: 2, retryDelay: 3_000 }),
  });
}

let _kzg: Kzg | null = null;
export function getKzg(): Kzg {
  if (_kzg) return _kzg;
  // WARNING: UNVERIFIED PATTERN — c-kzg v2 ESM interop: some versions expose the
  // API on .default. Test immediately at install (spike hour-0 exercises this).
  const cKzg: any = (cKzgNs as any).default ?? cKzgNs;
  _kzg = setupKzg(cKzg, mainnetTrustedSetupPath);
  return _kzg;
}

// --- BSC-lineage blob sidecar RPC (schema from bsc v1.5.13 source) ---
export interface SidecarResult {
  blockHash: Hex;
  blockNumber: Hex; // quantity hex
  txHash: Hex;      // NOTE: "txHash", not "transactionHash"
  txIndex: Hex;
  blobSidecar: { blobs: Hex[]; commitments: Hex[]; proofs: Hex[] };
}

const FULL_BLOB_HEX_LEN = 2 + 131_072 * 2; // 0x + 262144 chars

/// Returns full blobs for a mined type-3 tx, or null if pruned/unknown.
/// Defensive: asserts full-length blobs (fullBlob=false silently truncates to 32B)
/// and tolerates both nested (blobSidecar.blobs) and flat (blobs) wrapper shapes.
export async function getBlobsByTxHash(txHash: Hex): Promise<Hex[] | null> {
  const res = (await publicClient.request({
    method: "eth_getBlobSidecarByTxHash" as never,
    params: [txHash, true] as never,
  })) as unknown as (SidecarResult & { blobs?: Hex[] }) | null;
  if (res === null || res === undefined) return null;
  const blobs = res.blobSidecar?.blobs ?? res.blobs;
  if (!blobs || blobs.length === 0) return null;
  for (const b of blobs) {
    if (b.length !== FULL_BLOB_HEX_LEN) {
      throw new Error(
        `Sidecar blob has unexpected length ${b.length} (expected ${FULL_BLOB_HEX_LEN}) — truncated response?`
      );
    }
  }
  return blobs;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
