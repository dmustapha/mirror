// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IMirrorBeacon {
    struct Beacon {
        uint64 priceUsdtE6;
        uint128 volume24hUsdtE6;
        uint32 swapCount24h;
        uint64 lastIndexedBlock;
        uint64 latestEpoch;
    }
    function beacon() external view returns (Beacon memory);
}

/// @title BeaconReader — a contract that is NOT Mirror, reading Mirror's data
///        beacon on-chain. Deployed alongside the registry; Scene 2 cast-calls
///        THIS, turning "any contract can read it" from a claim into a witness.
contract BeaconReader {
    IMirrorBeacon public immutable mirror;

    constructor(address registry) {
        mirror = IMirrorBeacon(registry);
    }

    /// One human-readable read: WBOT price (USDT*1e6) and how fresh it is.
    function wbotPriceE6() external view returns (uint64 price, uint64 asOfBlock, uint64 epoch) {
        IMirrorBeacon.Beacon memory b = mirror.beacon();
        return (b.priceUsdtE6, b.lastIndexedBlock, b.latestEpoch);
    }
}
