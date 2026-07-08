// File: daemon/src/restore.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hexToBytes, decodeFunctionData, getAbiItem } from "viem";
import { publicClient, writeClient, getBlobsByTxHash, blobsToBytes, sleep } from "./chain.js";
import { registryAbi } from "./abi.js";
import { decodeEnvelope, contentHashOf } from "./codec.js";
import { config } from "./config.js";
import { Store } from "./store.js";
import { Ingestor } from "./ingest.js";
import type {
  Envelope, Hex, RestoreEpochReport, RestoreReport, SwapRow,
} from "./types.js";

const PROOF_PATH = fileURLToPath(new URL("../submission/proof.md", import.meta.url));

/// DEV-010: the restore is a minutes-long, demo-critical network path — transient
/// RPC failures (DNS blips, timeouts; observed live: ENOTFOUND rpc.bohr.life
/// mid-drill) must not kill it. Retry with backoff before any fallback/failure.
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const wait = 2_000 * 2 ** i;
      console.warn(`[restore] ${label} failed (attempt ${i + 1}/${attempts}) — retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

interface ChainNode {
  epoch: number;
  kind: number;
  blockFrom: number;
  blockTo: number;
  contentHash: Hex;
  prevEpoch: number;
  rowCount: number;
  blobCount: number;
}

/// Full cold-start restore. Requires only RPC_URL + REGISTRY_ADDRESS +
/// REGISTRY_DEPLOY_BLOCK — no private key, no local state, no snapshot file.
export async function restore(
  dbPath: string = config.dbPath,
  opts: { report?: boolean } = {}
): Promise<RestoreReport> {
  if (!config.registryAddress) throw new Error("REGISTRY_ADDRESS not set");
  if (!config.registryDeployBlock) throw new Error("REGISTRY_DEPLOY_BLOCK not set");
  const t0 = Date.now();

  // 1. Registry head: which epoch is live?
  const beacon = await writeClient.readContract({
    address: config.registryAddress,
    abi: registryAbi,
    functionName: "beacon",
  });
  const latestEpoch = Number(beacon.latestEpoch);
  if (latestEpoch === 0) throw new Error("registry has no checkpoints yet");
  console.log(`[restore] registry ${config.registryAddress} latestEpoch=${latestEpoch}`);

  // 2. epoch → carrying-tx map. A contract cannot know its own tx hash; the
  //    CheckpointRegistered event log is the bridge from epoch number to the
  //    tx whose sidecar holds the payload.
  const epochTx = await scanCheckpointTxs();
  console.log(`[restore] found ${epochTx.size} CheckpointRegistered events`);

  // 3. Walk the prevEpoch chain: HEAD → last SEGMENT → ... → first SEGMENT.
  //    Superseded HEADs are naturally skipped (nothing points at them).
  const chain: ChainNode[] = [];
  for (let e = latestEpoch; e !== 0; ) {
    const cp = await withRetry(`checkpoint(${e}) read`, () =>
      writeClient.readContract({
        address: config.registryAddress,
        abi: registryAbi,
        functionName: "checkpoints",
        args: [BigInt(e)],
      })
    );
    chain.push({
      epoch: e,
      kind: Number(cp.kind),
      blockFrom: Number(cp.blockFrom),
      blockTo: Number(cp.blockTo),
      contentHash: cp.contentHash as Hex,
      prevEpoch: Number(cp.prevEpoch),
      rowCount: Number(cp.rowCount),
      blobCount: Number(cp.blobCount),
    });
    e = Number(cp.prevEpoch);
  }
  chain.reverse(); // oldest-first: ranges are disjoint, but the story reads forward
  console.log(`[restore] checkpoint chain: ${chain.length} epochs (${chain[0].blockFrom} → ${chain[chain.length - 1].blockTo})`);

  // 4. Pull, verify, decode, insert — printing each tx hash as it is fetched.
  //    DEV-011: payload fetches are the wall clock (measured 39.5 min serial for
  //    207 epochs — ~11.5s/epoch of sidecar JSON). Prefetch a sliding window of
  //    RESTORE_CONCURRENCY epochs; verification/apply stays sequential and
  //    ordered, so the trust model is unchanged.
  const CONCURRENCY = Number(process.env.RESTORE_CONCURRENCY ?? "6");
  type Fetched = { bytes: Uint8Array; source: "blob" | "calldata-mirror"; txFrom: Hex | null; txBlobs: number };
  const fetches = new Map<number, Promise<Fetched>>();
  const startFetch = (idx: number) => {
    if (idx >= chain.length || fetches.has(idx)) return;
    const n = chain[idx];
    const l = epochTx.get(n.epoch);
    if (!l) return; // surfaces as a clear error at the await site
    fetches.set(idx, withRetry(`epoch ${n.epoch} payload fetch`, async () => {
      const { bytes, source } = await fetchPayload(n.epoch, l.txHash, n.contentHash);
      let txFrom: Hex | null = null;
      let txBlobs = n.blobCount;
      if (source === "blob") {
        const tx = await writeClient.getTransaction({ hash: l.txHash });
        txFrom = tx.from.toLowerCase() as Hex;
        txBlobs = tx.blobVersionedHashes?.length ?? n.blobCount;
      }
      return { bytes, source, txFrom, txBlobs };
    }));
  };
  for (let i = 0; i < Math.min(CONCURRENCY, chain.length); i++) startFetch(i);

  const store = new Store(dbPath);
  const report: RestoreReport = { epochs: [], rows: 0, tailRows: 0, seconds: 0 };
  for (let idx = 0; idx < chain.length; idx++) {
    const node = chain[idx];
    const loc = epochTx.get(node.epoch);
    if (!loc) throw new Error(`no CheckpointRegistered event for epoch ${node.epoch}`);
    const { bytes, source, txFrom, txBlobs } = await fetches.get(idx)!;
    fetches.delete(idx);
    startFetch(idx + CONCURRENCY);
    const computed = contentHashOf(bytes);
    if (computed !== node.contentHash) {
      throw new Error(
        `contentHash MISMATCH epoch ${node.epoch}: chain=${node.contentHash} computed=${computed}`
      );
    }
    const env = decodeEnvelope(bytes);
    applyEnvelope(store, env);
    const rows = env.body.swaps.length + env.body.transfers.length;
    report.rows += rows;
    const line: RestoreEpochReport = {
      epoch: node.epoch,
      txHash: loc.txHash,
      block: loc.block,
      contentHash: computed,
      ok: true,
      source,
    };
    report.epochs.push(line);
    // Rebuild the local checkpoint record: the post-restore daemon resumes the
    // SAME on-chain epoch chain (engine reads this table, then chain-syncs),
    // and /checkpoints + /proof show history immediately after resurrection.
    store.insertCheckpoint({
      epoch: node.epoch,
      kind: node.kind as 0 | 1,
      blockFrom: node.blockFrom,
      blockTo: node.blockTo,
      contentHash: node.contentHash,
      prevEpoch: node.prevEpoch,
      rowCount: node.rowCount,
      blobCount: node.blobCount,
      txHash: loc.txHash,
    });
    // Rebuild the blob self-view row for this checkpoint tx (its block is past
    // its own blockTo, so no envelope carries it). blobGasUsed is exact per
    // EIP-4844: blobCount * 2^17.
    if (source === "blob" && txFrom) {
      store.insertBlobTxs([{
        txHash: loc.txHash,
        block: loc.block,
        from: txFrom,
        to: config.registryAddress.toLowerCase() as Hex,
        blobCount: txBlobs,
        blobGasUsed: txBlobs * 131_072,
      }]);
    }
    // ANTI-THEATER: this line IS the demo. Real tx hash, verifiable in their
    // explorer, printed at the moment its payload lands.
    console.log(
      `[restore] epoch ${node.epoch} ${node.kind === 0 ? "SEGMENT" : "HEAD"} ` +
        `blocks ${node.blockFrom}-${node.blockTo} ${rows} rows ` +
        `← ${source} ${loc.txHash} hash✓`
    );
  }

  // 5. Tail replay: everything after the newest checkpoint flows through the
  //    SAME ingest path the daemon uses (no second code path).
  const before = store.counts();
  const ing = new Ingestor(store);
  await ing.seedKnownPools();
  await ing.refreshTsAnchor();
  const latest = Number(await publicClient.getBlockNumber());
  const safeHead = latest - config.confirmations;
  if (safeHead > store.lastIndexedBlock) {
    console.log(`[restore] tail replay ${store.lastIndexedBlock + 1} → ${safeHead}`);
    await ing.indexRange(store.lastIndexedBlock + 1, safeHead);
  }
  const after = store.counts();
  report.tailRows = after.swaps + after.transfers - (before.swaps + before.transfers);
  report.seconds = Math.round(((Date.now() - t0) / 1000) * 10) / 10;

  console.log(
    `[restore] COMPLETE: ${report.rows} rows from ${report.epochs.length} on-chain checkpoints ` +
      `+ ${report.tailRows} tail rows in ${report.seconds}s`
  );
  if (opts.report) appendRestoreReport(report);
  store.close();
  return report;
}

/// Chunked event scan from the registry's deploy block. Each event carries the
/// tx hash + block of the checkpoint that registered it.
async function scanCheckpointTxs(): Promise<Map<number, { txHash: Hex; block: number }>> {
  const out = new Map<number, { txHash: Hex; block: number }>();
  const latest = Number(await writeClient.getBlockNumber()); // DEV-006: registry lives on the write chain
  for (let from = config.registryDeployBlock; from <= latest; from += config.backfillChunkBlocks) {
    const to = Math.min(from + config.backfillChunkBlocks - 1, latest);
    const logs = await writeClient.getLogs({
      address: config.registryAddress,
      event: getAbiItem({ abi: registryAbi, name: "CheckpointRegistered" }),
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
    });
    for (const l of logs) {
      out.set(Number((l as unknown as { args: { epoch: bigint } }).args.epoch), {
        txHash: l.transactionHash as Hex,
        block: Number(l.blockNumber),
      });
    }
  }
  return out;
}

/// Blob sidecar first; calldata mirror as fallback. The fallback fires for
/// (a) sidecars pruned past the 18.2-day retention window, and (b) checkpoints
/// written by CalldataSink (where the registered tx never had a sidecar).
async function fetchPayload(
  epoch: number,
  txHash: Hex,
  expectedHash: Hex
): Promise<{ bytes: Uint8Array; source: "blob" | "calldata-mirror" }> {
  const blobs = await getBlobsByTxHash(txHash);
  if (blobs) {
    return { bytes: blobsToBytes(blobs), source: "blob" }; // DEV-008
  }
  const mirror = await findMirrorPayload(epoch, expectedHash);
  if (mirror) return { bytes: mirror, source: "calldata-mirror" };
  throw new Error(`epoch ${epoch}: sidecar pruned/absent and no calldata mirror found`);
}

/// HeadMirrored(epoch) event → carrying tx → decode mirrorHead calldata →
/// payload bytes. Also covers CalldataSink-mode checkpoints.
async function findMirrorPayload(epoch: number, expectedHash: Hex): Promise<Uint8Array | null> {
  const latest = Number(await writeClient.getBlockNumber());
  for (let from = config.registryDeployBlock; from <= latest; from += config.backfillChunkBlocks) {
    const to = Math.min(from + config.backfillChunkBlocks - 1, latest);
    const logs = await writeClient.getLogs({
      address: config.registryAddress,
      event: getAbiItem({ abi: registryAbi, name: "HeadMirrored" }),
      args: { epoch: BigInt(epoch) },
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
    });
    if (logs.length === 0) continue;
    const tx = await writeClient.getTransaction({ hash: logs[logs.length - 1].transactionHash });
    const decoded = decodeFunctionData({ abi: registryAbi, data: tx.input });
    if (decoded.functionName !== "mirrorHead") continue;
    const [, hash, payload] = decoded.args as [bigint, Hex, Hex];
    if (hash !== expectedHash) continue; // stale mirror of a different content
    return hexToBytes(payload);
  }
  return null;
}

function applyEnvelope(store: Store, env: Envelope): void {
  store.insertPools(env.body.pools);
  // Re-decorate the USDT side before insert: checkpoints strip the transient
  // amountUsdt tag (it is derived, not stored), but insertSwaps computes the
  // usdt_vol_e6 column from it — without this, 24h volume dies after restore.
  const tok = new Map(env.body.pools.map((p) => [p.addr, p]));
  const usdt = config.usdt.toLowerCase();
  for (const s of env.body.swaps as (SwapRow & { amountUsdt?: bigint })[]) {
    const p = tok.get(s.pool);
    if (!p) continue;
    if (p.token0.toLowerCase() === usdt) s.amountUsdt = s.amount0;
    else if (p.token1.toLowerCase() === usdt) s.amountUsdt = s.amount1;
  }
  store.insertSwaps(env.body.swaps);
  store.insertTransfers(env.body.transfers);
  store.insertBlobTxs(env.body.blobTxs);
  if (env.body.cursors.lastIndexedBlock > store.lastIndexedBlock) {
    store.lastIndexedBlock = env.body.cursors.lastIndexedBlock;
  }
  const anchor = store.getTsAnchor();
  if (env.body.tsAnchor.block > anchor.block) {
    store.setTsAnchor(env.body.tsAnchor.block, env.body.tsAnchor.ts);
  }
  if (env.kind === 0 && env.blockTo > store.segmentedThrough) {
    store.segmentedThrough = env.blockTo;
  }
}

/// `mirror restore --report` appends a timed restore report to the proof file
/// (PRD §7.6) — the "60-second trustless bootstrap" number is generated, never
/// hand-written.
function appendRestoreReport(r: RestoreReport): void {
  mkdirSync(dirname(PROOF_PATH), { recursive: true });
  const lines = [
    ``,
    `### Restore run (${r.seconds}s)`,
    ``,
    `${r.rows} rows from ${r.epochs.length} on-chain checkpoints + ${r.tailRows} live tail rows.`,
    ``,
    ...r.epochs.map(
      (e) => `- epoch ${e.epoch} ← ${e.source} [\`${e.txHash}\`](${config.explorerBase}/tx/${e.txHash}) hash verified`
    ),
    ``,
  ];
  appendFileSync(PROOF_PATH, lines.join("\n"));
}
