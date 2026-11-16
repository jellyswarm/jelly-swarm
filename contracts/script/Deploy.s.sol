// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AdminTimelock, HaltSwitch} from "../src/Admin.sol";
import {JellyJob} from "../src/JellyJob.sol";
import {RowSplit} from "../src/RowSplit.sol";
import {ReceiptRoot} from "../src/ReceiptRoot.sol";
import {CheckerBond, CheckerNet} from "../src/Checkers.sol";
import {BalanceVault} from "../src/BalanceVault.sol";
import {IntakeForwarderFactory} from "../src/IntakeForwarder.sol";
import {FeeRouter, BurnBucket} from "../src/Fees.sol";
import {OperatorRegistry, OperatorPayouts} from "../src/Operators.sol";
import {ICheckerNet, IHaltSwitch} from "../src/Interfaces.sol";

/// A minimal ERC20 for local/test deployments only; a real deployment passes USD_ADDRESS instead.
contract TestUSD is ERC20 {
    constructor() ERC20("Test USD", "tUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TestProductToken is ERC20 {
    constructor() ERC20("Test JellySwarm", "tJELLY") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * Deploys the whole contract set with the same wiring as test/Base.t.sol's
 * setUp(), minus test-only accounts (panelists, a bonded checker). Every
 * role defaults to the deployer when its env var is unset — fine for a
 * local/dev deploy, never for a real one: give each role its own key there.
 *
 * Usage:
 *   forge script script/Deploy.s.sol:Deploy --rpc-url <url> --private-key <deployer> --broadcast
 *
 * Env vars (all optional except where noted):
 *   USD_ADDRESS           an existing ERC20 stablecoin; deploys TestUSD if unset (local/test only)
 *   PRODUCT_TOKEN_ADDRESS an existing ERC20; deploys TestProductToken if unset (local/test only)
 *   TIMELOCK_WAIT_SECONDS default 48 hours if unset
 *   GUARDIAN, QUOTER, KEEPER, SEALER, RELAYER, CLASSIFIER, NODE_AUDITOR, TREASURY, CHECKER_POOL
 */
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address guardian = vm.envOr("GUARDIAN", deployer);
        address quoter = vm.envOr("QUOTER", deployer);
        address keeper = vm.envOr("KEEPER", deployer);
        address sealer = vm.envOr("SEALER", deployer);
        address relayer = vm.envOr("RELAYER", deployer);
        address classifier = vm.envOr("CLASSIFIER", deployer);
        address nodeAuditor = vm.envOr("NODE_AUDITOR", deployer);
        address treasury = vm.envOr("TREASURY", deployer);
        address checkerPool = vm.envOr("CHECKER_POOL", deployer);

        vm.startBroadcast(deployerKey);

        IERC20 usd = IERC20(vm.envOr("USD_ADDRESS", address(0)));
        if (address(usd) == address(0)) {
            console.log("USD_ADDRESS not set: deploying TestUSD (local/test only)");
            usd = IERC20(address(new TestUSD()));
        }
        IERC20 productToken = IERC20(vm.envOr("PRODUCT_TOKEN_ADDRESS", address(0)));
        if (address(productToken) == address(0)) {
            console.log("PRODUCT_TOKEN_ADDRESS not set: deploying TestProductToken (local/test only)");
            productToken = IERC20(address(new TestProductToken()));
        }

        HaltSwitch halt = new HaltSwitch(guardian, deployer);
        BalanceVault vault = new BalanceVault(usd, deployer, relayer);
        JellyJob job = new JellyJob(usd, IHaltSwitch(address(halt)), address(vault));
        ReceiptRoot receiptRoot = new ReceiptRoot(sealer, deployer);
        CheckerBond bond = new CheckerBond(usd, productToken, deployer, treasury, 100e6);
        OperatorRegistry registry = new OperatorRegistry(usd, productToken, deployer, nodeAuditor, treasury, 50e6, 0);
        OperatorPayouts payouts = new OperatorPayouts(usd, registry, deployer, keeper);
        BurnBucket burnBucket = new BurnBucket(usd, deployer, classifier, keeper, treasury);
        FeeRouter feeRouter = new FeeRouter(usd, deployer, address(payouts), burnBucket, treasury, checkerPool);
        burnBucket.setFeeRouter(address(feeRouter));
        RowSplit split =
            new RowSplit(job, receiptRoot, bond, feeRouter, IHaltSwitch(address(halt)), deployer, quoter, keeper, treasury);
        CheckerNet net = new CheckerNet(productToken, split, deployer, 1e18);
        split.setCheckerNet(ICheckerNet(address(net)));
        bond.setRowSplit(address(split));
        feeRouter.setSource(address(split), true);
        feeRouter.setSource(address(vault), true);
        vault.wire(job, feeRouter);
        IntakeForwarderFactory factory = new IntakeForwarderFactory(job);

        vm.stopBroadcast();

        console.log("usd               ", address(usd));
        console.log("productToken      ", address(productToken));
        console.log("haltSwitch        ", address(halt));
        console.log("jellyJob          ", address(job));
        console.log("rowSplit          ", address(split));
        console.log("receiptRoot       ", address(receiptRoot));
        console.log("checkerBond       ", address(bond));
        console.log("checkerNet        ", address(net));
        console.log("balanceVault      ", address(vault));
        console.log("operatorRegistry  ", address(registry));
        console.log("operatorPayouts   ", address(payouts));
        console.log("feeRouter         ", address(feeRouter));
        console.log("burnBucket        ", address(burnBucket));
        console.log("forwarderFactory  ", address(factory));
    }
}
