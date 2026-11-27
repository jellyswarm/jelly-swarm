// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Holds USDC job payments and releases them only under a treasury-signed
/// settlement decision. Anyone may submit a settlement and pays their own gas.
contract JellySwarmEscrow {
    struct Job {
        address client;
        uint128 amount;
        uint8 status;
    }

    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant NAME_HASH = keccak256("JellySwarmEscrow");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant DECISION_TYPEHASH = keccak256(
        "SettlementDecision(bytes32 jobId,uint16 clientShareBps,uint256 nonce,uint256 deadline)"
    );
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable usdc;
    address public immutable treasurySigner;
    mapping(bytes32 jobId => Job) public jobs;
    mapping(bytes32 jobId => uint256) public decisionNonces;

    error InvalidAddress();
    error InvalidAmount();
    error InvalidJob();
    error JobAlreadyFunded();
    error JobNotFunded();
    error InvalidShare();
    error ExpiredDecision();
    error InvalidSignature();
    error TokenTransferFailed();
    error UnsupportedTokenBehavior();

    event JobFunded(bytes32 indexed jobId, address indexed client, uint256 amount);
    event JobSettled(
        bytes32 indexed jobId,
        address indexed client,
        uint256 clientAmount,
        uint256 treasuryAmount,
        uint16 clientShareBps,
        uint256 nonce
    );

    constructor(address usdc_, address treasurySigner_) {
        if (usdc_ == address(0) || treasurySigner_ == address(0)) revert InvalidAddress();
        if (usdc_.code.length == 0) revert InvalidAddress();
        usdc = usdc_;
        treasurySigner = treasurySigner_;
    }

    /// @notice Deposit the exact quoted USDC amount for a unique job.
    /// The client must approve this contract before calling.
    function fundJob(bytes32 jobId, uint128 amount) external {
        if (jobId == bytes32(0)) revert InvalidJob();
        if (amount == 0) revert InvalidAmount();
        if (jobs[jobId].status != 0) revert JobAlreadyFunded();

        uint256 beforeBalance = _balanceOf(address(this));
        _safeTransferFrom(msg.sender, address(this), amount);
        if (_balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedTokenBehavior();

        jobs[jobId] = Job({client: msg.sender, amount: amount, status: 1});
        emit JobFunded(jobId, msg.sender, amount);
    }

    /// @notice Settle a funded job with the treasury's EIP-712 decision.
    /// Supported client shares: 100% (full refund), 50%, 70%, or 0% (full
    /// platform settlement). The 0% decision covers successful completion.
    /// A decision is bound to this contract, chain, job, nonce, share and deadline.
    function settleJob(
        bytes32 jobId,
        uint16 clientShareBps,
        uint256 deadline,
        bytes calldata signature
    ) external {
        Job storage job = jobs[jobId];
        if (job.status != 1) revert JobNotFunded();
        if (
            clientShareBps != 0 && clientShareBps != 5_000 && clientShareBps != 7_000
                && clientShareBps != 10_000
        ) revert InvalidShare();
        if (block.timestamp > deadline) revert ExpiredDecision();

        uint256 nonce = decisionNonces[jobId];
        bytes32 structHash = keccak256(
            abi.encode(DECISION_TYPEHASH, jobId, clientShareBps, nonce, deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        if (_recover(digest, signature) != treasurySigner) revert InvalidSignature();

        // Mark settled before external token calls so the decision cannot replay.
        job.status = 2;
        decisionNonces[jobId] = nonce + 1;

        uint256 clientAmount = (uint256(job.amount) * clientShareBps) / 10_000;
        uint256 treasuryAmount = uint256(job.amount) - clientAmount;
        if (clientAmount != 0) _safeTransfer(job.client, clientAmount);
        if (treasuryAmount != 0) _safeTransfer(treasurySigner, treasuryAmount);

        emit JobSettled(jobId, job.client, clientAmount, treasuryAmount, clientShareBps, nonce);
    }

    function decisionDigest(
        bytes32 jobId,
        uint16 clientShareBps,
        uint256 nonce,
        uint256 deadline
    ) external view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(DECISION_TYPEHASH, jobId, clientShareBps, nonce, deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_ORDER || (v != 27 && v != 28)) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }

    function _balanceOf(address account) private view returns (uint256 balance) {
        (bool success, bytes memory result) = usdc.staticcall(
            abi.encodeWithSelector(bytes4(0x70a08231), account)
        );
        if (!success || result.length != 32) revert TokenTransferFailed();
        balance = abi.decode(result, (uint256));
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool success, bytes memory result) = usdc.call(
            abi.encodeWithSelector(bytes4(0xa9059cbb), to, amount)
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TokenTransferFailed();
        }
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool success, bytes memory result) = usdc.call(
            abi.encodeWithSelector(bytes4(0x23b872dd), from, to, amount)
        );
        if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
            revert TokenTransferFailed();
        }
    }
}
