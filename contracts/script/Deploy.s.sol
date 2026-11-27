// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {JellySwarmEscrow} from "../src/JellySwarmEscrow.sol";

contract Deploy is Script {
    function run() external returns (JellySwarmEscrow escrow) {
        uint256 escrowPrivateKey = vm.envUint("ESCROW_PRIVATE_KEY");
        address escrowPublicKey = vm.envAddress("ESCROW_PUBLIC_KEY");
        address treasury = vm.envAddress("TREASURY_PUBLIC_KEY");
        address usdc = vm.envAddress("ELYSIUM_USDC_ADDRESS");
        require(vm.addr(escrowPrivateKey) == escrowPublicKey, "escrow key mismatch");

        vm.startBroadcast(escrowPrivateKey);
        escrow = new JellySwarmEscrow(usdc, treasury);
        vm.stopBroadcast();
        console2.log("JellySwarmEscrow", address(escrow));
    }
}
