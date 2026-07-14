// File: web/lib/api.ts
// Server components (integrations page) run INSIDE the web container under
// docker compose, where localhost:3400 is the wrong host — they use
// API_URL_INTERNAL (service-name URL). Browsers always use the public URL.
const PUBLIC_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3400";
export const API_BASE =
  typeof window === "undefined"
    ? process.env.API_URL_INTERNAL ?? PUBLIC_BASE
    : PUBLIC_BASE;
export const WS_URL = PUBLIC_BASE.replace(/^http/, "ws") + "/ws";

export interface PoolInfo {
  addr: string; token0: string; token1: string; fee: number; createdBlock: number;
  addrUrl: string; priceUsdt: number; volume24hUsdt: number; swapCount24h: number;
}
export interface SwapInfo {
  block: number; logIndex: number; txHash: string | null; txUrl: string | null;
  pool: string; amount0: string; amount1: string; priceUsdt: number;
  sender: string; recipient: string;
}
export interface Candle {
  time: number; open: number; high: number; low: number; close: number;
  volumeUsdt: number; trades: number;
}
export interface CheckpointInfo {
  epoch: number; kind: number; kindName: "SEGMENT" | "HEAD";
  blockFrom: number; blockTo: number; contentHash: string; prevEpoch: number;
  rowCount: number; blobCount: number; txHash: string | null; txUrl: string | null;
}
export interface BlobTxInfo {
  txHash: string; txUrl: string; block: number; from: string; to: string;
  blobCount: number; blobGasUsed: number;
}
export interface StatusInfo {
  chainId: number; chainHead: number; lastIndexedBlock: number; lagBlocks: number | null;
  counts: { swaps: number; transfers: number; pools: number; blobTxs: number; checkpoints: number };
  dbBytes: number; segmentedThrough: number; registry: string | null; uptimeSec: number;
}
export interface BeaconInfo {
  onchain: { priceUsdt: number; volume24hUsdt: number; swapCount24h: number; lastIndexedBlock: number; latestEpoch: number };
  local: { priceUsdt: number; volume24hUsdt: number; swapCount24h: number; lastIndexedBlock: number };
  registry: string; registryUrl: string;
}

async function get<T>(path: string, retries = 3): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`${path} → ${res.status}`);
      return res.json() as Promise<T>;
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw new Error(`${path} → exhausted retries`);
}

export const api = {
  pools: () => get<PoolInfo[]>("/pools"),
  swaps: (addr: string, limit = 50) => get<SwapInfo[]>(`/pools/${addr}/swaps?limit=${limit}`),
  ohlcv: (addr: string, interval = "1h", buckets = 200) =>
    get<Candle[]>(`/pools/${addr}/ohlcv?interval=${interval}&buckets=${buckets}`),
  checkpoints: () => get<CheckpointInfo[]>("/checkpoints"),
  blobs: () => get<BlobTxInfo[]>("/blobs"),
  status: () => get<StatusInfo>("/status"),
  beacon: () => get<BeaconInfo>("/beacon"),
  proof: () => get<Record<string, unknown>>("/proof"),
};

export const fmt = {
  usd: (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 }),
  price: (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 6 }),
  addr: (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`,
  bytes: (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`),
};