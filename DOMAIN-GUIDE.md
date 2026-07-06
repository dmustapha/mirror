# Mirror — Domain Guide

Generated from ARCHITECTURE §22 (Domain Knowledge File spec). Concepts, invariants, and glossary for the Mirror indexer: an unkillable BOT Chain DEX indexer whose database checkpoints live on-chain in blob transactions and resurrect from chain alone.

## Key Concepts

| # | Concept | Definition | Source |
|---|---------|-----------|--------|
| 1 | Blob transaction (EIP-4844, type-3) | Tx carrying up to 6 sidecar blobs of 131,072 bytes each, priced by separate blob gas; blobs are NOT in calldata and prune after a retention window | FEASIBILITY-SCOPE §1; viem blob docs |
| 2 | Blob sidecar | The `{blobs, commitments, proofs}` bundle stored alongside a block; fetched via `eth_getBlobSidecarByTxHash` on BSC-lineage chains | bsc v1.5.13 source (Phase 0B) |
| 3 | BEP-336 retention | BSC-lineage blob expiry: 18.2 days + ~1 day reserve; pruned sidecars return JSON null | BEP-336 (Phase 0B) |
| 4 | Field element packing | viem `toBlobs` packs 31 bytes per 32-byte field element + 0x80 terminator → 126,975 usable bytes/blob | viem source (Phase 0B) |
| 5 | SEGMENT checkpoint | Immutable, closed block range, written once, chained via prevEpoch | PRD §4 Checkpoint Engine |
| 6 | HEAD checkpoint | Rolling checkpoint of the not-yet-segmented span, every ~400 blocks (~5 min); superseded HEADs fall out of the chain | PRD §4 |
| 7 | contentHash | keccak256 of the envelope bytes, stored on-chain; restore MUST verify it before applying | Thesis invariant (U7) |
| 8 | Epoch chain | latestEpoch → prevEpoch walk that discovers exactly the live checkpoints | ARCHITECTURE §11 |
| 9 | Data beacon | On-chain struct (priceUsdtE6, volume24h, swapCount, lastIndexedBlock, latestEpoch) any contract can read | PRD depth item (a) |
| 10 | Fee floor | Hard mempool minimum 47.62 gwei on chain 677 (measured); blob base fee pinned at 1 wei | PULSE AF-4 |
| 11 | Safe head | latest − 3 confirmations; the ingestor never indexes shallower | FEASIBILITY I9 |
| 12 | sqrtPriceX96 | Uni-v3 price encoding: price = sqrtP²/2¹⁹²; converted to USDT×1e6 with 6/18-decimal handling | ARCHITECTURE §8 derivation |
| 13 | Mid-chunk filter refresh | Re-fetch logs for pools discovered inside the current getLogs chunk (else their same-chunk swaps are lost) | ARCHITECTURE §9 |
| 14 | Calldata mirror | Latest HEAD copied into `mirrorHead` calldata every ~6h — the >18.2-day restore point | DI-8 |
| 15 | Anti-theater | Restore prints each real checkpoint tx hash as pulled; wipe deletes WAL/SHM; no hidden copies ever | U7 / Thesis invariants |
| 16 | BANNED claims | "no indexer exists" (Blockscout does), "no DEX charts exist" (GeckoTerminal covers 677), literal "cannot die" | AMEND-1 |

## Rules / Invariants the Code Must Enforce

- contentHash mismatch is fatal (never warn-and-continue)
- epoch strictly monotonic (contract-enforced)
- beacon.latestEpoch == cp.epoch
- (block, logIndex) is row identity — txHash is derived
- INSERT OR IGNORE everywhere (replay-safe)
- cursor never advances past an error
- blob reads always fullBlob=true with length assert

## Glossary (domain → code)

| Domain term | Code |
|-------------|------|
| checkpoint | `CheckpointMeta` / `checkpoints` table |
| envelope | `Envelope` + codec.ts MIR1 format |
| the beacon | `BeaconState` / `MirrorRegistry.beacon()` |
| the spike | `scripts/hour0-spike.ts` |
| mode lock | `CHECKPOINT_MODE` |
| hero flow | `wipe` + `restore` commands |
