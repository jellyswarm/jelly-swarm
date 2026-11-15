import type { Hex } from "viem";
import type { LiveEventType } from "./event";

export type PublishedEvent = { seq: number; ts: number; type: LiveEventType | string; payload: unknown };
export type Subscriber = (event: PublishedEvent) => void;

/**
 * Fans out newly-published events to whoever is subscribed to a job right
 * now (§11.2 "Pipeline. Every service XADDs to Redis Stream"). This is the
 * live, at-most-once half; `JobStore.appendEvent`/`eventsSince` remain the
 * durable log a client replays from after a disconnect. A production
 * deployment backs this with Redis Streams so it fans out across processes;
 * this in-memory version only reaches subscribers in the same process.
 */
export interface EventBus {
  publish(jobKey: Hex, event: PublishedEvent): void;
  subscribe(jobKey: Hex, handler: Subscriber): () => void;
}

export class InMemoryEventBus implements EventBus {
  private readonly subscribers = new Map<Hex, Set<Subscriber>>();

  publish(jobKey: Hex, event: PublishedEvent): void {
    for (const handler of this.subscribers.get(jobKey) ?? []) handler(event);
  }

  subscribe(jobKey: Hex, handler: Subscriber): () => void {
    let set = this.subscribers.get(jobKey);
    if (!set) {
      set = new Set();
      this.subscribers.set(jobKey, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.subscribers.delete(jobKey);
    };
  }

  /** How many live subscribers a job currently has. For tests and diagnostics. */
  subscriberCount(jobKey: Hex): number {
    return this.subscribers.get(jobKey)?.size ?? 0;
  }
}
