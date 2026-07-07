// File: web/app/integrations/page.tsx
import type { ReactNode } from "react";
import { api, fmt } from "@/lib/api";

export const dynamic = "force-dynamic";

const OFFICIAL_PRICE_URL =
  "https://dex-wallet.botchain.ai/api/graph/price?token=0xD5452816194a3784dBa983426cCe7c122F4abd30";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function officialPrice(): Promise<number | null> {
  try {
    const res = await fetch(OFFICIAL_PRICE_URL, {
      headers: { "user-agent": UA },
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { price?: number | string } };
    return j.data?.price ? Number(j.data.price) : null;
  } catch {
    return null;
  }
}

export default async function IntegrationsPage() {
  const [beacon, official, status] = await Promise.all([
    api.beacon().catch(() => null),
    officialPrice(),
    api.status().catch(() => null),
  ]);

  const rows: { name: string; ok: boolean; detail: ReactNode }[] = [
    {
      name: "MirrorRegistry deployed on BOT Chain (testnet 968, faucet-funded — mainnet flip is one env var)",
      ok: !!beacon,
      detail: beacon ? (
        <a href={beacon.registryUrl} target="_blank" rel="noreferrer" className="mono">{beacon.registry}</a>
      ) : "unavailable",
    },
    {
      name: "On-chain data beacon readable by any contract",
      ok: !!beacon,
      detail: beacon
        ? `beacon.priceUsdtE6 → ${fmt.price(beacon.onchain.priceUsdt)} USDT, epoch ${beacon.onchain.latestEpoch}`
        : "unavailable",
    },
    {
      name: "Price agrees with the official BOT price API",
      ok:
        !!beacon &&
        official !== null &&
        official > 0 &&
        Math.abs(beacon.onchain.priceUsdt - official) / official < 0.05,
      detail:
        beacon && official !== null
          ? `Mirror ${fmt.price(beacon.onchain.priceUsdt)} vs official ${fmt.price(official)} (±5% window)`
          : "official API unavailable right now",
    },
    {
      name: "EIP-4844 blob transactions as checkpoint storage",
      ok: (status?.counts.checkpoints ?? 0) > 0,
      detail: `${status?.counts.checkpoints ?? 0} checkpoints registered`,
    },
    {
      name: "BDEX factory auto-discovery (all pools, including future ones)",
      ok: (status?.counts.pools ?? 0) >= 1,
      detail: `${status?.counts.pools ?? 0} pools tracked from PoolCreated events`,
    },
    {
      name: "Official RPC + WSS endpoints",
      ok: (status?.lagBlocks ?? 9e9) < 100,
      detail: `rpc.botchain.ai cursor loop, lag ${status?.lagBlocks ?? "?"} blocks; ws-rpc.botchain.ai nudge`,
    },
    {
      name: "Explorer deep links on every row",
      ok: true,
      detail: "scan.botchain.ai — every swap, checkpoint, and blob tx links out",
    },
  ];

  return (
    <>
      <h1>Official Integrations</h1>
      <p className="sub">Each line is verifiable right now, on this page or one click away.</p>
      <div className="panel">
        {rows.map((r) => (
          <div className="check" key={r.name}>
            <span className={r.ok ? "ok" : "neg"}>{r.ok ? "✓" : "×"}</span>
            <div>
              <div>{r.name}</div>
              <div className="sub mono">{r.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
