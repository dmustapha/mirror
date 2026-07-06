// File: daemon/src/store.ts
import Database from "better-sqlite3";
import { mkdirSync, existsSync, statSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import type {
  SwapRow, TransferRow, PoolRow, BlobTxRow, CheckpointMeta, Hex,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pools (
  addr TEXT PRIMARY KEY, token0 TEXT NOT NULL, token1 TEXT NOT NULL,
  fee INTEGER NOT NULL, created_block INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS swaps (
  block INTEGER NOT NULL, log_index INTEGER NOT NULL, tx_hash TEXT,
  pool TEXT NOT NULL, amount0 TEXT NOT NULL, amount1 TEXT NOT NULL,
  sqrt_price TEXT NOT NULL, price_usdt_e6 INTEGER NOT NULL,
  usdt_vol_e6 INTEGER NOT NULL DEFAULT 0,
  sender TEXT NOT NULL, recipient TEXT NOT NULL,
  PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS idx_swaps_pool ON swaps(pool, block);
CREATE TABLE IF NOT EXISTS transfers (
  block INTEGER NOT NULL, log_index INTEGER NOT NULL, tx_hash TEXT,
  from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_addr, block);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_addr, block);
CREATE TABLE IF NOT EXISTS blob_txs (
  tx_hash TEXT PRIMARY KEY, block INTEGER NOT NULL, from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL, blob_count INTEGER NOT NULL, blob_gas_used INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
  epoch INTEGER PRIMARY KEY, kind INTEGER NOT NULL, block_from INTEGER NOT NULL,
  block_to INTEGER NOT NULL, content_hash TEXT NOT NULL, prev_epoch INTEGER NOT NULL,
  row_count INTEGER NOT NULL, blob_count INTEGER NOT NULL, tx_hash TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class Store {
  db: Database.Database;

  constructor(path: string = config.dbPath) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  // ---------- meta / cursors ----------
  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
      | { value: string } | undefined;
    return r?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(key, value);
  }
  get lastIndexedBlock(): number {
    return Number(this.getMeta("lastIndexedBlock") ?? String(config.startBlock - 1));
  }
  set lastIndexedBlock(b: number) { this.setMeta("lastIndexedBlock", String(b)); }
  get segmentedThrough(): number { return Number(this.getMeta("segmentedThrough") ?? "0"); }
  set segmentedThrough(b: number) { this.setMeta("segmentedThrough", String(b)); }
  getTsAnchor(): { block: number; ts: number } {
    return {
      block: Number(this.getMeta("tsAnchorBlock") ?? "0"),
      ts: Number(this.getMeta("tsAnchorTs") ?? "0"),
    };
  }
  setTsAnchor(block: number, ts: number): void {
    this.setMeta("tsAnchorBlock", String(block));
    this.setMeta("tsAnchorTs", String(ts));
  }

  // ---------- inserts (idempotent: OR IGNORE — replays are safe) ----------
  insertPools(rows: PoolRow[]): void {
    const st = this.db.prepare(
      "INSERT OR IGNORE INTO pools(addr,token0,token1,fee,created_block) VALUES(?,?,?,?,?)"
    );
    const tx = this.db.transaction((rs: PoolRow[]) => {
      for (const p of rs) st.run(p.addr, p.token0, p.token1, p.fee, p.createdBlock);
    });
    tx(rows);
  }
  insertSwaps(rows: SwapRow[]): void {
    const st = this.db.prepare(
      `INSERT OR IGNORE INTO swaps(block,log_index,tx_hash,pool,amount0,amount1,sqrt_price,
       price_usdt_e6,usdt_vol_e6,sender,recipient) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    );
    const tx = this.db.transaction((rs: SwapRow[]) => {
      for (const s of rs) {
        const usdtVol = usdtVolumeE6(s);
        st.run(s.block, s.logIndex, s.txHash, s.pool, s.amount0.toString(),
          s.amount1.toString(), s.sqrtPriceX96.toString(), s.priceUsdtE6,
          usdtVol, s.sender, s.recipient);
      }
    });
    tx(rows);
  }
  insertTransfers(rows: TransferRow[]): void {
    const st = this.db.prepare(
      "INSERT OR IGNORE INTO transfers(block,log_index,tx_hash,from_addr,to_addr,value) VALUES(?,?,?,?,?,?)"
    );
    const tx = this.db.transaction((rs: TransferRow[]) => {
      for (const t of rs)
        st.run(t.block, t.logIndex, t.txHash, t.from, t.to, t.value.toString());
    });
    tx(rows);
  }
  insertBlobTxs(rows: BlobTxRow[]): void {
    const st = this.db.prepare(
      "INSERT OR IGNORE INTO blob_txs(tx_hash,block,from_addr,to_addr,blob_count,blob_gas_used) VALUES(?,?,?,?,?,?)"
    );
    const tx = this.db.transaction((rs: BlobTxRow[]) => {
      for (const b of rs) st.run(b.txHash, b.block, b.from, b.to, b.blobCount, b.blobGasUsed);
    });
    tx(rows);
  }
  insertCheckpoint(cp: CheckpointMeta): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO checkpoints(epoch,kind,block_from,block_to,content_hash,
       prev_epoch,row_count,blob_count,tx_hash) VALUES(?,?,?,?,?,?,?,?,?)`
    ).run(cp.epoch, cp.kind, cp.blockFrom, cp.blockTo, cp.contentHash, cp.prevEpoch,
      cp.rowCount, cp.blobCount, cp.txHash);
  }
  setSwapTxHash(block: number, logIndex: number, txHash: Hex): void {
    this.db.prepare("UPDATE swaps SET tx_hash=? WHERE block=? AND log_index=?")
      .run(txHash, block, logIndex);
  }
  setTransferTxHash(block: number, logIndex: number, txHash: Hex): void {
    this.db.prepare("UPDATE transfers SET tx_hash=? WHERE block=? AND log_index=?")
      .run(txHash, block, logIndex);
  }

  // ---------- queries ----------
  pools(): PoolRow[] {
    return (this.db.prepare("SELECT * FROM pools ORDER BY created_block").all() as any[])
      .map((r) => ({ addr: r.addr, token0: r.token0, token1: r.token1, fee: r.fee, createdBlock: r.created_block }));
  }
  swaps(pool: Hex, limit = 50, beforeBlock?: number): SwapRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM swaps WHERE pool=? ${beforeBlock ? "AND block<?" : ""}
       ORDER BY block DESC, log_index DESC LIMIT ?`
    ).all(...(beforeBlock ? [pool, beforeBlock, limit] : [pool, limit])) as any[];
    return rows.map(rowToSwap);
  }
  swapsInRange(fromBlock: number, toBlock: number): SwapRow[] {
    return (this.db.prepare(
      "SELECT * FROM swaps WHERE block>=? AND block<=? ORDER BY block, log_index"
    ).all(fromBlock, toBlock) as any[]).map(rowToSwap);
  }
  transfersInRange(fromBlock: number, toBlock: number): TransferRow[] {
    return (this.db.prepare(
      "SELECT * FROM transfers WHERE block>=? AND block<=? ORDER BY block, log_index"
    ).all(fromBlock, toBlock) as any[]).map(rowToTransfer);
  }
  blobTxsInRange(fromBlock: number, toBlock: number): BlobTxRow[] {
    return (this.db.prepare(
      "SELECT * FROM blob_txs WHERE block>=? AND block<=? ORDER BY block"
    ).all(fromBlock, toBlock) as any[]).map((r) => ({
      txHash: r.tx_hash, block: r.block, from: r.from_addr, to: r.to_addr,
      blobCount: r.blob_count, blobGasUsed: r.blob_gas_used,
    }));
  }
  transfersForAddr(addr: Hex, limit = 50): TransferRow[] {
    return (this.db.prepare(
      `SELECT * FROM transfers WHERE from_addr=? OR to_addr=?
       ORDER BY block DESC, log_index DESC LIMIT ?`
    ).all(addr, addr, limit) as any[]).map(rowToTransfer);
  }
  /// OHLCV from per-swap prices; timestamps estimated from the measured exact
  /// 0.750s cadence anchored to a real block timestamp (see decode.ts).
  ohlcv(pool: Hex, intervalSec: number, buckets: number, anchor: { block: number; ts: number }) {
    return this.db.prepare(
      `SELECT
         CAST((:ats - (:ablock - block) * 0.75) / :iv AS INTEGER) * :iv AS bucket_ts,
         MIN(price_usdt_e6) AS low, MAX(price_usdt_e6) AS high,
         (SELECT s2.price_usdt_e6 FROM swaps s2 WHERE s2.pool = swaps.pool
            AND CAST((:ats - (:ablock - s2.block) * 0.75) / :iv AS INTEGER) =
                CAST((:ats - (:ablock - swaps.block) * 0.75) / :iv AS INTEGER)
            ORDER BY s2.block ASC, s2.log_index ASC LIMIT 1) AS open,
         (SELECT s3.price_usdt_e6 FROM swaps s3 WHERE s3.pool = swaps.pool
            AND CAST((:ats - (:ablock - s3.block) * 0.75) / :iv AS INTEGER) =
                CAST((:ats - (:ablock - swaps.block) * 0.75) / :iv AS INTEGER)
            ORDER BY s3.block DESC, s3.log_index DESC LIMIT 1) AS close,
         SUM(usdt_vol_e6) AS volume_e6, COUNT(*) AS trades
       FROM swaps WHERE pool = :pool AND price_usdt_e6 > 0
       GROUP BY bucket_ts ORDER BY bucket_ts DESC LIMIT :buckets`
    ).all({ pool, iv: intervalSec, buckets, ats: anchor.ts, ablock: anchor.block }) as {
      bucket_ts: number; low: number; high: number; open: number; close: number;
      volume_e6: number; trades: number;
    }[];
  }
  aggregates24h(pool: Hex, headBlock: number) {
    const from = headBlock - 115_200; // 24h of 0.75s blocks
    const r = this.db.prepare(
      `SELECT COALESCE(SUM(usdt_vol_e6),0) AS vol, COUNT(*) AS cnt,
              COALESCE((SELECT price_usdt_e6 FROM swaps WHERE pool=? AND price_usdt_e6>0
                        ORDER BY block DESC, log_index DESC LIMIT 1),0) AS price
       FROM swaps WHERE pool=? AND block>?`
    ).get(pool, pool, from) as { vol: number; cnt: number; price: number };
    return { volume24hUsdtE6: BigInt(Math.round(r.vol)), swapCount24h: r.cnt, priceUsdtE6: BigInt(r.price) };
  }
  checkpointsList(limit = 100): CheckpointMeta[] {
    return (this.db.prepare(
      "SELECT * FROM checkpoints ORDER BY epoch DESC LIMIT ?"
    ).all(limit) as any[]).map((r) => ({
      epoch: r.epoch, kind: r.kind, blockFrom: r.block_from, blockTo: r.block_to,
      contentHash: r.content_hash, prevEpoch: r.prev_epoch, rowCount: r.row_count,
      blobCount: r.blob_count, txHash: r.tx_hash,
    }));
  }
  /// Block at the Nth swap row from `fromBlock` — cheap upper-bound estimate
  /// for segment sizing (checkpoint.ts fitSegment search start).
  blockAtRowOffset(fromBlock: number, offset: number): number | null {
    const r = this.db.prepare(
      "SELECT block FROM swaps WHERE block>=? ORDER BY block, log_index LIMIT 1 OFFSET ?"
    ).get(fromBlock, offset) as { block: number } | undefined;
    return r?.block ?? null;
  }
  counts() {
    const c = (t: string) =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { swaps: c("swaps"), transfers: c("transfers"), pools: c("pools"),
      blobTxs: c("blob_txs"), checkpoints: c("checkpoints") };
  }
  fileInfo(path: string = config.dbPath): { bytes: number } {
    return { bytes: existsSync(path) ? statSync(path).size : 0 };
  }
  close(): void { this.db.close(); }

  static wipe(path: string = config.dbPath): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = path + suffix;
      if (existsSync(p)) rmSync(p);
    }
  }
}

function rowToSwap(r: any): SwapRow {
  return {
    block: r.block, logIndex: r.log_index, txHash: r.tx_hash, pool: r.pool,
    amount0: BigInt(r.amount0), amount1: BigInt(r.amount1),
    sqrtPriceX96: BigInt(r.sqrt_price), priceUsdtE6: r.price_usdt_e6,
    sender: r.sender, recipient: r.recipient,
  };
}
function rowToTransfer(r: any): TransferRow {
  return {
    block: r.block, logIndex: r.log_index, txHash: r.tx_hash,
    from: r.from_addr, to: r.to_addr, value: BigInt(r.value),
  };
}

/// USDT-side absolute volume in e6 units for a swap (0 when pool has no USDT leg).
/// Safe as a JS number: single-swap USDT amounts are far below 2^53.
export function usdtVolumeE6(s: SwapRow): number {
  const usdt = config.usdt.toLowerCase();
  // pool token ordering is stored in pools table; amount0 is the token0 delta.
  // We tag USDT side at decode time by convention: decode.ts guarantees
  // priceUsdtE6 > 0 only for pools with a USDT leg, and amount sign carries it.
  // For volume we take |amountUSDT| = |amount0| if token0 is USDT else |amount1|.
  // decode.ts passes rows through decorateUsdtSide() before insert; the chosen
  // amount is stashed on the row as amountUsdt (not persisted separately).
  const a = (s as SwapRow & { amountUsdt?: bigint }).amountUsdt;
  if (a === undefined) return 0;
  const abs = a < 0n ? -a : a;
  return abs > 9_007_199_254_740_991n ? Number.MAX_SAFE_INTEGER : Number(abs);
}
