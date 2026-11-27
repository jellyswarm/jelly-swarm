// Shared helpers for the app: formatting, the same-origin API client and the local job history.
import { useSyncExternalStore } from "react";

export const MAX_AGENTS = 247;
export const PRICE_PER_AGENT = 300_000n; // 0.30 USDC, display estimate only: the API quote is authoritative.
export const JOB_ID = /^0x[0-9a-fA-F]{64}$/;
export const LIVE = new Set(["queued", "running", "payout_pending", "settlement_pending"]);
export const ACTIVE = new Set(["payment_pending", "queued", "running", "payout_pending", "settlement_pending"]);
export const JELLIES = ["jelly-mint.png", "jelly-cube.png", "jelly-sky.png", "jelly-a.png", "jelly-c.png"];

export const STATUS = {
  payment_pending: { label: "Waiting for payment", tone: "warn" },
  queued: { label: "Queued", tone: "live" },
  running: { label: "Swarm working", tone: "live" },
  payout_pending: { label: "Answer ready", tone: "good" },
  settled: { label: "Settled", tone: "good" },
  failed: { label: "Failed · under review", tone: "bad" },
  settlement_pending: { label: "Refund being paid", tone: "warn" },
};

export const short = (s, a = 6, b = 4) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s || "");
export const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function formatUsdc(base) {
  const v = BigInt(base || 0);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${frac.length < 2 ? frac.padEnd(2, "0") : frac}`;
}

// ───────────────────────── API (same-origin /api proxy) ─────────────────────────

export const ERRORS = {
  invalid_task: "Your task needs between 3 and 12,000 characters.",
  agent_count_out_of_range: "Pick between 1 and 247 agents.",
  invalid_client_address: "Connect a valid wallet first.",
  invalid_payment_mode: "Choose x402 or Direct.",
  invalid_job_id: "That doesn't look like a job ID. It starts with 0x and has 64 characters after it.",
  invalid_transaction_hash: "That payment transaction hash isn't valid.",
  job_not_found: "We couldn't find that job. Check the ID and try again.",
  payment_not_confirmed: "Your payment isn't confirmed yet. We'll keep checking.",
  payment_verification_unavailable: "We can't check payments right now. Your job and transaction are saved, so try again in a moment.",
  job_not_awaiting_payment: "This job isn't waiting for a payment anymore.",
  job_payment_already_recorded: "A payment is already recorded for this job.",
  quote_too_large: "That quote is too large. Try fewer agents.",
  backend_unavailable: "JellySwarm is unreachable right now. Please try again shortly.",
  backend_proxy_not_configured: "The app isn't connected to JellySwarm yet. Please contact the team.",
  unauthorized: "The app isn't connected to JellySwarm correctly. Please contact the team.",
};

const errorText = (code, status) =>
  ERRORS[code] ||
  (status === 401 ? ERRORS.unauthorized : status >= 500 ? ERRORS.backend_unavailable : "Something went wrong. Please try again.");

export class ApiError extends Error {
  constructor(status, body) {
    super(errorText(body?.error, status));
    this.status = status;
    this.code = body?.error || `http_${status}`;
  }
}

/** Calls the same-origin proxy. Never throws on an HTTP status; throws ApiError only if unreachable. */
export async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, { error: "backend_unavailable" });
  }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// ───────────────────────── local job history ─────────────────────────

const STORE_KEY = "jellyswarm-jobs-v2";
const listeners = new Set();
let cache = null;

function read() {
  if (cache) return cache;
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    cache = Array.isArray(v) ? v : [];
  } catch {
    cache = [];
  }
  return cache;
}

export const loadJobs = () => read();
export const storedJob = (id) => read().find((j) => j.jobId.toLowerCase() === String(id).toLowerCase());

export function saveJob(input) {
  // Drop undefined fields so a partial update never erases what was saved with the quote.
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const jobs = [...read()];
  const i = jobs.findIndex((j) => j.jobId === patch.jobId);
  if (i >= 0) jobs[i] = { ...jobs[i], ...patch };
  else jobs.unshift({ createdAt: Date.now(), ...patch });
  cache = jobs.slice(0, 100);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(cache));
  } catch {
    /* storage blocked: the job still works for this session */
  }
  listeners.forEach((fn) => fn());
}

addEventListener("storage", (e) => {
  if (e.key !== STORE_KEY) return;
  cache = null;
  listeners.forEach((fn) => fn());
});

export function useJobs() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    read,
  );
}
