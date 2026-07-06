// File: web/app/page.tsx
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, fmt, type PoolInfo } from "@/lib/api";
import LiveTicker from "@/components/LiveTicker";

export default function Home() {
  const [pools, setPools] = useState<PoolInfo[]>([]);
  useEffect(() => {
    void api.pools().then(setPools).catch(() => {});
    const t = setInterval(() => void api.pools().then(setPools).catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <h1>BOT Chain DEX — decoded, queryable, checkpointed on-chain</h1>
      <p className="sub">
        Every pool below was auto-discovered from the BDEX factory. Every row deep-links to the
        official explorer. The database behind this page checkpoints itself into blob transactions
        on BOT Chain — see <Link href="/checkpoints">Checkpoints</Link>.
      </p>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Pool</th><th>Pair</th><th>Fee</th><th>Price (USDT)</th><th>24h Volume</th><th>24h Swaps</th></tr>
          </thead>
          <tbody>
            {pools.map((p) => (
              <tr key={p.addr}>
                <td><Link href={`/pools/${p.addr}`} className="mono">{fmt.addr(p.addr)}</Link></td>
                <td className="mono">{fmt.addr(p.token0)} / {fmt.addr(p.token1)}</td>
                <td>{p.fee / 10_000}%</td>
                <td>{p.priceUsdt > 0 ? fmt.price(p.priceUsdt) : "—"}</td>
                <td>{fmt.usd(p.volume24hUsdt)}</td>
                <td>{p.swapCount24h}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Live</h2>
      <LiveTicker />
    </>
  );
}
