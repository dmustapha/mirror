// File: web/app/blobs/page.tsx
"use client";
import { useEffect, useState } from "react";
import { api, fmt, type BlobTxInfo } from "@/lib/api";

export default function BlobsPage() {
  const [rows, setRows] = useState<BlobTxInfo[]>([]);
  useEffect(() => {
    const load = () => void api.blobs().then(setRows).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <h1>Blob Activity</h1>
      <p className="sub">
        Every EIP-4844 blob transaction on BOT Chain, live. Mirror watches its own storage medium:
        the checkpoints keeping this database recoverable appear here, indexed by the database
        they protect.
      </p>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Block</th><th>From</th><th>To</th><th>Blobs</th><th>Blob gas</th><th>Tx</th></tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.txHash}>
                <td>{b.block.toLocaleString()}</td>
                <td className="mono">{fmt.addr(b.from)}</td>
                <td className="mono">{fmt.addr(b.to)}</td>
                <td>{b.blobCount}</td>
                <td>{b.blobGasUsed.toLocaleString()}</td>
                <td><a href={b.txUrl} target="_blank" rel="noreferrer">verify↗</a></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="sub">No blob transactions indexed yet.</p>}
      </div>
    </>
  );
}
