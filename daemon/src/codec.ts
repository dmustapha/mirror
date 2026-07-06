// File: daemon/src/codec.ts
import { gzipSync, gunzipSync } from "node:zlib";
import { keccak256 } from "viem";
import type {
  Envelope, EnvelopeBody, SwapRow, TransferRow, PoolRow, BlobTxRow, Hex,
} from "./types.js";

const MAGIC = new Uint8Array([0x4d, 0x49, 0x52, 0x31]); // "MIR1"

// ---------------- byte writer / reader ----------------
class Writer {
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  u8(v: number) { this.ensure(1); this.buf[this.len++] = v & 0xff; }
  raw(bytes: Uint8Array) { this.ensure(bytes.length); this.buf.set(bytes, this.len); this.len += bytes.length; }
  varint(v: number) { this.varbig(BigInt(v)); }
  varbig(v: bigint) { // unsigned LEB128, arbitrary precision
    if (v < 0n) throw new Error("varbig: negative");
    do {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v > 0n) byte |= 0x80;
      this.u8(byte);
    } while (v > 0n);
  }
  zigzag(v: bigint) { this.varbig(v >= 0n ? v << 1n : ((-v) << 1n) - 1n); }
  hexFixed(h: Hex, bytes: number) {
    const raw = hexToBytesFixed(h, bytes);
    this.raw(raw);
  }
  out(): Uint8Array { return this.buf.slice(0, this.len); }
}

