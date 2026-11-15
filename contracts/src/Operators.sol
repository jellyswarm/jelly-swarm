// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IOperatorRegistry} from "./Interfaces.sol";

/// @title OperatorRegistry
/// @notice Community compute operators (§5): stake to register, get slashed on a proven
///         mismatch, leave after a 7-day cooldown. Stake withdrawal is never pausable.
contract OperatorRegistry is IOperatorRegistry {
    using SafeERC20 for IERC20;

    enum Route {
        TEE,
        FINGERPRINT,
        STUDIO
    }

    enum Status {
        None,
        Active,
        Exiting,
        Removed
    }

    struct Operator {
        address owner;
        address payout;
        bytes32 endpointHash;
        Route route;
        Status status;
        uint8 strikes;
        uint64 exitAt;
        uint128 usdcStake;
        uint128 tokenStake;
    }

    uint64 public constant EXIT_COOLDOWN = 7 days;
    uint8 public constant STRIKES_TO_REMOVE = 3;

    IERC20 public immutable usdc;
    IERC20 public immutable productToken;
    address public immutable timelock;
    address public nodeAuditor;
    address public treasury;
    uint128 public minUsdcStake;
    uint128 public minTokenStake;
    mapping(uint64 => Operator) private _ops;

    event Registered(uint64 indexed operatorId, address indexed owner, address payout, Route route);
    event OperatorSlashed(uint64 indexed operatorId, uint16 bps, bytes32 evidenceHash, uint8 strikes, bool removed);
    event ExitRequested(uint64 indexed operatorId, uint64 exitAt);
    event StakeWithdrawn(uint64 indexed operatorId, uint256 usdcAmt, uint256 tokenAmt);
    event PayoutChanged(uint64 indexed operatorId, address payout);

    error NotAllowed();
    error Taken();
    error LowStake();
    error BadStatus();
    error TooEarly();
    error ZeroAddress();

    constructor(
        IERC20 usdc_,
        IERC20 productToken_,
        address timelock_,
        address nodeAuditor_,
        address treasury_,
        uint128 minUsdcStake_,
        uint128 minTokenStake_
    ) {
        usdc = usdc_;
        productToken = productToken_;
        timelock = timelock_;
        nodeAuditor = nodeAuditor_;
        treasury = treasury_;
        minUsdcStake = minUsdcStake_;
        minTokenStake = minTokenStake_;
    }

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert NotAllowed();
        _;
    }

    function setRoles(address nodeAuditor_, address treasury_) external onlyTimelock {
        nodeAuditor = nodeAuditor_;
        treasury = treasury_;
    }

    function setMinStakes(uint128 usdc_, uint128 token_) external onlyTimelock {
        minUsdcStake = usdc_;
        minTokenStake = token_;
    }

    /// Our own operator ids: no stake, and disclosed as studio-operated on /stats.
    function registerStudio(uint64 operatorId, address payout) external onlyTimelock {
        if (_ops[operatorId].status != Status.None) revert Taken();
        if (payout == address(0)) revert ZeroAddress();
        _ops[operatorId] = Operator(msg.sender, payout, bytes32(0), Route.STUDIO, Status.Active, 0, 0, 0, 0);
        emit Registered(operatorId, msg.sender, payout, Route.STUDIO);
    }

    function register(
        uint64 operatorId,
        address payout,
        bytes32 endpointHash,
        Route route,
        uint128 usdcStake,
        uint128 tokenStake
    ) external {
        if (operatorId == 0 || _ops[operatorId].status != Status.None) revert Taken();
        if (payout == address(0)) revert ZeroAddress();
        if (route == Route.STUDIO) revert NotAllowed();
        if (usdcStake < minUsdcStake || tokenStake < minTokenStake) revert LowStake();
        _ops[operatorId] =
            Operator(msg.sender, payout, endpointHash, route, Status.Active, 0, 0, usdcStake, tokenStake);
        if (usdcStake != 0) usdc.safeTransferFrom(msg.sender, address(this), usdcStake);
        if (tokenStake != 0) productToken.safeTransferFrom(msg.sender, address(this), tokenStake);
        emit Registered(operatorId, msg.sender, payout, route);
    }

    function operatorOf(uint64 operatorId) external view returns (Operator memory) {
        return _ops[operatorId];
    }

    function payoutOf(uint64 operatorId) external view returns (address) {
        return _ops[operatorId].payout;
    }

    function isActive(uint64 operatorId) external view returns (bool) {
        return _ops[operatorId].status == Status.Active;
    }

    function setPayout(uint64 operatorId, address payout) external {
        Operator storage o = _ops[operatorId];
        if (msg.sender != o.owner) revert NotAllowed();
        if (payout == address(0)) revert ZeroAddress();
        o.payout = payout;
        emit PayoutChanged(operatorId, payout);
    }

    /// Node-auditor key, with a published evidence bundle. Three strikes removes the operator.
    /// Slashing still applies while an operator is in its exit cooldown.
    function slash(uint64 operatorId, uint16 bps, bytes32 evidenceHash) external {
        if (msg.sender != nodeAuditor) revert NotAllowed();
        Operator storage o = _ops[operatorId];
        if (o.status != Status.Active && o.status != Status.Exiting) revert BadStatus();
        uint128 usdcCut = uint128((uint256(o.usdcStake) * bps) / 10_000);
        uint128 tokenCut = uint128((uint256(o.tokenStake) * bps) / 10_000);
        o.usdcStake -= usdcCut;
        o.tokenStake -= tokenCut;
        o.strikes += 1;
        bool removed = o.strikes >= STRIKES_TO_REMOVE;
        if (removed) {
            o.status = Status.Removed;
            o.exitAt = uint64(block.timestamp) + EXIT_COOLDOWN;
        }
        if (usdcCut != 0) usdc.safeTransfer(treasury, usdcCut);
        if (tokenCut != 0) productToken.safeTransfer(treasury, tokenCut);
        emit OperatorSlashed(operatorId, bps, evidenceHash, o.strikes, removed);
    }

    function requestExit(uint64 operatorId) external {
        Operator storage o = _ops[operatorId];
        if (msg.sender != o.owner) revert NotAllowed();
        if (o.status != Status.Active) revert BadStatus();
        o.status = Status.Exiting;
        o.exitAt = uint64(block.timestamp) + EXIT_COOLDOWN;
        emit ExitRequested(operatorId, o.exitAt);
    }

    /// Never pausable. A removed operator also gets its remaining stake back after the cooldown.
    function withdrawStake(uint64 operatorId) external {
        Operator storage o = _ops[operatorId];
        if (msg.sender != o.owner) revert NotAllowed();
        if (o.status != Status.Exiting && o.status != Status.Removed) revert BadStatus();
        if (block.timestamp < o.exitAt) revert TooEarly();
        (uint128 u, uint128 t) = (o.usdcStake, o.tokenStake);
        o.usdcStake = 0;
        o.tokenStake = 0;
        if (u != 0) usdc.safeTransfer(msg.sender, u);
        if (t != 0) productToken.safeTransfer(msg.sender, t);
        emit StakeWithdrawn(operatorId, u, t);
    }
}

