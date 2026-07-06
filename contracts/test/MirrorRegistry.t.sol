// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MirrorRegistry} from "../src/MirrorRegistry.sol";
import {BeaconReader} from "../src/BeaconReader.sol";

contract MirrorRegistryTest is Test {
    MirrorRegistry reg;
    address writer = address(0xBEEF);
    address stranger = address(0xBAD);

    function setUp() public {
        reg = new MirrorRegistry(writer);
    }

    function _cp(uint64 epoch, uint8 kind, uint64 from, uint64 to, uint64 prev)
        internal
        pure
        returns (MirrorRegistry.Checkpoint memory)
    {
        return MirrorRegistry.Checkpoint({
            epoch: epoch,
            kind: kind,
            blockFrom: from,
            blockTo: to,
            contentHash: keccak256(abi.encode(epoch, from, to)),
            prevEpoch: prev,
            rowCount: 100,
            blobCount: 1
        });
    }

    function _beacon(uint64 epoch) internal pure returns (MirrorRegistry.Beacon memory) {
        return MirrorRegistry.Beacon({
            priceUsdtE6: 9_710_000,
            volume24hUsdtE6: 1_600_000_000_000,
            swapCount24h: 9500,
            lastIndexedBlock: 15_000_000,
            latestEpoch: epoch
        });
    }

    function test_registerAndRead() public {
        vm.prank(writer);
        reg.registerCheckpoint(_cp(1, 0, 1_000_000, 2_000_000, 0), _beacon(1));
        assertEq(reg.latestEpoch(), 1);
        MirrorRegistry.Checkpoint memory got = reg.checkpoints(1);
        assertEq(got.blockTo, 2_000_000);
        assertEq(reg.beacon().priceUsdtE6, 9_710_000);
    }

    function test_epochMustBeSequential() public {
        vm.prank(writer);
        vm.expectRevert(MirrorRegistry.BadEpoch.selector);
        reg.registerCheckpoint(_cp(2, 0, 1, 2, 0), _beacon(2));
    }

    function test_onlyWriter() public {
        vm.prank(stranger);
        vm.expectRevert(MirrorRegistry.NotWriter.selector);
        reg.registerCheckpoint(_cp(1, 0, 1, 2, 0), _beacon(1));
    }

    function test_beaconEpochMustMatch() public {
        vm.prank(writer);
        vm.expectRevert(MirrorRegistry.BeaconEpochMismatch.selector);
        reg.registerCheckpoint(_cp(1, 0, 1, 2, 0), _beacon(9));
    }

    function test_chainWalk() public {
        vm.startPrank(writer);
        reg.registerCheckpoint(_cp(1, 0, 1_000_000, 2_000_000, 0), _beacon(1));
        reg.registerCheckpoint(_cp(2, 0, 2_000_001, 3_000_000, 1), _beacon(2));
        reg.registerCheckpoint(_cp(3, 1, 3_000_001, 3_000_400, 2), _beacon(3));
        vm.stopPrank();
        // walk: latest HEAD -> prev SEGMENT -> prev SEGMENT -> 0 (genesis)
        MirrorRegistry.Checkpoint memory head = reg.checkpoints(reg.latestEpoch());
        assertEq(head.kind, 1);
        MirrorRegistry.Checkpoint memory s2 = reg.checkpoints(head.prevEpoch);
        assertEq(s2.kind, 0);
        assertEq(reg.checkpoints(s2.prevEpoch).prevEpoch, 0);
    }

    function test_mirrorHead() public {
        vm.startPrank(writer);
        MirrorRegistry.Checkpoint memory cp = _cp(1, 1, 1, 400, 0);
        reg.registerCheckpoint(cp, _beacon(1));
        reg.mirrorHead(1, cp.contentHash, hex"deadbeef");
        vm.expectRevert(MirrorRegistry.BadHash.selector);
        reg.mirrorHead(1, bytes32(uint256(1)), hex"");
        vm.stopPrank();
    }

    function test_beaconReaderConsumesLiveBeacon() public {
        vm.prank(writer);
        reg.registerCheckpoint(_cp(1, 1, 1, 400, 0), _beacon(1));
        BeaconReader reader = new BeaconReader(address(reg));
        (uint64 price, uint64 asOf, uint64 epoch) = reader.wbotPriceE6();
        assertEq(price, 9_710_000);
        assertEq(asOf, 15_000_000);
        assertEq(epoch, 1);
    }

    function test_setWriter() public {
        reg.setWriter(stranger);
        vm.prank(stranger);
        reg.registerCheckpoint(_cp(1, 0, 1, 2, 0), _beacon(1));
        vm.prank(writer);
        vm.expectRevert(MirrorRegistry.NotWriter.selector);
        reg.registerCheckpoint(_cp(2, 0, 3, 4, 1), _beacon(2));
    }
}
