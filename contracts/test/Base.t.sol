// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdminTimelock, HaltSwitch} from "../src/Admin.sol";
import {JellyJob} from "../src/JellyJob.sol";
import {RowSplit} from "../src/RowSplit.sol";
import {ReceiptRoot} from "../src/ReceiptRoot.sol";
import {CheckerBond, CheckerNet} from "../src/Checkers.sol";
import {BalanceVault} from "../src/BalanceVault.sol";
import {IntakeForwarder, IntakeForwarderFactory} from "../src/IntakeForwarder.sol";
import {FeeRouter, BurnBucket} from "../src/Fees.sol";
import {OperatorRegistry, OperatorPayouts, VolumeMeter} from "../src/Operators.sol";
import {IBurnSwapper, ICheckerNet, IHaltSwitch, IJellyJob, IJobHook} from "../src/Interfaces.sol";

contract MockUSD is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockToken is ERC20 {
    constructor() ERC20("Mock Product Token", "MPT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Takes the stablecoin and reports a burn at a fixed rate.
contract MockSwapper is IBurnSwapper {
    IERC20 public immutable stable;
    uint256 public totalIn;

    constructor(IERC20 stable_) {
        stable = stable_;
    }

    function swapAndBurn(uint256 stableIn, uint256 minOut, bytes calldata) external returns (uint256 burned) {
        stable.transferFrom(msg.sender, address(this), stableIn);
        totalIn += stableIn;
        burned = stableIn * 1e12;
        require(burned >= minOut, "slippage");
    }
}

/// A hook that can be switched to revert on every call.
contract ToggleHook is IJobHook {
    bool public broken;

    function breakIt() external {
        broken = true;
    }

    function beforeAction(uint256, bytes4, bytes calldata) external view {
        require(!broken, "hook reverts");
    }

    function afterAction(uint256, bytes4, bytes calldata) external view {
        require(!broken, "hook reverts");
    }
}

/// Deploys the whole system. The test contract itself plays the timelock.
abstract contract Base is Test {
    MockUSD usd;
    MockToken ptoken;
    HaltSwitch halt;
    JellyJob job;
    RowSplit split;
    ReceiptRoot receiptRoot;
    CheckerBond bond;
    CheckerNet net;
    BalanceVault vault;
    IntakeForwarderFactory factory;
    FeeRouter feeRouter;
    BurnBucket burnBucket;
    OperatorRegistry registry;
    OperatorPayouts payouts;
    VolumeMeter meter;
    MockSwapper swapper;

    address guardian = makeAddr("guardian");
    address quoter = makeAddr("quoter");
    address keeper = makeAddr("keeper");
    address relayer = makeAddr("relayer");
    address sealer = makeAddr("sealer");
    address classifier = makeAddr("classifier");
    address nodeAuditor = makeAddr("nodeAuditor");
    address treasury = makeAddr("treasury");
    address checkerPool = makeAddr("checkerPool");
    address client = makeAddr("client");
    address stranger = makeAddr("stranger");
    address[3] panelists = [makeAddr("panel1"), makeAddr("panel2"), makeAddr("panel3")];

    uint256 checkerPk = 0xC0FFEE;
    address checker;
    uint64 constant WORKER_OPERATOR = 1;
    uint64 constant CHECKER_OPERATOR = 2;
    uint128 constant MIN_BOND = 100e6;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        checker = vm.addr(checkerPk);
        usd = new MockUSD();
        ptoken = new MockToken();

        halt = new HaltSwitch(guardian, address(this));
        vault = new BalanceVault(usd, address(this), relayer);
        job = new JellyJob(usd, IHaltSwitch(address(halt)), address(vault));
        receiptRoot = new ReceiptRoot(sealer, address(this));
        bond = new CheckerBond(usd, ptoken, address(this), treasury, MIN_BOND);
        registry = new OperatorRegistry(usd, ptoken, address(this), nodeAuditor, treasury, 50e6, 0);
        payouts = new OperatorPayouts(usd, registry, address(this), keeper);
        burnBucket = new BurnBucket(usd, address(this), classifier, keeper, treasury);
        feeRouter = new FeeRouter(usd, address(this), address(payouts), burnBucket, treasury, checkerPool);
        burnBucket.setFeeRouter(address(feeRouter));
        split = new RowSplit(
            job, receiptRoot, bond, feeRouter, IHaltSwitch(address(halt)), address(this), quoter, keeper, treasury
        );
        net = new CheckerNet(ptoken, split, address(this), 1e18);
        split.setCheckerNet(ICheckerNet(address(net)));
        bond.setRowSplit(address(split));
        feeRouter.setSource(address(split), true);
        feeRouter.setSource(address(vault), true);
        vault.wire(job, feeRouter);
        factory = new IntakeForwarderFactory(job);
        meter = new VolumeMeter(classifier, address(this));
        swapper = new MockSwapper(usd);
        burnBucket.setSwapper(swapper);
        registry.registerStudio(WORKER_OPERATOR, makeAddr("studioPayout"));

        // One bonded verdict signer, on a different operator id from the workers.
        bond.assignOperator(checker, CHECKER_OPERATOR);
        usd.mint(checker, MIN_BOND);
        vm.startPrank(checker);
        usd.approve(address(bond), MIN_BOND);
        bond.bond(MIN_BOND, 0);
        vm.stopPrank();

        // Three staked panelists.
        for (uint256 i; i < 3; ++i) {
            ptoken.mint(panelists[i], 10e18);
            vm.startPrank(panelists[i]);
            ptoken.approve(address(net), 10e18);
            net.stake(10e18);
            vm.stopPrank();
        }
    }

    // ───────────────────────── job helpers ─────────────────────────

    function _rows(uint32 n, uint64 unit, uint64 base, uint64 toolsCap) internal pure returns (RowSplit.Rows memory) {
        return RowSplit.Rows(n, unit, base, toolsCap, WORKER_OPERATOR);
    }

    function _open(RowSplit.Rows memory r) internal returns (uint256 jobId) {
        vm.prank(quoter);
        jobId = split.openJob(r, uint64(block.timestamp + 2 hours), "");
    }

    function _fund(uint256 jobId, address who) internal {
        uint256 budget = job.jobOf(jobId).budget;
        usd.mint(who, budget);
        vm.startPrank(who);
        usd.approve(address(job), budget);
        job.fundFor(jobId, who, who, "");
        vm.stopPrank();
    }

    function _openFunded(uint32 n, uint64 unit, uint64 base, uint64 toolsCap) internal returns (uint256 jobId) {
        jobId = _open(_rows(n, unit, base, toolsCap));
        _fund(jobId, client);
    }

    /// Leaves for a job where rows [0, passed) passed and the rest failed.
    function _leaves(uint256 jobId, uint32 n, uint32 passed, uint64 unit) internal view returns (bytes32[] memory l) {
        bytes32 key = split.jobKeyOf(jobId);
        l = new bytes32[](n);
        for (uint32 i; i < n; ++i) {
            l[i] = split.rowLeaf(key, i, i < passed, WORKER_OPERATOR, unit, keccak256(abi.encode("receipts", i)));
        }
    }

    function _verdict(uint256 jobId, uint32 n, uint32 passed, uint64 unit, uint64 tools)
        internal
        view
        returns (RowSplit.Verdict memory v)
    {
        v = RowSplit.Verdict({
            jobKey: split.jobKeyOf(jobId),
            rowCount: n,
            passedCount: passed,
            rowsRoot: _root(_leaves(jobId, n, passed, unit)),
            receiptsRoot: keccak256(abi.encode("receipts-root", jobId)),
            toolsUsd6: tools
        });
    }

    function _sign(uint256 pk, RowSplit.Verdict memory v) internal view returns (bytes memory) {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, split.verdictDigest(v));
        return abi.encodePacked(r, s, vv);
    }

    function _seal(RowSplit.Verdict memory v) internal {
        vm.prank(sealer);
        receiptRoot.seal(v.jobKey, v.receiptsRoot, 1, v.receiptsRoot);
    }

    function _settle(uint256 jobId, uint32 n, uint32 passed, uint64 unit, uint64 tools) internal {
        RowSplit.Verdict memory v = _verdict(jobId, n, passed, unit, tools);
        _seal(v);
        vm.prank(keeper);
        split.settle(jobId, v, _sign(checkerPk, v));
    }

    function _proofs(uint256 jobId, uint32 n, uint32 passed, uint64 unit, uint32[] memory idx)
        internal
        view
        returns (RowSplit.RowProofs memory p)
    {
        bytes32[] memory l = _leaves(jobId, n, passed, unit);
        p.rowIdx = idx;
        p.operatorIds = new uint64[](idx.length);
        p.receiptsHashes = new bytes32[](idx.length);
        p.proofs = new bytes32[][](idx.length);
        for (uint256 i; i < idx.length; ++i) {
            p.operatorIds[i] = WORKER_OPERATOR;
            p.receiptsHashes[i] = keccak256(abi.encode("receipts", idx[i]));
            p.proofs[i] = _proof(l, idx[i]);
        }
    }

    /// All three panelists vote the same steps, then the round is resolved.
    function _voteAll(uint256 roundId, uint8[] memory steps) internal {
        for (uint256 i; i < 3; ++i) {
            vm.prank(panelists[i]);
            net.vote(roundId, steps);
        }
        net.resolve(roundId);
    }

    function _range(uint32 n) internal pure returns (uint32[] memory a) {
        a = new uint32[](n);
        for (uint32 i; i < n; ++i) {
            a[i] = i;
        }
    }

    // ───────────────────────── merkle (same rule as packages/receipts) ─────────────────────────

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _next(bytes32[] memory level) internal pure returns (bytes32[] memory out) {
        out = new bytes32[]((level.length + 1) / 2);
        for (uint256 i; i < level.length; i += 2) {
            out[i / 2] = i + 1 < level.length ? _pair(level[i], level[i + 1]) : level[i];
        }
    }

    function _root(bytes32[] memory leaves) internal pure returns (bytes32) {
        if (leaves.length == 0) return bytes32(0);
        while (leaves.length > 1) {
            leaves = _next(leaves);
        }
        return leaves[0];
    }

    function _proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory proof) {
        bytes32[] memory tmp = new bytes32[](32);
        uint256 n;
        while (leaves.length > 1) {
            uint256 sib = index ^ 1;
            if (sib < leaves.length) tmp[n++] = leaves[sib];
            leaves = _next(leaves);
            index >>= 1;
        }
        proof = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            proof[i] = tmp[i];
        }
    }
}
