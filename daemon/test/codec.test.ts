// File: daemon/test/codec.test.ts
import { describe, expect, it } from "vitest";
import { toBlobs, fromBlobs, bytesToHex } from "viem";
import { encodeEnvelope, decodeEnvelope, contentHashOf } from "../src/codec.js";
import type { Envelope, Hex, SwapRow } from "../src/types.js";

const A = (n: number): Hex => `0x${n.toString(16).padStart(40, "a")}` as Hex;
const H = (n: number): Hex => `0x${n.toString(16).padStart(64, "b")}` as Hex;

function sampleEnvelope(swapCount: number): Envelope {
  const swaps: SwapRow[] = [];
  for (let i = 0; i < swapCount; i++) {
    swaps.push({
      block: 1_066_273 + Math.floor(i / 3), // multiple logs per block
      logIndex: i % 3,
      txHash: null, // codec never carries tx hashes
      pool: A(1),
      amount0: BigInt(i) * 1_000_000n * (i % 2 === 0 ? 1n : -1n), // signed
      amount1: BigInt(i) * -777_000_000_000_000_000n,
      sqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n + BigInt(i), // ~2^96
      priceUsdtE6: 123_456 + i,
      sender: A(2 + (i % 4)), // dictionary reuse
      recipient: A(3),
    });
  }
  return {
    version: 1,
    kind: 0,
    blockFrom: 1_066_273,
    blockTo: 1_066_273 + Math.ceil(swapCount / 3),
    prevEpoch: 7,
    body: {
      pools: [{ addr: A(1), token0: A(9), token1: A(8), fee: 3000, createdBlock: 1_000_000 }],
      swaps,
      transfers: [
        { block: 1_066_274, logIndex: 5, txHash: null, from: A(2), to: A(3), value: 42_000_000n },
      ],
      blobTxs: [
        { txHash: H(1), block: 1_066_275, from: A(2), to: A(4), blobCount: 3, blobGasUsed: 393_216 },
      ],
      cursors: { lastIndexedBlock: 1_066_280 },
      tsAnchor: { block: 1_066_280, ts: 1_751_700_000 },
    },
  };
}

describe("codec", () => {
  it("round-trips an envelope byte-faithfully", () => {
    const env = sampleEnvelope(500);
    const bytes = encodeEnvelope(env);
    const back = decodeEnvelope(bytes);
    expect(back).toEqual(env);
  });

  it("produces a stable contentHash for identical input", () => {
    const a = contentHashOf(encodeEnvelope(sampleEnvelope(100)));
    const b = contentHashOf(encodeEnvelope(sampleEnvelope(100)));
    expect(a).toBe(b);
  });

  it("changes contentHash when any row changes", () => {
    const env2 = sampleEnvelope(100);
    env2.body.swaps[50].amount0 += 1n;
    expect(contentHashOf(encodeEnvelope(sampleEnvelope(100)))).not.toBe(
      contentHashOf(encodeEnvelope(env2))
    );
  });

  it("rejects non-ascending block order", () => {
    const env = sampleEnvelope(10);
    env.body.swaps.reverse();
    expect(() => encodeEnvelope(env)).toThrow();
  });

  it("compresses production-shaped data to ≤ 20B/row target", () => {
    const env = sampleEnvelope(10_000);
    const bytes = encodeEnvelope(env);
    expect(bytes.length / env.body.swaps.length).toBeLessThanOrEqual(20);
  });

  it("survives the blob leg: envelope → toBlobs → fromBlobs → decode", () => {
    const env = sampleEnvelope(2_000);
    const bytes = encodeEnvelope(env);
    const blobs = toBlobs({ data: bytesToHex(bytes) });
    const back = fromBlobs({ blobs, to: "bytes" });
    // fromBlobs strips the terminator exactly — lengths must match, not just prefix
    expect(back.length).toBe(bytes.length);
    expect(decodeEnvelope(back)).toEqual(env);
    expect(contentHashOf(back)).toBe(contentHashOf(bytes));
  });
});
