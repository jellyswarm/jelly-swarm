// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {JellySwarmCore} from "../src/JellySwarmCore.sol";

contract Deploy is Script {
    function run() external returns (JellySwarmCore core) {
        vm.startBroadcast();
        core = new JellySwarmCore();
        vm.stopBroadcast();
        console2.log("JellySwarmCore", address(core));
    }
}
