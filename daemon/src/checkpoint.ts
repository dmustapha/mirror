// File: daemon/src/checkpoint.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toBlobs, bytesToHex, encodeFunctionData } from "viem";
import { writeClient, getWalletClient, getKzg } from "./chain.js";
import { registryAbi } from "./abi.js";
import { encodeEnvelope, contentHashOf } from "./codec.js";
import { config } from "./config.js";
import { Store } from "./store.js";
import { explorerTxWrite } from "./decode.js";
import type {
  BeaconState, CheckpointKind, CheckpointMeta, Envelope, Hex,
} from "./types.js";

const BLOB_USABLE_BYTES = 126_975; // 4096 × 31 − terminator
const SEGMENT_BUDGET = BLOB_USABLE_BYTES * config.maxBlobsPerTx; // 380,925
const GAS_PER_BLOB = 131_072; // EIP-4844: blobGasUsed = blobCount * 2^17 (exact)
// Module-relative (daemon/submission locally, /app/submission in Docker) —
// proof writes never depend on the caller's cwd.
const PROOF_PATH = fileURLToPath(new URL("../submission/proof.md", import.meta.url));

// ---------- envelope assembly ----------

/// Pools ride FULL-SET in every envelope (a handful of rows, bytes negligible).
/// This removes a bootstrap edge case: the seeded main pool predates START_BLOCK
/// and would otherwise belong to no checkpoint's range.
export function buildEnvelope(
  store: Store,
  kind: CheckpointKind,
  blockFrom: number,
  blockTo: number,
  prevEpoch: number
): Envelope {
  return {
    version: 1,
    kind,
    blockFrom,
    blockTo,
    prevEpoch,
    body: {
      pools: store.pools(),
      swaps: store.swapsInRange(blockFrom, blockTo),
      transfers: config.indexUsdtTransfers ? store.transfersInRange(blockFrom, blockTo) : [],
      blobTxs: store.blobTxsInRange(blockFrom, blockTo),
      cursors: { lastIndexedBlock: blockTo },
      tsAnchor: store.getTsAnchor(),
    },
  };
}

// ---------- viem struct args (shared by both sinks) ----------

function registerData(cp: CheckpointMeta, beacon: BeaconState): Hex {
  return encodeFunctionData({
    abi: registryAbi,
    functionName: "registerCheckpoint",
    args: [
      {
        epoch: BigInt(cp.epoch),
        kind: cp.kind,
        blockFrom: BigInt(cp.blockFrom),
        blockTo: BigInt(cp.blockTo),
        contentHash: cp.contentHash,
        prevEpoch: BigInt(cp.prevEpoch),
        rowCount: cp.rowCount,
        blobCount: cp.blobCount,
      },
      {
        priceUsdtE6: beacon.priceUsdtE6,
        volume24hUsdtE6: beacon.volume24hUsdtE6,
        swapCount24h: beacon.swapCount24h,
        lastIndexedBlock: BigInt(beacon.lastIndexedBlock),
        latestEpoch: BigInt(beacon.latestEpoch),
      },
    ],
  });
}

// ---------- sinks ----------

export interface CheckpointSink {
  readonly mode: "blob" | "calldata";
  /// Sends payload + registration. Returns the hash of the tx that CARRIES the
  /// payload (the hash restore must fetch) plus its mined block.
  send(
    bytes: Uint8Array,
    cp: CheckpointMeta,
    beacon: BeaconState
  ): Promise<{ txHash: Hex; block: number }>;
}

/// Primary path (locked by the hour-0 spike): ONE type-3 tx = blob payload +
/// registerCheckpoint calldata. Atomic by construction.
export class BlobSink implements CheckpointSink {
  readonly mode = "blob" as const;

