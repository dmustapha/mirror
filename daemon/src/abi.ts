// File: daemon/src/abi.ts
import { parseAbi } from "viem";

export const factoryAbi = parseAbi([
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
  "function createPool(address tokenA, address tokenB, uint24 fee) returns (address pool)",
]);

export const poolAbi = parseAbi([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);

export const erc20Abi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

export const registryAbi = parseAbi([
  "struct Checkpoint { uint64 epoch; uint8 kind; uint64 blockFrom; uint64 blockTo; bytes32 contentHash; uint64 prevEpoch; uint32 rowCount; uint8 blobCount; }",
  "struct Beacon { uint64 priceUsdtE6; uint128 volume24hUsdtE6; uint32 swapCount24h; uint64 lastIndexedBlock; uint64 latestEpoch; }",
  "function registerCheckpoint(Checkpoint cp, Beacon b)",
  "function mirrorHead(uint64 epoch, bytes32 contentHash, bytes payload)",
  "function latestEpoch() view returns (uint64)",
  "function checkpoints(uint64 epoch) view returns (Checkpoint)",
  "function beacon() view returns (Beacon)",
  "function setWriter(address w)",
  "event CheckpointRegistered(uint64 indexed epoch, uint8 kind, bytes32 contentHash, uint64 blockFrom, uint64 blockTo, uint64 prevEpoch)",
  "event HeadMirrored(uint64 indexed epoch, bytes32 contentHash)",
]);
