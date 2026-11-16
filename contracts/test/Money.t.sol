// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {AdminTimelock} from "../src/Admin.sol";
import {RowSplit} from "../src/RowSplit.sol";
import {JellyJob} from "../src/JellyJob.sol";
import {BalanceVault} from "../src/BalanceVault.sol";
import {IntakeForwarder} from "../src/IntakeForwarder.sol";
import {BurnBucket} from "../src/Fees.sol";
import {CheckerNet} from "../src/Checkers.sol";
import {OperatorRegistry, OperatorPayouts, VolumeMeter} from "../src/Operators.sol";
import {IJellyJob} from "../src/Interfaces.sol";

/// Disputes, the prepaid vault, x402 forwarders, payouts, burns, operators and the timelock.
contract MoneyTest is Base {
    uint64 constant UNIT = 1_000_000; // $1 a row, so dispute and refund amounts are easy to read
    uint64 constant BASE = 250_000;

    // ───────────────────────── disputes ─────────────────────────

    function _settled(uint32 n, uint32 passed) private returns (uint256 jobId) {
        jobId = _openFunded(n, UNIT, BASE, 0);
        _settle(jobId, n, passed, UNIT, 0);
    }

    function _dispute(uint256 jobId, uint32 n, uint32 passed, uint32[] memory idx) private returns (uint256 roundId) {
        usd.mint(client, 10e6);
        vm.startPrank(client);
        usd.approve(address(split), 10e6);
        roundId = split.disputeRows(jobId, _proofs(jobId, n, passed, UNIT, idx));
        vm.stopPrank();
    }

    function _steps(uint8 a, uint8 b, uint8 c) private pure returns (uint8[] memory s) {
        s = new uint8[](3);
        (s[0], s[1], s[2]) = (a, b, c);
    }

    function test_dispute_reversalRefundsOnTheCurve_slashesTheSigner_andReturnsTheFee() public {
        uint256 jobId = _settled(10, 10);
        uint256 before = usd.balanceOf(client);
        uint256 roundId = _dispute(jobId, 10, 10, _range(3));
        // fee = max($0.50, 1% of $3) = $0.50
        assertEq(before + 10e6 - usd.balanceOf(client), 500_000);

        // rows 0,1,2 → reversed at 100%, 75%, upheld
        _voteAll(roundId, _steps(0, 1, 3));
        assertEq(usd.balanceOf(client) - before - 10e6, 1_000_000 + 750_000, "refund on the curve, fee returned");
        (uint128 bonded,,,) = bond.bonds(checker);
        assertEq(bonded, MIN_BOND - MIN_BOND / 10, "signer slashed 10%");
        assertTrue(split.rowReversed(jobId, 0));
        assertFalse(split.rowReversed(jobId, 2));

        vm.warp(block.timestamp + 24 hours);
        split.finalize(jobId);
        assertEq(usd.balanceOf(address(payouts)), ((10e6 + BASE - 1_750_000) * 8000) / 10_000);
    }

    function test_dispute_upheld_feeGoesToTheTreasury_noSlash() public {
        uint256 jobId = _settled(10, 10);
        uint256 roundId = _dispute(jobId, 10, 10, _range(3));
        uint256 treasuryBefore = usd.balanceOf(treasury);
        _voteAll(roundId, _steps(3, 3, 3));
        assertEq(usd.balanceOf(treasury) - treasuryBefore, 500_000);
        (uint128 bonded,,,) = bond.bonds(checker);
        assertEq(bonded, MIN_BOND);
    }

    function test_dispute_theMedianVoteDecides() public {
        uint256 jobId = _settled(10, 10);
        uint256 before = usd.balanceOf(client);
        uint256 roundId = _dispute(jobId, 10, 10, _range(1));
        uint8[] memory s = new uint8[](1);
        address[3] memory panel = net.roundOf(roundId).panel;
        uint8[3] memory votes = [0, 1, 3]; // 100%, 75%, uphold → median 75%
        for (uint256 i; i < 3; ++i) {
            s[0] = votes[i];
            vm.prank(panel[i]);
            net.vote(roundId, s);
        }
        net.resolve(roundId);
        assertEq(usd.balanceOf(client) - before - 10e6, 750_000);
    }

    function test_dispute_everyRowFullyReversed_refundsTheBaseToo() public {
        uint256 jobId = _settled(3, 3);
        uint256 before = usd.balanceOf(client);
        uint256 roundId = _dispute(jobId, 3, 3, _range(3));
        _voteAll(roundId, _steps(0, 0, 0));
        assertEq(usd.balanceOf(client) - before - 10e6, 3e6 + BASE);
        vm.warp(block.timestamp + 24 hours);
        split.finalize(jobId);
        assertEq(usd.balanceOf(address(payouts)), 0, "nothing left to split");
    }

    function test_dispute_guards() public {
        uint256 jobId = _settled(40, 30);
        usd.mint(client, 100e6);
        vm.prank(client);
        usd.approve(address(split), 100e6);

        RowSplit.RowProofs memory three = _proofs(jobId, 40, 30, UNIT, _range(3));
        vm.prank(stranger); // only the client
        vm.expectRevert(RowSplit.NotAllowed.selector);
        split.disputeRows(jobId, three);

        RowSplit.RowProofs memory tooMany = _proofs(jobId, 40, 30, UNIT, _range(26));
        vm.prank(client);
        vm.expectRevert(RowSplit.BadRows.selector);
        split.disputeRows(jobId, tooMany);

        // Row 35 failed: it cannot be proven as a passed row.
        uint32[] memory failed = new uint32[](1);
        failed[0] = 35;
        RowSplit.RowProofs memory bad = _proofs(jobId, 40, 30, UNIT, failed);
        vm.prank(client);
        vm.expectRevert(RowSplit.BadProof.selector);
        split.disputeRows(jobId, bad);

        vm.prank(client);
        split.disputeRows(jobId, three);
        vm.prank(client); // a row is in one round at a time
        vm.expectRevert(RowSplit.RowUnavailable.selector);
        split.disputeRows(jobId, three);

        vm.warp(block.timestamp + 24 hours);
        uint32[] memory late = new uint32[](1);
        late[0] = 9;
        RowSplit.RowProofs memory lateProofs = _proofs(jobId, 40, 30, UNIT, late);
        vm.prank(client);
        vm.expectRevert(RowSplit.WindowClosed.selector);
        split.disputeRows(jobId, lateProofs);
    }

    function test_panel_onlyPanelistsVote_once_andOnlyThePanelCanReverse() public {
        uint256 jobId = _settled(10, 10);
        uint256 roundId = _dispute(jobId, 10, 10, _range(3));
        vm.prank(stranger);
        vm.expectRevert(CheckerNet.NotPanelist.selector);
        net.vote(roundId, _steps(0, 0, 0));
        vm.prank(panelists[0]);
        net.vote(roundId, _steps(0, 0, 0));
        vm.prank(panelists[0]);
        vm.expectRevert(CheckerNet.AlreadyVoted.selector);
        net.vote(roundId, _steps(0, 0, 0));
        vm.expectRevert(CheckerNet.NotReady.selector);
        net.resolve(roundId); // one vote, deadline not reached

        uint16[] memory bps = new uint16[](3);
        vm.prank(stranger);
        vm.expectRevert(RowSplit.NotAllowed.selector);
        split.applyReversal(jobId, roundId, _range(3), bps);
    }

    function test_checkerStakeAndBondExits_areNeverBlockedByHalt() public {
        vm.prank(guardian);
        halt.halt();
        vm.startPrank(panelists[0]);
        net.requestUnstake(10e18);
        vm.expectRevert(CheckerNet.TooEarly.selector);
        net.withdrawUnstaked();
        vm.warp(block.timestamp + 7 days);
        net.withdrawUnstaked();
        vm.stopPrank();
        assertEq(ptoken.balanceOf(panelists[0]), 10e18);

        vm.startPrank(checker);
        bond.requestExit();
        vm.warp(vm.getBlockTimestamp() + 7 days);
        bond.withdraw();
        vm.stopPrank();
        assertEq(usd.balanceOf(checker), MIN_BOND);
    }

    // ───────────────────────── vault ─────────────────────────

    uint256 ownerPk = 0xA11CE;

    function _grant(uint64 perJob, uint64 perDay) private view returns (BalanceVault.SpendGrant memory g) {
        g = BalanceVault.SpendGrant({
            owner: vm.addr(ownerPk),
            keyId: bytes32("key-1"),
            perJobCapUsd6: perJob,
            perDayCapUsd6: perDay,
            expiresAt: uint64(block.timestamp + 30 days),
            periodCapUsd6: 49e6,
            minCoverageBps: 9500
        });
    }

    function _signGrant(uint256 pk, BalanceVault.SpendGrant memory g) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.grantDigest(g));
        return abi.encodePacked(r, s, v);
    }

    function _deposit(uint256 amount) private returns (address owner) {
        owner = vm.addr(ownerPk);
        usd.mint(owner, amount);
        vm.startPrank(owner);
        usd.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function test_vault_fundsAJobWithinTheGrant_andRefundsComeBackToTheBalance() public {
        address owner = _deposit(50e6);
        BalanceVault.SpendGrant memory g = _grant(25e6, 50e6);
        bytes memory sig = _signGrant(ownerPk, g);
        uint256 jobId = _open(_rows(10, UNIT, BASE, 0));
        uint256 budget = job.jobOf(jobId).budget;

        vm.prank(relayer);
        vault.fundJob(g, sig, jobId, budget);
        assertEq(vault.balanceOf(owner), 50e6 - budget);
        assertEq(job.jobOf(jobId).client, owner);
        assertEq(job.refundTo(jobId), address(vault));

        _settle(jobId, 10, 6, UNIT, 0); // 4 rows fail
        assertEq(vault.balanceOf(owner), 50e6 - budget + 4e6, "refund credited to the owner's vault balance");
        assertEq(usd.balanceOf(owner), 0);
    }

    function test_vault_expiryRefundAlsoReturnsToTheBalance() public {
        address owner = _deposit(50e6);
        BalanceVault.SpendGrant memory g = _grant(25e6, 50e6);
        uint256 jobId = _open(_rows(10, UNIT, BASE, 0));
        uint256 budget = job.jobOf(jobId).budget;
        bytes memory sig = _signGrant(ownerPk, g);
        vm.prank(relayer);
        vault.fundJob(g, sig, jobId, budget);
        vm.warp(block.timestamp + 2 hours);
        job.claimRefund(jobId);
        assertEq(vault.balanceOf(owner), 50e6);
    }

    function test_vault_withdrawIsOwnerOnly_andWorksWhileHalted() public {
        address owner = _deposit(50e6);
        BalanceVault.SpendGrant memory g = _grant(25e6, 50e6);
        uint256 jobId = _open(_rows(10, UNIT, BASE, 0));
        uint256 budget = job.jobOf(jobId).budget;
        bytes memory sig = _signGrant(ownerPk, g);
        vm.prank(relayer);
        vault.fundJob(g, sig, jobId, budget);

        vm.prank(guardian);
        halt.halt();
        vm.prank(relayer); // the relayer cannot withdraw anyone's balance
        vm.expectRevert(BalanceVault.Insufficient.selector);
        vault.withdraw(1, relayer);

        vm.prank(owner); // with a job open and the system halted
        vault.withdraw(50e6 - budget, owner);
        assertEq(usd.balanceOf(owner), 50e6 - budget);
        assertEq(vault.balanceOf(owner), 0);
    }

    function test_vault_grantLimits() public {
        _deposit(100e6);
        BalanceVault.SpendGrant memory g = _grant(12e6, 20e6);
        bytes memory sig = _signGrant(ownerPk, g);
        uint256 small = _open(_rows(10, UNIT, BASE, 0)); // $10.25
        uint256 big = _open(_rows(20, UNIT, BASE, 0)); // $20.25
        uint256 second = _open(_rows(10, UNIT, BASE, 0));

        vm.startPrank(relayer);
        vm.expectRevert(BalanceVault.OverCap.selector); // above the per-job cap
        vault.fundJob(g, sig, big, 20_250_000);
        vm.expectRevert(BalanceVault.BadGrant.selector); // amount must equal the job's budget
        vault.fundJob(g, sig, small, 5e6);
        vault.fundJob(g, sig, small, 10_250_000);
        vm.expectRevert(BalanceVault.OverCap.selector); // would pass the per-day cap
        vault.fundJob(g, sig, second, 10_250_000);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days); // a new day resets the daily cap
        uint256 third = _open(_rows(10, UNIT, BASE, 0));
        vm.prank(relayer);
        vault.fundJob(g, sig, third, 10_250_000);
    }

    function test_vault_rejectsForgedExpiredAndRevokedGrants_andNonRelayers() public {
        address owner = _deposit(100e6);
        BalanceVault.SpendGrant memory g = _grant(25e6, 50e6);
        bytes memory sig = _signGrant(ownerPk, g);
        uint256 jobId = _open(_rows(10, UNIT, BASE, 0));

        vm.prank(stranger);
        vm.expectRevert(BalanceVault.NotAllowed.selector);
        vault.fundJob(g, sig, jobId, 10_250_000);

        bytes memory badSig = _signGrant(0xBAD, g);
        vm.startPrank(relayer);
        vm.expectRevert(BalanceVault.BadGrant.selector); // signed by someone else
        vault.fundJob(g, badSig, jobId, 10_250_000);

        BalanceVault.SpendGrant memory widened = _grant(1000e6, 1000e6); // caps changed after signing
        vm.expectRevert(BalanceVault.BadGrant.selector);
        vault.fundJob(widened, sig, jobId, 10_250_000);
        vm.stopPrank();

        vm.prank(owner);
        vault.revokeGrant(g.keyId);
        vm.prank(relayer);
        vm.expectRevert(BalanceVault.BadGrant.selector);
        vault.fundJob(g, sig, jobId, 10_250_000);

        BalanceVault.SpendGrant memory other = _grant(25e6, 50e6);
        other.keyId = bytes32("key-2");
        bytes memory otherSig = _signGrant(ownerPk, other);
        vm.warp(block.timestamp + 31 days);
        vm.prank(relayer);
        vm.expectRevert(BalanceVault.BadGrant.selector); // expired
        vault.fundJob(other, otherSig, jobId, 10_250_000);
    }

    function test_vault_picketPeriodIsBilledOnce_andOnlyAbove95PercentCoverage() public {
        address owner = _deposit(100e6);
        BalanceVault.SpendGrant memory g = _grant(25e6, 60e6);
        g.minCoverageBps = 5000; // a grant cannot lower the 95% floor
        bytes memory sig = _signGrant(ownerPk, g);
        bytes32 period = keccak256("2026-11");

        vm.startPrank(relayer);
        vm.expectRevert(BalanceVault.LowCoverage.selector);
        vault.debitPeriod(g, sig, period, 49e6, 9499);
        vm.expectRevert(BalanceVault.OverCap.selector);
        vault.debitPeriod(g, sig, period, 50e6, 10_000);
        vault.debitPeriod(g, sig, period, 49e6, 9500);
        vm.expectRevert(BalanceVault.AlreadyDebited.selector);
        vault.debitPeriod(g, sig, period, 1e6, 10_000);
        vm.stopPrank();

        assertEq(vault.balanceOf(owner), 51e6);
        assertEq(usd.balanceOf(address(payouts)), (49e6 * 8000) / 10_000, "a period fee takes the same 80/10/5/5 split");
    }

    function test_vault_isWiredOnce() public {
        vm.expectRevert(BalanceVault.AlreadySet.selector);
        vault.wire(IJellyJob(address(1)), feeRouter);
    }

    // ───────────────────────── x402 forwarder ─────────────────────────

    function _pay(uint256 jobId, address payer, uint256 amount) private returns (address fwd) {
        fwd = factory.predict(IntakeForwarder.Mode.Job, jobId, payer);
        usd.mint(fwd, amount); // an x402 transfer straight to the forwarder address
    }

    function test_forwarder_fundsTheJobForThePayer_andReturnsAnyExcess() public {
        uint256 jobId = _open(_rows(10, UNIT, BASE, 0));
        uint256 budget = job.jobOf(jobId).budget;
        _pay(jobId, client, budget + 7);
        vm.prank(stranger); // anyone can sweep
        factory.deployAndSweep(IntakeForwarder.Mode.Job, jobId, client);
        assertEq(uint8(job.jobOf(jobId).status), uint8(IJellyJob.Status.Funded));
        assertEq(job.jobOf(jobId).client, client);
        assertEq(job.refundTo(jobId), client);
        assertEq(usd.balanceOf(client), 7);
    }

    function test_forwarder_afterExpiry_alwaysReturnsFundsToTheClient() public {
        uint256 jobId = _open(_rows(10, UNIT, BASE, 0));
        uint256 budget = job.jobOf(jobId).budget;
        address fwd = _pay(jobId, client, budget - 1); // short by one micro-dollar
        factory.deployAndSweep(IntakeForwarder.Mode.Job, jobId, client);
        assertEq(usd.balanceOf(fwd), budget - 1, "waits while the job can still be funded");

        vm.warp(block.timestamp + 2 hours);
        vm.prank(stranger);
        IntakeForwarder(fwd).sweep();
        assertEq(usd.balanceOf(client), budget - 1);
        assertEq(usd.balanceOf(fwd), 0);
    }

    function test_forwarder_whileHalted_holdsThenReturnsOnExpiry() public {
        uint256 jobId = _open(_rows(10, UNIT, BASE, 0));
        uint256 budget = job.jobOf(jobId).budget;
        address fwd = _pay(jobId, client, budget);
        vm.prank(guardian);
        halt.halt();
        factory.deployAndSweep(IntakeForwarder.Mode.Job, jobId, client);
        assertEq(usd.balanceOf(fwd), budget);
        vm.warp(block.timestamp + 2 hours);
        IntakeForwarder(fwd).sweep();
        assertEq(usd.balanceOf(client), budget);
    }

    function test_forwarder_aLatePaymentToAnAlreadyFundedJobGoesBack() public {
        uint256 jobId = _openFunded(10, UNIT, BASE, 0);
        _pay(jobId, stranger, 5e6);
        factory.deployAndSweep(IntakeForwarder.Mode.Job, jobId, stranger);
        assertEq(usd.balanceOf(stranger), 5e6);
    }

    function test_forwarder_topUpCreditsTheOwnersVaultBalance() public {
        address fwd = factory.predict(IntakeForwarder.Mode.TopUp, 0, client);
        usd.mint(fwd, 5e6);
        factory.deployAndSweep(IntakeForwarder.Mode.TopUp, 0, client);
        assertEq(vault.balanceOf(client), 5e6);
        vm.expectRevert(IntakeForwarder.AlreadyInitialized.selector);
        IntakeForwarder(fwd).initialize(job, IntakeForwarder.Mode.Job, 1, stranger);
    }

    // ───────────────────────── operator payouts ─────────────────────────

    function test_payouts_claimsArePermissionless_paidOnce_andNotBlockedByHalt() public {
        uint256 jobId = _settled(10, 10);
        vm.warp(block.timestamp + 24 hours);
        split.finalize(jobId);
        uint256 pool = usd.balanceOf(address(payouts));

        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = payouts.leafOf(1, WORKER_OPERATOR, pool - 100);
        leaves[1] = payouts.leafOf(1, 99, 100);
        vm.startPrank(keeper);
        vm.expectRevert(OperatorPayouts.Unfunded.selector); // cannot promise more than it holds
        payouts.postEpoch(1, _root(leaves), pool + 1);
        payouts.postEpoch(1, _root(leaves), pool);
        vm.expectRevert(OperatorPayouts.AlreadyPosted.selector);
        payouts.postEpoch(1, _root(leaves), 0);
        vm.stopPrank();

        vm.prank(guardian);
        halt.halt();
        address payout = registry.payoutOf(WORKER_OPERATOR);
        vm.prank(stranger);
        payouts.claim(1, WORKER_OPERATOR, pool - 100, _proof(leaves, 0));
        assertEq(usd.balanceOf(payout), pool - 100);

        vm.expectRevert(OperatorPayouts.AlreadyClaimed.selector);
        payouts.claim(1, WORKER_OPERATOR, pool - 100, _proof(leaves, 0));
        vm.expectRevert(OperatorPayouts.BadProof.selector);
        payouts.claim(1, WORKER_OPERATOR + 1, pool - 100, _proof(leaves, 0));
        vm.expectRevert(OperatorPayouts.NoPayout.selector); // operator 99 is not registered
        payouts.claim(1, 99, 100, _proof(leaves, 1));
    }

    // ───────────────────────── burn bucket ─────────────────────────

    function _twoFinalizedJobs() private returns (bytes32[] memory keys, uint256 share) {
        uint256 a = _settled(10, 10);
        uint256 b = _settled(10, 10);
        vm.warp(block.timestamp + 24 hours);
        split.finalize(a);
        split.finalize(b);
        keys = new bytes32[](2);
        keys[0] = split.jobKeyOf(a);
        keys[1] = split.jobKeyOf(b);
        share = ((10e6 + BASE) * 500) / 10_000;
        assertEq(burnBucket.accrued(keys[0]), share);
    }

    function test_burn_onlyOutsidePaidJobsFundABurn_andEachShareIsSpentOnce() public {
        (bytes32[] memory keys, uint256 share) = _twoFinalizedJobs();
        bytes32[] memory first = new bytes32[](1);
        first[0] = keys[0];
        bytes32[] memory second = new bytes32[](1);
        second[0] = keys[1];

        vm.prank(keeper);
        vm.expectRevert(BurnBucket.WrongClass.selector); // not classified yet
        burnBucket.burn(first, 0, "");

        vm.startPrank(classifier);
        burnBucket.classify(first, true);
        burnBucket.classify(second, false);
        vm.expectRevert(BurnBucket.AlreadyClassified.selector); // a class is written once
        burnBucket.classify(second, true);
        vm.stopPrank();

        vm.startPrank(keeper);
        vm.expectRevert(BurnBucket.WrongClass.selector); // a studio-linked job never burns
        burnBucket.burn(second, 0, "");
        vm.expectRevert(BurnBucket.WrongClass.selector);
        burnBucket.sweepNonExternal(first, "x");

        burnBucket.burn(first, 0, "");
        assertEq(swapper.totalIn(), share, "amount in == sum accrued");
        vm.expectRevert(BurnBucket.NothingAccrued.selector);
        burnBucket.burn(first, 0, "");

        uint256 before = usd.balanceOf(treasury);
        burnBucket.sweepNonExternal(second, "studio-funded");
        assertEq(usd.balanceOf(treasury) - before, share);
        vm.stopPrank();

        vm.expectRevert(BurnBucket.NoRoute.selector);
        burnBucket.bridgeOut(first, "");
        vm.prank(stranger);
        vm.expectRevert(BurnBucket.NotAllowed.selector);
        burnBucket.accrue(keys[0], 1);
    }

    // ───────────────────────── operator registry ─────────────────────────

    function test_registry_stakeSlashThreeStrikesAndExit() public {
        address op = makeAddr("operator");
        usd.mint(op, 100e6);
        vm.startPrank(op);
        usd.approve(address(registry), 100e6);
        vm.expectRevert(OperatorRegistry.LowStake.selector);
        registry.register(7, op, bytes32("ep"), OperatorRegistry.Route.FINGERPRINT, 49e6, 0);
        vm.expectRevert(OperatorRegistry.NotAllowed.selector); // only governance registers studio ids
        registry.register(7, op, bytes32("ep"), OperatorRegistry.Route.STUDIO, 100e6, 0);
        registry.register(7, op, bytes32("ep"), OperatorRegistry.Route.FINGERPRINT, 100e6, 0);
        vm.expectRevert(OperatorRegistry.Taken.selector);
        registry.register(7, op, bytes32("ep"), OperatorRegistry.Route.TEE, 0, 0);
        vm.stopPrank();
        assertTrue(registry.isActive(7));

        vm.prank(stranger);
        vm.expectRevert(OperatorRegistry.NotAllowed.selector);
        registry.slash(7, 1000, bytes32("evidence"));

        vm.startPrank(nodeAuditor);
        registry.slash(7, 1000, bytes32("e1")); // 100 → 90
        registry.slash(7, 1000, bytes32("e2")); // 90 → 81
        assertTrue(registry.isActive(7));
        registry.slash(7, 1000, bytes32("e3")); // 81 → 72.9, third strike
        vm.stopPrank();
        assertFalse(registry.isActive(7));
        assertEq(usd.balanceOf(treasury), 10e6 + 9e6 + 8_100_000);

        vm.prank(guardian);
        halt.halt();
        vm.startPrank(op);
        vm.expectRevert(OperatorRegistry.TooEarly.selector);
        registry.withdrawStake(7);
        vm.warp(block.timestamp + 7 days);
        registry.withdrawStake(7); // never pausable
        vm.stopPrank();
        assertEq(usd.balanceOf(op), 72_900_000);
    }

    // ───────────────────────── timelock and meter ─────────────────────────

    function test_timelock_changesWait48Hours() public {
        AdminTimelock tl = new AdminTimelock(address(this));
        bytes memory data = abi.encodeCall(AdminTimelock.setAdmin, (stranger));
        vm.expectRevert(AdminTimelock.NotQueued.selector);
        tl.execute(address(tl), 0, data, bytes32(0));
        tl.queue(address(tl), 0, data, bytes32(0));
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert(AdminTimelock.TooEarly.selector);
        tl.execute(address(tl), 0, data, bytes32(0));
        vm.warp(block.timestamp + 1);
        tl.execute(address(tl), 0, data, bytes32(0));
        assertEq(tl.admin(), stranger);
        vm.expectRevert(AdminTimelock.NotAdmin.selector);
        tl.queue(address(tl), 0, data, bytes32(0));
    }

    function test_meter_isAppendOnly() public {
        VolumeMeter.Day memory d = VolumeMeter.Day(20_407, 0, 100e6, 5e6, 2e6, 1e6, 0, bytes32("jobs"));
        vm.prank(stranger);
        vm.expectRevert(VolumeMeter.NotAllowed.selector);
        meter.post(d);
        vm.startPrank(classifier);
        meter.post(d);
        d.realUsd6 = 999e6;
        vm.expectRevert(VolumeMeter.AlreadyPosted.selector);
        meter.post(d);
        vm.stopPrank();
        assertEq(meter.dayOf(20_407, 0).realUsd6, 100e6);
    }
}