  async send(
    bytes: Uint8Array,
    cp: CheckpointMeta,
    beacon: BeaconState
  ): Promise<{ txHash: Hex; block: number }> {
    const wallet = getWalletClient();
    const blobs = toBlobs({ data: bytesToHex(bytes) });
    if (blobs.length > config.maxBlobsPerTx) {
      throw new Error(
        `payload needs ${blobs.length} blobs > max ${config.maxBlobsPerTx} — segment sizing bug`
      );
    }
    const hash = await wallet.sendTransaction({
      to: config.registryAddress,
      data: registerData(cp, beacon),
      blobs,
      kzg: getKzg(),
      maxFeePerBlobGas: config.maxFeePerBlobGas,
      maxFeePerGas: config.maxFeePerGas,
      maxPriorityFeePerGas: config.maxPriorityFeePerGas,
    });
    const receipt = await writeClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`checkpoint tx reverted: ${hash}`);
    return { txHash: hash, block: Number(receipt.blockNumber) };
  }
}

/// Fallback path (promoted only if funded blob inclusion fails — PRD risk tree).
/// Two txs: registerCheckpoint (metadata + beacon), then mirrorHead carrying the
/// payload in calldata. mirrorHead validates contentHash on-chain, and despite
/// the name it works for SEGMENTs too — it only checks the stored checkpoint.
export class CalldataSink implements CheckpointSink {
  readonly mode = "calldata" as const;

  async send(
    bytes: Uint8Array,
    cp: CheckpointMeta,
    beacon: BeaconState
  ): Promise<{ txHash: Hex; block: number }> {
    const wallet = getWalletClient();
    const feeOpts = {
      maxFeePerGas: config.maxFeePerGas,
      maxPriorityFeePerGas: config.maxPriorityFeePerGas,
    };
    const regHash = await wallet.sendTransaction({
      to: config.registryAddress,
      data: registerData(cp, beacon),
      ...feeOpts,
    });
    const regReceipt = await writeClient.waitForTransactionReceipt({ hash: regHash, timeout: 120_000 });
    if (regReceipt.status !== "success") throw new Error(`register tx reverted: ${regHash}`);

    const hash = await wallet.sendTransaction({
      to: config.registryAddress,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: "mirrorHead",
        args: [BigInt(cp.epoch), cp.contentHash, bytesToHex(bytes)],
      }),
      ...feeOpts,
    });
    const receipt = await writeClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`mirror tx reverted: ${hash}`);
    return { txHash: hash, block: Number(receipt.blockNumber) };
  }
}

// ---------- engine ----------

export class CheckpointEngine {
  private store: Store;
  private sink: CheckpointSink;
  private nextEpoch: number;
  private lastSegmentEpoch: number;
  private lastHeadBlock = 0;
  private headsSinceMirror = 0;
  private busy = false;
  private initialized = false;

  constructor(store: Store, sink: CheckpointSink) {
    this.store = store;
    this.sink = sink;
    // Local table gives a fast starting guess; the CHAIN is the authority —
    // syncWithChain() reconciles on the first tick and after any send error
    // (wiped DB, scratch-DB runs against the same registry, receipt timeout
    // after actual inclusion would otherwise wedge the epoch chain forever).
    const all = store.checkpointsList(100_000);
    this.nextEpoch = (all[0]?.epoch ?? 0) + 1;
    this.lastSegmentEpoch = all.find((c) => c.kind === 0)?.epoch ?? 0;
    this.lastHeadBlock = all[0]?.blockTo ?? 0;
  }

  /// Called by the ingestor after every indexed range. Serialized by `busy`:
  /// a slow blob send never overlaps the next tick, and ticks that arrive
  /// mid-send are simply dropped (the next one re-evaluates from store state).
  async tick(safeHead: number): Promise<void> {
    if (this.busy) return;
    if (!config.registryAddress) return; // pre-deploy: index-only mode
    this.busy = true;
    try {
      if (!this.initialized) await this.syncWithChain();
      await this.closeSegments(safeHead);
      await this.maybeHead(safeHead);
    } catch (err) {
      // Re-sync from chain next tick: a receipt timeout after actual inclusion
      // means on-chain lastEpoch advanced while local state did not.
      this.initialized = false;
      console.error("[checkpoint] tick failed (will re-sync epoch state and retry):", err);
    } finally {
      this.busy = false;
    }
  }

