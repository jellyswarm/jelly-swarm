import type { Lane, Role } from "@jelly/shared";
import type { BudgetKey } from "./types";

/** Deployment-wide daily ceilings, set by config. The per-job ceiling is the quote itself. */
export type BudgetLimits = {
  accountDayMicros: bigint;
  laneDayMicros: Record<Lane, bigint>;
  globalDayMicros: bigint;
  /** Admin-set daily budget for the free tier (§10.3). */
  freeTierDayMicros: bigint;
  /** Optional cap on one role's share of a job's quote, in bps. Default: the whole quote. */
  roleShareBps?: Partial<Record<Role, number>>;
};

export type BudgetScope = {
  jobKey: string;
  /** The job's quote: the hard cap on what the job may spend (§0.4). */
  quoteMicros: bigint;
  role: Role;
  accountId: string;
  lane: Lane;
  /** True for free-tier and credit-funded jobs. */
  freeTier: boolean;
  /** UTC day, YYYY-MM-DD. */
  day: string;
};

export const jobBudgetKey = (jobKey: string): string => `job:${jobKey}`;

/** UTC day string for a timestamp. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The budgets one call is reserved against (§13): job, role-job, account-day,
 * lane-day, global-day and, for free jobs, free-tier-day.
 */
export function budgetKeys(scope: BudgetScope, limits: BudgetLimits): BudgetKey[] {
  const roleBps = limits.roleShareBps?.[scope.role] ?? 10_000;
  const keys: BudgetKey[] = [
    { key: jobBudgetKey(scope.jobKey), limitMicros: scope.quoteMicros },
    {
      key: `role-job:${scope.jobKey}:${scope.role}`,
      limitMicros: (scope.quoteMicros * BigInt(roleBps)) / 10_000n,
    },
    { key: `account-day:${scope.accountId}:${scope.day}`, limitMicros: limits.accountDayMicros },
    { key: `lane-day:${scope.lane}:${scope.day}`, limitMicros: limits.laneDayMicros[scope.lane] },
    { key: `global-day:${scope.day}`, limitMicros: limits.globalDayMicros },
  ];
  if (scope.freeTier) {
    keys.push({ key: `free-tier-day:${scope.day}`, limitMicros: limits.freeTierDayMicros });
  }
  return keys;
}
