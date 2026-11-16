import type { Verdict, VerdictDomainParams } from "@jelly/checker";
import type { Seal } from "@jelly/receipts";
import type { ChainKey } from "@jelly/shared";
import { type Address, type Hex, encodeAbiParameters, getAddress, keccak256 } from "viem";

/**
 * Everything the job service needs from the settlement chain. The service
 * never talks to a chain directly: it goes through this interface. The viem
 * implementation against the deployed contracts arrives with the settlement
 * keeper in Phase 6; `MemoryEscrow` below stands in until then.
 */
export type OpenJobArgs = {
  rows: number;
  unitUsd6: bigint;
  baseUsd6: bigint;
  toolsCapUsd6: bigint;
  workerOperatorId: bigint;
  /** Unix seconds. */
  expiresAtSec: number;
};

export type EscrowStatus = "open" | "funded" | "settled" | "finalized" | "refunded" | "expired";

/** A spend grant the vault owner signed (§10.2). Opaque here; the vault contract checks it. */
export type SignedGrant = {
  owner: Address;
  keyId: Hex;
  perJobCapUsd6: bigint;
  perDayCapUsd6: bigint;
  expiresAt: bigint;
  periodCapUsd6: bigint;
  minCoverageBps: number;
  signature: Hex;
};

/** A transaction for the client's own wallet to sign. We never sign for a user. */
export type UnsignedCall = { to: Address; data: Hex; note: string };

export interface Escrow {
  readonly chain: ChainKey;
  /** CAIP-2 id, e.g. "eip155:8453". */
  readonly network: string;
  /** The stablecoin jobs are paid in, with its EIP-712 domain for x402. */
  readonly asset: { address: Address; symbol: string; name: string; version: string };
  verdictDomain(): VerdictDomainParams;

  openJob(args: OpenJobArgs): Promise<{ jobId: bigint; jobKey: Hex }>;
  status(jobId: bigint): Promise<EscrowStatus>;

  /** Route (a): calls for the client's wallet to approve and fund the job itself. */
  walletFundCalls(jobId: bigint, client: Address, amountUsd6: bigint): Promise<UnsignedCall[]>;
  /** Route (b): the relayer funds the job from the owner's vault balance under their grant. */
  fundFromVault(jobId: bigint, grant: SignedGrant, amountUsd6: bigint): Promise<{ tx: string }>;
  /** Route (c): the address an x402 payment for this job is sent to. */
  jobForwarder(jobId: bigint, payer: Address): Promise<Address>;
  /** The address an x402 vault top-up for this owner is sent to. */
  topUpForwarder(owner: Address): Promise<Address>;
  /** Moves a forwarder's balance into the job (or vault), or back to the payer. */
  sweepJob(jobId: bigint, payer: Address): Promise<{ tx: string }>;
  sweepTopUp(owner: Address): Promise<{ tx: string }>;

  seal(jobKey: Hex, seal: Seal): Promise<{ tx: string }>;
  settle(jobId: bigint, verdict: Verdict, signature: Hex): Promise<{ tx: string; releaseAtSec: number }>;

  /**
   * §3.3 step 8. Opens a checker-panel round over rows of a settled job,
   * inside its dispute window. The settlement-keeper calls this for the
   * random 5% sample and for every job of $50 or more; a client calls the
   * equivalent path (not modelled here) to dispute rows itself.
   */
  openAuditRound(jobId: bigint, rowIdx: number[]): Promise<{ roundId: bigint }>;
  /** Rounds (audits or disputes) still open for a job. `finalize` refuses while this is above 0. */
  roundsOpen(jobId: bigint): Promise<number>;
  /**
   * §3.3 step 9. After the dispute window, with no round open, releases the
   * held amount to the 80/10/5/5 split. Permissionless on-chain; called here
   * by the settlement-keeper as a courtesy so it happens promptly.
   */
  finalize(jobId: bigint): Promise<{ tx: string }>;
}

/**
 * In-memory stand-in for the contracts: tracks each job's status and the
 * balance sitting at each forwarder address, with the same rules for when a
 * job counts as funded. For tests and local runs only; it moves no money.
 */
