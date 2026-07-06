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

  useEffect(() => {
    if (!el.current) return;
    chart.current = createChart(el.current, {
      autoSize: true,
      height: 360,
      layout: { background: { color: "#131722" }, textColor: "#8a94ab" },
      grid: { vertLines: { color: "#1c2330" }, horzLines: { color: "#1c2330" } },
      timeScale: { timeVisible: true },
    });
    const series = chart.current.addCandlestickSeries({
      upColor: "#3fb68b", downColor: "#e0555d",
      wickUpColor: "#3fb68b", wickDownColor: "#e0555d", borderVisible: false,
    });
    let alive = true;
    const load = () =>
      void api.ohlcv(addr, interval_).then((rows) => {
        if (!alive) return;
        series.setData(
          rows
            .filter((r) => r.open > 0)
            .map((r) => ({
              time: r.time as UTCTimestamp,
              open: r.open, high: r.high, low: r.low, close: r.close,
            }))
        );
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
            style={{
              background: iv === interval_ ? "var(--accent)" : "var(--panel)",
              color: iv === interval_ ? "#0b0e14" : "var(--muted)",
              border: "1px solid var(--border)", borderRadius: 4, padding: "3px 10px", cursor: "pointer",
            }}
          >
            {iv}
          </button>
        ))}
      </div>
      <div ref={el} />
    </div>
  );
}
