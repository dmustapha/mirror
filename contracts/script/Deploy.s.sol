// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MirrorRegistry} from "../src/MirrorRegistry.sol";
import {DemoToken} from "../src/DemoToken.sol";
import {BeaconReader} from "../src/BeaconReader.sol";

/// Deploys MirrorRegistry with the deployer as writer, the BeaconReader
/// consumer (Scene 2's independent on-chain reader, E-2), plus the DemoToken
/// (pool creation itself happens ON camera via create-demo-pool.ts).
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        MirrorRegistry reg = new MirrorRegistry(vm.addr(pk));
        BeaconReader reader = new BeaconReader(address(reg));
        DemoToken token = new DemoToken();
        vm.stopBroadcast();
        console.log("MirrorRegistry:", address(reg));
        console.log("BeaconReader:", address(reader));
        console.log("DemoToken:", address(token));
        console.log("Deploy block (approx):", block.number);
        console.log("Set in .env: REGISTRY_ADDRESS + REGISTRY_DEPLOY_BLOCK (exact block: broadcast/*/run-latest.json) + DEMO_TOKEN_ADDRESS");
    }
}