export class MemoryEscrow implements Escrow {
  readonly chain: ChainKey = "base";
  readonly network = "eip155:8453";
  readonly asset = {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
    symbol: "USDC",
    name: "USD Coin",
    version: "2",
  };
  private readonly escrowAddress = "0x00000000000000000000000000000000000000e5" as Address;
  private readonly splitAddress = "0x00000000000000000000000000000000000000f5" as Address;
  private readonly jobs = new Map<bigint, { args: OpenJobArgs; status: EscrowStatus; client?: Address }>();
  private readonly balances = new Map<string, bigint>();
  readonly vault = new Map<string, bigint>();
  readonly sealed = new Map<Hex, Seal>();
  readonly settled = new Map<bigint, { verdict: Verdict; signature: Hex }>();
  private readonly rounds = new Map<bigint, { jobId: bigint; rowIdx: number[]; resolved: boolean }>();
  private readonly openRoundsByJob = new Map<bigint, number>();
  private readonly releaseAtSecByJob = new Map<bigint, number>();
  readonly finalized = new Set<bigint>();
  private nextId = 1n;
  private nextRoundId = 1n;
  private txs = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private tx(): string {
    return keccak256(encodeAbiParameters([{ type: "uint256" }], [BigInt(++this.txs)]));
  }

  private job(jobId: bigint) {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`unknown job ${jobId}`);
    if ((j.status === "open" || j.status === "funded") && this.now() / 1000 >= j.args.expiresAtSec) {
      j.status = j.status === "funded" ? "expired" : "open";
    }
    return j;
  }

  private budget(a: OpenJobArgs): bigint {
    return a.baseUsd6 + BigInt(a.rows) * a.unitUsd6 + a.toolsCapUsd6;
  }

  private forwarder(kind: string, id: bigint, who: Address): Address {
    const h = keccak256(
      encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }], [kind, id, who]),
    );
    return getAddress(`0x${h.slice(-40)}`);
  }

  verdictDomain(): VerdictDomainParams {
    return { chainId: 8453, verifyingContract: this.splitAddress };
  }

  async openJob(args: OpenJobArgs): Promise<{ jobId: bigint; jobKey: Hex }> {
    const jobId = this.nextId++;
    this.jobs.set(jobId, { args, status: "open" });
    const jobKey = keccak256(
      encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }], [8453n, this.escrowAddress, jobId]),
    );
    return { jobId, jobKey };
  }

  async status(jobId: bigint): Promise<EscrowStatus> {
    return this.job(jobId).status;
  }

  async walletFundCalls(jobId: bigint, client: Address, amountUsd6: bigint): Promise<UnsignedCall[]> {
    this.job(jobId);
    return [
      { to: this.asset.address, data: "0x", note: `approve ${amountUsd6} to the escrow` },
      { to: this.escrowAddress, data: "0x", note: `fund job ${jobId} for ${client}` },
    ];
  }

  async fundFromVault(jobId: bigint, grant: SignedGrant, amountUsd6: bigint): Promise<{ tx: string }> {
    const j = this.job(jobId);
    if (j.status !== "open") throw new Error("job is not open");
    if (amountUsd6 !== this.budget(j.args)) throw new Error("amount must equal the budget");
    if (amountUsd6 > grant.perJobCapUsd6) throw new Error("over the per-job cap");
    const balance = this.vault.get(grant.owner.toLowerCase()) ?? 0n;
    if (balance < amountUsd6) throw new Error("insufficient vault balance");
    this.vault.set(grant.owner.toLowerCase(), balance - amountUsd6);
    j.status = "funded";
    j.client = grant.owner;
    return { tx: this.tx() };
  }

  async jobForwarder(jobId: bigint, payer: Address): Promise<Address> {
    return this.forwarder("job", jobId, payer);
  }

  async topUpForwarder(owner: Address): Promise<Address> {
    return this.forwarder("topup", 0n, owner);
  }

  /** Test helper: an x402 transfer landing at an address. */
  pay(to: Address, amountUsd6: bigint): void {
    this.balances.set(to.toLowerCase(), (this.balances.get(to.toLowerCase()) ?? 0n) + amountUsd6);
  }

  /** Test helper: the client's own wallet funded the job. */
  markFunded(jobId: bigint, client: Address): void {
    const j = this.job(jobId);
    j.status = "funded";
    j.client = client;
  }

  async sweepJob(jobId: bigint, payer: Address): Promise<{ tx: string }> {
    const j = this.job(jobId);
    const fwd = (await this.jobForwarder(jobId, payer)).toLowerCase();
    const balance = this.balances.get(fwd) ?? 0n;
    if (j.status === "open" && this.now() / 1000 < j.args.expiresAtSec) {
      if (balance >= this.budget(j.args)) {
        j.status = "funded";
        j.client = payer;
        this.balances.set(fwd, 0n);
      }
    } else {
      this.balances.set(fwd, 0n); // returned to the payer
    }
    return { tx: this.tx() };
  }

  async sweepTopUp(owner: Address): Promise<{ tx: string }> {
    const fwd = (await this.topUpForwarder(owner)).toLowerCase();
    const balance = this.balances.get(fwd) ?? 0n;
    this.balances.set(fwd, 0n);
    this.vault.set(owner.toLowerCase(), (this.vault.get(owner.toLowerCase()) ?? 0n) + balance);
    return { tx: this.tx() };
  }

  async seal(jobKey: Hex, seal: Seal): Promise<{ tx: string }> {
    if (this.sealed.has(jobKey)) throw new Error("already sealed");
    this.sealed.set(jobKey, seal);
    return { tx: this.tx() };
  }

  async settle(jobId: bigint, verdict: Verdict, signature: Hex): Promise<{ tx: string; releaseAtSec: number }> {
    const j = this.job(jobId);
    if (j.status !== "funded") throw new Error("job is not funded");
    if (this.sealed.get(verdict.jobKey)?.root !== verdict.receiptsRoot) throw new Error("receipts are not sealed");
    j.status = verdict.passedCount === 0 ? "refunded" : "settled";
    this.settled.set(jobId, { verdict, signature });
    const releaseAtSec = Math.floor(this.now() / 1000) + 24 * 3600;
    this.releaseAtSecByJob.set(jobId, releaseAtSec);
    return { tx: this.tx(), releaseAtSec };
  }

  async openAuditRound(jobId: bigint, rowIdx: number[]): Promise<{ roundId: bigint }> {
    const j = this.job(jobId);
    if (j.status !== "settled") throw new Error("job is not settled");
    const releaseAtSec = this.releaseAtSecByJob.get(jobId);
    if (releaseAtSec !== undefined && this.now() / 1000 > releaseAtSec) throw new Error("dispute window is closed");
    const roundId = this.nextRoundId++;
    this.rounds.set(roundId, { jobId, rowIdx, resolved: false });
    this.openRoundsByJob.set(jobId, (this.openRoundsByJob.get(jobId) ?? 0) + 1);
    return { roundId };
  }

  async roundsOpen(jobId: bigint): Promise<number> {
    return this.openRoundsByJob.get(jobId) ?? 0;
  }

  /**
   * Test helper standing in for a checker panel's vote (§3.3 step 8). The
   * real panel lives in CheckerNet.sol, out of scope for this in-memory
   * escrow; here a round simply resolves as "the verdict stands".
   */
  resolveRound(roundId: bigint): void {
    const round = this.rounds.get(roundId);
    if (!round || round.resolved) return;
    round.resolved = true;
    const left = (this.openRoundsByJob.get(round.jobId) ?? 1) - 1;
    this.openRoundsByJob.set(round.jobId, Math.max(0, left));
  }

  async finalize(jobId: bigint): Promise<{ tx: string }> {
    const j = this.job(jobId);
    if (j.status !== "settled") throw new Error("job is not settled");
    const releaseAtSec = this.releaseAtSecByJob.get(jobId);
    if (releaseAtSec === undefined || this.now() / 1000 < releaseAtSec) throw new Error("dispute window is still open");
    if ((this.openRoundsByJob.get(jobId) ?? 0) > 0) throw new Error("a round is still open for this job");
    j.status = "finalized";
    this.finalized.add(jobId);
    return { tx: this.tx() };
  }
}