class Reader {
  pos = 0;
  constructor(private buf: Uint8Array) {}
  u8(): number { return this.buf[this.pos++]; }
  raw(n: number): Uint8Array { const r = this.buf.slice(this.pos, this.pos + n); this.pos += n; return r; }
  varint(): number { return Number(this.varbig()); }
  varbig(): bigint {
    let result = 0n, shift = 0n;
    for (;;) {
      const byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  }
  zigzag(): bigint { const u = this.varbig(); return (u & 1n) === 0n ? u >> 1n : -((u + 1n) >> 1n); }
  hexFixed(bytes: number): Hex { return bytesToHexStr(this.raw(bytes)); }
  get remaining(): number { return this.buf.length - this.pos; }
}

function hexToBytesFixed(h: Hex, n: number): Uint8Array {
  const s = h.slice(2).padStart(n * 2, "0");
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(s.substring(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHexStr(b: Uint8Array): Hex {
  let s = "0x";
  for (const byte of b) s += byte.toString(16).padStart(2, "0");
  return s as Hex;
}

// ---------------- address dictionary ----------------
class Dict {
  map = new Map<string, number>();
  list: Hex[] = [];
  idx(addr: Hex): number {
    const k = addr.toLowerCase();
    const found = this.map.get(k);
    if (found !== undefined) return found;
    const i = this.list.length;
    this.map.set(k, i);
    this.list.push(k as Hex);
    return i;
  }
}

// ---------------- envelope encode ----------------
export function encodeEnvelope(env: Envelope): Uint8Array {
  const body = encodeBody(env.body);
  const gz = gzipSync(body, { level: 9 });
  const w = new Writer();
  w.raw(MAGIC);
  w.u8(env.version);
  w.u8(env.kind);
  w.varint(env.blockFrom);
  w.varint(env.blockTo);
  w.varint(env.prevEpoch);
  w.varint(gz.length);
  w.raw(gz);
  return w.out();
}

function encodeBody(b: EnvelopeBody): Uint8Array {
  const w = new Writer();
  const dict = new Dict();
  // pre-walk to build the dictionary in deterministic order
  for (const p of b.pools) { dict.idx(p.addr); dict.idx(p.token0); dict.idx(p.token1); }
  for (const s of b.swaps) { dict.idx(s.pool); dict.idx(s.sender); dict.idx(s.recipient); }
  for (const t of b.transfers) { dict.idx(t.from); dict.idx(t.to); }
  for (const bt of b.blobTxs) { dict.idx(bt.from); dict.idx(bt.to); }
  // dictionary section
  w.varint(dict.list.length);
  for (const a of dict.list) w.hexFixed(a, 20);
  // pools
  w.varint(b.pools.length);
  for (const p of b.pools) {
    w.varint(dict.idx(p.addr)); w.varint(dict.idx(p.token0)); w.varint(dict.idx(p.token1));
    w.varint(p.fee); w.varint(p.createdBlock);
  }
  // swaps (block delta-encoded, ascending order REQUIRED)
  w.varint(b.swaps.length);
  let prevBlock = 0;
  for (const s of b.swaps) {
    if (s.block < prevBlock) throw new Error("codec: swaps must be block-ascending");
    w.varint(s.block - prevBlock); prevBlock = s.block;
    w.varint(s.logIndex);
    w.varint(dict.idx(s.pool));
    w.zigzag(s.amount0);
    w.zigzag(s.amount1);
    w.varbig(s.sqrtPriceX96);
    w.varint(s.priceUsdtE6);
    w.varint(dict.idx(s.sender));
    w.varint(dict.idx(s.recipient));
  }
  // transfers
  w.varint(b.transfers.length);
  prevBlock = 0;
  for (const t of b.transfers) {
    if (t.block < prevBlock) throw new Error("codec: transfers must be block-ascending");
    w.varint(t.block - prevBlock); prevBlock = t.block;
    w.varint(t.logIndex);
    w.varint(dict.idx(t.from));
    w.varint(dict.idx(t.to));
    w.varbig(t.value);
  }
  // blob txs
  w.varint(b.blobTxs.length);
  prevBlock = 0;
  for (const bt of b.blobTxs) {
    if (bt.block < prevBlock) throw new Error("codec: blobTxs must be block-ascending");
    w.varint(bt.block - prevBlock); prevBlock = bt.block;
    w.hexFixed(bt.txHash, 32);
    w.varint(dict.idx(bt.from));
    w.varint(dict.idx(bt.to));
    w.varint(bt.blobCount);
    w.varint(bt.blobGasUsed);
  }
  // cursors + ts anchor
  w.varint(b.cursors.lastIndexedBlock);
  w.varint(b.tsAnchor.block);
  w.varint(b.tsAnchor.ts);
  return w.out();
}

// ---------------- envelope decode ----------------
export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const r = new Reader(bytes);
  const magic = r.raw(4);
  for (let i = 0; i < 4; i++) {
    if (magic[i] !== MAGIC[i]) throw new Error("codec: bad magic — not a MIR1 envelope");
  }
  const version = r.u8();
  if (version !== 1) throw new Error(`codec: unsupported version ${version}`);
  const kind = r.u8() as 0 | 1;
  const blockFrom = r.varint();
  const blockTo = r.varint();
  const prevEpoch = r.varint();
  const gzLen = r.varint();
  const body = decodeBody(gunzipSync(r.raw(gzLen)));
  return { version: 1, kind, blockFrom, blockTo, prevEpoch, body };
}

function decodeBody(bytes: Uint8Array): EnvelopeBody {
  const r = new Reader(bytes);
  const dictLen = r.varint();
  const dict: Hex[] = [];
  for (let i = 0; i < dictLen; i++) dict.push(r.hexFixed(20));
  const pools: PoolRow[] = [];
  const nPools = r.varint();
  for (let i = 0; i < nPools; i++) {
    pools.push({
      addr: dict[r.varint()], token0: dict[r.varint()], token1: dict[r.varint()],
      fee: r.varint(), createdBlock: r.varint(),
    });
  }
  const swaps: SwapRow[] = [];
  const nSwaps = r.varint();
  let block = 0;
  for (let i = 0; i < nSwaps; i++) {
    block += r.varint();
    swaps.push({
      block, logIndex: r.varint(), txHash: null, pool: dict[r.varint()],
      amount0: r.zigzag(), amount1: r.zigzag(), sqrtPriceX96: r.varbig(),
      priceUsdtE6: r.varint(), sender: dict[r.varint()], recipient: dict[r.varint()],
    });
  }
  const transfers: TransferRow[] = [];
  const nTransfers = r.varint();
  block = 0;
  for (let i = 0; i < nTransfers; i++) {
    block += r.varint();
    transfers.push({
      block, logIndex: r.varint(), txHash: null,
      from: dict[r.varint()], to: dict[r.varint()], value: r.varbig(),
    });
  }
  const blobTxs: BlobTxRow[] = [];
  const nBlobTxs = r.varint();
  block = 0;
  for (let i = 0; i < nBlobTxs; i++) {
    block += r.varint();
    blobTxs.push({
      block, txHash: r.hexFixed(32), from: dict[r.varint()], to: dict[r.varint()],
      blobCount: r.varint(), blobGasUsed: r.varint(),
    });
  }
  const cursors = { lastIndexedBlock: r.varint() };
  const tsAnchor = { block: r.varint(), ts: r.varint() };
  return { pools, swaps, transfers, blobTxs, cursors, tsAnchor };
}

export function contentHashOf(envelopeBytes: Uint8Array): Hex {
  return keccak256(envelopeBytes);
}
