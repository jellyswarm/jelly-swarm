import { MAX_AGENTS, TileState } from "@jelly/shared";
import { z } from "zod";

/**
 * §11.2 live progress event schema, version 1. Every event carries `v: 1`;
 * a later incompatible change bumps it, and old clients can ignore events
 * whose version they don't understand.
 */
export const EVENT_VERSION = 1 as const;

const versioned = <S extends z.ZodRawShape>(shape: S) => z.object({ v: z.literal(EVENT_VERSION), ...shape });

export const JobQuoted = versioned({ agents: z.number().int(), of: z.literal(MAX_AGENTS), priceUsd: z.string(), tier: z.string() });
export const JobFunded = versioned({ route: z.string(), chain: z.string(), tx: z.string().optional() });
export const WaveStarted = versioned({ wave: z.number().int(), rows: z.tuple([z.number().int(), z.number().int()]) });
export const Tile = versioned({
  agentIdx: z.number().int().min(1).max(MAX_AGENTS),
  rowIdx: z.number().int().nonnegative(),
  state: TileState,
  host: z.enum(["community", "tee", "std"]).optional(),
});
/** A compact snapshot: one byte per tile, 1..247, the live `TileState` as a small int. 0 means "no tile". */
export const TilesBatch = versioned({ states: z.string() });
export const Cost = versioned({ spentUsd: z.string(), quoteUsd: z.string() });
export const Eta = versioned({ sec: z.number().int().nonnegative(), queuePos: z.number().int().nonnegative().optional() });
/** Owner channel only: the row's cells, exactly as the result would show them. */
export const Row = versioned({ rowIdx: z.number().int().nonnegative(), cells: z.record(z.string(), z.unknown()) });
export const JobMerged = versioned({ passed: z.number().int(), refunded: z.number().int(), unverifiedCells: z.number().int() });
export const JobSealed = versioned({ root: z.string(), tx: z.string() });
export const JobSettled = versioned({ paidUsd: z.string(), refundedUsd: z.string(), tx: z.string() });
export const JobFinalized = versioned({ tx: z.string() });

export const EVENT_SCHEMA = {
  "job.quoted": JobQuoted,
  "job.funded": JobFunded,
  "wave.started": WaveStarted,
  tile: Tile,
  "tiles.batch": TilesBatch,
  cost: Cost,
  eta: Eta,
  row: Row,
  "job.merged": JobMerged,
  "job.sealed": JobSealed,
  "job.settled": JobSettled,
  "job.finalized": JobFinalized,
} as const;

export type LiveEventType = keyof typeof EVENT_SCHEMA;
/** True for `row`, the one event type that carries raw cell data. */
export const carriesCellData = (type: string): type is "row" => type === "row";

export const TILE_STATE_CODE: Record<z.infer<typeof TileState>, number> = {
  scouting: 1,
  working: 2,
  checking: 3,
  passed: 4,
  retrying: 5,
  refunded: 6,
};

/** Encodes a sparse set of tile states as the base64 string `tiles.batch.states` wants: 247 bytes, index = agentIdx - 1. */
export function encodeTilesBatch(tiles: ReadonlyMap<number, keyof typeof TILE_STATE_CODE>): string {
  const bytes = new Uint8Array(MAX_AGENTS);
  for (const [agentIdx, state] of tiles) {
    if (agentIdx >= 1 && agentIdx <= MAX_AGENTS) bytes[agentIdx - 1] = TILE_STATE_CODE[state];
  }
  return Buffer.from(bytes).toString("base64");
}
