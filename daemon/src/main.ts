// File: daemon/src/main.ts
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { Store } from "./store.js";
import { Ingestor } from "./ingest.js";
import { BlobSink, CalldataSink, CheckpointEngine } from "./checkpoint.js";
import { restore } from "./restore.js";
import { publicClient } from "./chain.js";

const cmd = process.argv[2] ?? "daemon";

async function runDaemon(): Promise<void> {
  const store = new Store();
  const ingestor = new Ingestor(store);
  // Mode locked by the hour-0 spike (PRD §4): blob is primary; calldata is the
  // promoted fallback. The pitch always matches this env var.
  const mode = process.env.CHECKPOINT_MODE ?? "blob";
  const sink = mode === "calldata" ? new CalldataSink() : new BlobSink();
  const engine = new CheckpointEngine(store, sink);
  console.log(`[main] mirrord starting — checkpoint mode: ${sink.mode}, db: ${config.dbPath}`);

  // DEV-004: api.ts lands in Task 4.1 — lazy-load keeps status/restore/wipe
  // compiling and running before the API module exists. The ignore directive
  // (deliberately not an expect-error) stays valid once api.ts is created.
  // @ts-ignore — module created in Task 4.1
  const { buildApi } = await import("./api.js");
  const app = await buildApi(store, ingestor);
  await app.listen({ port: config.apiPort, host: "0.0.0.0" });
  console.log(`[main] API listening on :${config.apiPort}`);

  const shutdown = () => {
    console.log("[main] shutting down");
    ingestor.stop();
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await ingestor.run((safeHead) => engine.tick(safeHead));
}

async function runWipe(): Promise<void> {
  if (!existsSync(config.dbPath)) {
    console.log(`[wipe] ${config.dbPath} does not exist — nothing to delete`);
    return;
  }
  // The on-camera beat: state the loss BEFORE causing it (PRD Flow 2).
  const store = new Store();
  const counts = store.counts();
  const bytes = store.fileInfo().bytes;
  store.close();
  console.log(`[wipe] ${config.dbPath}: ${(bytes / 1e6).toFixed(1)} MB`);
  console.log(
    `[wipe] rows: ${counts.swaps} swaps, ${counts.transfers} transfers, ` +
      `${counts.pools} pools, ${counts.checkpoints} checkpoints`
  );
  Store.wipe(); // removes db + -wal + -shm — the deletion is total
  console.log(`[wipe] DELETED. Recovery path: the ${counts.checkpoints} checkpoints on BOT Chain.`);
}

async function runStatus(): Promise<void> {
  const store = new Store();
  const counts = store.counts();
  const latest = Number(await publicClient.getBlockNumber());
  console.log(`chain head:      ${latest}`);
  console.log(`indexed through: ${store.lastIndexedBlock} (lag ${latest - config.confirmations - store.lastIndexedBlock})`);
  console.log(`segmented thru:  ${store.segmentedThrough}`);
  console.log(`rows:            ${counts.swaps} swaps / ${counts.transfers} transfers / ${counts.pools} pools`);
  console.log(`checkpoints:     ${counts.checkpoints} (${counts.blobTxs} blob txs seen)`);
  console.log(`db size:         ${(store.fileInfo().bytes / 1e6).toFixed(1)} MB`);
  store.close();
}

switch (cmd) {
  case "daemon":
    await runDaemon();
    break;
  case "restore":
    await restore(config.dbPath, { report: process.argv.includes("--report") });
    break;
  case "wipe":
    await runWipe();
    break;
  case "status":
    await runStatus();
    break;
  default:
    console.error(`unknown command: ${cmd} (expected daemon | restore | wipe | status)`);
    process.exit(1);
}
