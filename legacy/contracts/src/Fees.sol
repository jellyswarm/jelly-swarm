// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBurnBucket, IBurnSwapper, IFeeRouter} from "./Interfaces.sol";

/// @title FeeRouter
/// @notice Splits every finalized payment 80 / 10 / 5 / 5 between worker operators, the
///         treasury, checker pay and buy-and-burn (§0.5). The shares are constants: no
///         one, including the timelock, can change them.
contract FeeRouter is IFeeRouter {
    using SafeERC20 for IERC20;

    uint16 public constant OPERATORS_BPS = 8000;
    uint16 public constant TREASURY_BPS = 1000;
    uint16 public constant CHECKER_BPS = 500;
    uint16 public constant BURN_BPS = 500;

    IERC20 public immutable token;
    address public immutable timelock;
    address public immutable operatorPayouts;
    IBurnBucket public immutable burnBucket;
    address public treasury;
    address public checkerPool;
    mapping(address => bool) public isSource;

    event Routed(bytes32 indexed key, uint256 operators, uint256 treasury, uint256 checker, uint256 burn);

    error NotAllowed();

    constructor(
        IERC20 token_,
        address timelock_,
        address operatorPayouts_,
        IBurnBucket burnBucket_,
        address treasury_,
        address checkerPool_
    ) {
        token = token_;
        timelock = timelock_;
        operatorPayouts = operatorPayouts_;
        burnBucket = burnBucket_;
        treasury = treasury_;
        checkerPool = checkerPool_;
    }

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert NotAllowed();
        _;
    }

    /// Contracts allowed to route payments (RowSplit, BalanceVault).
    function setSource(address source, bool allowed) external onlyTimelock {
        isSource[source] = allowed;
    }

    function setRecipients(address treasury_, address checkerPool_) external onlyTimelock {
        treasury = treasury_;
        checkerPool = checkerPool_;
    }

    /// Pulls `amount` from the caller and pays the four shares. Each share rounds down;
    /// the few micro-dollars of rounding dust go to the treasury.
    function route(bytes32 key, uint256 amount) external {
        if (!isSource[msg.sender]) revert NotAllowed();
        token.safeTransferFrom(msg.sender, address(this), amount);

        uint256 operators = (amount * OPERATORS_BPS) / 10_000;
        uint256 checker = (amount * CHECKER_BPS) / 10_000;
        uint256 burn = (amount * BURN_BPS) / 10_000;
        uint256 toTreasury = amount - operators - checker - burn;

        token.safeTransfer(operatorPayouts, operators);
        token.safeTransfer(treasury, toTreasury);
        token.safeTransfer(checkerPool, checker);
        if (burn != 0) {
            token.forceApprove(address(burnBucket), burn);
            burnBucket.accrue(key, burn);
        }
        emit Routed(key, operators, toTreasury, checker, burn);
    }
}

/// @title BurnBucket
/// @notice Holds each job's 5% burn share, by job (§0.5). A share is burned only if the
///         job was paid for by an outside wallet; otherwise it goes to the treasury. Every
///         burn names the jobs that funded it.
contract BurnBucket is IBurnBucket, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Class {
        Unclassified,
        External,
        NonExternal
    }

    IERC20 public immutable token;
    address public immutable timelock;
    address public feeRouter;
    /// The meter key: records each job's volume class.
    address public classifier;
    address public keeper;
    address public treasury;
    IBurnSwapper public swapper;

    mapping(bytes32 => uint256) public accrued;
    mapping(bytes32 => Class) public classOf;

    event Accrued(bytes32 indexed jobKey, uint256 amount);
    event Classified(bytes32 indexed jobKey, Class class);
    event Burned(bytes32 jobKeysRoot, uint32 jobs, uint256 stableIn, uint256 tokenBurned);
    event SweptToTreasury(bytes32 jobKeysRoot, uint32 jobs, uint256 amount, bytes32 reason);

    error NotAllowed();
    error WrongClass();
    error AlreadyClassified();
    error NothingAccrued();
    error NoRoute();
    error AlreadySet();

    constructor(IERC20 token_, address timelock_, address classifier_, address keeper_, address treasury_) {
        token = token_;
        timelock = timelock_;
        classifier = classifier_;
        keeper = keeper_;
        treasury = treasury_;
    }

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert NotAllowed();
        _;
    }

    function setFeeRouter(address a) external onlyTimelock {
        if (feeRouter != address(0)) revert AlreadySet();
        feeRouter = a;
    }

    function setRoles(address classifier_, address keeper_, address treasury_) external onlyTimelock {
        classifier = classifier_;
        keeper = keeper_;
        treasury = treasury_;
    }

    function setSwapper(IBurnSwapper swapper_) external onlyTimelock {
        swapper = swapper_;
    }

    function accrue(bytes32 jobKey, uint256 amount) external {
        if (msg.sender != feeRouter) revert NotAllowed();
        accrued[jobKey] += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Accrued(jobKey, amount);
    }

    /// A job's class is written once and cannot be changed afterwards.
    function classify(bytes32[] calldata jobKeys, bool isExternal) external {
        if (msg.sender != classifier) revert NotAllowed();
        Class c = isExternal ? Class.External : Class.NonExternal;
        for (uint256 i; i < jobKeys.length; ++i) {
            if (classOf[jobKeys[i]] != Class.Unclassified) revert AlreadyClassified();
            classOf[jobKeys[i]] = c;
            emit Classified(jobKeys[i], c);
        }
    }

    function _take(bytes32[] calldata jobKeys, Class required) private returns (uint256 total) {
        for (uint256 i; i < jobKeys.length; ++i) {
            bytes32 k = jobKeys[i];
            if (classOf[k] != required) revert WrongClass();
            total += accrued[k];
            accrued[k] = 0;
        }
        if (total == 0) revert NothingAccrued();
    }

    /// Buys the product token with exactly the shares accrued by these outside-paid jobs, and burns it.
    function burn(bytes32[] calldata jobKeys, uint256 minOut, bytes calldata route) external nonReentrant {
        if (msg.sender != keeper) revert NotAllowed();
        if (address(swapper) == address(0)) revert NoRoute();
        uint256 stableIn = _take(jobKeys, Class.External);
        token.forceApprove(address(swapper), stableIn);
        uint256 burned = swapper.swapAndBurn(stableIn, minOut, route);
        emit Burned(keccak256(abi.encode(jobKeys)), uint32(jobKeys.length), stableIn, burned);
    }

    /// Shares from free, credit, test and studio-linked jobs never fund a burn.
    function sweepNonExternal(bytes32[] calldata jobKeys, bytes32 reason) external nonReentrant {
        if (msg.sender != keeper) revert NotAllowed();
        uint256 amount = _take(jobKeys, Class.NonExternal);
        token.safeTransfer(treasury, amount);
        emit SweptToTreasury(keccak256(abi.encode(jobKeys)), uint32(jobKeys.length), amount, reason);
    }

    /// Moving a bucket to the token's home chain needs a bridge route that has not been
    /// chosen (day-1 check 12). Until then shares stay here and the gap is disclosed on /stats.
    function bridgeOut(bytes32[] calldata, bytes calldata) external pure {
        revert NoRoute();
    }
}
