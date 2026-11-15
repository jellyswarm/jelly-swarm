// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IReceiptRoot} from "./Interfaces.sol";

/// @title ReceiptRoot
/// @notice Stores, once per job, the Merkle root over that job's call receipts (§4).
///         Anyone can then prove that a given receipt belongs to the job.
contract ReceiptRoot is IReceiptRoot {
    struct Seal {
        bytes32 root;
        uint32 count;
        bytes32 head;
    }

    address public immutable timelock;
    /// The receipt-service key.
    address public sealer;
    mapping(bytes32 => Seal) private _seals;

    event JobSealed(bytes32 indexed jobKey, bytes32 root, uint32 count, bytes32 head);
    event SealerChanged(address indexed sealer);

    error NotSealer();
    error NotTimelock();
    error AlreadySealed();
    error EmptySeal();

    constructor(address sealer_, address timelock_) {
        sealer = sealer_;
        timelock = timelock_;
        emit SealerChanged(sealer_);
    }

    function setSealer(address sealer_) external {
        if (msg.sender != timelock) revert NotTimelock();
        sealer = sealer_;
        emit SealerChanged(sealer_);
    }

    /// A job is sealed exactly once; a seal can never be replaced.
    function seal(bytes32 jobKey, bytes32 root, uint32 count, bytes32 head) external {
        if (msg.sender != sealer) revert NotSealer();
        if (count == 0 || root == bytes32(0)) revert EmptySeal();
        if (_seals[jobKey].count != 0) revert AlreadySealed();
        _seals[jobKey] = Seal(root, count, head);
        emit JobSealed(jobKey, root, count, head);
    }

    function verifyStep(bytes32 jobKey, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        Seal storage s = _seals[jobKey];
        return s.count != 0 && MerkleProof.verifyCalldata(proof, s.root, leaf);
    }

    function headOf(bytes32 jobKey) external view returns (bytes32 root, uint32 count, bytes32 head) {
        Seal storage s = _seals[jobKey];
        return (s.root, s.count, s.head);
    }
}
