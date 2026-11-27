// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IBalanceVault, IJellyJob} from "./Interfaces.sol";

/// @title IntakeForwarder
/// @notice A one-purpose deposit address for an x402 payment (§9.2). Its address is known
///         before it exists, so a payer can send to it directly. `sweep` then moves the
///         money to exactly one of two places: the escrow (or vault) it was created for,
///         or back to the client. Never anywhere else.
contract IntakeForwarder {
    using SafeERC20 for IERC20;

    enum Mode {
        Job,
        TopUp
    }

    IJellyJob public jellyJob;
    IERC20 public token;
    Mode public mode;
    /// Job mode: the job to fund. TopUp mode: unused.
    uint256 public jobId;
    /// Job mode: the payer, who is also where refunds go. TopUp mode: the vault owner.
    address public client;

    event SweptToJob(uint256 indexed jobId, uint256 amount);
    event SweptToVault(address indexed owner, uint256 amount);
    event Returned(address indexed client, uint256 amount);

    error AlreadyInitialized();

    function initialize(IJellyJob jellyJob_, Mode mode_, uint256 jobId_, address client_) external {
        if (address(jellyJob) != address(0)) revert AlreadyInitialized();
        jellyJob = jellyJob_;
        token = IERC20(jellyJob_.token());
        mode = mode_;
        jobId = jobId_;
        client = client_;
    }

    /// Callable by anyone, any number of times.
    function sweep() external {
        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) return;

        if (mode == Mode.TopUp) {
            address vault = jellyJob.vault();
            token.forceApprove(vault, balance);
            try IBalanceVault(vault).depositFor(client, balance) {
                emit SweptToVault(client, balance);
            } catch {
                token.forceApprove(vault, 0);
                _return(balance);
            }
            return;
        }

        IJellyJob.Job memory j = jellyJob.jobOf(jobId);
        bool fundable = j.status == IJellyJob.Status.Open && block.timestamp < j.expiredAt && j.budget != 0;
        if (!fundable) {
            // Expired, cancelled, or already funded another way: the payer gets everything back.
            _return(balance);
            return;
        }
        if (balance < j.budget) return; // not enough yet; wait for the rest, or for expiry

        token.forceApprove(address(jellyJob), j.budget);
        try jellyJob.fundFor(jobId, client, client, "") {
            emit SweptToJob(jobId, j.budget);
            uint256 extra = balance - j.budget;
            if (extra != 0) _return(extra);
        } catch {
            // e.g. the system is halted. Leave the money here: it can be swept into the
            // job later, and is returned to the payer once the job expires.
            token.forceApprove(address(jellyJob), 0);
        }
    }

    function _return(uint256 amount) private {
        token.safeTransfer(client, amount);
        emit Returned(client, amount);
    }
}

/// @title IntakeForwarderFactory
/// @notice Deploys forwarders at addresses that depend only on (mode, jobId, client).
contract IntakeForwarderFactory {
    address public immutable implementation;
    IJellyJob public immutable jellyJob;

    event ForwarderDeployed(address indexed forwarder, IntakeForwarder.Mode mode, uint256 jobId, address client);

    constructor(IJellyJob jellyJob_) {
        jellyJob = jellyJob_;
        implementation = address(new IntakeForwarder());
    }

    function saltOf(IntakeForwarder.Mode mode, uint256 jobId, address client) public pure returns (bytes32) {
        return keccak256(abi.encode(mode, jobId, client));
    }

    /// The address to pay, whether or not the forwarder has been deployed yet.
    function predict(IntakeForwarder.Mode mode, uint256 jobId, address client) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, saltOf(mode, jobId, client), address(this));
    }

    /// Deploys the forwarder if needed, then sweeps it. Anyone may call.
    function deployAndSweep(IntakeForwarder.Mode mode, uint256 jobId, address client) external returns (address fwd) {
        fwd = predict(mode, jobId, client);
        if (fwd.code.length == 0) {
            Clones.cloneDeterministic(implementation, saltOf(mode, jobId, client));
            IntakeForwarder(fwd).initialize(jellyJob, mode, jobId, client);
            emit ForwarderDeployed(fwd, mode, jobId, client);
        }
        IntakeForwarder(fwd).sweep();
    }
}
