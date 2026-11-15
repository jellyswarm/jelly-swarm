// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICheckerBond, ICheckerNet, IRowSplit} from "./Interfaces.sol";

/// @title CheckerBond
/// @notice The bond a verdict signer posts (§6.1). A reversed verdict slashes it.
///         Exits and withdrawals are never pausable.
contract CheckerBond is ICheckerBond {
    using SafeERC20 for IERC20;

    struct Bond {
        uint128 usdc;
        uint128 token;
        uint64 operatorId;
        /// Non-zero once the signer has asked to leave; withdrawable from this time.
        uint64 exitAt;
    }

    uint64 public constant EXIT_COOLDOWN = 7 days;

    IERC20 public immutable usdc;
    IERC20 public immutable productToken;
    address public immutable timelock;
    address public rowSplit;
    address public treasury;
    uint128 public minUsdc;
    mapping(address => Bond) public bonds;

    event OperatorAssigned(address indexed signer, uint64 operatorId);
    event Bonded(address indexed signer, uint256 usdcAmt, uint256 tokenAmt);
    event Slashed(address indexed signer, uint16 bps, uint256 indexed jobId, uint256 usdcCut, uint256 tokenCut);
    event ExitRequested(address indexed signer, uint64 exitAt);
    event Withdrawn(address indexed signer, uint256 usdcAmt, uint256 tokenAmt);

    error NotAllowed();
    error NoOperator();
    error Exiting();
    error NotExiting();
    error TooEarly();

    constructor(IERC20 usdc_, IERC20 productToken_, address timelock_, address treasury_, uint128 minUsdc_) {
        usdc = usdc_;
        productToken = productToken_;
        timelock = timelock_;
        treasury = treasury_;
        minUsdc = minUsdc_;
    }

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert NotAllowed();
        _;
    }

    function setRowSplit(address a) external onlyTimelock {
        rowSplit = a;
    }

    function setTreasury(address a) external onlyTimelock {
        treasury = a;
    }

    function setMinUsdc(uint128 v) external onlyTimelock {
        minUsdc = v;
    }

    /// The operator id is assigned by governance, never chosen by the signer: the
    /// settlement check "checker operator != worker operator" depends on it.
    function assignOperator(address signer, uint64 operatorId) external onlyTimelock {
        bonds[signer].operatorId = operatorId;
        emit OperatorAssigned(signer, operatorId);
    }

    function bond(uint256 usdcAmt, uint256 tokenAmt) external {
        Bond storage b = bonds[msg.sender];
        if (b.operatorId == 0) revert NoOperator();
        if (b.exitAt != 0) revert Exiting();
        b.usdc += uint128(usdcAmt);
        b.token += uint128(tokenAmt);
        if (usdcAmt != 0) usdc.safeTransferFrom(msg.sender, address(this), usdcAmt);
        if (tokenAmt != 0) productToken.safeTransferFrom(msg.sender, address(this), tokenAmt);
        emit Bonded(msg.sender, usdcAmt, tokenAmt);
    }

    function isActive(address signer) external view returns (bool active, uint64 operatorId) {
        Bond storage b = bonds[signer];
        return (b.operatorId != 0 && b.exitAt == 0 && b.usdc >= minUsdc, b.operatorId);
    }

    /// Called by RowSplit when a panel reverses a verdict. Still applies during an exit cooldown.
    function slash(address signer, uint16 bps, uint256 jobId) external {
        if (msg.sender != rowSplit) revert NotAllowed();
        Bond storage b = bonds[signer];
        uint128 usdcCut = uint128((uint256(b.usdc) * bps) / 10_000);
        uint128 tokenCut = uint128((uint256(b.token) * bps) / 10_000);
        b.usdc -= usdcCut;
        b.token -= tokenCut;
        if (usdcCut != 0) usdc.safeTransfer(treasury, usdcCut);
        if (tokenCut != 0) productToken.safeTransfer(treasury, tokenCut);
        emit Slashed(signer, bps, jobId, usdcCut, tokenCut);
    }

    function requestExit() external {
        Bond storage b = bonds[msg.sender];
        if (b.exitAt != 0) revert Exiting();
        b.exitAt = uint64(block.timestamp) + EXIT_COOLDOWN;
        emit ExitRequested(msg.sender, b.exitAt);
    }

    function withdraw() external {
        Bond storage b = bonds[msg.sender];
        if (b.exitAt == 0) revert NotExiting();
        if (block.timestamp < b.exitAt) revert TooEarly();
        (uint128 u, uint128 t) = (b.usdc, b.token);
        b.usdc = 0;
        b.token = 0;
        if (u != 0) usdc.safeTransfer(msg.sender, u);
        if (t != 0) productToken.safeTransfer(msg.sender, t);
        emit Withdrawn(msg.sender, u, t);
    }
}

