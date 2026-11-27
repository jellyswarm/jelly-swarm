// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Temporary compile/deploy scaffold. Product contract behavior is intentionally undefined.
contract JellySwarmCore {
    address public immutable deployer;

    constructor() {
        deployer = msg.sender;
    }
}
