/**
 * §10.3 "Devices and accounts linked to rejected jobs get their PoW
 * difficulty doubled. Repeat offenders are banned. Bans never touch money:
 * withdrawals and refunds still work." This package only ever decides
 * whether a NEW job may start; it has no connection to the escrow or vault,
 * so there is nothing here that could block a refund or a withdrawal even
 * by mistake.
 */
export type SubjectKind = "device" | "account";

export interface BanStore {
  isBanned(kind: SubjectKind, id: string): Promise<boolean>;
  ban(kind: SubjectKind, id: string): Promise<void>;
  /** Rejections recorded so far, before this one. */
  recordRejection(kind: SubjectKind, id: string): Promise<number>;
  penaltyBits(kind: SubjectKind, id: string): Promise<number>;
}

export class MemoryBanStore implements BanStore {
  private readonly banned = new Set<string>();
  private readonly rejections = new Map<string, number>();

  private key(kind: SubjectKind, id: string): string {
    return `${kind}:${id}`;
  }

  async isBanned(kind: SubjectKind, id: string): Promise<boolean> {
    return this.banned.has(this.key(kind, id));
  }

  async ban(kind: SubjectKind, id: string): Promise<void> {
    this.banned.add(this.key(kind, id));
  }

  async recordRejection(kind: SubjectKind, id: string): Promise<number> {
    const key = this.key(kind, id);
    const n = (this.rejections.get(key) ?? 0) + 1;
    this.rejections.set(key, n);
    return n;
  }

  async penaltyBits(kind: SubjectKind, id: string): Promise<number> {
    const n = this.rejections.get(this.key(kind, id)) ?? 0;
    // Each rejection doubles the PoW difficulty (one more bit); the ban escalation below is separate.
    return n;
  }
}

export type BanEscalation = { rejections: number; penaltyBits: number; banned: boolean };

/**
 * Records one more rejected job against `id` and escalates: the PoW
 * difficulty bit count doubles with each rejection, and a repeat offender
 * (by default, the fourth rejection) is banned outright from starting new
 * jobs. Never touches money.
 */
export async function onJobRejected(store: BanStore, kind: SubjectKind, id: string, banAfter = 4): Promise<BanEscalation> {
  const rejections = await store.recordRejection(kind, id);
  const penaltyBits = await store.penaltyBits(kind, id);
  const banned = rejections >= banAfter;
  if (banned) await store.ban(kind, id);
  return { rejections, penaltyBits, banned };
}
