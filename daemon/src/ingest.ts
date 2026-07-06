// File: daemon/src/ingest.ts
import { EventEmitter } from "node:events";
import type { Log } from "viem";
import { publicClient, makeWsClient, sleep } from "./chain.js";
import { config } from "./config.js";
import { Store } from "./store.js";
import { decodeLogs } from "./decode.js";
import { poolAbi } from "./abi.js";
import type { Hex, SwapRow, BlobTxRow } from "./types.js";

/// Emits: "swaps" (SwapRow[]) after each chunk insert — consumed by the API's
/// WebSocket stream. Correctness never depends on listeners.
export class Ingestor extends EventEmitter {
  store: Store;
  poolTokens = new Map<string, { token0: Hex; token1: Hex }>();
  private nudgeFn: (() => void) | null = null;
  private running = false;

  constructor(store: Store) {
    super();
    this.store = store;
    for (const p of store.pools()) {
      this.poolTokens.set(p.addr, { token0: p.token0, token1: p.token1 });
    }
  }

  /// The main WBOT/USDT pool predates START_BLOCK (its PoolCreated fired before
  /// the first swap we index), so it is seeded by direct contract reads, never
  /// by log replay. Idempotent: INSERT OR IGNORE.
  async seedKnownPools(): Promise<void> {
    const addr = config.mainPool.toLowerCase() as Hex;
    if (this.poolTokens.has(addr)) return;
    const [token0, token1, fee] = await Promise.all([
      publicClient.readContract({ address: config.mainPool, abi: poolAbi, functionName: "token0" }),
      publicClient.readContract({ address: config.mainPool, abi: poolAbi, functionName: "token1" }),
      publicClient.readContract({ address: config.mainPool, abi: poolAbi, functionName: "fee" }),
    ]);
    const row = {
      addr,
      token0: (token0 as Hex).toLowerCase() as Hex,
      token1: (token1 as Hex).toLowerCase() as Hex,
      fee: Number(fee),
      createdBlock: config.startBlock,
    };
    this.store.insertPools([row]);
    this.poolTokens.set(addr, { token0: row.token0, token1: row.token1 });
    console.log(`[ingest] seeded main pool ${addr} (${row.token0}/${row.token1} fee ${row.fee})`);
  }

  trackedAddresses(): Hex[] {
    const addrs: Hex[] = [config.factory];
    if (config.indexUsdtTransfers) addrs.push(config.usdt);
    addrs.push(...([...this.poolTokens.keys()] as Hex[]));
    return addrs;
  }

  /// Index [from, to] inclusive. Chunked, paced, idempotent. Used by backfill,
  /// tail, and restore-tail identically.
  async indexRange(from: number, to: number): Promise<void> {
    for (let a = from; a <= to; a += config.backfillChunkBlocks) {
      const b = Math.min(a + config.backfillChunkBlocks - 1, to);
      await this.indexChunk(a, b);
      this.store.lastIndexedBlock = b;
      if (b < to) await sleep(config.backfillPaceMs);
    }
  }

  private async indexChunk(from: number, to: number): Promise<void> {
    // DEV-003: BOT Chain serves >10MB log batches in dense regions; viem's HTTP
    // transport caps response bodies at 10MB (ResponseBodyTooLargeError). Bisect
    // the range until it fits — denser regions self-heal, sparse ones stay fast.
    try {
      await this.indexChunkRaw(from, to);
    } catch (err) {
      const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
      if (to > from && /ResponseBodyTooLarge|size limit/i.test(msg)) {
        const mid = from + Math.floor((to - from) / 2);
        console.log(`[ingest] chunk ${from}-${to} exceeds 10MB response cap — splitting at ${mid}`);
        await this.indexChunk(from, mid);
        await this.indexChunk(mid + 1, to);
        return;
      }
      throw err;
    }
  }

  private async indexChunkRaw(from: number, to: number): Promise<void> {
    const logs = await publicClient.getLogs({
      address: this.trackedAddresses(),
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
    });
    const decoded = decodeLogs(logs as Log[], this.poolTokens);

    // Mid-chunk filter refresh (depth mandate item b): a pool created INSIDE
    // this chunk was not in the address filter when getLogs ran, so its Swap
    // logs were not fetched. Register it, then re-fetch just the new pool
    // addresses over the same range. Without this, same-chunk swaps on brand
    // new pools are silently lost — exactly the on-camera demo beat (Flow 5).
    if (decoded.pools.length > 0) {
      this.store.insertPools(decoded.pools);
      for (const p of decoded.pools) {
        this.poolTokens.set(p.addr, { token0: p.token0, token1: p.token1 });
        console.log(`[ingest] pool discovered: ${p.addr} (block ${p.createdBlock})`);
      }
      const extraLogs = await publicClient.getLogs({
        address: decoded.pools.map((p) => p.addr),
        fromBlock: BigInt(from),
        toBlock: BigInt(to),
      });
      const extra = decodeLogs(extraLogs as Log[], this.poolTokens);
      decoded.swaps.push(...extra.swaps);
    }

    this.store.insertSwaps(decoded.swaps);
    if (config.indexUsdtTransfers) this.store.insertTransfers(decoded.transfers);
    if (decoded.swaps.length > 0) this.emit("swaps", decoded.swaps);

    // Blob-tx tracking (depth mandate item c): headers carry blobGasUsed, so a
    // cheap header scan finds type-3 txs. Only tail-sized ranges are scanned:
    // chain history has ZERO blob txs (measured — the "first blob tx" claim),
    // and our own checkpoint txs are recorded directly at send time. A header
    // scan of 15M backfill blocks would cost hours and find nothing.
    if (to - from <= 100) await this.scanBlobTxs(from, to);
  }

