import type { LiveEventType } from "./event";

export type Visibility = "private" | "unlisted" | "public";
export type Channel = "owner" | "public";

export type ChannelContext = {
  channel: Channel;
  walletJob: boolean;
  visibility: Visibility;
};

/**
 * §11.2 channel rules:
 *   - the owner channel always sees everything;
 *   - a wallet job has no public channel at all;
 *   - the public channel sees tile states, counts, cost and ETA, but never a
 *     row's cell data unless the share is public (not merely unlisted).
 */
export function isVisibleOn(type: LiveEventType, ctx: ChannelContext): boolean {
  if (ctx.channel === "owner") return true;
  if (ctx.walletJob) return false;
  if (type === "row") return ctx.visibility === "public";
  return true;
}

/** Drops payload fields a channel may not see; returns null if the event is not visible at all. */
export function filterEvent<T>(type: LiveEventType, payload: T, ctx: ChannelContext): T | null {
  return isVisibleOn(type, ctx) ? payload : null;
}
