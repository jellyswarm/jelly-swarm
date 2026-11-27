import type { Verdict, VerdictDomainParams } from "@jelly/checker";
import type { Seal } from "@jelly/receipts";
import type { ChainKey } from "@jelly/shared";
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  decodeEventLog,
  encodeFunctionData,
  parseAbi,
} from "viem";
import type { Escrow, EscrowStatus, OpenJobArgs, SignedGrant, UnsignedCall } from "./escrow";

const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

const JELLY_JOB_ABI = parseAbi([
  "struct Job { address client; address refundTo; address provider; address evaluator; address hook; uint256 budget; uint64 expiredAt; uint8 status; }",
  "function jobOf(uint256 jobId) view returns (Job)",
  "function fundFor(uint256 jobId, address client, address refundTo, bytes optParams)",
  "function claimRefund(uint256 jobId)",
]);

const ROW_SPLIT_ABI = parseAbi([
  "struct Rows { uint32 rowCount; uint64 unitUsd6; uint64 baseUsd6; uint64 toolsCapUsd6; uint64 workerOperatorId; }",
  "struct Verdict { bytes32 jobKey; uint32 rowCount; uint32 passedCount; bytes32 rowsRoot; bytes32 receiptsRoot; uint64 toolsUsd6; }",
  "struct State { bool settled; bool finalized; uint16 openRounds; uint32 passedCount; uint32 fullyReversed; uint64 releaseAt; uint64 window; address signer; bytes32 rowsRoot; uint256 heldGross; uint256 heldTools; uint256 refunded; }",
  "event JobOpened(uint256 indexed jobId, bytes32 indexed jobKey, uint32 rowCount, uint64 unitUsd6, uint256 budget)",
  "event Settled(uint256 indexed jobId, uint32 passed, uint256 refunded, uint256 heldGross, uint64 releaseAt)",
  "function openJob(Rows r, uint64 expiredAt, string description) returns (uint256 jobId)",
  "function jobKeyOf(uint256 jobId) view returns (bytes32)",
  "function jobOf(uint256 jobId) view returns (Rows, State)",
  "function settle(uint256 jobId, Verdict v, bytes checkerSig)",
  "function finalize(uint256 jobId)",
]);

const RECEIPT_ROOT_ABI = parseAbi(["function seal(bytes32 jobKey, bytes32 root, uint32 count, bytes32 head)"]);

const BALANCE_VAULT_ABI = parseAbi([
  "struct SpendGrant { address owner; bytes32 keyId; uint64 perJobCapUsd6; uint64 perDayCapUsd6; uint64 expiresAt; uint64 periodCapUsd6; uint16 minCoverageBps; }",
  "function fundJob(SpendGrant g, bytes ownerSig, uint256 jobId, uint256 amount)",
]);

const FORWARDER_FACTORY_ABI = parseAbi([
  "function predict(uint8 mode, uint256 jobId, address client) view returns (address)",
  "function deployAndSweep(uint8 mode, uint256 jobId, address client) returns (address fwd)",
]);

const MODE_JOB = 0;
const MODE_TOP_UP = 1;

export type ViemEscrowAddresses = {
  jellyJob: Address;
  rowSplit: Address;
  receiptRoot: Address;
  balanceVault: Address;
  forwarderFactory: Address;
};

export type ViemEscrowDeps = {
  chain: ChainKey;
  chainId: number;
  /** CAIP-2 id, e.g. "eip155:8453". */
  network: string;
  asset: { address: Address; symbol: string; name: string; version: string };
  publicClient: PublicClient;
  /** Separate keys per role, matching the contracts' own access control. All may be the same account. */
  quoterWallet: WalletClient;
  keeperWallet: WalletClient;
  sealerWallet: WalletClient;
  relayerWallet: WalletClient;
  addresses: ViemEscrowAddresses;
};

const STATUS_BY_CODE = ["none", "open", "funded", "submitted", "completed", "rejected", "expired"] as const;

/**
 * viem-backed Escrow against the deployed RowSplit/JellyJob/ReceiptRoot/
 * BalanceVault/IntakeForwarderFactory contracts (day1.md #23; the contracts
 * this calls are the ones under `contracts/`, exercised by `forge test`).
 *
 * `openAuditRound` is NOT implemented: `RowSplit.auditRows` needs a merkle
 * proof over every row's leaf — `(jobKey, rowIdx, passed, workerOperatorId,
 * unitUsd6, receiptsHash)` — and `receiptsHash` is only ever recorded as a
 * placeholder in tests. Nothing in `@jelly/engine`'s `RowResult` or
 * `@jelly/receipts` currently tracks a row's real sealed receipts hash, so
 * there is no correct proof to build yet; shipping a guess here would make
 * audits fail silently against real money, which is worse than refusing.
 * Closing this needs that hash threaded through the engine/merger first.
 */
