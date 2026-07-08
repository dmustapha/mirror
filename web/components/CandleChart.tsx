// File: web/components/CandleChart.tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { createChart, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { api } from "@/lib/api";

const INTERVALS = ["5m", "15m", "1h", "4h", "1d"] as const;

export default function CandleChart({ addr }: { addr: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const [interval_, setInterval_] = useState<(typeof INTERVALS)[number]>("1h");
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    if (!el.current) return;
    chart.current = createChart(el.current, {
      autoSize: true,
      height: 360,
      layout: { background: { color: "#141824" }, textColor: "#7d8598" },
      grid: { vertLines: { color: "#1c2130" }, horzLines: { color: "#1c2130" } },
      timeScale: { timeVisible: true },
    });
    const series = chart.current.addCandlestickSeries({
      upColor: "#d6ff3f", downColor: "#ff5470",
      wickUpColor: "#d6ff3f", wickDownColor: "#ff5470", borderVisible: false,
    });
    let alive = true;
    const load = () =>
      void api.ohlcv(addr, interval_).then((rows) => {
        if (!alive) return;
        const candles = rows
          .filter((r) => r.open > 0)
          .map((r) => ({
            time: r.time as UTCTimestamp,
            open: r.open, high: r.high, low: r.low, close: r.close,
          }));
        setEmpty(candles.length === 0);
        series.setData(candles);
      }).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); chart.current?.remove(); };
  }, [addr, interval_]);

  return (
    <div className="panel">
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {INTERVALS.map((iv) => (
          <button
            key={iv}
            onClick={() => setInterval_(iv)}
            className={`ivbtn${iv === interval_ ? " active" : ""}`}
          >
            {iv}
          </button>
        ))}
      </div>
      <div style={{ position: "relative" }}>
        <div ref={el} />
        {empty && (
          <div className="sub" style={{
            position: "absolute", inset: 0, display: "flex", zIndex: 3, pointerEvents: "none",
            alignItems: "center", justifyContent: "center", textAlign: "center",
          }}>
            No USDT-priced trades in this window yet — recent swaps below still verify on-chain.
          </div>
        )}
      </div>
    </div>
  );
}
