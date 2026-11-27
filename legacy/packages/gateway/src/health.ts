import { ROUTER } from "@jelly/shared";

export type HealthOptions = {
  /** Sliding window for error rate and latency. */
  windowMs: number;
  /** Below this many samples in the window, rate and latency checks do not apply. */
  minSamples: number;
  maxErrorRateBps: number;
  /** Consecutive failures that open the circuit breaker. */
  breakerFailures: number;
  breakerCooldownMs: number;
};

export const DEFAULT_HEALTH: HealthOptions = {
  windowMs: ROUTER.errorWindowMs,
  minSamples: 20,
  maxErrorRateBps: ROUTER.maxErrorRateBps,
  breakerFailures: 5,
  breakerCooldownMs: 30_000,
};

type Sample = { at: number; ok: boolean; latencyMs: number };
type HostHealth = { samples: Sample[]; consecutiveFailures: number; openUntil: number; inFlight: number };

/**
 * §2.3 step 3. A host is skipped while its circuit breaker is open, its error
 * rate over the last minute is above 5%, or its p95 latency is above its SLO.
 * In-process; each gateway instance keeps its own view.
 */
export class HealthTracker {
  private readonly hosts = new Map<string, HostHealth>();

  constructor(private readonly opts: HealthOptions = DEFAULT_HEALTH) {}

  private host(id: string): HostHealth {
    let h = this.hosts.get(id);
    if (!h) {
      h = { samples: [], consecutiveFailures: 0, openUntil: 0, inFlight: 0 };
      this.hosts.set(id, h);
    }
    return h;
  }

  begin(id: string): void {
    this.host(id).inFlight++;
  }

  end(id: string): void {
    const h = this.host(id);
    h.inFlight = Math.max(0, h.inFlight - 1);
  }

  /** Calls currently in flight to this host: the queue-depth tiebreak when ranking. */
  depth(id: string): number {
    return this.hosts.get(id)?.inFlight ?? 0;
  }

  record(id: string, ok: boolean, latencyMs: number, now: number): void {
    const h = this.host(id);
    h.samples.push({ at: now, ok, latencyMs });
    this.trim(h, now);
    if (ok) {
      h.consecutiveFailures = 0;
    } else if (++h.consecutiveFailures >= this.opts.breakerFailures) {
      h.openUntil = now + this.opts.breakerCooldownMs;
      h.consecutiveFailures = 0;
    }
  }

  private trim(h: HostHealth, now: number): void {
    const cutoff = now - this.opts.windowMs;
    while (h.samples.length > 0 && h.samples[0]!.at <= cutoff) h.samples.shift();
  }

  /** Why the host should be skipped right now, or null if it is healthy. */
  unhealthy(id: string, sloP95Ms: number, now: number): string | null {
    const h = this.hosts.get(id);
    if (!h) return null;
    if (now < h.openUntil) return "circuit breaker open";
    this.trim(h, now);
    const n = h.samples.length;
    if (n < this.opts.minSamples) return null;
    const failures = h.samples.filter((s) => !s.ok).length;
    if (failures * 10_000 > this.opts.maxErrorRateBps * n) return "error rate above 5%";
    const latencies = h.samples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const p95 = latencies[Math.min(n - 1, Math.ceil(n * 0.95) - 1)]!;
    if (p95 > sloP95Ms) return "p95 latency above SLO";
    return null;
  }
}
