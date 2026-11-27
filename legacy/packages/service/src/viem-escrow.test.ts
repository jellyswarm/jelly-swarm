import { VERDICT_TYPES, verdictDomain } from "@jelly/checker";
import { describe, expect, test } from "bun:test";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ViemEscrowAddresses } from "./viem-escrow";
import { ViemEscrow } from "./viem-escrow";

/**
 * Needs a local anvil node with the contracts deployed by
 * contracts/script/Deploy.s.sol (see that file's header for the command).
 * Skipped when anvil is not reachable, unless REQUIRE_INFRA=1.
 *
 * The deployer key below is anvil's well-known, publicly-documented default
 * account #0 — the same test-only key already used throughout
 * packages/x402/src/x402.test.ts — never a real secret.
 */
const RPC_URL = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const CLIENT_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const CHECKER_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const publicClient = createPublicClient({ transport: http(RPC_URL) });
const chainUp = await publicClient.getChainId().then(() => true, () => false);
if (!chainUp && process.env.REQUIRE_INFRA === "1") throw new Error("REQUIRE_INFRA=1 but anvil is not reachable");

describe.skipIf(!chainUp)("ViemEscrow against a real deployment (anvil)", () => {
  test("openJob, wallet-fund, seal, settle and finalize all land on chain", async () => {
    const chainId = await publicClient.getChainId();
    const deployer = privateKeyToAccount(DEPLOYER_PK);
    const client = privateKeyToAccount(CLIENT_PK);
    const checker = privateKeyToAccount(CHECKER_PK);
    const deployerWallet = createWalletClient({ account: deployer, transport: http(RPC_URL) });
    const clientWallet = createWalletClient({ account: client, transport: http(RPC_URL) });

    // Addresses from contracts/script/Deploy.s.sol's broadcast log, run against this same anvil instance.
    const addresses: ViemEscrowAddresses = {
      jellyJob: process.env.VIEM_ESCROW_TEST_JELLY_JOB as Address,
      rowSplit: process.env.VIEM_ESCROW_TEST_ROW_SPLIT as Address,
      receiptRoot: process.env.VIEM_ESCROW_TEST_RECEIPT_ROOT as Address,
      balanceVault: process.env.VIEM_ESCROW_TEST_BALANCE_VAULT as Address,
      forwarderFactory: process.env.VIEM_ESCROW_TEST_FORWARDER_FACTORY as Address,
    };
    const usdAddress = process.env.VIEM_ESCROW_TEST_USD as Address;
    const checkerBondAddress = process.env.VIEM_ESCROW_TEST_CHECKER_BOND as Address;
    expect(addresses.rowSplit, "run Deploy.s.sol and set VIEM_ESCROW_TEST_* env vars to its logged addresses").toBeTruthy();

    const TEST_USD_ABI = parseAbi(["function mint(address to, uint256 amount)", "function approve(address spender, uint256 amount) returns (bool)"]);
    const CHECKER_BOND_ABI = parseAbi([
      "function assignOperator(address signer, uint64 operatorId)",
      "function bond(uint256 usdcAmt, uint256 tokenAmt)",
    ]);

    // Bond a checker on a different operator id from the worker, so settle() accepts its signature.
    await deployerWallet.writeContract({
      chain: null,
      address: checkerBondAddress,
      abi: CHECKER_BOND_ABI,
      functionName: "assignOperator",
      args: [checker.address, 2n],
    });
    await deployerWallet.writeContract({ chain: null, address: usdAddress, abi: TEST_USD_ABI, functionName: "mint", args: [checker.address, 100_000_000n] });
    const checkerWallet = createWalletClient({ account: checker, transport: http(RPC_URL) });
    await checkerWallet.writeContract({ chain: null, address: usdAddress, abi: TEST_USD_ABI, functionName: "approve", args: [checkerBondAddress, 100_000_000n] });
    const bondHash = await checkerWallet.writeContract({
      chain: null,
      address: checkerBondAddress,
      abi: CHECKER_BOND_ABI,
      functionName: "bond",
      args: [100_000_000n, 0n],
    });
    await publicClient.waitForTransactionReceipt({ hash: bondHash });

    const escrow = new ViemEscrow({
      chain: "base",
      chainId,
      network: `eip155:${chainId}`,
      asset: { address: usdAddress, symbol: "tUSD", name: "Test USD", version: "1" },
      publicClient,
      quoterWallet: deployerWallet,
      keeperWallet: deployerWallet,
      sealerWallet: deployerWallet,
      relayerWallet: deployerWallet,
      addresses,
    });

    const { jobId, jobKey } = await escrow.openJob({
      rows: 10,
      unitUsd6: 15_000n,
      baseUsd6: 250_000n,
      toolsCapUsd6: 0n,
      workerOperatorId: 1n,
      expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(await escrow.status(jobId)).toBe("open");

    const budget = 250_000n + 10n * 15_000n;
    await deployerWallet.writeContract({ chain: null, address: usdAddress, abi: TEST_USD_ABI, functionName: "mint", args: [client.address, budget] });
    const calls = await escrow.walletFundCalls(jobId, client.address, budget);
    for (const call of calls) {
      const hash = await clientWallet.sendTransaction({ chain: null, to: call.to, data: call.data });
      await publicClient.waitForTransactionReceipt({ hash });
    }
    expect(await escrow.status(jobId)).toBe("funded");

    const receiptsRoot = keccak256(toBytes("test-receipts-root"));
    await escrow.seal(jobKey, { root: receiptsRoot, count: 1, head: receiptsRoot });

    const verdict = { jobKey, rowCount: 10, passedCount: 8, rowsRoot: keccak256(toBytes("rows-root")), receiptsRoot, toolsUsd6: 0n };
    const signature = await checker.signTypedData({
      domain: verdictDomain({ chainId, verifyingContract: addresses.rowSplit }),
      types: VERDICT_TYPES,
      primaryType: "Verdict",
      message: verdict,
    });
    const { releaseAtSec } = await escrow.settle(jobId, verdict, signature);
    expect(releaseAtSec).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(await escrow.status(jobId)).toBe("settled");
    expect(await escrow.roundsOpen(jobId)).toBe(0);

    // Advance anvil past the 24h dispute window, then finalize.
    await publicClient.transport.request({ method: "evm_increaseTime", params: [24 * 3600 + 1] });
    await publicClient.transport.request({ method: "evm_mine", params: [] });
    await escrow.finalize(jobId);
    expect(await escrow.status(jobId)).toBe("finalized");
  }, 60_000);
});
