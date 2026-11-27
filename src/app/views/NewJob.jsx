import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError, MAX_AGENTS, PRICE_PER_AGENT, api, formatUsdc, saveJob } from "../lib.js";
import { useToast } from "../Toasts.jsx";
import { useEnsureWallet } from "../WalletGate.jsx";
import { BusyButton } from "./parts.jsx";

const DRAFT_KEY = "jelly-task";
const PRESETS = [5, 12, 50, 120, 247];
const clamp = (n) => Math.min(MAX_AGENTS, Math.max(1, Math.round(n) || 1));

export default function NewJob() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const toast = useToast();
  const ensureWallet = useEnsureWallet();
  const taskRef = useRef(null);
  const [task, setTask] = useState(() => {
    if (state?.prefill) return state.prefill;
    try {
      return sessionStorage.getItem(DRAFT_KEY) || "";
    } catch {
      return "";
    }
  });
  const [countText, setCountText] = useState("12");
  const [mode, setMode] = useState("x402");
  const [busy, setBusy] = useState(false);
  const agents = clamp(Number(countText));

  useEffect(() => {
    const el = taskRef.current;
    el?.focus({ preventScroll: true });
    if (state?.prefill) el?.setSelectionRange(el.value.length, el.value.length);
  }, [state]);

  useEffect(() => {
    try {
      sessionStorage.setItem(DRAFT_KEY, task);
    } catch {}
  }, [task]);

  const len = task.trim().length;
  const bad = task.length > 0 && (len < 3 || task.length > 12000);
  const setAgents = (n) => setCountText(String(clamp(n)));

  async function submit(e) {
    e.preventDefault();
    const text = task.trim();
    if (text.length < 3 || text.length > 12000) {
      taskRef.current?.focus();
      return toast("Your task needs between 3 and 12,000 characters.", "warn");
    }
    setAgents(agents);
    setBusy(true);
    const progress = toast("Choose a wallet to continue…", "progress");
    try {
      const address = await ensureWallet();
      progress.update("Pricing your swarm…", "progress");
      const res = await api("/jobs", { method: "POST", body: { task: text, agentCount: agents, clientAddress: address, paymentMode: mode } });
      if (res.status !== 402 && res.status !== 201) throw new ApiError(res.status, res.data);
      const q = res.data;
      const accept = q.payment?.accepts?.[0];
      if (!q.jobId || !accept || !q.fundCall) throw new Error("The quote came back incomplete. Please try again.");
      saveJob({
        jobId: q.jobId,
        task: text.slice(0, 280),
        agentCount: q.agentCount ?? agents,
        amount: String(accept.amount),
        payTo: accept.payTo,
        asset: accept.asset,
        fundCall: q.fundCall,
        clientAddress: (accept.extra?.clientAddress || address).toLowerCase(),
        paymentMode: q.paymentMode || mode,
        status: "payment_pending",
      });
      setTask("");
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {}
      progress.update(`Your price is ${formatUsdc(accept.amount)} USDC. Review it and pay when you're ready.`, "success");
      navigate(`/app/job/${q.jobId}`);
    } catch (err) {
      progress.update(err.message || "Couldn't get a quote.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="new-grid">
      <div className="panel composer">
        <form onSubmit={submit} noValidate>
          <label className="field-label" htmlFor="task">
            Your task
          </label>
          <textarea
            id="task"
            ref={taskRef}
            rows={7}
            maxLength={12000}
            required
            aria-invalid={bad}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Compare the three most-used bridges to Elysium and recommend one, with reasons."
          />
          <div className="field-hint">
            <span className={bad ? "bad" : ""}>{bad ? "Use 3 to 12,000 characters." : "3 to 12,000 characters."}</span>
            <span>{task.length.toLocaleString()} / 12,000</span>
          </div>

          <div className="field-row">
            <div>
              <label className="field-label" htmlFor="agent-count">
                Agents
              </label>
              <div className="stepper">
                <button type="button" aria-label="Fewer agents" onClick={() => setAgents(agents - 1)}>
                  −
                </button>
                <input
                  id="agent-count"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="247"
                  value={countText}
                  onChange={(e) => setCountText(e.target.value)}
                  onBlur={() => setAgents(Number(countText))}
                />
                <button type="button" aria-label="More agents" onClick={() => setAgents(agents + 1)}>
                  +
                </button>
              </div>
              <input className="range" type="range" min="1" max="247" value={agents} aria-label="Agents" onChange={(e) => setAgents(Number(e.target.value))} />
              <div className="presets" role="group" aria-label="Swarm size presets">
                {PRESETS.map((p) => (
                  <button type="button" key={p} aria-pressed={agents === p} onClick={() => setAgents(p)}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="field-label" id="mode-label">
                Payment request
              </span>
              <div className="segmented" role="radiogroup" aria-labelledby="mode-label">
                {[
                  ["x402", "x402"],
                  ["direct", "Direct"],
                ].map(([value, label]) => (
                  <button type="button" role="radio" key={value} aria-checked={mode === value} onClick={() => setMode(value)}>
                    {label}
                  </button>
                ))}
              </div>
              <p className="field-note">Both send one USDC transfer from your wallet.</p>
            </div>
          </div>

          <BusyButton className="button primary wide" id="quote-button" type="submit" busy={busy} busyLabel="Getting your quote…">
            Get a quote <span aria-hidden="true">→</span>
          </BusyButton>
          <p className="fine">You'll see the exact amount before your wallet asks you to pay. Gas is paid in HYPE.</p>
        </form>
      </div>

      <aside className="panel summary" aria-live="polite">
        <img className="summary-jelly" src="/media/jelly-mint.png" alt="" />
        <span className="eyebrow">Your swarm</span>
        <div className="summary-count">
          <strong>{agents}</strong>
          <span>of 247 agents</span>
        </div>
        <dl className="kv">
          <div>
            <dt>Per agent</dt>
            <dd>0.30 USDC</dd>
          </div>
          <div>
            <dt>Synthesis</dt>
            <dd>Included</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>Elysium</dd>
          </div>
          <div className="total">
            <dt>Estimated total</dt>
            <dd>{formatUsdc(PRICE_PER_AGENT * BigInt(agents))} USDC</dd>
          </div>
        </dl>
        <ol className="next-steps">
          <li>
            <b>Quote.</b> JellySwarm confirms the exact amount.
          </li>
          <li>
            <b>Pay.</b> Approve one USDC transfer in your wallet.
          </li>
          <li>
            <b>Watch.</b> Follow the agents as they finish.
          </li>
          <li>
            <b>Read.</b> Get one answer plus every finding.
          </li>
        </ol>
      </aside>
    </div>
  );
}
