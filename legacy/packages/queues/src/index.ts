import { LANE_PRIORITY, type Lane } from "@jelly/shared";
import { type ConnectionOptions, type JobsOptions, Queue, type QueueOptions } from "bullmq";

/**
 * Queue conventions (§7): hyphenated names, 3 attempts with exponential
 * backoff, a dead-letter queue per queue, and removeOnComplete: 1000.
 */
export const QUEUES = [
  "intake",
  "job-quote",
  "job-plan",
  "rows-priority",
  "rows-paid",
  "rows-free",
  "rows-deferred",
  "row-check",
  "row-done",
  "job-merge",
  "job-seal",
  "job-settle",
  "job-finalize",
  "receipt-ingest",
  "refund-sweep",
  "burn-execute",
  "payout-epoch",
  "node-audit",
  "volume-classify",
  "chain-index",
  "x402-settled",
] as const;
export type QueueName = (typeof QUEUES)[number];

export const rowsQueue = (lane: Lane): QueueName => `rows-${lane}`;

/** Where a job goes after its last failed attempt; an alert hook watches these. */
export const dlqName = (queue: QueueName): string => `${queue}-dlq`;

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: 1000,
  removeOnFail: false,
};

/**
 * §3.3 deterministic row job id: `${jobId}-${rowIdx}-${attempt}`. Adding the
 * same row attempt twice is a no-op, so a redelivered message cannot run a
 * row twice. BullMQ ids may not contain ":"; job keys are hex, so this is safe.
 */
export const rowJobId = (jobKey: string, rowIdx: number, attempt: number): string => `${jobKey}-${rowIdx}-${attempt}`;

/** Options for one row job: its deterministic id and its lane's priority (1 / 2 / 5 / 10). */
export const rowJobOptions = (jobKey: string, rowIdx: number, attempt: number, lane: Lane): JobsOptions => ({
  ...DEFAULT_JOB_OPTIONS,
  jobId: rowJobId(jobKey, rowIdx, attempt),
  priority: LANE_PRIORITY[lane],
});

export function createQueue<T = unknown>(
  name: QueueName,
  connection: ConnectionOptions,
  opts: Omit<QueueOptions, "connection" | "defaultJobOptions"> = {},
): Queue<T> {
  return new Queue<T>(name, { ...opts, connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
}
