import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "./index";
import * as schema from "./schema";

/**
 * A saved Picket watch request. Storage only (see the comment on the
 * `watches` table in schema.ts): nothing checks `target` against
 * `condition`, so a watch here never actually monitors anything.
 */
export type StoredWatch = { id: string; accountId: string; target: string; condition: string; createdAtMs: number };

export interface WatchStore {
  putWatch(accountId: string, target: string, condition: string): Promise<StoredWatch>;
  listWatches(accountId: string): Promise<StoredWatch[]>;
  /** Returns false if no watch with that id belongs to this account. */
  deleteWatch(accountId: string, id: string): Promise<boolean>;
}

export class PgWatchStore implements WatchStore {
  constructor(private readonly db: Db) {}

  async putWatch(accountId: string, target: string, condition: string): Promise<StoredWatch> {
    const [row] = await this.db.insert(schema.watches).values({ id: randomUUID(), accountId, target, condition }).returning();
    return { id: row!.id, accountId: row!.accountId, target: row!.target, condition: row!.condition, createdAtMs: row!.createdAt.getTime() };
  }

  async listWatches(accountId: string): Promise<StoredWatch[]> {
    const rows = await this.db.select().from(schema.watches).where(eq(schema.watches.accountId, accountId)).orderBy(desc(schema.watches.createdAt));
    return rows.map((row) => ({ id: row.id, accountId: row.accountId, target: row.target, condition: row.condition, createdAtMs: row.createdAt.getTime() }));
  }

  async deleteWatch(accountId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(schema.watches)
      .where(and(eq(schema.watches.id, id), eq(schema.watches.accountId, accountId)))
      .returning({ id: schema.watches.id });
    return deleted.length > 0;
  }
}
