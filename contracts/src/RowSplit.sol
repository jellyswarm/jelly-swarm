// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {
    ICheckerBond,
    ICheckerNet,
    IFeeRouter,
    IHaltSwitch,
    IJellyJob,
    IJobHook,
    IReceiptRoot,
    IRowSplit
} from "./Interfaces.sol";
import {RefundPay} from "./RefundPay.sol";

/// @title RowSplit
/// @notice Row-level pay-on-pass (§3.3). Each row of a job is its own payment slot.
///         This contract is the provider, evaluator and hook of every job it opens:
///
///           openJob     quoter fixes the row count, unit, base and tools cap
///           settle      keeper submits the checker's signed verdict; failed rows and
///                       unused tools are refunded at once; the rest is held
///           disputeRows the client challenges passed rows inside the dispute window
///           auditRows   the keeper sends rows to a checker panel
///           applyReversal a panel outcome refunds reversed rows and slashes the signer
///           finalize    after the window, anyone releases the held amount to the 80/10/5/5 split
///
///         Invariant: refunded + held + finalized == budget, at every step.
/// @dev    Not audited.
contract RowSplit is IRowSplit, IJobHook, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Rows {
        uint32 rowCount;
        uint64 unitUsd6;
        uint64 baseUsd6;
        uint64 toolsCapUsd6;
        /// Operator that ran the workers. The verdict signer must be a different operator.
        uint64 workerOperatorId;
    }

    struct Verdict {
        bytes32 jobKey;
        uint32 rowCount;
        uint32 passedCount;
        bytes32 rowsRoot;
        bytes32 receiptsRoot;
        uint64 toolsUsd6;
    }

    struct State {
        bool settled;
        bool finalized;
        uint16 openRounds;
        uint32 passedCount;
        /// Passed rows later reversed at 100%.
        uint32 fullyReversed;
        uint64 releaseAt;
        /// Dispute window, fixed when the job is opened.
        uint64 window;
        address signer;
        bytes32 rowsRoot;
        /// Row and base money still held for the split.
        uint256 heldGross;
        /// Tool spend billed to the client, held for the treasury.
        uint256 heldTools;
        uint256 refunded;
    }

    /// Rows being challenged, each with what is needed to prove it against the rows root.
    struct RowProofs {
        uint32[] rowIdx;
        uint64[] operatorIds;
        bytes32[] receiptsHashes;
        bytes32[][] proofs;
    }

    struct Round {
        uint256 jobId;
        address disputer;
        uint256 fee;
        bool closed;
    }

    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(bytes32 jobKey,uint32 rowCount,uint32 passedCount,bytes32 rowsRoot,bytes32 receiptsRoot,uint64 toolsUsd6)"
    );
    uint256 public constant MAX_DISPUTE_ROWS = 25;
    uint256 public constant MIN_DISPUTE_FEE = 500_000; // $0.50
    uint16 public constant DISPUTE_FEE_BPS = 100; // 1%
    uint16 public constant SIGNER_SLASH_BPS = 1000; // 10%
    uint64 public constant MAX_WINDOW = 7 days;

    IJellyJob public immutable jellyJob;
    IERC20 public immutable token;
    IReceiptRoot public immutable receiptRoot;
    ICheckerBond public immutable checkerBond;
    IFeeRouter public immutable feeRouter;
    IHaltSwitch public immutable haltSwitch;
    address public immutable timelock;

    ICheckerNet public checkerNet;
    address public quoter;
    address public keeper;
    address public treasury;
    /// Dispute window for jobs opened from now on.
    uint64 public disputeWindow = 24 hours;
    uint16 public disputeFeeMultiplier = 1;

    mapping(uint256 => Rows) private _rows;
    mapping(uint256 => State) private _state;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(uint32 => bool)) public rowReversed;
    mapping(uint256 => mapping(uint32 => bool)) public rowInRound;

    event JobOpened(uint256 indexed jobId, bytes32 indexed jobKey, uint32 rowCount, uint64 unitUsd6, uint256 budget);
    event Settled(uint256 indexed jobId, uint32 passed, uint256 refunded, uint256 heldGross, uint64 releaseAt);
    event RoundOpened(uint256 indexed jobId, uint256 indexed roundId, bool dispute, uint32[] rowIdx, uint256 fee);
    event RowsReversed(uint256 indexed jobId, uint32[] rowIdx, uint256 refunded, address slashedSigner);
    event Finalized(uint256 indexed jobId, uint256 gross, uint256 tools);
    event RoleChanged(bytes32 indexed role, address account);
    event WindowChanged(uint64 window);

    error Halted();
    error NotAllowed();
    error BadRows();
    error BadVerdict();
    error BadSigner();
    error NotSealed();
    error BadState();
    error WindowClosed();
    error WindowOpen();
    error RoundsOpen();
    error BadProof();
    error RowUnavailable();

    constructor(
        IJellyJob jellyJob_,
        IReceiptRoot receiptRoot_,
        ICheckerBond checkerBond_,
        IFeeRouter feeRouter_,
        IHaltSwitch haltSwitch_,
        address timelock_,
        address quoter_,
        address keeper_,
        address treasury_
    ) EIP712("JellySwarm RowSplit", "1") {
        jellyJob = jellyJob_;
        token = IERC20(jellyJob_.token());
        receiptRoot = receiptRoot_;
        checkerBond = checkerBond_;
        feeRouter = feeRouter_;
        haltSwitch = haltSwitch_;
        timelock = timelock_;
        quoter = quoter_;
        keeper = keeper_;
        treasury = treasury_;
    }

    // ───────────────────────── admin (timelocked) ─────────────────────────

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert NotAllowed();
        _;
    }

    function setCheckerNet(ICheckerNet net) external onlyTimelock {
        checkerNet = net;
        emit RoleChanged("checkerNet", address(net));
    }

    function setQuoter(address a) external onlyTimelock {
        quoter = a;
        emit RoleChanged("quoter", a);
    }

    function setKeeper(address a) external onlyTimelock {
        keeper = a;
        emit RoleChanged("keeper", a);
    }

    function setTreasury(address a) external onlyTimelock {
        treasury = a;
        emit RoleChanged("treasury", a);
    }

    /// Applies to jobs opened afterwards; a job keeps the window it was opened with.
    function setDisputeWindow(uint64 window, uint16 feeMultiplier) external onlyTimelock {
        if (window == 0 || window > MAX_WINDOW || feeMultiplier == 0) revert BadRows();
        disputeWindow = window;
        disputeFeeMultiplier = feeMultiplier;
        emit WindowChanged(window);
    }

    // ───────────────────────── views ─────────────────────────

    function jobKeyOf(uint256 jobId) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(jellyJob), jobId));
    }

    function jobOf(uint256 jobId) external view returns (Rows memory, State memory) {
        return (_rows[jobId], _state[jobId]);
    }

    function budgetOf(Rows memory r) public pure returns (uint256) {
        return uint256(r.baseUsd6) + uint256(r.rowCount) * r.unitUsd6 + r.toolsCapUsd6;
    }

    function rowLeaf(bytes32 jobKey, uint32 rowIdx, bool passed, uint64 operatorId, uint64 unitUsd6, bytes32 receiptsHash)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(jobKey, rowIdx, passed, operatorId, unitUsd6, receiptsHash));
    }

    function verdictDigest(Verdict calldata v) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(VERDICT_TYPEHASH, v.jobKey, v.rowCount, v.passedCount, v.rowsRoot, v.receiptsRoot, v.toolsUsd6)
            )
        );
    }

    // ───────────────────────── open ─────────────────────────

    /// Creates the escrow job and registers its rows in one step. Quoter key only.
    /// The job's budget is exactly base + rowCount × unit + toolsCap.
    function openJob(Rows calldata r, uint64 expiredAt, string calldata description) external returns (uint256 jobId) {
        if (msg.sender != quoter) revert NotAllowed();
        if (haltSwitch.halted()) revert Halted();
        if (r.rowCount == 0 || r.unitUsd6 == 0) revert BadRows();
        jobId = jellyJob.createJob(address(this), address(this), expiredAt, description, address(this));
        uint256 budget = budgetOf(r);
        jellyJob.setBudget(jobId, budget);
        _rows[jobId] = r;
        _state[jobId].window = disputeWindow;
        emit JobOpened(jobId, jobKeyOf(jobId), r.rowCount, r.unitUsd6, budget);
    }

    // ───────────────────────── settle ─────────────────────────

    /// Keeper submits the checker's verdict. Requirements:
    ///  - the signer holds an active checker bond and is a different operator from the workers;
    ///  - the job's receipts are sealed under the verdict's receiptsRoot;
    ///  - passed <= rowCount and tools <= toolsCap.
    /// Failed rows and unused tools are refunded now. If nothing passed, everything is.
    function settle(uint256 jobId, Verdict calldata v, bytes calldata checkerSig) external nonReentrant {
        if (msg.sender != keeper) revert NotAllowed();
        if (haltSwitch.halted()) revert Halted();
        Rows memory r = _rows[jobId];
        State storage s = _state[jobId];
        if (r.rowCount == 0 || s.settled) revert BadState();
        if (
            v.jobKey != jobKeyOf(jobId) || v.rowCount != r.rowCount || v.passedCount > r.rowCount
                || v.toolsUsd6 > r.toolsCapUsd6
        ) revert BadVerdict();

        address signer = ECDSA.recover(verdictDigest(v), checkerSig);
        (bool active, uint64 signerOperator) = checkerBond.isActive(signer);
        if (!active || signerOperator == r.workerOperatorId) revert BadSigner();

        (bytes32 sealedRoot, uint32 sealedCount,) = receiptRoot.headOf(v.jobKey);
        if (sealedCount == 0 || sealedRoot != v.receiptsRoot) revert NotSealed();

        uint256 budget = budgetOf(r);
        s.settled = true;
        s.signer = signer;
        s.passedCount = v.passedCount;
        s.rowsRoot = v.rowsRoot;

        if (v.passedCount == 0) {
            // Nothing passed: the escrow refunds the whole budget, base and tools included.
            s.finalized = true;
            s.refunded = budget;
            jellyJob.reject(jobId, v.rowsRoot, "");
            emit Settled(jobId, 0, budget, 0, 0);
            return;
        }

        jellyJob.submit(jobId, v.rowsRoot, "");
        jellyJob.complete(jobId, v.receiptsRoot, "");

        s.heldGross = uint256(v.passedCount) * r.unitUsd6 + r.baseUsd6;
        s.heldTools = v.toolsUsd6;
        uint256 refund = budget - s.heldGross - s.heldTools;
        s.refunded = refund;
        s.releaseAt = uint64(block.timestamp) + s.window;
        _refund(jobId, refund);
        emit Settled(jobId, v.passedCount, refund, s.heldGross, s.releaseAt);
    }

    // ───────────────────────── disputes and audits ─────────────────────────

    /// The client challenges up to 25 passed rows before the window closes, paying one fee:
    /// max($0.50, 1%) × multiplier on the amount at stake. The fee is returned if any row is reversed.
    function disputeRows(uint256 jobId, RowProofs calldata p) external nonReentrant returns (uint256 roundId) {
        if (msg.sender != jellyJob.jobOf(jobId).client) revert NotAllowed();
        if (p.rowIdx.length > MAX_DISPUTE_ROWS) revert BadRows();
        _challenge(jobId, p);

        uint256 fee = (p.rowIdx.length * _rows[jobId].unitUsd6 * DISPUTE_FEE_BPS) / 10_000;
        if (fee < MIN_DISPUTE_FEE) fee = MIN_DISPUTE_FEE;
        fee *= disputeFeeMultiplier;
        token.safeTransferFrom(msg.sender, address(this), fee);
        roundId = _openRound(jobId, p.rowIdx, ICheckerNet.Kind.Dispute, msg.sender, fee);
    }

    /// The keeper sends passed rows of a settled job to a checker panel
    /// (5% of jobs, and every job of $50 or more).
    function auditRows(uint256 jobId, RowProofs calldata p) external nonReentrant returns (uint256 roundId) {
        if (msg.sender != keeper) revert NotAllowed();
        _challenge(jobId, p);
        roundId = _openRound(jobId, p.rowIdx, ICheckerNet.Kind.Audit, address(0), 0);
    }

    /// Checks the window is open, proves each row against the verdict's rows root as a
    /// passed row, and reserves the rows for one round.
    function _challenge(uint256 jobId, RowProofs calldata p) private {
        uint256 n = p.rowIdx.length;
        if (n == 0 || p.operatorIds.length != n || p.receiptsHashes.length != n || p.proofs.length != n) revert BadRows();
        State storage s = _state[jobId];
        if (!s.settled || s.finalized) revert BadState();
        if (block.timestamp >= s.releaseAt) revert WindowClosed();

        bytes32 jobKey = jobKeyOf(jobId);
        uint64 unit = _rows[jobId].unitUsd6;
        for (uint256 i; i < n; ++i) {
            uint32 idx = p.rowIdx[i];
            bytes32 leaf = rowLeaf(jobKey, idx, true, p.operatorIds[i], unit, p.receiptsHashes[i]);
            if (!MerkleProof.verifyCalldata(p.proofs[i], s.rowsRoot, leaf)) revert BadProof();
            // A row can be in one round at a time and cannot be challenged again once reversed.
            if (rowReversed[jobId][idx] || rowInRound[jobId][idx]) revert RowUnavailable();
            rowInRound[jobId][idx] = true;
        }
    }

    function _openRound(uint256 jobId, uint32[] calldata rowIdx, ICheckerNet.Kind kind, address disputer, uint256 fee)
        private
        returns (uint256 roundId)
    {
        roundId = checkerNet.openRound(jobId, rowIdx, kind);
        rounds[roundId] = Round({jobId: jobId, disputer: disputer, fee: fee, closed: false});
        _state[jobId].openRounds += 1;
        emit RoundOpened(jobId, roundId, kind == ICheckerNet.Kind.Dispute, rowIdx, fee);
    }

    /// Panel outcome. For each row, `refundBps` is 0 (verdict upheld) or a step of the
    /// refund curve (10000 / 7500 / 3500). A reversed row refunds unit × bps, rounded up in
    /// the client's favour, and the verdict signer's bond is slashed 10%. If every passed
    /// row ends up fully reversed, the base and billed tools are refunded too.
    function applyReversal(uint256 jobId, uint256 roundId, uint32[] calldata rowIdx, uint16[] calldata refundBps)
        external
        nonReentrant
    {
        if (msg.sender != address(checkerNet)) revert NotAllowed();
        Round storage round = rounds[roundId];
        State storage s = _state[jobId];
        if (round.jobId != jobId || round.closed || s.finalized || rowIdx.length != refundBps.length) revert BadState();
        round.closed = true;
        s.openRounds -= 1;

        uint256 unit = _rows[jobId].unitUsd6;
        uint256 refund;
        bool reversedAny;
        for (uint256 i; i < rowIdx.length; ++i) {
            uint32 idx = rowIdx[i];
            if (!rowInRound[jobId][idx]) revert RowUnavailable();
            rowInRound[jobId][idx] = false;
            uint16 bps = refundBps[i];
            if (bps == 0) continue;
            if (bps > 10_000) revert BadRows();
            rowReversed[jobId][idx] = true;
            reversedAny = true;
            refund += (unit * bps + 9_999) / 10_000;
            if (bps == 10_000) s.fullyReversed += 1;
        }

        if (reversedAny) {
            if (s.fullyReversed >= s.passedCount) {
                // No row survived: base and tools go back as well.
                refund = s.heldGross + s.heldTools;
                s.heldTools = 0;
            } else if (refund > s.heldGross) {
                refund = s.heldGross;
            }
            s.heldGross = refund > s.heldGross ? 0 : s.heldGross - refund;
            s.refunded += refund;
            _refund(jobId, refund);
            checkerBond.slash(s.signer, SIGNER_SLASH_BPS, jobId);
            emit RowsReversed(jobId, rowIdx, refund, s.signer);
        }

        // Dispute fee: back to the client if they were right, otherwise to the treasury (panel pay).
        if (round.fee != 0) {
            token.safeTransfer(reversedAny ? round.disputer : treasury, round.fee);
        }
    }

    // ───────────────────────── finalize ─────────────────────────

    /// After the dispute window, with no round open, anyone releases the held amount:
    /// rows and base to the 80/10/5/5 split, billed tools to the treasury.
    /// Deliberately not gated by the halt switch.
    function finalize(uint256 jobId) external nonReentrant {
        State storage s = _state[jobId];
        if (!s.settled || s.finalized) revert BadState();
        if (block.timestamp < s.releaseAt) revert WindowOpen();
        if (s.openRounds != 0) revert RoundsOpen();
        s.finalized = true;

        uint256 gross = s.heldGross;
        uint256 tools = s.heldTools;
        s.heldGross = 0;
        s.heldTools = 0;
        if (gross != 0) {
            token.forceApprove(address(feeRouter), gross);
            feeRouter.route(jobKeyOf(jobId), gross);
        }
        if (tools != 0) token.safeTransfer(treasury, tools);
        emit Finalized(jobId, gross, tools);
    }

    // ───────────────────────── hook ─────────────────────────

    /// A job opened here can only be funded once its rows are registered and its budget matches them.
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata) external view {
        if (msg.sender != address(jellyJob)) revert NotAllowed();
        if (selector == IJellyJob.fund.selector || selector == IJellyJob.fundFor.selector) {
            Rows memory r = _rows[jobId];
            if (r.rowCount == 0 || jellyJob.jobOf(jobId).budget != budgetOf(r)) revert BadRows();
        }
    }

    function afterAction(uint256, bytes4, bytes calldata) external view {
        if (msg.sender != address(jellyJob)) revert NotAllowed();
    }

    function _refund(uint256 jobId, uint256 amount) private {
        IJellyJob.Job memory j = jellyJob.jobOf(jobId);
        RefundPay.pay(token, jellyJob.vault(), j.client, j.refundTo, amount);
    }
}