/// @notice §3.3 refund curve for a reversed row, by step: 100% / 75% / 35% / 0%.
library RefundCurve {
    uint8 internal constant UPHELD = 3;

    function bpsAt(uint8 step) internal pure returns (uint16) {
        if (step == 0) return 10_000;
        if (step == 1) return 7_500;
        if (step == 2) return 3_500;
        return 0;
    }
}

/// @title CheckerNet
/// @notice Checker panels for audit and dispute rounds (§3.3 step 8). Checkers stake the
///         product token to sit on panels. Each round draws a panel of 3, each panelist
///         votes a refund-curve step per row, and the median decides.
/// @dev    A first version written from the build doc's one-line description. Panel
///         selection uses block randomness, which a block producer can bias; panelists who
///         vote against the outcome are not penalised. Both need a proper design and an
///         audit before real funds depend on a panel. Unstaking is never pausable.
contract CheckerNet is ICheckerNet {
    using SafeERC20 for IERC20;

    struct RoundData {
        uint256 jobId;
        uint64 deadline;
        bool resolved;
        uint8 votesCast;
        address[3] panel;
        uint32[] rowIdx;
    }

    uint256 public constant PANEL_SIZE = 3;
    uint64 public constant VOTE_PERIOD = 24 hours;
    uint64 public constant UNSTAKE_COOLDOWN = 7 days;

    IERC20 public immutable productToken;
    IRowSplit public immutable rowSplit;
    address public immutable timelock;
    uint256 public minStake;

    address[] public checkers;
    mapping(address => uint256) public stakeOf;
    mapping(address => bool) public listed;
    mapping(address => uint256) public unstaking;
    mapping(address => uint64) public unstakeAt;

    uint256 public roundCount;
    mapping(uint256 => RoundData) private _rounds;
    /// roundId => panelist => per-row step (stored +1 so 0 means "no vote").
    mapping(uint256 => mapping(address => uint8[])) private _votes;

    event Staked(address indexed checker, uint256 amount);
    event UnstakeRequested(address indexed checker, uint256 amount, uint64 at);
    event Unstaked(address indexed checker, uint256 amount);
    event RoundOpened(uint256 indexed roundId, uint256 indexed jobId, Kind kind, address[3] panel);
    event Voted(uint256 indexed roundId, address indexed panelist);
    event RoundResolved(uint256 indexed roundId, uint16[] refundBps);

    error NotAllowed();
    error NotEnoughCheckers();
    error NotPanelist();
    error AlreadyVoted();
    error BadVote();
    error NotReady();
    error TooEarly();

    constructor(IERC20 productToken_, IRowSplit rowSplit_, address timelock_, uint256 minStake_) {
        productToken = productToken_;
        rowSplit = rowSplit_;
        timelock = timelock_;
        minStake = minStake_;
    }

    function setMinStake(uint256 v) external {
        if (msg.sender != timelock) revert NotAllowed();
        minStake = v;
    }

    // ───────────────────────── stake ─────────────────────────

    function stake(uint256 amount) external {
        stakeOf[msg.sender] += amount;
        if (!listed[msg.sender]) {
            listed[msg.sender] = true;
            checkers.push(msg.sender);
        }
        productToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function requestUnstake(uint256 amount) external {
        stakeOf[msg.sender] -= amount;
        unstaking[msg.sender] += amount;
        unstakeAt[msg.sender] = uint64(block.timestamp) + UNSTAKE_COOLDOWN;
        emit UnstakeRequested(msg.sender, amount, unstakeAt[msg.sender]);
    }

    /// Never pausable.
    function withdrawUnstaked() external {
        if (block.timestamp < unstakeAt[msg.sender]) revert TooEarly();
        uint256 amount = unstaking[msg.sender];
        unstaking[msg.sender] = 0;
        productToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    // ───────────────────────── rounds ─────────────────────────

    function openRound(uint256 jobId, uint32[] calldata rowIdx, Kind kind) external returns (uint256 roundId) {
        if (msg.sender != address(rowSplit)) revert NotAllowed();
        roundId = ++roundCount;
        RoundData storage r = _rounds[roundId];
        r.jobId = jobId;
        r.deadline = uint64(block.timestamp) + VOTE_PERIOD;
        r.rowIdx = rowIdx;
        r.panel = _drawPanel(roundId);
        emit RoundOpened(roundId, jobId, kind, r.panel);
    }

    function _drawPanel(uint256 roundId) private view returns (address[3] memory panel) {
        uint256 n = checkers.length;
        uint256 seed = uint256(keccak256(abi.encode(block.prevrandao, roundId, n)));
        uint256 found;
        for (uint256 i; i < n && found < PANEL_SIZE; ++i) {
            address c = checkers[(seed + i) % n];
            if (stakeOf[c] >= minStake && stakeOf[c] != 0) panel[found++] = c;
        }
        if (found < PANEL_SIZE) revert NotEnoughCheckers();
    }

    function roundOf(uint256 roundId) external view returns (RoundData memory) {
        return _rounds[roundId];
    }

    /// One step per row: 0 = reverse at 100%, 1 = 75%, 2 = 35%, 3 = uphold the verdict.
    function vote(uint256 roundId, uint8[] calldata steps) external {
        RoundData storage r = _rounds[roundId];
        if (r.resolved || block.timestamp >= r.deadline) revert NotReady();
        if (msg.sender != r.panel[0] && msg.sender != r.panel[1] && msg.sender != r.panel[2]) revert NotPanelist();
        if (_votes[roundId][msg.sender].length != 0) revert AlreadyVoted();
        if (steps.length != r.rowIdx.length) revert BadVote();
        uint8[] storage stored = _votes[roundId][msg.sender];
        for (uint256 i; i < steps.length; ++i) {
            if (steps[i] > RefundCurve.UPHELD) revert BadVote();
            stored.push(steps[i] + 1);
        }
        r.votesCast += 1;
        emit Voted(roundId, msg.sender);
    }

    /// Anyone may resolve once all three have voted, or after the deadline. With fewer than
    /// two votes the verdict stands, so a silent panel can never block a job's finalization.
    function resolve(uint256 roundId) external {
        RoundData storage r = _rounds[roundId];
        if (r.resolved) revert NotReady();
        if (r.votesCast < PANEL_SIZE && block.timestamp < r.deadline) revert NotReady();
        r.resolved = true;

        uint256 n = r.rowIdx.length;
        uint16[] memory refundBps = new uint16[](n);
        if (r.votesCast >= 2) {
            for (uint256 i; i < n; ++i) {
                refundBps[i] = RefundCurve.bpsAt(_decide(roundId, r.panel, i));
            }
        }
        rowSplit.applyReversal(r.jobId, roundId, r.rowIdx, refundBps);
        emit RoundResolved(roundId, refundBps);
    }

    /// Median of three votes; with two votes, the one that refunds less.
    function _decide(uint256 roundId, address[3] storage panel, uint256 row) private view returns (uint8) {
        uint8[3] memory v;
        uint256 count;
        for (uint256 p; p < PANEL_SIZE; ++p) {
            uint8[] storage votes = _votes[roundId][panel[p]];
            if (votes.length != 0) v[count++] = votes[row] - 1;
        }
        if (count == 2) return v[0] > v[1] ? v[0] : v[1];
        // sort three
        if (v[0] > v[1]) (v[0], v[1]) = (v[1], v[0]);
        if (v[1] > v[2]) (v[1], v[2]) = (v[2], v[1]);
        if (v[0] > v[1]) (v[0], v[1]) = (v[1], v[0]);
        return v[1];
    }
}
