// File: web/components/SwapTable.tsx
"use client";
import { useEffect, useState } from "react";
import { api, fmt, type SwapInfo } from "@/lib/api";

export default function SwapTable({ addr }: { addr: string }) {
  const [rows, setRows] = useState<SwapInfo[]>([]);
  useEffect(() => {
    const load = () => void api.swaps(addr, 50).then(setRows).catch(() => {});
    load();
    const t = setInterval(load, 8_000);
    return () => clearInterval(t);
  }, [addr]);

  return (
    <div className="panel">
      <table>
        <thead>
          <tr><th>Block</th><th>Price (USDT)</th><th>Sender</th><th>Recipient</th><th>Tx</th></tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={`${s.block}:${s.logIndex}`}>
              <td>{s.block.toLocaleString()}</td>
              <td>{s.priceUsdt > 0 ? fmt.price(s.priceUsdt) : "—"}</td>
              <td className="mono">{fmt.addr(s.sender)}</td>
              <td className="mono">{fmt.addr(s.recipient)}</td>
              <td>{s.txUrl ? <a href={s.txUrl} target="_blank" rel="noreferrer">verify↗</a> : <span className="sub">resolving…</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