  /// Chain is authoritative for epoch state. Never send an epoch the registry
  /// would reject with BadEpoch.
  private async syncWithChain(): Promise<void> {
    const chainLatest = Number(
      await writeClient.readContract({
        address: config.registryAddress,
        abi: registryAbi,
        functionName: "latestEpoch",
      })
    );
    if (chainLatest + 1 > this.nextEpoch) {
      const cp = await writeClient.readContract({
        address: config.registryAddress,
        abi: registryAbi,
        functionName: "checkpoints",
        args: [BigInt(chainLatest)],
      });
      this.nextEpoch = chainLatest + 1;
      this.lastSegmentEpoch = Number(cp.kind) === 0 ? chainLatest : Number(cp.prevEpoch);
      console.log(
        `[checkpoint] synced from chain: nextEpoch=${this.nextEpoch} lastSegmentEpoch=${this.lastSegmentEpoch}`
      );
    }
    this.initialized = true;
  }

  /// Close immutable SEGMENTs while the un-segmented span encodes big enough.
  private async closeSegments(safeHead: number): Promise<void> {
    for (;;) {
      const from =
        this.store.segmentedThrough === 0 ? config.startBlock : this.store.segmentedThrough + 1;
      if (from > safeHead) return;
      const { env, bytes, end } = this.fitSegment(from, safeHead);
      // Not enough pending data for a full segment AND nothing was clipped:
      // leave it to the rolling HEAD.
      console.log(
        `[checkpoint:debug] closeSegments from=${from} safeHead=${safeHead} bytes=${bytes.length} end=${end} ` +
        `swaps=${this.store.counts().swaps} segmentedThrough=${this.store.segmentedThrough}`
      );
      if (bytes.length < config.segmentTargetBytes && end === safeHead) return;
      await this.register(env, bytes);
      this.store.segmentedThrough = end;
    }
  }

  /// Largest block range starting at `from` whose envelope fits the blob
  /// budget. Halves the span until it fits — payloads compress unevenly, so
  /// size is discovered by encoding, not estimated.
  private fitSegment(from: number, to: number): { env: Envelope; bytes: Uint8Array; end: number } {
    // Start the search near the row budget (~25K rows ≈ 375-500KB encoded), not
    // the full span — the first tick after a 15M-block backfill would otherwise
    // gzip nearly the whole history log2(span) times.
    const approx = this.store.blockAtRowOffset(from, 25_000);
    let end = approx !== null && approx < to ? approx : to;
    for (;;) {
      const env = buildEnvelope(this.store, 0, from, end, this.lastSegmentEpoch);
      const bytes = encodeEnvelope(env);
      if (bytes.length <= SEGMENT_BUDGET) return { env, bytes, end };
      if (end === from) {
        throw new Error(`single block ${from} encodes to ${bytes.length}B > budget — impossible unless codec broke`);
      }
      end = from + Math.floor((end - from) / 2);
    }
  }

  private async maybeHead(safeHead: number): Promise<void> {
    if (safeHead - this.lastHeadBlock < config.headCadenceBlocks) return;
    const from =
      this.store.segmentedThrough === 0 ? config.startBlock : this.store.segmentedThrough + 1;
    if (from > safeHead) return;
    const env = buildEnvelope(this.store, 1, from, safeHead, this.lastSegmentEpoch);
    const bytes = encodeEnvelope(env);
    // closeSegments ran first this tick, so the pending span is < segmentTargetBytes
    // (340K) < SEGMENT_BUDGET (380,925). Assert rather than trust.
    if (bytes.length > SEGMENT_BUDGET) {
      throw new Error(`HEAD payload ${bytes.length}B exceeds budget after segmentation — invariant broken`);
    }
    const cp = await this.register(env, bytes);
    this.lastHeadBlock = safeHead;
    this.headsSinceMirror++;
    // DI-8 redundancy: mirror the latest HEAD into calldata every ~6h so a
    // >18.2-day-old restore point always exists past blob retention.
    if (this.headsSinceMirror >= config.calldataMirrorEveryNHeads) {
      await this.mirrorLatestHead(cp, bytes);
      this.headsSinceMirror = 0;
    }
  }

