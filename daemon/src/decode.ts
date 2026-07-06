// File: daemon/src/decode.ts
import { decodeEventLog, type Log } from "viem";
import { poolAbi, erc20Abi, factoryAbi } from "./abi.js";
import { config } from "./config.js";
import type { SwapRow, TransferRow, PoolRow, Hex } from "./types.js";

const Q192 = 1n << 192n;
const E18 = 10n ** 18n;

/// Price of the NON-USDT token in USDT * 1e6, from sqrtPriceX96.
/// Derivation (key insight: "USDT * 1e6" IS raw USDT units, since USDT has 6dp):
///   p_raw = sqrtP^2 / 2^192 = token1 raw units per token0 raw unit.
///  - token1 = USDT(6dp), token0 = X(18dp): USDT-units per X-wei = p_raw
///      → USDT-units per whole X = p_raw * 1e18 → priceE6 = sqrtP^2 * 1e18 / 2^192
///  - token0 = USDT(6dp), token1 = X(18dp): p_raw = X-wei per USDT-unit
///      → USDT-units per whole X = 1e18 / p_raw → priceE6 = 1e18 * 2^192 / sqrtP^2
/// Sanity anchor (main pool, token0=USDT token1=WBOT... check ordering at runtime):
/// WBOT ≈ $9.71 → priceE6 ≈ 9_710_000. If a branch is off you get 9.71 or 9.71e12,
/// both instantly visible against the official price API (integrations panel).
/// Assumes the non-USDT token has 18 decimals (true for WBOT and DemoToken;
/// generic-decimals support is out of hackathon scope, documented).
export function priceUsdtE6(sqrtPriceX96: bigint, token0: Hex, token1: Hex): number {
  const usdt = config.usdt.toLowerCase();
  const sq = sqrtPriceX96 * sqrtPriceX96;
  if (sq === 0n) return 0;
  let e6: bigint;
  if (token0.toLowerCase() === usdt) {
    e6 = (E18 * Q192) / sq;
  } else if (token1.toLowerCase() === usdt) {
    e6 = (sq * E18) / Q192;
  } else {
    return 0; // no USDT leg — price tracking not applicable
  }
  return e6 > 9_007_199_254_740_991n ? Number.MAX_SAFE_INTEGER : Number(e6);
}

export interface DecodedLogs {
  swaps: SwapRow[];
  transfers: TransferRow[];
  pools: PoolRow[];
}

/// Decode a raw getLogs batch into typed rows. poolTokens maps pool address
/// (lowercase) → {token0, token1}; unknown-pool Swap logs are skipped (they
/// get picked up after PoolCreated registers the pool and backfill covers them).
export function decodeLogs(
  logs: Log[],
  poolTokens: Map<string, { token0: Hex; token1: Hex }>
): DecodedLogs {
  const out: DecodedLogs = { swaps: [], transfers: [], pools: [] };
  for (const log of logs) {
    const addr = (log.address as Hex).toLowerCase() as Hex;
    const block = Number(log.blockNumber);
    const logIndex = Number(log.logIndex);
    const txHash = log.transactionHash as Hex;
    if (addr === config.factory.toLowerCase()) {
      try {
        const ev = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "PoolCreated") {
          out.pools.push({
            addr: (ev.args.pool as Hex).toLowerCase() as Hex,
            token0: (ev.args.token0 as Hex).toLowerCase() as Hex,
            token1: (ev.args.token1 as Hex).toLowerCase() as Hex,
            fee: Number(ev.args.fee),
            createdBlock: block,
          });
        }
      } catch { /* non-PoolCreated factory log — ignore */ }
    } else if (addr === config.usdt.toLowerCase()) {
      try {
        const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        if (ev.eventName === "Transfer") {
          out.transfers.push({
            block, logIndex, txHash,
            from: (ev.args.from as Hex).toLowerCase() as Hex,
            to: (ev.args.to as Hex).toLowerCase() as Hex,
            value: ev.args.value as bigint,
          });
        }
      } catch { /* non-Transfer USDT log — ignore */ }
    } else if (poolTokens.has(addr)) {
      try {
        const ev = decodeEventLog({ abi: poolAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "Swap") {
          const t = poolTokens.get(addr)!;
          const row: SwapRow & { amountUsdt?: bigint } = {
            block, logIndex, txHash, pool: addr,
            amount0: ev.args.amount0 as bigint,
            amount1: ev.args.amount1 as bigint,
            sqrtPriceX96: ev.args.sqrtPriceX96 as bigint,
            priceUsdtE6: priceUsdtE6(ev.args.sqrtPriceX96 as bigint, t.token0, t.token1),
            sender: (ev.args.sender as Hex).toLowerCase() as Hex,
            recipient: (ev.args.recipient as Hex).toLowerCase() as Hex,
          };
          const usdt = config.usdt.toLowerCase();
          if (t.token0.toLowerCase() === usdt) row.amountUsdt = row.amount0;
          else if (t.token1.toLowerCase() === usdt) row.amountUsdt = row.amount1;
          out.swaps.push(row);
        }
      } catch { /* non-Swap pool log (Mint/Burn/Collect) — ignored by design */ }
    }
  }
  return out;
}

/// Timestamp estimation from the measured exact 0.750s cadence (VF-W1), anchored
/// to a real block header timestamp. Good enough for hourly candles; documented
/// honestly (drift re-checked at build with a second distant anchor).
export function estTs(block: number, anchor: { block: number; ts: number }): number {
  return Math.round(anchor.ts - (anchor.block - block) * 0.75);
}

export function explorerTx(hash: string): string {
  return `${config.explorerBase}/tx/${hash}`;
}
export function explorerAddr(addr: string): string {
  return `${config.explorerBase}/address/${addr}`;
}
