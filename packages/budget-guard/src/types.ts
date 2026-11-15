/**
 * Budget guard (§13, layer 2). Before a model or paid-tool call, the caller
 * reserves its estimated cost against several budgets at once. The reserve is
 * atomic: either every budget has room and all are debited, or none is.
 * After the call, the reservation is settled at the actual cost.
 *
 * All amounts are integer micro-dollars.
 */
export type BudgetKey = { key: string; limitMicros: bigint };

export type ReserveResult =
  | { ok: true }
  | {
      ok: false;
      /** The first budget that had no room. */
      key: string;
      limitMicros: bigint;
      usedMicros: bigint;
      reservedMicros: bigint;
      requestedMicros: bigint;
    };

export type SettleResult = {
  reservedMicros: bigint;
  actualMicros: bigint;
  /** How far the actual cost ran over the reservation (0 if it did not). */
  overrunMicros: bigint;
};

export type Usage = { usedMicros: bigint; reservedMicros: bigint };

export class UnknownReservationError extends Error {
  constructor(readonly id: string) {
    super(`unknown or expired budget reservation: ${id}`);
    this.name = "UnknownReservationError";
  }
}

export class DuplicateReservationError extends Error {
  constructor(readonly id: string) {
    super(`budget reservation id already in use: ${id}`);
    this.name = "DuplicateReservationError";
  }
}

export interface BudgetStore {
  /**
   * Reserves `amountMicros` against every key, or none. `expiresAtMs` is when
   * an unsettled reservation may be reaped (a crashed caller must not hold
   * budget for ever).
   */
  reserve(id: string, keys: readonly BudgetKey[], amountMicros: bigint, expiresAtMs: number): Promise<ReserveResult>;
  /**
   * Replaces the reservation with the actual cost. The actual cost is always
   * recorded, even above the limit: the money is already spent, and recording
   * it is what makes later reservations fail.
   */
  settle(id: string, actualMicros: bigint): Promise<SettleResult>;
  /** Cancels a reservation without spending. Returns false if it was not found. */
  release(id: string): Promise<boolean>;
  usage(key: string): Promise<Usage>;
  /** Releases reservations whose expiry has passed. Returns how many. */
  reapExpired(nowMs: number): Promise<number>;
}

export function assertAmount(name: string, v: bigint): void {
  if (v < 0n) throw new Error(`${name} must not be negative: ${v}`);
  // Redis scripts compare amounts as doubles; stay inside the exact range.
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} is too large: ${v}`);
}
