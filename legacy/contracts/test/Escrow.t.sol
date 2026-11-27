// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base, ToggleHook} from "./Base.t.sol";
import {RowSplit} from "../src/RowSplit.sol";
import {JellyJob} from "../src/JellyJob.sol";
import {ReceiptRoot} from "../src/ReceiptRoot.sol";
import {IJellyJob} from "../src/Interfaces.sol";

/// Escrow, settlement, disputes and the money invariant (§6.1 "Invariants the tests must lock in").
contract EscrowTest is Base {
    uint64 constant UNIT = 15_000; // $0.015
    uint64 constant BASE = 250_000; // $0.25

    // ───────────────────────── invariant ─────────────────────────

    /// refunds + finalized splits == budget, over row counts up to 2,000 and random
    /// verdicts and reversals. Nothing is left in the escrow or the splitter.
    function testFuzz_moneyIsConserved(
        uint32 n,
        uint64 unit,
        uint64 base,
        uint64 toolsCap,
        uint32 passed,
        uint64 tools,
        uint256 seed
    ) public {
        n = uint32(bound(n, 1, 2000));
        unit = uint64(bound(unit, 1, 1e6));
        base = uint64(bound(base, 0, 5e6));
        toolsCap = uint64(bound(toolsCap, 0, 5e6));
        passed = uint32(bound(passed, 0, n));
        tools = uint64(bound(tools, 0, toolsCap));

        uint256 jobId = _openFunded(n, unit, base, toolsCap);
        uint256 budget = job.jobOf(jobId).budget;
        assertEq(usd.balanceOf(address(job)), budget);

        _settle(jobId, n, passed, unit, tools);

        uint256 bondBefore = usd.balanceOf(address(bond));
        if (passed > 0) {
            // Reverse up to 5 passed rows at random steps of the refund curve.
            uint32 k = passed < 5 ? passed : 5;
            uint8[] memory steps = new uint8[](k);
            for (uint256 i; i < k; ++i) {
                steps[i] = uint8(uint256(keccak256(abi.encode(seed, i))) % 4);
            }
            vm.startPrank(keeper);
            uint256 roundId = split.auditRows(jobId, _proofs(jobId, n, passed, unit, _range(k)));
            vm.stopPrank();
            _voteAll(roundId, steps);

            vm.warp(block.timestamp + 24 hours);
            split.finalize(jobId);
        }
        uint256 slashed = bondBefore - usd.balanceOf(address(bond));

        uint256 out = usd.balanceOf(client) + usd.balanceOf(address(payouts)) + usd.balanceOf(checkerPool)
            + usd.balanceOf(address(burnBucket)) + usd.balanceOf(treasury) - slashed;
        assertEq(out, budget, "refunds + splits == budget");
        assertEq(usd.balanceOf(address(job)), 0, "escrow empty");
        assertEq(usd.balanceOf(address(split)), 0, "splitter empty");
        assertEq(usd.balanceOf(address(feeRouter)), 0, "router empty");
    }

    /// A refunded amount never pays a fee: what reaches the split is exactly the surviving rows plus base.
    function test_noFeeOnRefundedRows() public {
        uint256 jobId = _openFunded(100, UNIT, BASE, 0);
        _settle(jobId, 100, 60, UNIT, 0);
        assertEq(usd.balanceOf(client), 40 * uint256(UNIT), "40 failed rows refunded at settle");

        vm.warp(block.timestamp + 24 hours);
        split.finalize(jobId);
        uint256 gross = 60 * uint256(UNIT) + BASE;
        assertEq(usd.balanceOf(address(payouts)), (gross * 8000) / 10_000);
        assertEq(usd.balanceOf(checkerPool), (gross * 500) / 10_000);
        assertEq(usd.balanceOf(address(burnBucket)), (gross * 500) / 10_000);
        assertEq(
            usd.balanceOf(address(payouts)) + usd.balanceOf(checkerPool) + usd.balanceOf(address(burnBucket))
                + usd.balanceOf(treasury),
            gross
        );
    }

    function test_feeSplitIsFixedAt8000_1000_500_500() public view {
        assertEq(feeRouter.OPERATORS_BPS(), 8000);
        assertEq(feeRouter.TREASURY_BPS(), 1000);
        assertEq(feeRouter.CHECKER_BPS(), 500);
        assertEq(feeRouter.BURN_BPS(), 500);
    }

    // ───────────────────────── expiry refund ─────────────────────────

    function test_claimRefund_worksWhileHalted_byAnyone() public {
        uint256 jobId = _openFunded(10, UNIT, BASE, 0);
        uint256 budget = job.jobOf(jobId).budget;
        vm.prank(guardian);
        halt.halt();

        vm.expectRevert(JellyJob.NotExpired.selector);
        job.claimRefund(jobId);

        vm.warp(block.timestamp + 2 hours);
        vm.prank(stranger);
        job.claimRefund(jobId);
        assertEq(usd.balanceOf(client), budget);
        assertEq(uint8(job.jobOf(jobId).status), uint8(IJellyJob.Status.Expired));

        vm.expectRevert(JellyJob.BadStatus.selector);
        job.claimRefund(jobId); // only once
    }

    function test_claimRefund_worksWithEveryKeeperKeyRevoked() public {
        uint256 jobId = _openFunded(10, UNIT, BASE, 0);
        split.setKeeper(address(0));
        split.setQuoter(address(0));
        receiptRoot.setSealer(address(0));
        vm.warp(block.timestamp + 2 hours);
        job.claimRefund(jobId);
        assertEq(usd.balanceOf(client), job.jobOf(jobId).budget);
    }

    function test_claimRefund_worksWithARevertingHook() public {
        ToggleHook hook = new ToggleHook();
        vm.prank(client);
        uint256 jobId = job.createJob(stranger, stranger, uint64(block.timestamp + 1 hours), "", address(hook));
        vm.prank(client);
        job.setBudget(jobId, 1e6);
        usd.mint(client, 1e6);
        vm.startPrank(client);
        usd.approve(address(job), 1e6);
        job.fund(jobId, 1e6, "");
        vm.stopPrank();

        hook.breakIt();
        vm.prank(stranger);
        vm.expectRevert(bytes("hook reverts"));
        job.submit(jobId, bytes32(0), ""); // the hook now blocks the normal path...

        vm.warp(block.timestamp + 1 hours);
        job.claimRefund(jobId); // ...but never the refund
        assertEq(usd.balanceOf(client), 1e6);
    }

    function test_noSettleAfterExpiry_soTheRefundIsFirm() public {
        uint256 jobId = _openFunded(10, UNIT, BASE, 0);
        RowSplit.Verdict memory v = _verdict(jobId, 10, 10, UNIT, 0);
        _seal(v);
        vm.warp(block.timestamp + 2 hours);
        bytes memory sig = _sign(checkerPk, v);
        vm.prank(keeper);
        vm.expectRevert(JellyJob.AlreadyExpired.selector);
        split.settle(jobId, v, sig);
    }

    function test_jobLifetimeIsCappedAt24Hours() public {
        vm.prank(quoter);
        vm.expectRevert(JellyJob.BadExpiry.selector);
        split.openJob(_rows(1, UNIT, BASE, 0), uint64(block.timestamp + 24 hours + 1), "");
    }

    // ───────────────────────── halt ─────────────────────────

    function test_haltBlocksNewJobsFundingAndSettlement_butNotFinalize() public {
        uint256 settledJob = _openFunded(10, UNIT, BASE, 0);
        _settle(settledJob, 10, 10, UNIT, 0);
        uint256 fundedJob = _openFunded(10, UNIT, BASE, 0);
        uint256 openJob = _open(_rows(10, UNIT, BASE, 0));
        RowSplit.Verdict memory v = _verdict(fundedJob, 10, 10, UNIT, 0);
        _seal(v);

        vm.prank(guardian);
        halt.halt();

        vm.prank(quoter);
        vm.expectRevert(RowSplit.Halted.selector);
        split.openJob(_rows(1, UNIT, BASE, 0), uint64(block.timestamp + 1 hours), "");

        usd.mint(client, 1e9);
        vm.startPrank(client);
        usd.approve(address(job), 1e9);
        vm.expectRevert(JellyJob.Halted.selector);
        job.fundFor(openJob, client, client, "");
        vm.stopPrank();

        bytes memory sig = _sign(checkerPk, v);
        vm.prank(keeper);
        vm.expectRevert(RowSplit.Halted.selector);
        split.settle(fundedJob, v, sig);

        vm.warp(block.timestamp + 24 hours);
        split.finalize(settledJob); // never blocked
        assertGt(usd.balanceOf(address(payouts)), 0);
    }

    function test_guardianCanHaltButNotResume() public {
        vm.prank(stranger);
        vm.expectRevert();
        halt.halt();
        vm.prank(guardian);
        halt.halt();
        vm.prank(guardian);
        vm.expectRevert();
        halt.resume();
        halt.resume(); // the test contract is the timelock
        assertFalse(halt.halted());
    }

    // ───────────────────────── settle ─────────────────────────

    function test_settle_refundsFailedRowsAndUnusedToolsAtOnce() public {
        uint256 jobId = _openFunded(20, UNIT, BASE, 1_100_000);
        _settle(jobId, 20, 15, UNIT, 550_000);
        // 5 failed rows × $0.015 + unused tools $0.55
        assertEq(usd.balanceOf(client), 5 * uint256(UNIT) + 550_000);
        (, RowSplit.State memory s) = split.jobOf(jobId);
        assertEq(s.heldGross, 15 * uint256(UNIT) + BASE);
        assertEq(s.heldTools, 550_000);
        assertEq(s.releaseAt, block.timestamp + 24 hours);
    }

    function test_settle_nothingPassed_refundsEverythingIncludingBase() public {
        uint256 jobId = _openFunded(20, UNIT, BASE, 1_100_000);
        uint256 budget = job.jobOf(jobId).budget;
        _settle(jobId, 20, 0, UNIT, 0);
        assertEq(usd.balanceOf(client), budget);
        assertEq(usd.balanceOf(address(split)), 0);
        vm.expectRevert(RowSplit.BadState.selector);
        split.finalize(jobId);
    }

    function test_settle_rejectsASignerOnTheWorkersOperatorId() public {
        uint256 pk = 0xBAD;
        address same = vm.addr(pk);
        bond.assignOperator(same, WORKER_OPERATOR);
        usd.mint(same, MIN_BOND);
        vm.startPrank(same);
        usd.approve(address(bond), MIN_BOND);
        bond.bond(MIN_BOND, 0);
        vm.stopPrank();

        uint256 jobId = _openFunded(10, UNIT, BASE, 0);
        RowSplit.Verdict memory v = _verdict(jobId, 10, 10, UNIT, 0);
        _seal(v);
        bytes memory badSig = _sign(pk, v);
        vm.prank(keeper);
        vm.expectRevert(RowSplit.BadSigner.selector);
        split.settle(jobId, v, badSig);
    }

    function test_settle_rejectsUnbondedOrExitingSigners() public {
        uint256 jobId = _openFunded(10, UNIT, BASE, 0);
        RowSplit.Verdict memory v = _verdict(jobId, 10, 10, UNIT, 0);
        _seal(v);
        bytes memory unbondedSig = _sign(0xDEAD, v);
        vm.prank(keeper);
        vm.expectRevert(RowSplit.BadSigner.selector);
        split.settle(jobId, v, unbondedSig);

        vm.prank(checker);
        bond.requestExit();
        bytes memory exitingSig = _sign(checkerPk, v);
        vm.prank(keeper);
        vm.expectRevert(RowSplit.BadSigner.selector);
        split.settle(jobId, v, exitingSig);
    }

    function test_settle_rejectsBadVerdicts() public {
        uint256 jobId = _openFunded(10, UNIT, BASE, 100);
        RowSplit.Verdict memory good = _verdict(jobId, 10, 10, UNIT, 0);

        bytes memory unsealedSig = _sign(checkerPk, good);
        vm.prank(keeper); // receipts not sealed yet
        vm.expectRevert(RowSplit.NotSealed.selector);
        split.settle(jobId, good, unsealedSig);
        _seal(good);

        RowSplit.Verdict memory v = _verdict(jobId, 10, 10, UNIT, 0);
        v.passedCount = 11;
        _expectBadVerdict(jobId, v);
        v = _verdict(jobId, 10, 10, UNIT, 101); // tools above the cap
        _expectBadVerdict(jobId, v);
        v = _verdict(jobId, 10, 10, UNIT, 0);
        v.rowCount = 9;
        _expectBadVerdict(jobId, v);
        v = _verdict(jobId, 10, 10, UNIT, 0);
        v.jobKey = bytes32(uint256(1));
        _expectBadVerdict(jobId, v);
        v = _verdict(jobId, 10, 10, UNIT, 0);
        v.receiptsRoot = bytes32(uint256(2)); // not what was sealed
        bytes memory unsealedSig2 = _sign(checkerPk, v);
        vm.prank(keeper);
        vm.expectRevert(RowSplit.NotSealed.selector);
        split.settle(jobId, v, unsealedSig2);

        bytes memory goodSig = _sign(checkerPk, good);
        vm.prank(stranger); // not the keeper
        vm.expectRevert(RowSplit.NotAllowed.selector);
        split.settle(jobId, good, goodSig);

        vm.prank(keeper);
        split.settle(jobId, good, goodSig);
        bytes memory goodSig2 = _sign(checkerPk, good);
        vm.prank(keeper); // only once
        vm.expectRevert(RowSplit.BadState.selector);
        split.settle(jobId, good, goodSig2);
    }

    function _expectBadVerdict(uint256 jobId, RowSplit.Verdict memory v) private {
        bytes memory sig = _sign(checkerPk, v);
        vm.prank(keeper);
        vm.expectRevert(RowSplit.BadVerdict.selector);
        split.settle(jobId, v, sig);
    }

    function test_onlyTheQuoterOpensJobs_andAJobCannotBeFundedWithADifferentBudget() public {
        vm.prank(stranger);
        vm.expectRevert(RowSplit.NotAllowed.selector);
        split.openJob(_rows(1, UNIT, BASE, 0), uint64(block.timestamp + 1 hours), "");

        // Before funding, the splitter is both client and provider, so no one else can change the budget.
        uint256 jobId = _open(_rows(10, UNIT, BASE, 0));
        vm.prank(client);
        vm.expectRevert(JellyJob.NotAllowed.selector);
        job.setBudget(jobId, 1);
    }

    function test_receiptsAreSealedOnce() public {
        vm.startPrank(sealer);
        receiptRoot.seal(bytes32("k"), bytes32("root"), 3, bytes32("head"));
        vm.expectRevert(ReceiptRoot.AlreadySealed.selector);
        receiptRoot.seal(bytes32("k"), bytes32("other"), 3, bytes32("head"));
        vm.expectRevert(ReceiptRoot.EmptySeal.selector);
        receiptRoot.seal(bytes32("k2"), bytes32("root"), 0, bytes32("head"));
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(ReceiptRoot.NotSealer.selector);
        receiptRoot.seal(bytes32("k3"), bytes32("root"), 1, bytes32("head"));
    }

    // ───────────────────────── finalize ─────────────────────────

    function test_finalize_revertsBeforeTheWindow_thenAnyoneCanCallIt() public {
        uint256 jobId = _openFunded(10, UNIT, BASE, 200_000);
        _settle(jobId, 10, 10, UNIT, 200_000);

        vm.expectRevert(RowSplit.WindowOpen.selector);
        split.finalize(jobId);
        vm.warp(block.timestamp + 24 hours - 1);
        vm.expectRevert(RowSplit.WindowOpen.selector);
        split.finalize(jobId);

        vm.warp(block.timestamp + 1);
        uint256 treasuryBefore = usd.balanceOf(treasury);
        vm.prank(stranger);
        split.finalize(jobId);
        uint256 gross = 10 * uint256(UNIT) + BASE;
        // billed tools go to the treasury on top of its 10%
        assertEq(usd.balanceOf(treasury) - treasuryBefore, gross - (gross * 9000) / 10_000 + 200_000);

        vm.expectRevert(RowSplit.BadState.selector);
        split.finalize(jobId);
    }

    function test_finalize_waitsForOpenRounds() public {
        uint256 jobId = _openFunded(10, UNIT, BASE, 0);
        _settle(jobId, 10, 10, UNIT, 0);
        vm.startPrank(keeper);
        uint256 roundId = split.auditRows(jobId, _proofs(jobId, 10, 10, UNIT, _range(2)));
        vm.stopPrank();

        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert(RowSplit.RoundsOpen.selector);
        split.finalize(jobId);

        net.resolve(roundId); // deadline passed with no votes: the verdict stands
        split.finalize(jobId);
        assertEq(usd.balanceOf(client), 0);
    }

    function test_aJobKeepsTheWindowItWasOpenedWith() public {
        uint256 jobId = _openFunded(10, UNIT, BASE, 0);
        split.setDisputeWindow(1 hours, 1);
        _settle(jobId, 10, 10, UNIT, 0);
        (, RowSplit.State memory s) = split.jobOf(jobId);
        assertEq(s.releaseAt, block.timestamp + 24 hours);
    }
}
