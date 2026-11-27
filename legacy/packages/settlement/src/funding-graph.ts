/**
 * §8 volume classification needs to know whether a job's funder is linked to
 * us: a studio wallet itself, or funded (directly or through a short chain
 * of wallets) by one, within the lookback window. The real answer comes
 * from indexing on-chain transfers (apps/indexer, not yet built); this
 * package only needs the question asked, so it is an interface.
 */
export interface FundingGraph {
  /**
   * True if `address` is in `studioWallets`, or was funded — directly, or
   * through up to `maxHops - 1` further wallets — by one of them, with every
   * hop's funding event at or after `atMs - withinMs` and at or before `atMs`.
   */
  isStudioLinked(address: string, studioWallets: ReadonlySet<string>, maxHops: number, withinMs: number, atMs: number): Promise<boolean>;
}

export type FundingEdge = { from: string; to: string; atMs: number };

/**
 * In-memory funding graph for tests and local runs: holds "from funded to"
 * edges and walks them backward from the address being classified. A real
 * deployment replaces this with one backed by the chain indexer.
 */
export class MemoryFundingGraph implements FundingGraph {
  private readonly fundedBy = new Map<string, FundingEdge[]>();

  constructor(edges: readonly FundingEdge[] = []) {
    for (const e of edges) this.addEdge(e);
  }

  /** Records that `edge.from` sent funds to `edge.to` at `edge.atMs`. */
  addEdge(edge: FundingEdge): void {
    const key = edge.to.toLowerCase();
    const list = this.fundedBy.get(key) ?? [];
    list.push(edge);
    this.fundedBy.set(key, list);
  }

  async isStudioLinked(
    address: string,
    studioWallets: ReadonlySet<string>,
    maxHops: number,
    withinMs: number,
    atMs: number,
  ): Promise<boolean> {
    const studio = new Set([...studioWallets].map((a) => a.toLowerCase()));
    let frontier = new Set([address.toLowerCase()]);
    const seen = new Set(frontier);
    if ([...frontier].some((a) => studio.has(a))) return true;

    for (let hop = 0; hop < maxHops; hop++) {
      const next = new Set<string>();
      for (const node of frontier) {
        for (const edge of this.fundedBy.get(node) ?? []) {
          if (edge.atMs < atMs - withinMs || edge.atMs > atMs) continue;
          const funder = edge.from.toLowerCase();
          if (seen.has(funder)) continue;
          seen.add(funder);
          next.add(funder);
        }
      }
      if ([...next].some((a) => studio.has(a))) return true;
      frontier = next;
      if (frontier.size === 0) break;
    }
    return false;
  }
}

/** Treats every address as unlinked. Useful where the indexer is not wired up yet; never over-classifies as internal. */
export class NullFundingGraph implements FundingGraph {
  async isStudioLinked(_address: string, _studioWallets: ReadonlySet<string>, _maxHops: number, _withinMs: number, _atMs: number): Promise<boolean> {
    return false;
  }
}
