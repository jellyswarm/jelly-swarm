// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {RowSplit} from "../src/RowSplit.sol";
import {JellyJob} from "../src/JellyJob.sol";
import {BalanceVault} from "../src/BalanceVault.sol";
import {IntakeForwarder} from "../src/IntakeForwarder.sol";
import {CheckerNet} from "../src/Checkers.sol";
import {OperatorRegistry, OperatorPayouts} from "../src/Operators.sol";
import {IJellyJob} from "../src/Interfaces.sol";

/// @title KillSwitchDrill
/// @notice §13's kill-switch table, run as one drill: the guardian's halt blocks
/// createJob, fund and settle; it blocks no new wave starting (covered by the
/// gateway's own heartbeat logic off-chain, not here); and it never blocks any
/// of the functions in the "never blocks" list, however much money or state
/// each is holding at the time.
///
/// Run on its own with `forge test --match-contract KillSwitchDrill`.
///
/// The build doc asks for this drill on both the anvil fork and
/// solana-test-validator. Only the EVM half exists: the Solana program
/// (`programs/jelly_sol`, §6.2) is a later phase, so its half of the table —
/// `jelly_sol.withdraw` and `jelly_sol.claim` — is not yet provable and is
/// tracked in docs/day1.md instead of asserted here.
contract KillSwitchDrillTest is Base {
    uint64 constant UNIT = 1_000_000; // $1/row, so amounts in assertions read as whole dollars
    uint64 constant BASE = 250_000;

    // ───────────────────────── blocked while halted ─────────────────────────

    function test_halted_blocksOpeningAJob() public {
        vm.prank(guardian);
        halt.halt();

        vm.prank(quoter);
        vm.expectRevert(RowSplit.Halted.selector);
        split.openJob(_rows(1, UNIT, BASE, 0), uint64(block.timestamp + 1 hours), "");
    }

    function test_halted_blocksFundingAJob() public {
        // The job exists before the halt; funding it is still refused.
        uint256 jobId = _open(_rows(5, UNIT, BASE, 0));
        vm.prank(guardian);
        halt.halt();

        usd.mint(client, 10e6);
        vm.startPrank(client);
        usd.approve(address(job), 10e6);
        vm.expectRevert(JellyJob.Halted.selector);
        job.fundFor(jobId, client, client, "");
        vm.stopPrank();
    }

    function test_halted_blocksSettlement() public {
        uint256 jobId = _openFunded(5, UNIT, BASE, 0);
        RowSplit.Verdict memory v = _verdict(jobId, 5, 5, UNIT, 0);
        _seal(v);
        vm.prank(guardian);
        halt.halt();

        vm.prank(keeper);
        vm.expectRevert(RowSplit.Halted.selector);
        split.settle(jobId, v, _sign(checkerPk, v));
    }

    // ───────────────────────── never blocked while halted ─────────────────────────

    /// claimRefund: a funded, unsettled job past its expiry refunds in full, halted or not.
    function test_neverBlocked_claimRefund() public {
        uint256 jobId = _openFunded(5, UNIT, BASE, 0);
        uint256 budget = job.jobOf(jobId).budget;
        vm.warp(block.timestamp + 2 hours);
        vm.prank(guardian);
        halt.halt();

        vm.prank(stranger); // anyone, not just the client
        job.claimRefund(jobId);
        assertEq(usd.balanceOf(client), budget);
        assertEq(uint8(job.jobOf(jobId).status), uint8(IJellyJob.Status.Expired));
    }

    /// IntakeForwarder.sweep, the refund path: an expired, unswept x402 payment returns to the payer.
    function test_neverBlocked_forwarderRefundSweep() public {
        uint256 jobId = _open(_rows(5, UNIT, BASE, 0));
        uint256 budget = job.jobOf(jobId).budget;
        address fwd = factory.predict(IntakeForwarder.Mode.Job, jobId, client);
        usd.mint(fwd, budget);
        vm.warp(block.timestamp + 2 hours); // the job can no longer be funded this way
        vm.prank(guardian);
        halt.halt();

        factory.deployAndSweep(IntakeForwarder.Mode.Job, jobId, client);
        assertEq(usd.balanceOf(client), budget);
    }

    /// BalanceVault.withdraw: the owner's prepaid balance is theirs even while halted and
    /// even with an open job and an active grant.
    function test_neverBlocked_vaultWithdraw() public {
        uint256 ownerPk = 0xA11CE;
        address owner = vm.addr(ownerPk);
        usd.mint(owner, 20e6);
        vm.startPrank(owner);
        usd.approve(address(vault), 20e6);
        vault.deposit(20e6);
        vm.stopPrank();
        vm.prank(guardian);
        halt.halt();

        vm.prank(owner);
        vault.withdraw(20e6, owner);
        assertEq(usd.balanceOf(owner), 20e6);
        assertEq(vault.balanceOf(owner), 0);
    }

    /// RowSplit.finalize: a settled job past its dispute window, with no round open, still releases.
    function test_neverBlocked_finalize() public {
        uint256 jobId = _openFunded(5, UNIT, BASE, 0);
        _settle(jobId, 5, 5, UNIT, 0);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(guardian);
        halt.halt();

        split.finalize(jobId);
        assertGt(usd.balanceOf(address(payouts)), 0);
    }

    /// OperatorPayouts.claim: a posted epoch pays out on proof, whoever calls it, halted or not.
    function test_neverBlocked_operatorPayoutsClaim() public {
        uint256 jobId = _openFunded(5, UNIT, BASE, 0);
        _settle(jobId, 5, 5, UNIT, 0);
        vm.warp(block.timestamp + 24 hours);
        split.finalize(jobId);
        uint256 pool = usd.balanceOf(address(payouts));
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = payouts.leafOf(1, WORKER_OPERATOR, pool);
        vm.prank(keeper);
        payouts.postEpoch(1, _root(leaves), pool);
        vm.prank(guardian);
        halt.halt();

        address payout = registry.payoutOf(WORKER_OPERATOR);
        vm.prank(stranger);
        payouts.claim(1, WORKER_OPERATOR, pool, _proof(leaves, 0));
        assertEq(usd.balanceOf(payout), pool);
    }

    /// OperatorRegistry.withdrawStake: a community operator's stake, once its exit cooldown has
    /// passed, comes back whatever the halt switch says.
    function test_neverBlocked_operatorRegistryWithdrawStake() public {
        address op = makeAddr("communityOperator");
        usd.mint(op, 100e6);
        vm.startPrank(op);
        usd.approve(address(registry), 100e6);
        registry.register(9, op, bytes32("ep"), OperatorRegistry.Route.FINGERPRINT, 100e6, 0);
        registry.requestExit(9);
        vm.stopPrank();
        vm.warp(block.timestamp + 7 days);
        vm.prank(guardian);
        halt.halt();

        vm.prank(op);
        registry.withdrawStake(9);
        assertEq(usd.balanceOf(op), 100e6);
    }

    /// CheckerNet.withdrawUnstaked: a checker's unstaked tokens, past the cooldown, are never held hostage.
    function test_neverBlocked_checkerNetWithdrawUnstaked() public {
        vm.prank(panelists[0]);
        net.requestUnstake(10e18);
        vm.warp(block.timestamp + 7 days);
        vm.prank(guardian);
        halt.halt();

        vm.prank(panelists[0]);
        net.withdrawUnstaked();
        assertEq(ptoken.balanceOf(panelists[0]), 10e18);
    }

    /// CheckerBond.withdraw: a verdict signer's bond, past its own exit cooldown, is also exempt
    /// (§6.1: "Operator payout claims and checker unstake withdrawals are never pausable" covers
    /// this bond the same way it covers CheckerNet's stake).
    function test_neverBlocked_checkerBondWithdraw() public {
        vm.prank(checker);
        bond.requestExit();
        vm.warp(block.timestamp + 7 days);
        vm.prank(guardian);
        halt.halt();

        vm.prank(checker);
        bond.withdraw();
        assertEq(usd.balanceOf(checker), MIN_BOND);
    }

    // ───────────────────────── the switch itself ─────────────────────────

    function test_onlyGuardianHalts_onlyTimelockResumes() public {
        vm.prank(stranger);
        vm.expectRevert();
        halt.halt();
        vm.prank(guardian);
        halt.halt();
        assertTrue(halt.halted());

        vm.prank(stranger);
        vm.expectRevert();
        halt.resume();
        vm.prank(guardian); // not even the guardian can resume its own halt
        vm.expectRevert();
        halt.resume();

        halt.resume(); // only the timelock (this test contract) can
        assertFalse(halt.halted());
    }
}