  private async scanBlobTxs(from: number, to: number): Promise<void> {
    for (let n = from; n <= to; n++) {
      const header = await publicClient.getBlock({ blockNumber: BigInt(n) });
      if (((header as { blobGasUsed?: bigint }).blobGasUsed ?? 0n) === 0n) continue;
      const full = await publicClient.getBlock({ blockNumber: BigInt(n), includeTransactions: true });
      const rows: BlobTxRow[] = (full.transactions as unknown[])
        .filter((t) => (t as { type?: string }).type === "eip4844")
        .map((t) => {
          const tx = t as { hash: Hex; from: Hex; to: Hex | null; blobVersionedHashes?: Hex[] };
          return {
            txHash: tx.hash,
            block: n,
            from: tx.from.toLowerCase() as Hex,
            to: ((tx.to ?? "0x0") as Hex).toLowerCase() as Hex,
            blobCount: tx.blobVersionedHashes?.length ?? 0,
            blobGasUsed: Number((header as { blobGasUsed?: bigint }).blobGasUsed ?? 0n),
          };
        });
      if (rows.length > 0) {
        this.store.insertBlobTxs(rows);
        console.log(`[ingest] blob tx(s) at block ${n}: ${rows.map((r) => r.txHash).join(", ")}`);
      }
    }
  }

  async refreshTsAnchor(): Promise<void> {
    const b = await publicClient.getBlock();
    this.store.setTsAnchor(Number(b.number), Number(b.timestamp));
  }

  /// Main daemon loop. `onRangeIndexed` is the checkpoint engine hook — called
  /// after every successfully indexed range with the new safe head.
  async run(onRangeIndexed?: (safeHead: number) => Promise<void>): Promise<void> {
    this.running = true;
    await this.seedKnownPools();
    await this.refreshTsAnchor();
    this.startWssNudge();
    let lastAnchorRefresh = Date.now();

    while (this.running) {
      try {
        const latest = Number(await publicClient.getBlockNumber());
        const safeHead = latest - config.confirmations;
        if (safeHead > this.store.lastIndexedBlock) {
          const from = this.store.lastIndexedBlock + 1;
          if (safeHead - from > 1000) {
            console.log(`[ingest] backfill ${from} → ${safeHead} (${safeHead - from + 1} blocks)`);
          }
          await this.indexRange(from, safeHead);
          if (onRangeIndexed) await onRangeIndexed(safeHead);
        }
        if (Date.now() - lastAnchorRefresh > 60_000) {
          await this.refreshTsAnchor();
          lastAnchorRefresh = Date.now();
        }
      } catch (err) {
        // Loop-level catch: any RPC failure waits and retries. The cursor never
        // advances past an error, so nothing is skipped.
        console.error("[ingest] loop error (retrying in 5s):", err);
        await sleep(5_000);
      }
      await this.waitNudgeOrTimeout(config.tailIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
    this.nudgeFn?.();
  }

  private waitNudgeOrTimeout(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.nudgeFn = null;
        resolve();
      }, ms);
      this.nudgeFn = () => {
        clearTimeout(t);
        this.nudgeFn = null;
        resolve();
      };
    });
  }

  private startWssNudge(): void {
    try {
      const ws = makeWsClient();
      ws.watchBlockNumber({
        onBlockNumber: () => this.nudgeFn?.(),
        onError: () => {
          /* WSS is best-effort; the cursor loop is authoritative (AF-10) */
        },
      });
      console.log("[ingest] WSS nudge subscribed");
    } catch {
      console.warn("[ingest] WSS unavailable — cursor loop only");
    }
  }
}

/// Lazily re-resolve tx hashes for checkpoint-restored rows (checkpoints strip
/// them — see types.ts). One getLogs over the rows' block span re-derives the
/// hashes by (block, logIndex); results are cached back into the DB so each row
/// pays this once. Called by the API layer on demand.
export async function resolveSwapTxHashes(
  store: Store,
  pool: Hex,
  rows: SwapRow[]
): Promise<SwapRow[]> {
  const missing = rows.filter((r) => !r.txHash);
  if (missing.length === 0) return rows;
  const from = Math.min(...missing.map((r) => r.block));
  const to = Math.max(...missing.map((r) => r.block));
  if (to - from > config.backfillChunkBlocks) return rows; // span too wide — resolve on narrower pages
  const logs = await publicClient.getLogs({
    address: pool,
    fromBlock: BigInt(from),
    toBlock: BigInt(to),
  });
  const byKey = new Map(
    logs.map((l) => [`${Number(l.blockNumber)}:${Number(l.logIndex)}`, l.transactionHash as Hex])
  );
  for (const r of rows) {
    if (r.txHash) continue;
    const h = byKey.get(`${r.block}:${r.logIndex}`);
    if (h) {
      r.txHash = h;
      store.setSwapTxHash(r.block, r.logIndex, h);
    }
  }
  return rows;
}
