import type { Redis } from "ioredis";
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

/**
 * Redis-backed budget store. Each operation is one Lua script, so it is
 * atomic across every budget key it touches.
 *
 * Layout (all under `prefix`):
 *   k:<budget>     hash {used, reserved}
 *   res:<id>       hash {amount}
 *   resk:<id>      list of budget names the reservation holds
 *   exp            zset of reservation ids scored by expiry time
 *
 * The scripts build key names from arguments, so this targets a single Redis
 * instance, not Redis Cluster. Amounts are passed as decimal strings and only
 * compared as numbers, which is exact below 2^53 micro-dollars.
 */
const RESERVE = `
local p, id, amount, exp, n = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5])
if redis.call('EXISTS', p .. 'res:' .. id) == 1 then return {'dup'} end
for i = 0, n - 1 do
  local name, limit = ARGV[6 + i * 2], ARGV[7 + i * 2]
  local k = p .. 'k:' .. name
  local used = redis.call('HGET', k, 'used') or '0'
  local res = redis.call('HGET', k, 'reserved') or '0'
  if tonumber(used) + tonumber(res) + tonumber(amount) > tonumber(limit) then
    return {'no', name, limit, used, res}
  end
end
for i = 0, n - 1 do
  local name = ARGV[6 + i * 2]
  local k = p .. 'k:' .. name
  redis.call('HINCRBY', k, 'reserved', amount)
  redis.call('EXPIRE', k, 691200)
  redis.call('RPUSH', p .. 'resk:' .. id, name)
end
redis.call('HSET', p .. 'res:' .. id, 'amount', amount)
redis.call('ZADD', p .. 'exp', exp, id)
return {'ok'}
`;

/** ARGV: prefix, id, actual. An actual of '0' with mode 'release' cancels. */
const SETTLE = `
local p, id, actual = ARGV[1], ARGV[2], ARGV[3]
local amount = redis.call('HGET', p .. 'res:' .. id, 'amount')
if not amount then return {'unknown'} end
local names = redis.call('LRANGE', p .. 'resk:' .. id, 0, -1)
for _, name in ipairs(names) do
  local k = p .. 'k:' .. name
  if amount ~= '0' then redis.call('HINCRBY', k, 'reserved', '-' .. amount) end
  if actual ~= '0' then redis.call('HINCRBY', k, 'used', actual) end
end
redis.call('DEL', p .. 'res:' .. id, p .. 'resk:' .. id)
redis.call('ZREM', p .. 'exp', id)
return {'ok', amount}
`;

const REAP = `
local p, now = ARGV[1], ARGV[2]
local ids = redis.call('ZRANGEBYSCORE', p .. 'exp', '-inf', now, 'LIMIT', 0, 200)
for _, id in ipairs(ids) do
  local amount = redis.call('HGET', p .. 'res:' .. id, 'amount')
  if amount then
    local names = redis.call('LRANGE', p .. 'resk:' .. id, 0, -1)
    if amount ~= '0' then
      for _, name in ipairs(names) do
        redis.call('HINCRBY', p .. 'k:' .. name, 'reserved', '-' .. amount)
      end
    end
    redis.call('DEL', p .. 'res:' .. id, p .. 'resk:' .. id)
  end
  redis.call('ZREM', p .. 'exp', id)
end
return #ids
`;

export class RedisBudgetStore implements BudgetStore {
  private readonly prefix: string;

  constructor(
    private readonly redis: Redis,
    opts: { prefix?: string } = {},
  ) {
    this.prefix = opts.prefix ?? "bg:";
  }

  async reserve(
    id: string,
    keys: readonly BudgetKey[],
    amountMicros: bigint,
    expiresAtMs: number,
  ): Promise<ReserveResult> {
    assertAmount("amountMicros", amountMicros);
    const args: string[] = [this.prefix, id, amountMicros.toString(), String(expiresAtMs), String(keys.length)];
    for (const k of keys) {
      assertAmount("limitMicros", k.limitMicros);
      args.push(k.key, k.limitMicros.toString());
    }
    const out = (await this.redis.eval(RESERVE, 0, ...args)) as string[];
    if (out[0] === "ok") return { ok: true };
    if (out[0] === "dup") throw new DuplicateReservationError(id);
    return {
      ok: false,
      key: out[1]!,
      limitMicros: BigInt(out[2]!),
      usedMicros: BigInt(out[3]!),
      reservedMicros: BigInt(out[4]!),
      requestedMicros: amountMicros,
    };
  }

  async settle(id: string, actualMicros: bigint): Promise<SettleResult> {
    assertAmount("actualMicros", actualMicros);
    const out = (await this.redis.eval(SETTLE, 0, this.prefix, id, actualMicros.toString())) as string[];
    if (out[0] !== "ok") throw new UnknownReservationError(id);
    const reservedMicros = BigInt(out[1]!);
    return {
      reservedMicros,
      actualMicros,
      overrunMicros: actualMicros > reservedMicros ? actualMicros - reservedMicros : 0n,
    };
  }

  async release(id: string): Promise<boolean> {
    const out = (await this.redis.eval(SETTLE, 0, this.prefix, id, "0")) as string[];
    return out[0] === "ok";
  }

  async usage(key: string): Promise<Usage> {
    const [used, reserved] = await this.redis.hmget(`${this.prefix}k:${key}`, "used", "reserved");
    return { usedMicros: BigInt(used ?? "0"), reservedMicros: BigInt(reserved ?? "0") };
  }

  async reapExpired(nowMs: number): Promise<number> {
    let total = 0;
    for (;;) {
      const n = (await this.redis.eval(REAP, 0, this.prefix, String(nowMs))) as number;
      total += n;
      if (n < 200) return total;
    }
  }
}
