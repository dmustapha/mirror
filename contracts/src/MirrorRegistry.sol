// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MirrorRegistry — checkpoint registry + data beacon for the Mirror indexer.
/// @notice Each Mirror checkpoint is ONE type-3 (blob) transaction sent TO this
///         contract: the blobs carry the database payload, the calldata calls
///         registerCheckpoint. The Beacon makes Mirror's latest aggregates readable
///         by any other BOT Chain contract (on-chain data beacon).
contract MirrorRegistry {
    struct Checkpoint {
        uint64 epoch;        // sequential, assigned by writer, enforced == lastEpoch+1
        uint8 kind;          // 0 = SEGMENT (immutable range), 1 = HEAD (rolling)
        uint64 blockFrom;
        uint64 blockTo;
        bytes32 contentHash; // keccak256 of the full envelope bytes in the blobs
        uint64 prevEpoch;    // restore walks this chain (HEAD -> latest SEGMENT -> ...)
        uint32 rowCount;
        uint8 blobCount;
    }

    struct Beacon {
        uint64 priceUsdtE6;     // WBOT price in USDT * 1e6
        uint128 volume24hUsdtE6;
        uint32 swapCount24h;
        uint64 lastIndexedBlock;
        uint64 latestEpoch;
    }

    event CheckpointRegistered(
        uint64 indexed epoch,
        uint8 kind,
        bytes32 contentHash,
        uint64 blockFrom,
        uint64 blockTo,
        uint64 prevEpoch
    );
    event HeadMirrored(uint64 indexed epoch, bytes32 contentHash);
    event WriterChanged(address indexed writer);

    error NotOwner();
    error NotWriter();
    error BadEpoch();
    error BadHash();
    error BadRange();
    error BadKind();
    error BeaconEpochMismatch();

    address public owner;
    address public writer;
    uint64 public lastEpoch;
    Beacon private _beacon;
    mapping(uint64 => Checkpoint) private _checkpoints;

    constructor(address initialWriter) {
        owner = msg.sender;
        writer = initialWriter;
        emit WriterChanged(initialWriter);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyWriter() {
        if (msg.sender != writer) revert NotWriter();
        _;
    }

    /// @notice Register a checkpoint. Called in the SAME tx that carries the blobs.
    function registerCheckpoint(Checkpoint calldata cp, Beacon calldata b) external onlyWriter {
        if (cp.epoch != lastEpoch + 1) revert BadEpoch();
        if (cp.prevEpoch >= cp.epoch) revert BadEpoch(); // chain must walk strictly backward
        if (cp.blockTo < cp.blockFrom) revert BadRange();
        if (cp.kind > 1) revert BadKind();
        if (b.latestEpoch != cp.epoch) revert BeaconEpochMismatch();
        lastEpoch = cp.epoch;
        _checkpoints[cp.epoch] = cp;
        _beacon = b;
        emit CheckpointRegistered(cp.epoch, cp.kind, cp.contentHash, cp.blockFrom, cp.blockTo, cp.prevEpoch);
    }

    /// @notice Calldata redundancy mirror of the latest HEAD payload (DI-8).
    /// @dev Payload is not stored; it lives in this tx's calldata, retrievable by
    ///      tx hash forever (calldata never prunes, unlike blob sidecars).
    function mirrorHead(uint64 epoch, bytes32 contentHash, bytes calldata /*payload*/ )
        external
        onlyWriter
    {
        if (epoch != lastEpoch) revert BadEpoch();
        if (_checkpoints[epoch].contentHash != contentHash) revert BadHash();
        emit HeadMirrored(epoch, contentHash);
    }

    function setWriter(address w) external onlyOwner {
        writer = w;
        emit WriterChanged(w);
    }

    function latestEpoch() external view returns (uint64) {
        return lastEpoch;
    }

    function checkpoints(uint64 epoch) external view returns (Checkpoint memory) {
        return _checkpoints[epoch];
    }

    function beacon() external view returns (Beacon memory) {
        return _beacon;
    }
}
