// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {JellySwarmCore} from "../src/JellySwarmCore.sol";

contract JellySwarmCoreTest {
    function testConstructorRecordsDeployer() public {
        JellySwarmCore core = new JellySwarmCore();
        require(core.deployer() == address(this), "wrong deployer");
    }
}
