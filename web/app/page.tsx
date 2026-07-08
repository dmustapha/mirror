// File: web/app/page.tsx — overview (Signal Bento)
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, fmt, type PoolInfo, type StatusInfo, type CheckpointInfo } from "@/lib/api";
import LiveTicker from "@/components/LiveTicker";

export default function Home() {
  const [pools, setPools] = useState<PoolInfo[]>([]);
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [head, setHead] = useState<CheckpointInfo | null>(null);
  useEffect(() => {
    const load = () => {
      void api.pools().then(setPools).catch(() => {});
      void api.status().then(setStatus).catch(() => {});
      void api.checkpoints().then((c) => setHead(c[0] ?? null)).catch(() => {});
    };
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <h1>The index lives <span className="hl">on the chain</span> it indexes.</h1>
      <p className="sub" style={{ marginBottom: 26 }}>
        Mirror decodes BOT Chain DEX activity into a queryable database, then checkpoints that
        database into blob transactions on BOT Chain itself. A day of data restores in under a
        minute — the full 3-million-row history in under ten, every checkpoint hash-verified.
        See <Link href="/checkpoints" style={{ color: "var(--accent)" }}>Checkpoints</Link>.
      </p>

      <div className="bento" style={{ marginBottom: 14 }}>
        <div className="panel c3"><div className="k">Swaps decoded</div><div className="big">{status ? status.counts.swaps.toLocaleString() : "—"}</div></div>
        <div className="panel c3"><div className="k">Checkpoints on-chain</div><div className="big hl">{status ? status.counts.checkpoints : "—"}</div><div className="note">{head?.txHash ? `latest ${fmt.addr(head.txHash)}` : ""}</div></div>
        <div className="panel c3"><div className="k">Pools discovered</div><div className="big">{status ? status.counts.pools : "—"}</div></div>
        <div className="panel c3"><div className="k">Database</div><div className="big">{status ? fmt.bytes(status.dbBytes) : "—"}</div><div className="note">restorable from chain alone</div></div>
      </div>

      <div className="bento">
        <div className="panel c8">
          <div className="k">Pools — auto-discovered from the BDEX factory</div>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr><th>Pool</th><th>Pair</th><th>Fee</th><th>Price (USDT)</th><th>24h Volume</th><th>24h Swaps</th></tr>
            </thead>
            <tbody>
              {pools.map((p) => (
                <tr key={p.addr}>
                  <td><Link href={`/pools/${p.addr}`} className="mono">{fmt.addr(p.addr)}</Link></td>
                  <td className="mono" style={{ color: "var(--muted)" }}>{fmt.addr(p.token0)} / {fmt.addr(p.token1)}</td>
                  <td>{p.fee / 10_000}%</td>
                  <td>{p.priceUsdt > 0 ? fmt.price(p.priceUsdt) : <span style={{ color: "var(--muted)" }}>—</span>}</td>
                  <td>{fmt.usd(p.volume24hUsdt)}</td>
                  <td>{p.swapCount24h}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel c4">
          <div className="k" style={{ marginBottom: 6 }}>Live feed</div>
          <LiveTicker />
        </div>
      </div>
    </>
  );
}
