// File: web/app/pools/[addr]/page.tsx
import CandleChart from "@/components/CandleChart";
import SwapTable from "@/components/SwapTable";

export default async function PoolPage({ params }: { params: Promise<{ addr: string }> }) {
  const { addr } = await params; // Next 15: params is a Promise
  return (
    <>
      <h1 className="mono">{addr}</h1>
      <p className="sub">
        Candles are computed from decoded Swap events — history the explorer holds but cannot answer.
        Timestamps use the measured exact 0.750s block cadence anchored to a live header.
      </p>
      <CandleChart addr={addr} />
      <h2>Recent swaps</h2>
      <SwapTable addr={addr} />
    </>
  );
}
