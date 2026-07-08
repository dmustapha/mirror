// File: daemon/src/api.ts
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import type { WebSocket } from "@fastify/websocket";
import { publicClient, writeClient } from "./chain.js";
import { registryAbi } from "./abi.js";
import { config } from "./config.js";
import { Store } from "./store.js";
import { Ingestor, resolveSwapTxHashes } from "./ingest.js";
import { explorerTx, explorerTxWrite, explorerAddr } from "./decode.js";
import type { Hex, SwapRow } from "./types.js";

const INTERVALS: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
};

const startedAt = Date.now();

function swapJson(s: SwapRow) {
  return {
    block: s.block,
    logIndex: s.logIndex,
    txHash: s.txHash,
    txUrl: s.txHash ? explorerTx(s.txHash) : null, // deep link — verifiability concern #4
    pool: s.pool,
    amount0: s.amount0.toString(),
    amount1: s.amount1.toString(),
    priceUsdt: s.priceUsdtE6 / 1e6,
    sender: s.sender,
    recipient: s.recipient,
  };
}

export async function buildApi(store: Store, ingestor: Ingestor) {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  // Dashboard polling alone is ~40 req/min per tab (status+checkpoints 5s,
  // swaps 8s, ohlcv 10s); 300 bounds abuse without 429ing the demo (PRD §4).
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(websocket);

  // ---------- WS: live swap + checkpoint feed ----------
  const sockets = new Set<WebSocket>();
  const broadcast = (msg: unknown) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) {
      try { ws.send(s); } catch { sockets.delete(ws); }
    }
  };
  ingestor.on("swaps", (swaps: SwapRow[]) => {
    for (const s of swaps) broadcast({ type: "swap", data: swapJson(s) });
  });
  // Checkpoint feed by head-polling the store (decoupled from the engine — no
  // cross-object wiring; a 3s delay on a 5-minute cadence is invisible).
  let lastSeenEpoch = store.checkpointsList(1)[0]?.epoch ?? 0;
  const cpPoll = setInterval(() => {
    const head = store.checkpointsList(1)[0];
    if (head && head.epoch > lastSeenEpoch) {
      lastSeenEpoch = head.epoch;
      broadcast({ type: "checkpoint", data: { ...head, txUrl: head.txHash ? explorerTxWrite(head.txHash) : null } });
    }
  }, 3_000);
  app.addHook("onClose", async () => clearInterval(cpPoll));

  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  // ---------- REST ----------
  app.get("/pools", async () => {
    const head = store.lastIndexedBlock;
    return store.pools().map((p) => ({
      ...p,
      addrUrl: explorerAddr(p.addr),
      ...(() => {
        const a = store.aggregates24h(p.addr as Hex, head);
        return {
          priceUsdt: Number(a.priceUsdtE6) / 1e6,
          volume24hUsdt: Number(a.volume24hUsdtE6) / 1e6,
          swapCount24h: a.swapCount24h,
        };
      })(),
    }));
  });

  app.get<{ Params: { addr: string }; Querystring: { limit?: string; before?: string } }>(
    "/pools/:addr/swaps",
    async (req) => {
      const addr = req.params.addr.toLowerCase() as Hex;
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const before = req.query.before ? Number(req.query.before) : undefined;
      let rows = store.swaps(addr, limit, before);
      // Checkpoint-restored rows carry no tx hash — resolve lazily, cache in DB.
      rows = await resolveSwapTxHashes(store, addr, rows);
      return rows.map(swapJson);
    }
  );

  app.get<{ Params: { addr: string }; Querystring: { interval?: string; buckets?: string } }>(
    "/pools/:addr/ohlcv",
    async (req, reply) => {
      const iv = INTERVALS[req.query.interval ?? "1h"];
      if (!iv) return reply.code(400).send({ error: `interval must be one of ${Object.keys(INTERVALS).join(",")}` });
      const buckets = Math.min(Number(req.query.buckets ?? 200), 1000);
      const anchor = store.getTsAnchor();
      const rows = store.ohlcv(req.params.addr.toLowerCase() as Hex, iv, buckets, anchor);
      return rows.reverse().map((r) => ({
        time: r.bucket_ts,
        open: r.open / 1e6, high: r.high / 1e6, low: r.low / 1e6, close: r.close / 1e6,
        volumeUsdt: r.volume_e6 / 1e6,
        trades: r.trades,
      }));
    }
  );

  app.get<{ Params: { addr: string }; Querystring: { limit?: string } }>(
    "/transfers/:addr",
    async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      return store
        .transfersForAddr(req.params.addr.toLowerCase() as Hex, limit)
        .map((t) => ({
          block: t.block, logIndex: t.logIndex, txHash: t.txHash,
          txUrl: t.txHash ? explorerTx(t.txHash) : null,
          from: t.from, to: t.to, valueUsdt: Number(t.value) / 1e6,
        }));
    }
  );

  app.get("/checkpoints", async () =>
    store.checkpointsList(200).map((c) => ({
      ...c,
      kindName: c.kind === 0 ? "SEGMENT" : "HEAD",
      txUrl: c.txHash ? explorerTxWrite(c.txHash) : null, // DEV-006
    }))
  );

  /// On-chain beacon read — proves depth item (a): the same struct any BOT
  /// Chain contract can consume. Local aggregates ride along for freshness
  /// comparison on the dashboard.
  app.get("/beacon", async (_req, reply) => {
    if (!config.registryAddress) return reply.code(503).send({ error: "registry not deployed yet" });
    const b = await writeClient.readContract({
      address: config.registryAddress, abi: registryAbi, functionName: "beacon",
    });
    const local = store.aggregates24h(config.mainPool.toLowerCase() as Hex, store.lastIndexedBlock);
    return {
      onchain: {
        priceUsdt: Number(b.priceUsdtE6) / 1e6,
        volume24hUsdt: Number(b.volume24hUsdtE6) / 1e6,
        swapCount24h: Number(b.swapCount24h),
        lastIndexedBlock: Number(b.lastIndexedBlock),
        latestEpoch: Number(b.latestEpoch),
      },
      local: {
        priceUsdt: Number(local.priceUsdtE6) / 1e6,
        volume24hUsdt: Number(local.volume24hUsdtE6) / 1e6,
        swapCount24h: local.swapCount24h,
        lastIndexedBlock: store.lastIndexedBlock,
      },
      registry: config.registryAddress,
      registryUrl: `${config.writeExplorerBase}/address/${config.registryAddress}`, // DEV-006: registry lives on the write chain
    };
  });

  /// Blob self-view (depth item c): every type-3 tx the chain has ever seen —
  /// which, on BOT Chain, is Mirror's own checkpoints.
  app.get("/blobs", async () => {
    const reg = config.registryAddress.toLowerCase();
    // DEV-006: checkpoint blob txs carry WRITE-chain block numbers, which run
    // ahead of the read-chain head — bounding by lastIndexedBlock hid them all.
    return store.blobTxsInRange(0, Number.MAX_SAFE_INTEGER).map((b) => ({
      ...b,
      // DEV-006: our checkpoint blob txs live on the write chain; anything else
      // (none in mainnet history, measured) is a read-chain tx.
      txUrl: b.to === reg && reg ? explorerTxWrite(b.txHash) : explorerTx(b.txHash),
    }));
  });

  app.get("/status", async () => {
    // Cached by the ingest tick; live fallback only before the first tick.
    const latest = ingestor.lastSeenChainHead ||
      Number(await publicClient.getBlockNumber().catch(() => 0n));
    const counts = store.counts();
    return {
      chainId: config.chainId,
      chainHead: latest,
      lastIndexedBlock: store.lastIndexedBlock,
      lagBlocks: latest ? latest - config.confirmations - store.lastIndexedBlock : null,
      counts,
      dbBytes: store.fileInfo().bytes,
      segmentedThrough: store.segmentedThrough,
      registry: config.registryAddress || null,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    };
  });

  /// JSON twin of submission/proof.md — everything a judge needs to verify.
  app.get("/proof", async () => {
    const cps = store.checkpointsList(500);
    return {
      registry: config.registryAddress || null,
      registryUrl: config.registryAddress ? explorerAddr(config.registryAddress) : null,
      checkpointCount: cps.length,
      checkpoints: cps.map((c) => ({
        epoch: c.epoch,
        kind: c.kind === 0 ? "SEGMENT" : "HEAD",
        blocks: `${c.blockFrom}-${c.blockTo}`,
        rows: c.rowCount,
        contentHash: c.contentHash,
        txHash: c.txHash,
        txUrl: c.txHash ? explorerTxWrite(c.txHash) : null, // DEV-006
      })),
      reproduce:
        "docker compose up --build -d  # hero flow: docker compose stop daemon && docker compose run --rm daemon npx tsx src/main.ts wipe && docker compose run --rm daemon npx tsx src/main.ts restore && docker compose start daemon",
    };
  });

  return app;
}
