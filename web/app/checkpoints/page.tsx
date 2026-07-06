// File: web/app/checkpoints/page.tsx
"use client";
import { useEffect, useState } from "react";
import { api, fmt, type CheckpointInfo } from "@/lib/api";

export default function CheckpointsPage() {
  const [rows, setRows] = useState<CheckpointInfo[]>([]);
  useEffect(() => {
    const load = () => void api.checkpoints().then(setRows).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <h1>Checkpoints</h1>
      <p className="sub">
        Immutable SEGMENTs chain backward via prevEpoch; the rolling HEAD covers the newest blocks.
        Delete this site's database and it restores itself from exactly these transactions —
        snapshot-sync for the query layer, snapshots ON the chain.
      </p>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Epoch</th><th>Kind</th><th>Blocks</th><th>Rows</th><th>Blobs</th><th>Content hash</th><th>Tx</th></tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.epoch}>
                <td>{c.epoch}</td>
                <td><span className={`badge ${c.kindName.toLowerCase()}`}>{c.kindName}</span></td>
                <td className="mono">{c.blockFrom.toLocaleString()}–{c.blockTo.toLocaleString()}</td>
                <td>{c.rowCount.toLocaleString()}</td>
                <td>{c.blobCount}</td>
                <td className="mono">{fmt.addr(c.contentHash)}</td>
                <td>{c.txUrl ? <a href={c.txUrl} target="_blank" rel="noreferrer">verify↗</a> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
