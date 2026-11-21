// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IHaltSwitch, IJellyJob, IJobHook} from "./Interfaces.sol";
import {RefundPay} from "./RefundPay.sol";

/// @title JellyJob
/// @notice Job escrow in the shape of ERC-8183: a client funds a job, a provider submits,
///         an evaluator completes or rejects it, and an unsettled job can be refunded by
///         anyone once it expires. One instance per chain.
/// @dev    Written from the build doc's description of ERC-8183; check it against the
///         final EIP text before relying on interface compatibility. Not audited.
contract JellyJob is IJellyJob, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// §3.3: a job expires at most 24 hours after it is created.
    uint64 public constant MAX_LIFETIME = 24 hours;

    IERC20 private immutable _token;
    IHaltSwitch public immutable haltSwitch;
    /// The prepaid vault. Refunds for vault-funded jobs are credited there.
    address private immutable _vault;

    uint256 public jobCount;
    mapping(uint256 => Job) private _jobs;

    event JobCreated(
        uint256 indexed jobId, address indexed client, address provider, address evaluator, uint64 expiredAt
    );
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, address refundTo, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, bytes32 reason, uint256 paid);
    event JobRejected(uint256 indexed jobId, bytes32 reason, uint256 refunded);
    event Refunded(uint256 indexed jobId, address indexed refundTo, uint256 amount);

    error Halted();
    error BadStatus();
    error NotAllowed();
    error BadExpiry();
    error BadBudget();
    error ZeroAddress();
    error NotExpired();
    error AlreadyExpired();

    constructor(IERC20 token_, IHaltSwitch haltSwitch_, address vault_) {
        _token = token_;
        haltSwitch = haltSwitch_;
        _vault = vault_;
    }

    modifier notHalted() {
        if (haltSwitch.halted()) revert Halted();
        _;
    }

    function token() external view returns (address) {
        return address(_token);
    }

    function vault() external view returns (address) {
        return _vault;
    }

    function jobOf(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function refundTo(uint256 jobId) external view returns (address) {
        return _jobs[jobId].refundTo;
    }

    // ───────────────────────── lifecycle ─────────────────────────

    function createJob(address provider, address evaluator, uint64 expiredAt, string calldata description, address hook)
        external
        notHalted
        returns (uint256 jobId)
    {
        if (evaluator == address(0)) revert ZeroAddress();
        if (expiredAt <= block.timestamp || expiredAt > block.timestamp + MAX_LIFETIME) revert BadExpiry();
        description; // carried in calldata for indexers; not stored
        jobId = ++jobCount;
        _jobs[jobId] = Job({
            client: msg.sender,
            refundTo: msg.sender,
            provider: provider,
            evaluator: evaluator,
            hook: hook,
            budget: 0,
            expiredAt: expiredAt,
            status: Status.Open
        });
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt);
    }

    function setBudget(uint256 jobId, uint256 amount) external {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Open) revert BadStatus();
        if (msg.sender != j.client && msg.sender != j.provider) revert NotAllowed();
        j.budget = amount;
        emit BudgetSet(jobId, amount);
    }

    /// The client funds their own job. `expectedBudget` guards against a budget changed in flight.
    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external nonReentrant notHalted {
        Job storage j = _jobs[jobId];
        if (msg.sender != j.client) revert NotAllowed();
        if (j.budget != expectedBudget) revert BadBudget();
        _fund(jobId, j, optParams, this.fund.selector);
    }

    /// Pulls the job's budget from msg.sender (a wallet, the vault, or an intake forwarder)
    /// on behalf of `client`. `refundTo` receives every refund for this job and is fixed here.
    function fundFor(uint256 jobId, address client, address refundTo_, bytes calldata optParams)
        external
        nonReentrant
        notHalted
    {
        if (client == address(0) || refundTo_ == address(0)) revert ZeroAddress();
        Job storage j = _jobs[jobId];
        j.client = client;
        j.refundTo = refundTo_;
        _fund(jobId, j, optParams, this.fundFor.selector);
    }

    function _fund(uint256 jobId, Job storage j, bytes calldata optParams, bytes4 selector) private {
        if (j.status != Status.Open) revert BadStatus();
        if (j.budget == 0) revert BadBudget();
        if (block.timestamp >= j.expiredAt) revert AlreadyExpired();
        _before(j.hook, jobId, selector, optParams);
        j.status = Status.Funded;
        _token.safeTransferFrom(msg.sender, address(this), j.budget);
        emit JobFunded(jobId, j.client, j.refundTo, j.budget);
        _after(j.hook, jobId, selector, optParams);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external notHalted {
        Job storage j = _jobs[jobId];
        if (msg.sender != j.provider) revert NotAllowed();
        if (j.status != Status.Funded) revert BadStatus();
        if (block.timestamp >= j.expiredAt) revert AlreadyExpired();
        _before(j.hook, jobId, this.submit.selector, optParams);
        j.status = Status.Submitted;
        emit JobSubmitted(jobId, deliverable);
        _after(j.hook, jobId, this.submit.selector, optParams);
    }

    /// The evaluator accepts the work: the whole budget goes to the provider.
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant notHalted {
        Job storage j = _jobs[jobId];
        if (msg.sender != j.evaluator) revert NotAllowed();
        if (j.status != Status.Submitted) revert BadStatus();
        if (block.timestamp >= j.expiredAt) revert AlreadyExpired();
        _before(j.hook, jobId, this.complete.selector, optParams);
        j.status = Status.Completed;
        uint256 amount = j.budget;
        _token.safeTransfer(j.provider, amount);
        emit JobCompleted(jobId, reason, amount);
        _after(j.hook, jobId, this.complete.selector, optParams);
    }

    /// The client cancels an unfunded job, or the evaluator rejects a funded one (full refund).
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        Job storage j = _jobs[jobId];
        uint256 amount;
        if (j.status == Status.Open) {
            if (msg.sender != j.client) revert NotAllowed();
        } else if (j.status == Status.Funded || j.status == Status.Submitted) {
            if (msg.sender != j.evaluator) revert NotAllowed();
            amount = j.budget;
        } else {
            revert BadStatus();
        }
        _before(j.hook, jobId, this.reject.selector, optParams);
        j.status = Status.Rejected;
        _refund(jobId, j, amount);
        emit JobRejected(jobId, reason, amount);
        _after(j.hook, jobId, this.reject.selector, optParams);
    }

    /// §0.3 Anyone may return a funded job's whole budget once it has expired unsettled.
    /// This function reads no halt flag, calls no hook and needs no keeper.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Funded && j.status != Status.Submitted) revert BadStatus();
        if (block.timestamp < j.expiredAt) revert NotExpired();
        j.status = Status.Expired;
        _refund(jobId, j, j.budget);
    }

    // ───────────────────────── internals ─────────────────────────

    function _refund(uint256 jobId, Job storage j, uint256 amount) private {
        if (amount == 0) return;
        RefundPay.pay(_token, _vault, j.client, j.refundTo, amount);
        emit Refunded(jobId, j.refundTo, amount);
    }

    function _before(address hook, uint256 jobId, bytes4 selector, bytes calldata data) private {
        if (hook != address(0)) IJobHook(hook).beforeAction(jobId, selector, data);
    }

    function _after(address hook, uint256 jobId, bytes4 selector, bytes calldata data) private {
        if (hook != address(0)) IJobHook(hook).afterAction(jobId, selector, data);
    }
}