/// @title OperatorPayouts
/// @notice Receives the 80% operator share and pays it out by daily Merkle root of
///         (epoch, operatorId, amount). Claims are permissionless, paid in the stablecoin
///         to the operator's registered payout address, and never pausable. No emissions.
contract OperatorPayouts {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    IOperatorRegistry public immutable registry;
    address public immutable timelock;
    address public keeper;

    mapping(uint32 => bytes32) public rootOf;
    mapping(uint32 => mapping(uint64 => bool)) public claimed;
    /// Posted to operators and not yet claimed.
    uint256 public owed;

    event EpochPosted(uint32 indexed epoch, bytes32 root, uint256 total);
    event Claimed(uint32 indexed epoch, uint64 indexed operatorId, address payout, uint256 amount);

    error NotAllowed();
    error AlreadyPosted();
    error Unfunded();
    error AlreadyClaimed();
    error BadProof();
    error NoPayout();

    constructor(IERC20 token_, IOperatorRegistry registry_, address timelock_, address keeper_) {
        token = token_;
        registry = registry_;
        timelock = timelock_;
        keeper = keeper_;
    }

    function setKeeper(address keeper_) external {
        if (msg.sender != timelock) revert NotAllowed();
        keeper = keeper_;
    }

    /// An epoch can only promise money this contract already holds and has not promised before.
    function postEpoch(uint32 epoch, bytes32 root, uint256 total) external {
        if (msg.sender != keeper) revert NotAllowed();
        if (rootOf[epoch] != bytes32(0) || root == bytes32(0)) revert AlreadyPosted();
        if (owed + total > token.balanceOf(address(this))) revert Unfunded();
        rootOf[epoch] = root;
        owed += total;
        emit EpochPosted(epoch, root, total);
    }

    function leafOf(uint32 epoch, uint64 operatorId, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(epoch, operatorId, amount))));
    }

    function claim(uint32 epoch, uint64 operatorId, uint256 amount, bytes32[] calldata proof) external {
        if (claimed[epoch][operatorId]) revert AlreadyClaimed();
        if (!MerkleProof.verifyCalldata(proof, rootOf[epoch], leafOf(epoch, operatorId, amount))) revert BadProof();
        address payout = registry.payoutOf(operatorId);
        if (payout == address(0)) revert NoPayout();
        claimed[epoch][operatorId] = true;
        owed -= amount;
        token.safeTransfer(payout, amount);
        emit Claimed(epoch, operatorId, payout, amount);
    }
}

/// @title VolumeMeter
/// @notice Append-only daily commitments of paid volume by class (§8), behind /stats.
contract VolumeMeter {
    struct Day {
        uint32 day;
        uint8 product;
        uint64 realUsd6;
        uint64 externalSmallUsd6;
        uint64 incentiveUsd6;
        uint64 internalUsd6;
        uint64 testUsd6;
        bytes32 jobsRoot;
    }

    address public immutable timelock;
    address public meter;
    mapping(uint32 => mapping(uint8 => Day)) private _days;
    mapping(uint32 => mapping(uint8 => bool)) public posted;

    event Posted(uint32 indexed day, uint8 indexed product, Day d);

    error NotAllowed();
    error AlreadyPosted();

    constructor(address meter_, address timelock_) {
        meter = meter_;
        timelock = timelock_;
    }

    function setMeter(address meter_) external {
        if (msg.sender != timelock) revert NotAllowed();
        meter = meter_;
    }

    /// One post per (day, product); a post can never be edited or removed.
    function post(Day calldata d) external {
        if (msg.sender != meter) revert NotAllowed();
        if (posted[d.day][d.product]) revert AlreadyPosted();
        posted[d.day][d.product] = true;
        _days[d.day][d.product] = d;
        emit Posted(d.day, d.product, d);
    }

    function dayOf(uint32 day, uint8 product) external view returns (Day memory) {
        return _days[day][product];
    }
}
