import type { ReserveResult } from "@jelly/budget-guard";
import type { SignedReceipt } from "@jelly/receipts";

/** §2.2: family(checker) must differ from family(worker) on every job. */
export class CrossFamilyViolation extends Error {
  constructor(
    readonly family: string,
    readonly where: string,
  ) {
    super(`cross-family rule violated: checker and worker would both run on the "${family}" family (${where})`);
    this.name = "CrossFamilyViolation";
  }
}

/** The call would take the job (or a daily budget) past its cap. Nothing was sent. */
export class BudgetExceeded extends Error {
  constructor(readonly refusal: Extract<ReserveResult, { ok: false }> | { key: string; reason: "stopped" }) {
    super(`budget refused the call: ${refusal.key}`);
    this.name = "BudgetExceeded";
  }
}

/**
 * §13: the call ran more than 20% over its reservation. The cost is recorded
 * and receipted; the row must be failed by the caller.
 */
export class BudgetOverrun extends Error {
  constructor(
    readonly reservedMicros: bigint,
    readonly actualMicros: bigint,
    readonly receipt: SignedReceipt,
  ) {
    super(`call cost ${actualMicros} micros against a reservation of ${reservedMicros}`);
    this.name = "BudgetOverrun";
  }
}

/** No host passed the tier, privacy and health filters. The gateway never relaxes a filter to find one. */
export class NoEligibleHost extends Error {
  constructor(readonly detail: string) {
    super(`no eligible host: ${detail}`);
    this.name = "NoEligibleHost";
  }
}

/** Every eligible host that was tried failed. */
export class AllHostsFailed extends Error {
  constructor(readonly attempts: { hostId: string; error: string }[]) {
    super(`all hosts failed: ${attempts.map((a) => `${a.hostId} (${a.error})`).join("; ")}`);
    this.name = "AllHostsFailed";
  }
}

/** A TEE-only call came back without hardware attestation. Fails closed. */
export class MissingAttestation extends Error {
  constructor(readonly hostId: string) {
    super(`host ${hostId} returned no hardware attestation for a TEE-only call`);
    this.name = "MissingAttestation";
  }
}

export class PolicyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolation";
  }
}
