// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AdminTimelock
/// @notice Every parameter change waits 48 hours between being queued and being executed (§6.1).
contract AdminTimelock {
    uint256 public constant DELAY = 48 hours;
    uint256 public constant GRACE = 14 days;

    address public admin;
    mapping(bytes32 => uint256) public etaOf;

    event Queued(bytes32 indexed id, address indexed target, uint256 value, bytes data, uint256 eta);
    event Executed(bytes32 indexed id);
    event Cancelled(bytes32 indexed id);
    event AdminChanged(address indexed admin);

    error NotAdmin();
    error NotQueued();
    error TooEarly();
    error Stale();
    error CallFailed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address admin_) {
        admin = admin_;
        emit AdminChanged(admin_);
    }

    function idOf(address target, uint256 value, bytes calldata data, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(target, value, data, salt));
    }

    function queue(address target, uint256 value, bytes calldata data, bytes32 salt)
        external
        onlyAdmin
        returns (bytes32 id)
    {
        id = idOf(target, value, data, salt);
        uint256 eta = block.timestamp + DELAY;
        etaOf[id] = eta;
        emit Queued(id, target, value, data, eta);
    }

    function cancel(bytes32 id) external onlyAdmin {
        delete etaOf[id];
        emit Cancelled(id);
    }

    function execute(address target, uint256 value, bytes calldata data, bytes32 salt)
        external
        payable
        onlyAdmin
        returns (bytes memory result)
    {
        bytes32 id = idOf(target, value, data, salt);
        uint256 eta = etaOf[id];
        if (eta == 0) revert NotQueued();
        if (block.timestamp < eta) revert TooEarly();
        if (block.timestamp > eta + GRACE) revert Stale();
        delete etaOf[id];
        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) revert CallFailed();
        emit Executed(id);
    }

    /// Changing the admin is itself a timelocked call to this contract.
    function setAdmin(address admin_) external {
        if (msg.sender != address(this)) revert NotAdmin();
        admin = admin_;
        emit AdminChanged(admin_);
    }
}

/// @title HaltSwitch
/// @notice The kill switch (§13). The guardian can halt at once but cannot resume;
///         resuming is a timelocked decision. A halt blocks new jobs, funding and
///         settlement. It never blocks refunds, withdrawals, finalize or payout claims:
///         those functions do not read this contract at all.
contract HaltSwitch {
    address public immutable timelock;
    address public guardian;
    bool public halted;

    event Halted(address indexed by);
    event Resumed();
    event GuardianChanged(address indexed guardian);

    error NotGuardian();
    error NotTimelock();

    constructor(address guardian_, address timelock_) {
        guardian = guardian_;
        timelock = timelock_;
        emit GuardianChanged(guardian_);
    }

    function halt() external {
        if (msg.sender != guardian) revert NotGuardian();
        halted = true;
        emit Halted(msg.sender);
    }

    function resume() external {
        if (msg.sender != timelock) revert NotTimelock();
        halted = false;
        emit Resumed();
    }

    function setGuardian(address guardian_) external {
        if (msg.sender != timelock) revert NotTimelock();
        guardian = guardian_;
        emit GuardianChanged(guardian_);
    }
}
