import type { TileState } from "@jelly/shared";
import { encodeTilesBatch } from "./event";

/**
 * §11.2 "Tile events are coalesced to at most 10/s per job. Clients render
 * from tiles.batch plus deltas." One of these per running job: individual
 * `tile` events pass straight through up to that rate; anything over budget
 * is only reflected in the next `tiles.batch` snapshot, so no client-visible
 * state is ever lost, only its single-tile delta.
 */
export class TileCoalescer {
  private readonly states = new Map<number, TileState>();
  private readonly changedSinceBatch = new Set<number>();
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly maxPerSecond = 10,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = maxPerSecond;
    this.lastRefillMs = now();
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsed = nowMs - this.lastRefillMs;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.maxPerSecond, this.tokens + (elapsed / 1000) * this.maxPerSecond);
    this.lastRefillMs = nowMs;
  }

  /** Records a tile's new state. Returns true if an individual `tile` event may be sent for it right now. */
  record(agentIdx: number, state: TileState): boolean {
    this.states.set(agentIdx, state);
    this.changedSinceBatch.add(agentIdx);
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** A full 247-tile snapshot as the `tiles.batch` payload wants it. */
  snapshotBase64(): string {
    return encodeTilesBatch(this.states);
  }

  /** Tiles that changed since the last batch, cleared after reading. */
  drainChanged(): number[] {
    const out = [...this.changedSinceBatch];
    this.changedSinceBatch.clear();
    return out;
  }
}
