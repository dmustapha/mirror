// File: web/components/StatusBar.tsx
"use client";
import { useEffect, useState } from "react";
import { api, fmt, type StatusInfo, type CheckpointInfo } from "@/lib/api";

export default function StatusBar() {
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [head, setHead] = useState<CheckpointInfo | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, cps] = await Promise.all([api.status(), api.checkpoints()]);
        if (!alive) return;
        setStatus(s);
        setHead(cps[0] ?? null);
      } catch { /* daemon down — bar goes quiet, page still renders */ }
    };
    void load();
    const t = setInterval(load, 5_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!status) return <div className="statusbar" style={{ padding: "10px 20px" }}>connecting to mirrord…</div>;
  return (
    <div className="statusbar" style={{ padding: "10px 20px", borderBottom: "1px solid var(--border)" }}>
      <span>indexed <b>{status.lastIndexedBlock.toLocaleString()}</b>{status.lagBlocks !== null && ` (lag ${status.lagBlocks})`}</span>
      <span><b>{status.counts.swaps.toLocaleString()}</b> swaps</span>
      <span>db <b>{fmt.bytes(status.dbBytes)}</b></span>
      <span><b>{status.counts.checkpoints}</b> checkpoints on-chain</span>
      {head?.txUrl && (
        <span>latest: <a href={head.txUrl} target="_blank" rel="noreferrer" className="mono">
          epoch {head.epoch} → {fmt.addr(head.txHash!)}
        </a></span>
      )}
    </div>
  );
}
