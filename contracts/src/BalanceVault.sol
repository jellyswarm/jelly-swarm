// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IBalanceVault, IFeeRouter, IJellyJob} from "./Interfaces.sol";

/// @title BalanceVault
/// @notice Prepaid balances (§6.1). The owner deposits once and signs a spend grant; the
///         relayer can then fund that owner's jobs within the grant's caps. Each job is
///         still its own escrow.
///
///         The relayer can move money along exactly two paths: owner's balance → escrow
///         for the owner's own job, and owner's balance → fee split for a Picket period.
///         It cannot withdraw, and it cannot send funds anywhere else.
///
///         `withdraw` is owner-only and reads no halt flag, grant or open job: escrowed
///         money has already left this contract, so what is here is always the owner's.
/// @dev    Not audited.
contract BalanceVault is IBalanceVault, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct SpendGrant {
        address owner;
        /// Identifies the API key or device this grant belongs to; revocable on its own.
        bytes32 keyId;
        uint64 perJobCapUsd6;
        uint64 perDayCapUsd6;
        uint64 expiresAt;
        /// Picket: most that one billing period may debit. Zero disables period debits.
        uint64 periodCapUsd6;
        /// Picket: a period is billed only if the watch covered at least this share of it.
        uint16 minCoverageBps;
    }

    bytes32 public constant GRANT_TYPEHASH = keccak256(
        "SpendGrant(address owner,bytes32 keyId,uint64 perJobCapUsd6,uint64 perDayCapUsd6,uint64 expiresAt,uint64 periodCapUsd6,uint16 minCoverageBps)"
    );
    /// §6.1: a Picket period is never billed below 95% coverage, whatever the grant says.
    uint16 public constant MIN_COVERAGE_FLOOR_BPS = 9500;

    IERC20 public immutable token;
    address public immutable timelock;
    IJellyJob public jellyJob;
    IFeeRouter public feeRouter;
    address public relayer;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public revoked;
    /// owner => keyId => day => spent
    mapping(address => mapping(bytes32 => mapping(uint256 => uint256))) public spentOn;
    mapping(address => mapping(bytes32 => bool)) public periodDebited;

    event Deposited(address indexed owner, uint256 amount);
    event Withdrawn(address indexed owner, address to, uint256 amount);
    event GrantRevoked(address indexed owner, bytes32 keyId);
    event JobFunded(address indexed owner, bytes32 indexed keyId, uint256 indexed jobId, uint256 amount);
    event PeriodDebited(address indexed owner, bytes32 indexed periodKey, uint256 amount, uint16 coverageBps);

    error NotAllowed();
    error BadGrant();
    error OverCap();
    error Insufficient();
    error LowCoverage();
    error AlreadyDebited();
    error AlreadySet();

    constructor(IERC20 token_, address timelock_, address relayer_) EIP712("JellySwarm Vault", "1") {
        token = token_;
        timelock = timelock_;
        relayer = relayer_;
    }

    /// The escrow and fee router are wired once after deployment and can never be changed,
    /// so the relayer's two paths are fixed for the life of the vault.
    function wire(IJellyJob jellyJob_, IFeeRouter feeRouter_) external {
        if (msg.sender != timelock) revert NotAllowed();
        if (address(jellyJob) != address(0)) revert AlreadySet();
        jellyJob = jellyJob_;
        feeRouter = feeRouter_;
    }

    function setRelayer(address relayer_) external {
        if (msg.sender != timelock) revert NotAllowed();
        relayer = relayer_;
    }

    // ───────────────────────── owner ─────────────────────────

    function deposit(uint256 amount) external {
        _deposit(msg.sender, amount);
    }

    /// Anyone may add to an owner's balance (top-ups, and refunds from the escrow).
    function depositFor(address owner, uint256 amount) external {
        _deposit(owner, amount);
    }

    function _deposit(address owner, uint256 amount) private {
        balanceOf[owner] += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(owner, amount);
    }

    /// Owner only. NEVER checks the halt switch, grants or open jobs.
    function withdraw(uint256 amount, address to) external nonReentrant {
        if (balanceOf[msg.sender] < amount) revert Insufficient();
        balanceOf[msg.sender] -= amount;
        token.safeTransfer(to, amount);
        emit Withdrawn(msg.sender, to, amount);
    }

    function revokeGrant(bytes32 keyId) external {
        revoked[msg.sender][keyId] = true;
        emit GrantRevoked(msg.sender, keyId);
    }

    // ───────────────────────── relayer ─────────────────────────

    function grantDigest(SpendGrant calldata g) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    GRANT_TYPEHASH,
                    g.owner,
                    g.keyId,
                    g.perJobCapUsd6,
                    g.perDayCapUsd6,
                    g.expiresAt,
                    g.periodCapUsd6,
                    g.minCoverageBps
                )
            )
        );
    }

    /// Verifies the owner's signature (ERC-1271 for passkey accounts), expiry and revocation.
    function _checkGrant(SpendGrant calldata g, bytes calldata ownerSig) private view {
        if (msg.sender != relayer) revert NotAllowed();
        if (block.timestamp >= g.expiresAt || revoked[g.owner][g.keyId]) revert BadGrant();
        if (!SignatureChecker.isValidSignatureNow(g.owner, grantDigest(g), ownerSig)) revert BadGrant();
    }

    function _spend(SpendGrant calldata g, uint256 amount) private {
        uint256 day = block.timestamp / 1 days;
        uint256 spent = spentOn[g.owner][g.keyId][day] + amount;
        if (spent > g.perDayCapUsd6) revert OverCap();
        spentOn[g.owner][g.keyId][day] = spent;
        if (balanceOf[g.owner] < amount) revert Insufficient();
        balanceOf[g.owner] -= amount;
    }

    /// Funds the owner's job from their balance. `amount` must equal the job's budget.
    /// Refunds for the job come back to the owner's balance here.
    function fundJob(SpendGrant calldata g, bytes calldata ownerSig, uint256 jobId, uint256 amount)
        external
        nonReentrant
    {
        _checkGrant(g, ownerSig);
        if (amount > g.perJobCapUsd6) revert OverCap();
        if (jellyJob.jobOf(jobId).budget != amount) revert BadGrant();
        _spend(g, amount);
        token.forceApprove(address(jellyJob), amount);
        jellyJob.fundFor(jobId, g.owner, address(this), "");
        emit JobFunded(g.owner, g.keyId, jobId, amount);
    }

    /// Picket billing: debits one period, once, and only if the watch really ran.
    /// The coverage figure is reported by the relayer from the watch log.
    function debitPeriod(
        SpendGrant calldata g,
        bytes calldata ownerSig,
        bytes32 periodKey,
        uint256 amount,
        uint16 coverageBps
    ) external nonReentrant {
        _checkGrant(g, ownerSig);
        uint16 need = g.minCoverageBps < MIN_COVERAGE_FLOOR_BPS ? MIN_COVERAGE_FLOOR_BPS : g.minCoverageBps;
        if (coverageBps < need) revert LowCoverage();
        if (amount > g.periodCapUsd6) revert OverCap();
        if (periodDebited[g.owner][periodKey]) revert AlreadyDebited();
        periodDebited[g.owner][periodKey] = true;
        _spend(g, amount);
        token.forceApprove(address(feeRouter), amount);
        feeRouter.route(periodKey, amount);
        emit PeriodDebited(g.owner, periodKey, amount, coverageBps);
    }
}
