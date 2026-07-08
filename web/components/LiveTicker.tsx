// File: web/components/LiveTicker.tsx — chip-style live feed (Signal Bento)
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
        setItems((prev) => [msg, ...prev].slice(0, 14));
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
    <div className="feed">
      {items.length === 0 && <div className="check sub">listening for swaps…</div>}
      {items.map((it) => (
        <div className="check" key={it.at}>
          {it.type === "checkpoint" ? (
            <>
              <span className="chip cp">Checkpoint</span>
              <span>
                epoch {String(it.data.epoch)} →{" "}
                <a href={String(it.data.txUrl)} target="_blank" rel="noreferrer" className="mono">
                  {fmt.addr(String(it.data.txHash))}
                </a>
              </span>
            </>
          ) : (
            <>
              <span className="chip">Swap</span>
              <span className="mono">
                {fmt.addr(String(it.data.pool))} @ {fmt.price(Number(it.data.priceUsdt))}{" "}
                {it.data.txUrl ? <a href={String(it.data.txUrl)} target="_blank" rel="noreferrer">tx↗</a> : null}
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
