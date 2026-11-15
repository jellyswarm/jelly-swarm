/**
 * §2.3 prompt caching. All workers in a job share one system prompt and tool
 * block. The first call with a given prefix goes out alone so the host can
 * write its cache; calls that arrive meanwhile wait for it, then run in
 * parallel and get cache reads.
 */
export class PrefixGate {
  private readonly warm = new Set<string>();
  private readonly warming = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    for (;;) {
      if (this.warm.has(key)) return fn();
      const pending = this.warming.get(key);
      if (!pending) break;
      await pending;
    }

    let done!: () => void;
    this.warming.set(
      key,
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    try {
      const result = await fn();
      this.warm.add(key);
      return result;
    } finally {
      // On failure the key stays cold, and the next waiter becomes the warmer.
      this.warming.delete(key);
      done();
    }
  }

  forget(prefix: string): void {
    for (const k of this.warm) if (k.startsWith(prefix)) this.warm.delete(k);
  }
}