export class ViemEscrow implements Escrow {
  readonly chain: ChainKey;
  readonly network: string;
  readonly asset: { address: Address; symbol: string; name: string; version: string };

  constructor(private readonly deps: ViemEscrowDeps) {
    this.chain = deps.chain;
    this.network = deps.network;
    this.asset = deps.asset;
  }

  verdictDomain(): VerdictDomainParams {
    return { chainId: this.deps.chainId, verifyingContract: this.deps.addresses.rowSplit };
  }

  grantDomain(): { chainId: number; verifyingContract: Address } {
    return { chainId: this.deps.chainId, verifyingContract: this.deps.addresses.balanceVault };
  }

  async openJob(args: OpenJobArgs): Promise<{ jobId: bigint; jobKey: Hex }> {
    const { request } = await this.deps.publicClient.simulateContract({
      address: this.deps.addresses.rowSplit,
      abi: ROW_SPLIT_ABI,
      functionName: "openJob",
      args: [
        { rowCount: args.rows, unitUsd6: args.unitUsd6, baseUsd6: args.baseUsd6, toolsCapUsd6: args.toolsCapUsd6, workerOperatorId: args.workerOperatorId },
        BigInt(args.expiresAtSec),
        "",
      ],
      account: this.deps.quoterWallet.account,
    });
    const hash = await this.deps.quoterWallet.writeContract(request);
    const receipt = await this.deps.publicClient.waitForTransactionReceipt({ hash });
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: ROW_SPLIT_ABI, eventName: "JobOpened", data: log.data, topics: log.topics });
        return { jobId: decoded.args.jobId, jobKey: decoded.args.jobKey };
      } catch {
        continue;
      }
    }
    throw new Error("openJob transaction mined without a JobOpened event");
  }

  async status(jobId: bigint): Promise<EscrowStatus> {
    const job = await this.deps.publicClient.readContract({
      address: this.deps.addresses.jellyJob,
      abi: JELLY_JOB_ABI,
      functionName: "jobOf",
      args: [jobId],
    });
    const status = STATUS_BY_CODE[job.status] ?? "open";
    if (status === "submitted") return "funded";
    if (status === "rejected") return "refunded";
    if (status !== "completed") return status as EscrowStatus;

    const [, state] = await this.deps.publicClient.readContract({
      address: this.deps.addresses.rowSplit,
      abi: ROW_SPLIT_ABI,
      functionName: "jobOf",
      args: [jobId],
    });
    return state.finalized ? "finalized" : "settled";
  }

  async walletFundCalls(jobId: bigint, client: Address, amountUsd6: bigint): Promise<UnsignedCall[]> {
    return [
      {
        to: this.asset.address,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [this.deps.addresses.jellyJob, amountUsd6] }),
        note: `approve ${amountUsd6} to the escrow`,
      },
      {
        to: this.deps.addresses.jellyJob,
        data: encodeFunctionData({ abi: JELLY_JOB_ABI, functionName: "fundFor", args: [jobId, client, client, "0x"] }),
        note: `fund job ${jobId} for ${client}`,
      },
    ];
  }

  async fundFromVault(jobId: bigint, grant: SignedGrant, amountUsd6: bigint): Promise<{ tx: string }> {
    const { request } = await this.deps.publicClient.simulateContract({
      address: this.deps.addresses.balanceVault,
      abi: BALANCE_VAULT_ABI,
      functionName: "fundJob",
      args: [
        {
          owner: grant.owner,
          keyId: grant.keyId,
          perJobCapUsd6: grant.perJobCapUsd6,
          perDayCapUsd6: grant.perDayCapUsd6,
          expiresAt: grant.expiresAt,
          periodCapUsd6: grant.periodCapUsd6,
          minCoverageBps: grant.minCoverageBps,
        },
        grant.signature,
        jobId,
        amountUsd6,
      ],
      account: this.deps.relayerWallet.account,
    });
    const tx = await this.deps.relayerWallet.writeContract(request);
    await this.deps.publicClient.waitForTransactionReceipt({ hash: tx });
    return { tx };
  }

  async jobForwarder(jobId: bigint, payer: Address): Promise<Address> {
    return this.deps.publicClient.readContract({
      address: this.deps.addresses.forwarderFactory,
      abi: FORWARDER_FACTORY_ABI,
      functionName: "predict",
      args: [MODE_JOB, jobId, payer],
    });
  }

  async topUpForwarder(owner: Address): Promise<Address> {
    return this.deps.publicClient.readContract({
      address: this.deps.addresses.forwarderFactory,
      abi: FORWARDER_FACTORY_ABI,
      functionName: "predict",
      args: [MODE_TOP_UP, 0n, owner],
    });
  }

  private async sweep(mode: number, jobId: bigint, who: Address): Promise<{ tx: string }> {
    const { request } = await this.deps.publicClient.simulateContract({
      address: this.deps.addresses.forwarderFactory,
      abi: FORWARDER_FACTORY_ABI,
      functionName: "deployAndSweep",
      args: [mode, jobId, who],
      account: this.deps.relayerWallet.account,
    });
    const tx = await this.deps.relayerWallet.writeContract(request);
    await this.deps.publicClient.waitForTransactionReceipt({ hash: tx });
    return { tx };
  }

  sweepJob(jobId: bigint, payer: Address): Promise<{ tx: string }> {
    return this.sweep(MODE_JOB, jobId, payer);
  }

  sweepTopUp(owner: Address): Promise<{ tx: string }> {
    return this.sweep(MODE_TOP_UP, 0n, owner);
  }

  async seal(jobKey: Hex, seal: Seal): Promise<{ tx: string }> {
    const { request } = await this.deps.publicClient.simulateContract({
      address: this.deps.addresses.receiptRoot,
      abi: RECEIPT_ROOT_ABI,
      functionName: "seal",
      args: [jobKey, seal.root, seal.count, seal.head],
      account: this.deps.sealerWallet.account,
    });
    const tx = await this.deps.sealerWallet.writeContract(request);
    await this.deps.publicClient.waitForTransactionReceipt({ hash: tx });
    return { tx };
  }

  async settle(jobId: bigint, verdict: Verdict, signature: Hex): Promise<{ tx: string; releaseAtSec: number }> {
    const { request } = await this.deps.publicClient.simulateContract({
      address: this.deps.addresses.rowSplit,
      abi: ROW_SPLIT_ABI,
      functionName: "settle",
      args: [jobId, verdict, signature],
      account: this.deps.keeperWallet.account,
    });
    const hash = await this.deps.keeperWallet.writeContract(request);
    const receipt = await this.deps.publicClient.waitForTransactionReceipt({ hash });
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: ROW_SPLIT_ABI, eventName: "Settled", data: log.data, topics: log.topics });
        return { tx: hash, releaseAtSec: Number(decoded.args.releaseAt) };
      } catch {
        continue;
      }
    }
    // Nothing passed: settle() refunds everything immediately with no dispute window, and emits no Settled event.
    return { tx: hash, releaseAtSec: Math.floor(Date.now() / 1000) };
  }

  openAuditRound(_jobId: bigint, _rowIdx: number[]): Promise<{ roundId: bigint }> {
    throw new Error(
      "ViemEscrow.openAuditRound is not implemented: RowSplit.auditRows needs a merkle proof over each row's " +
        "sealed receiptsHash, which nothing upstream (RowResult / the receipt chain) tracks yet. " +
        "See the class-level comment on ViemEscrow.",
    );
  }

  async roundsOpen(jobId: bigint): Promise<number> {
    const [, state] = await this.deps.publicClient.readContract({
      address: this.deps.addresses.rowSplit,
      abi: ROW_SPLIT_ABI,
      functionName: "jobOf",
      args: [jobId],
    });
    return state.openRounds;
  }

  async finalize(jobId: bigint): Promise<{ tx: string }> {
    const { request } = await this.deps.publicClient.simulateContract({
      address: this.deps.addresses.rowSplit,
      abi: ROW_SPLIT_ABI,
      functionName: "finalize",
      args: [jobId],
      account: this.deps.keeperWallet.account,
    });
    const tx = await this.deps.keeperWallet.writeContract(request);
    await this.deps.publicClient.waitForTransactionReceipt({ hash: tx });
    return { tx };
  }
}
