// File: web/components/LiveTicker.tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { WS_URL, fmt } from "@/lib/api";

interface FeedItem { type: "swap" | "checkpoint"; data: Record<string, unknown>; at: number }

export default function LiveTicker() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (closed) return; // a scheduled reconnect can fire after unmount
      ws = new WebSocket(WS_URL);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as FeedItem;
        msg.at = seq.current++;
        setItems((prev) => [msg, ...prev].slice(0, 30));
      };
      ws.onclose = () => {
        if (!closed) timer = setTimeout(connect, 3_000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return (
    <div className="panel">
      {items.length === 0 && <span className="sub">waiting for swaps…</span>}
      {items.map((it) => (
        <div className="check" key={it.at}>
          {it.type === "checkpoint" ? (
            <>
              <span className="badge head">CHECKPOINT</span>
              <span>
                epoch {String(it.data.epoch)} written to BOT Chain —{" "}
                <a href={String(it.data.txUrl)} target="_blank" rel="noreferrer" className="mono">
                  {fmt.addr(String(it.data.txHash))}
                </a>
              </span>
            </>
          ) : (
            <>
              <span className={Number(it.data.priceUsdt) > 0 ? "pos" : ""}>SWAP</span>
              <span className="mono">
                {fmt.addr(String(it.data.pool))} @ {fmt.price(Number(it.data.priceUsdt))} USDT{" "}
                {it.data.txUrl ? <a href={String(it.data.txUrl)} target="_blank" rel="noreferrer">tx↗</a> : null}
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
