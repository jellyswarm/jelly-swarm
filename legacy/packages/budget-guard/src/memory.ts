import {
  type BudgetKey,
  type BudgetStore,
  DuplicateReservationError,
  type ReserveResult,
  type SettleResult,
  UnknownReservationError,
  type Usage,
  assertAmount,
} from "./types";

type Reservation = { keys: string[]; amount: bigint; expiresAtMs: number };

/**
 * In-process budget store with the same semantics as the Redis one. For tests
 * and single-process runs; it shares nothing between processes.
 */
export class MemoryBudgetStore implements BudgetStore {
  private readonly budgets = new Map<string, { used: bigint; reserved: bigint }>();
  private readonly reservations = new Map<string, Reservation>();

  private budget(key: string) {
    let b = this.budgets.get(key);
    if (!b) {
      b = { used: 0n, reserved: 0n };
      this.budgets.set(key, b);
    }
    return b;
  }

  async reserve(
    id: string,
    keys: readonly BudgetKey[],
    amountMicros: bigint,
    expiresAtMs: number,
  ): Promise<ReserveResult> {
    assertAmount("amountMicros", amountMicros);
    if (this.reservations.has(id)) throw new DuplicateReservationError(id);
    for (const { key, limitMicros } of keys) {
      assertAmount("limitMicros", limitMicros);
      const b = this.budget(key);
      if (b.used + b.reserved + amountMicros > limitMicros) {
        return {
          ok: false,
          key,
          limitMicros,
          usedMicros: b.used,
          reservedMicros: b.reserved,
          requestedMicros: amountMicros,
        };
      }
    }
    for (const { key } of keys) this.budget(key).reserved += amountMicros;
    this.reservations.set(id, { keys: keys.map((k) => k.key), amount: amountMicros, expiresAtMs });
    return { ok: true };
  }

  async settle(id: string, actualMicros: bigint): Promise<SettleResult> {
    assertAmount("actualMicros", actualMicros);
    const r = this.reservations.get(id);
    if (!r) throw new UnknownReservationError(id);
    this.reservations.delete(id);
    for (const key of r.keys) {
      const b = this.budget(key);
      b.reserved -= r.amount;
      b.used += actualMicros;
    }
    return {
      reservedMicros: r.amount,
      actualMicros,
      overrunMicros: actualMicros > r.amount ? actualMicros - r.amount : 0n,
    };
  }

  async release(id: string): Promise<boolean> {
    const r = this.reservations.get(id);
    if (!r) return false;
    this.reservations.delete(id);
    for (const key of r.keys) this.budget(key).reserved -= r.amount;
    return true;
  }

  async usage(key: string): Promise<Usage> {
    const b = this.budgets.get(key);
    return { usedMicros: b?.used ?? 0n, reservedMicros: b?.reserved ?? 0n };
  }

  async reapExpired(nowMs: number): Promise<number> {
    let n = 0;
    for (const [id, r] of this.reservations) {
      if (r.expiresAtMs <= nowMs) {
        await this.release(id);
        n++;
      }
    }
    return n;
  }
}
