// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Shared interfaces between the JellySwarm contracts (§6.1).

interface IHaltSwitch {
    function halted() external view returns (bool);
}

/// Optional per-job hook on the escrow. claimRefund never calls it.
interface IJobHook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

interface IJellyJob {
    enum Status {
        None,
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        address client;
        address refundTo;
        address provider;
        address evaluator;
        address hook;
        uint256 budget;
        uint64 expiredAt;
        Status status;
    }

    function createJob(address provider, address evaluator, uint64 expiredAt, string calldata description, address hook)
        external
        returns (uint256 jobId);
    function setBudget(uint256 jobId, uint256 amount) external;
    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external;
    function fundFor(uint256 jobId, address client, address refundTo, bytes calldata optParams) external;
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function claimRefund(uint256 jobId) external;
    function jobOf(uint256 jobId) external view returns (Job memory);
    function refundTo(uint256 jobId) external view returns (address);
    function token() external view returns (address);
    function vault() external view returns (address);
}

interface IReceiptRoot {
    function seal(bytes32 jobKey, bytes32 root, uint32 count, bytes32 head) external;
    function verifyStep(bytes32 jobKey, bytes32 leaf, bytes32[] calldata proof) external view returns (bool);
    function headOf(bytes32 jobKey) external view returns (bytes32 root, uint32 count, bytes32 head);
}

interface IBalanceVault {
    function depositFor(address owner, uint256 amount) external;
}

interface IFeeRouter {
    /// Pulls `amount` from the caller and splits it 80/10/5/5.
    function route(bytes32 key, uint256 amount) external;
}

interface IBurnBucket {
    function accrue(bytes32 jobKey, uint256 amount) external;
}

interface ICheckerBond {
    function isActive(address signer) external view returns (bool active, uint64 operatorId);
    function slash(address signer, uint16 bps, uint256 jobId) external;
}

interface ICheckerNet {
    enum Kind {
        Audit,
        Dispute
    }

    function openRound(uint256 jobId, uint32[] calldata rowIdx, Kind kind) external returns (uint256 roundId);
}

interface IRowSplit {
    function applyReversal(uint256 jobId, uint256 roundId, uint32[] calldata rowIdx, uint16[] calldata refundBps)
        external;
}

interface IOperatorRegistry {
    function payoutOf(uint64 operatorId) external view returns (address);
}

/// Swaps a stablecoin for the product token and burns it. Chosen per chain on day 1.
interface IBurnSwapper {
    function swapAndBurn(uint256 stableIn, uint256 minOut, bytes calldata route) external returns (uint256 tokenBurned);
}