  private async register(env: Envelope, bytes: Uint8Array): Promise<CheckpointMeta> {
    const epoch = this.nextEpoch;
    // Exact count via toBlobs (ceil-estimate can overshoot at boundaries);
    // calldata mode carries no blobs.
    const blobCount =
      this.sink.mode === "blob" ? toBlobs({ data: bytesToHex(bytes) }).length : 0;
    const cp: CheckpointMeta = {
      epoch,
      kind: env.kind,
      blockFrom: env.blockFrom,
      blockTo: env.blockTo,
      contentHash: contentHashOf(bytes),
      prevEpoch: env.prevEpoch,
      rowCount: env.body.swaps.length + env.body.transfers.length,
      blobCount,
      txHash: null,
    };
    const beacon = this.buildBeacon(env.blockTo, epoch);
    const { txHash, block } = await this.sink.send(bytes, cp, beacon);
    cp.txHash = txHash;
    this.store.insertCheckpoint(cp);
    // Self-record the blob tx: the /blobs self-view (depth item c) must show
    // our checkpoints regardless of tail-scan window (ingest only header-scans
    // tail-sized ranges).
    if (this.sink.mode === "blob") {
      this.store.insertBlobTxs([{
        txHash,
        block,
        from: getWalletClient().account.address.toLowerCase() as Hex,
        to: config.registryAddress.toLowerCase() as Hex,
        blobCount,
        blobGasUsed: blobCount * GAS_PER_BLOB,
      }]);
    }
    this.nextEpoch = epoch + 1;
    if (cp.kind === 0) this.lastSegmentEpoch = epoch;
    appendProofLine(cp, this.sink.mode);
    console.log(
      `[checkpoint] epoch ${epoch} ${cp.kind === 0 ? "SEGMENT" : "HEAD"} ` +
        `blocks ${cp.blockFrom}-${cp.blockTo} rows ${cp.rowCount} ` +
        `(${bytes.length}B, ${cp.blobCount} blob${cp.blobCount === 1 ? "" : "s"}) → ${txHash}`
    );
    return cp;
  }

  private buildBeacon(lastIndexedBlock: number, epoch: number): BeaconState {
    const agg = this.store.aggregates24h(config.mainPool.toLowerCase() as Hex, lastIndexedBlock);
    return {
      priceUsdtE6: agg.priceUsdtE6,
      volume24hUsdtE6: agg.volume24hUsdtE6,
      swapCount24h: agg.swapCount24h,
      lastIndexedBlock,
      latestEpoch: epoch, // contract enforces beacon.latestEpoch == cp.epoch
    };
  }

  private async mirrorLatestHead(cp: CheckpointMeta, bytes: Uint8Array): Promise<void> {
    if (this.sink.mode === "calldata") return; // payload already lives in calldata
    const wallet = getWalletClient();
    const hash = await wallet.sendTransaction({
      to: config.registryAddress,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: "mirrorHead",
        args: [BigInt(cp.epoch), cp.contentHash, bytesToHex(bytes)],
      }),
      maxFeePerGas: config.maxFeePerGas,
      maxPriorityFeePerGas: config.maxPriorityFeePerGas,
    });
    await writeClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    console.log(`[checkpoint] calldata mirror of epoch ${cp.epoch} → ${hash}`);
  }
}

/// Every registered checkpoint appends one row to submission/proof.md — the
/// judge-facing proof table is produced as a side effect of running for real
/// (PRD §7.6). hour0-spike.ts seeds the file header.
function appendProofLine(cp: CheckpointMeta, mode: string): void {
  mkdirSync(dirname(PROOF_PATH), { recursive: true });
  const kind = cp.kind === 0 ? "SEGMENT" : "HEAD";
  appendFileSync(
    PROOF_PATH,
    `| ${cp.epoch} | ${kind} | ${cp.blockFrom}-${cp.blockTo} | ${cp.rowCount} | ${mode} | [\`${cp.txHash}\`](${explorerTxWrite(cp.txHash!)}) |\n`
  );
}
