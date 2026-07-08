// File: web/components/StatusBar.tsx — compact nav pill (Signal Bento)
"use client";
import { useEffect, useState } from "react";
import { api, type StatusInfo, type CheckpointInfo } from "@/lib/api";

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

  if (!status) return <div className="statusbar">connecting…</div>;
  return (
    <div className="statusbar">
      <span>block <b>{status.lastIndexedBlock.toLocaleString()}</b>{status.lagBlocks !== null && ` · lag ${status.lagBlocks}`}</span>
      <span><b>{status.counts.swaps.toLocaleString()}</b> swaps</span>
      <span><b>{status.counts.checkpoints}</b> checkpoints</span>
      {head?.txUrl && (
        <a href={head.txUrl} target="_blank" rel="noreferrer">epoch {head.epoch} ↗</a>
      )}
    </div>
  );
}
