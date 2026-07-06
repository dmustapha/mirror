// File: daemon/src/types.ts
// All shared daemon types. Rows are stored exactly as decoded from chain logs;
// txHash on SwapRow/TransferRow is nullable because checkpoints do NOT carry tx
// hashes (32 incompressible bytes/row) — they are lazily re-resolved via getLogs
// and cached back into the DB. Rows stay chain-verifiable via (block, logIndex).

export type Hex = `0x${string}`;

export interface SwapRow {
  block: number;
  logIndex: number;
  txHash: Hex | null;
  pool: Hex;
  amount0: bigint;   // signed, token0 delta (USDT side for the main pool)
  amount1: bigint;   // signed, token1 delta (WBOT side for the main pool)
  sqrtPriceX96: bigint;
  priceUsdtE6: number; // human price of the non-USDT token, USDT * 1e6 (0 if pool has no USDT side)
  sender: Hex;
  recipient: Hex;
}

export interface TransferRow {
  block: number;
  logIndex: number;
  txHash: Hex | null;
  from: Hex;
  to: Hex;
  value: bigint; // USDT has 6 decimals
}

export interface PoolRow {
  addr: Hex;
  token0: Hex;
  token1: Hex;
  fee: number;
  createdBlock: number;
}

export interface BlobTxRow {
  txHash: Hex;
  block: number;
  from: Hex;
  to: Hex;
  blobCount: number;
  blobGasUsed: number;
}

export type CheckpointKind = 0 | 1; // 0 = SEGMENT (immutable range), 1 = HEAD (rolling)

export interface CheckpointMeta {
  epoch: number;
  kind: CheckpointKind;
  blockFrom: number;
  blockTo: number;
  contentHash: Hex;
  prevEpoch: number;
  rowCount: number;
  blobCount: number;
  txHash: Hex | null; // filled from CheckpointRegistered event / send receipt
}

export interface BeaconState {
  priceUsdtE6: bigint;      // uint64 on-chain: WBOT price in USDT * 1e6
  volume24hUsdtE6: bigint;  // uint128 on-chain
  swapCount24h: number;
  lastIndexedBlock: number;
  latestEpoch: number;
}

// Envelope: the byte payload packed into blobs. codec.ts owns encode/decode.
export interface EnvelopeBody {
  pools: PoolRow[];
  swaps: SwapRow[];      // txHash stripped on encode
  transfers: TransferRow[];
  blobTxs: BlobTxRow[];
  cursors: { lastIndexedBlock: number };
  tsAnchor: { block: number; ts: number }; // block-time anchor for timestamp estimation
}

export interface Envelope {
  version: 1;
  kind: CheckpointKind;
  blockFrom: number;
  blockTo: number;
  prevEpoch: number;
  body: EnvelopeBody;
}

export interface RestoreEpochReport {
  epoch: number;
  txHash: Hex;
  block: number;
  contentHash: Hex;
  ok: boolean;
  source: "blob" | "calldata-mirror";
}

export interface RestoreReport {
  epochs: RestoreEpochReport[];
  rows: number;
  tailRows: number;
  seconds: number;
}
