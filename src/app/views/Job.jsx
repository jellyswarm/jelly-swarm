import React, { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getAccount, getBalance, readContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { erc20Abi } from "viem";
import { ApiError, ERRORS, JOB_ID, LIVE, STATUS, api, clip, formatUsdc, saveJob, short, sleep, storedJob, useJobs } from "../lib.js";
import { EXPLORER, USDC, config, elysium } from "../wallet.js";
import { useToast } from "../Toasts.jsx";
import { useEnsureWallet } from "../WalletGate.jsx";
import { BusyButton, EmptyState, StatePill } from "./parts.jsx";

const POLL_MS = 2500;
const STAGES = ["Quote", "Payment", "Agents", "Answer", "Settled"];
// d = done, n = now, b = failed, "" = not reached.
const RAIL = {
  payment_pending: "dn___",
  queued: "ddn__",
  running: "ddn__",
  payout_pending: "ddddn",
  settled: "ddddd",
  failed: "ddb__",
  settlement_pending: "ddb_n",
};
const RAIL_STATE = { d: "done", n: "now", b: "bad", _: "" };

function Timeline({ status }) {
  const rail = RAIL[status] || "d____";
  return (
    <ol className="timeline" aria-label="Job progress">
      {STAGES.map((name, i) => (
        <li key={name} data-s={RAIL_STATE[rail[i]]}>
          {name}
        </li>
      ))}
    </ol>
  );
}

function TxLink({ hash }) {
  if (!hash) return "—";
  return (
    <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noopener">
      {short(hash, 10, 8)}
    </a>
  );
}

/** A small, safe markdown subset for answers: headings, bullet and numbered lists, bold and code. */
function Markdown({ text }) {
  const inline = (s, key) => {
    const parts = String(s).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((p, i) =>
      p.startsWith("**") && p.endsWith("**") ? (
        <strong key={`${key}-${i}`}>{p.slice(2, -2)}</strong>
      ) : p.startsWith("`") && p.endsWith("`") && p.length > 1 ? (
        <code key={`${key}-${i}`}>{p.slice(1, -1)}</code>
      ) : (
        <Fragment key={`${key}-${i}`}>{p}</Fragment>
      ),
    );
  };
  const blocks = [];
  let list = null;
  const flush = () => {
    if (list) blocks.push(list);
    list = null;
  };
  String(text || "")
    .split(/\r?\n/)
    .forEach((raw, n) => {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) flush();
      else if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
        flush();
        blocks.push(<h3 key={n}>{inline(m[1], n)}</h3>);
      } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        const type = /^\s*\d/.test(line) ? "ol" : "ul";
        if (!list || list.type !== type) {
          flush();
          list = { type, key: n, items: [] };
        }
        list.items.push(<li key={n}>{inline(m[1], n)}</li>);
      } else {
        flush();
        blocks.push(<p key={n}>{inline(line, n)}</p>);
      }
    });
  flush();
  if (!blocks.length) return <p>No answer text was returned.</p>;
  return blocks.map((b) => (b.items ? React.createElement(b.type, { key: `l${b.key}` }, b.items) : b));
}

export default function Job() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const ensureWallet = useEnsureWallet();
  useJobs(); // re-render when the saved quote or transaction changes
  const saved = storedJob(id) || {};
  const [job, setJob] = useState(null);
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState("");
  const [paying, setPaying] = useState(false);
  const [checking, setChecking] = useState(false);
  const failures = useRef(0);
  const alive = useRef(true);

  const valid = JOB_ID.test(id || "");

  const refresh = useCallback(async () => {
    const res = await api(`/jobs/${id}`);
    if (!res.ok) throw new ApiError(res.status, res.data);
    if (!alive.current) return res.data;
    setJob(res.data);
    if (["queued", "running"].includes(res.data.status)) {
      const a = await api(`/jobs/${id}/agents`);
      if (a.ok && alive.current) setAgents(Array.isArray(a.data.agents) ? a.data.agents : []);
    }
    saveJob({
      jobId: id,
      status: res.data.status,
      agentCount: res.data.agentCount,
      amount: res.data.amountBaseUnits != null ? String(res.data.amountBaseUnits) : undefined,
      task: storedJob(id)?.task ? undefined : res.data.task ? String(res.data.task).slice(0, 280) : undefined,
    });
    return res.data;
  }, [id]);

  // First load.
  useEffect(() => {
    alive.current = true;
    setJob(null);
    setAgents([]);
    setError("");
    if (!valid) return;
    refresh().catch((e) => {
      if (!alive.current) return;
      setError(e.message);
      toast(e.message, "error");
    });
    return () => {
      alive.current = false;
    };
  }, [id, valid, refresh, toast]);

  // Poll while the job is live, backing off on network errors.
  useEffect(() => {
    if (!job || !LIVE.has(job.status)) return;
    let timer;
    const tick = async () => {
      try {
        await refresh();
        failures.current = 0;
      } catch (e) {
        failures.current++;
        if (failures.current === 2) toast(`${e.message} We'll keep trying.`, "warn");
        timer = setTimeout(tick, Math.min(30000, POLL_MS * 2 ** failures.current));
      }
    };
    timer = setTimeout(tick, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [job, refresh, toast]);

  const verify = useCallback(async () => {
    const tx = storedJob(id)?.txHash;
    if (!tx) return toast("No payment found for this job on this device.", "warn");
    setChecking(true);
    const progress = toast("Confirming your payment with JellySwarm…", "progress");
    try {
      for (let attempt = 0; attempt < 40; attempt++) {
        const res = await api(`/jobs/${id}/payment`, { method: "POST", body: { transactionHash: tx } });
        if (res.status === 202) {
          progress.update("Payment confirmed. Your swarm is on it.", "success");
          await refresh();
          return;
        }
        if (res.status === 409 && res.data?.error === "payment_not_confirmed") {
          progress.update("Waiting for two confirmations on Elysium…", "progress");
          await sleep(3000);
          continue;
        }
        if (res.status === 409 && res.data?.error === "job_not_awaiting_payment") {
          progress.dismiss();
          await refresh();
          return;
        }
        throw new ApiError(res.status, res.data);
      }
      progress.update("Your payment is taking a while to confirm. It's saved, so check again shortly. Don't pay again.", "warn");
    } catch (e) {
      progress.update(e.message || "Couldn't confirm your payment yet.", "error");
    } finally {
      setChecking(false);
    }
  }, [id, refresh, toast]);

  async function pay() {
    const q = storedJob(id);
    if (!q?.payTo || !q.fundCall) return toast("This quote isn't on this device. Create a new quote.", "warn");
    const fc = q.fundCall;
    // The API is authoritative, but never send a transfer whose details disagree with the quote itself.
    if (
      String(fc.contract).toLowerCase() !== USDC.toLowerCase() ||
      String(fc.args?.[0]).toLowerCase() !== String(q.payTo).toLowerCase() ||
      String(fc.args?.[1]) !== String(q.amount)
    ) {
      return toast("The payment details don't match the quote. Please create a new quote.", "error");
    }
    setPaying(true);
    const progress = toast("Check your wallet to approve the payment…", "progress");
    try {
      const address = await ensureWallet();
      if (address.toLowerCase() !== q.clientAddress.toLowerCase()) {
        throw new Error(`Switch to the wallet that created this quote (${short(q.clientAddress)}).`);
      }
      const amount = BigInt(q.amount);
      const [usdc, hype] = await Promise.all([
        readContract(config, { chainId: elysium.id, address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] }).catch(() => null),
        getBalance(config, { chainId: elysium.id, address }).then((b) => b.value).catch(() => null),
      ]);
      if (usdc !== null && usdc < amount) {
        throw new Error(`You need ${formatUsdc(amount)} USDC on Elysium. Your wallet has ${formatUsdc(usdc)} USDC.`);
      }
      if (hype === 0n) throw new Error("Your wallet needs a little HYPE on Elysium to pay for gas.");

      let hash;
      try {
        hash = await writeContract(config, {
          chainId: elysium.id,
          account: getAccount(config).address,
          address: USDC,
          abi: erc20Abi,
          functionName: "transfer",
          args: [fc.args[0], amount],
        });
      } catch (e) {
        if (e?.name === "UserRejectedRequestError" || /reject|denied/i.test(e?.shortMessage || e?.message || "")) {
          throw new Error("You declined the payment. Nothing was sent.");
        }
        throw new Error(e?.shortMessage || "Your wallet could not send the payment.");
      }
      saveJob({ jobId: id, txHash: hash });
      progress.update("Payment sent. Waiting for it to confirm on Elysium…", "progress");

      let status = null;
      try {
        status = (await waitForTransactionReceipt(config, { chainId: elysium.id, hash, timeout: 180_000 })).status;
      } catch {
        status = null;
      }
      if (status === null) {
        progress.update("Your payment is still pending. We saved it, so check this job again in a minute. Don't pay again.", "warn");
        return;
      }
      if (status !== "success") {
        saveJob({ jobId: id, txHash: "" });
        progress.update("The payment transaction failed on chain, so no USDC moved. You can try again.", "error");
        return;
      }
      progress.dismiss();
      await verify();
    } catch (e) {
      progress.update(e.message || "The payment didn't go through.", "error");
    } finally {
      setPaying(false);
    }
  }

  const copy = async (text, msg) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(msg, "success");
    } catch {
      toast("Couldn't copy. Select the text and copy it instead.", "warn");
    }
  };

  if (!valid) {
    return (
      <div className="panel job">
        <EmptyState title="That isn't a job ID" body={ERRORS.invalid_job_id} cta={false} />
      </div>
    );
  }

  let body;
  if (!job) {
    body = error ? (
      <EmptyState title="We couldn't load this job" body={error} cta={false} />
    ) : (
      <div className="running-jelly">
        <img src="/media/jelly-sky.png" alt="" />
        <p>Loading your job…</p>
      </div>
    );
  } else {
    const n = Number(job.agentCount || saved.agentCount || 0);
    const amount = job.amountBaseUnits || saved.amount;
    const st = STATUS[job.status] || { label: job.status };
    body = (
      <>
        <div className="job-top">
          <div>
            <span className="eyebrow">
              {n ? `${n} of 247 agents` : "Job"}
              {amount ? ` · ${formatUsdc(amount)} USDC` : ""}
            </span>
            <h2>{st.label}</h2>
            <span className="job-id">
              {short(id, 10, 8)}
              <button className="copy-btn" type="button" onClick={() => copy(id, "Job ID copied.")}>
                Copy ID
              </button>
            </span>
          </div>
          <StatePill status={job.status} raw />
        </div>
        <Timeline status={job.status} />
        {(saved.task || job.task) && (
          <p className="muted" style={{ marginBottom: 18 }}>
            “{clip(saved.task || job.task, 220)}”
          </p>
        )}
        {job.status === "payment_pending" && (
          <PaymentBox job={job} saved={saved} paying={paying} checking={checking} onPay={pay} onVerify={verify} />
        )}
        {(job.status === "queued" || job.status === "running") && <RunningBox job={job} n={n} agents={agents} />}
        {(job.status === "payout_pending" || job.status === "settled") && <ResultBox job={job} onCopy={copy} />}
        {(job.status === "failed" || job.status === "settlement_pending") && <FailedBox job={job} id={id} />}
      </>
    );
  }

  return (
    <>
      <Link className="back-link" to="/app/jobs">
        <span aria-hidden="true">←</span> My jobs
      </Link>
      <div className="panel job" aria-live="polite">
        {body}
      </div>
    </>
  );
}

function PaymentBox({ job, saved, paying, checking, onPay, onVerify }) {
  const amount = saved.amount || job.amountBaseUnits;
  if (!saved.payTo || !saved.fundCall) {
    return (
      <div className="pay-box">
        <div className="pay-amount">
          {amount ? formatUsdc(amount) : "—"} <small>USDC</small>
        </div>
        <div className="notice info">This job is waiting for payment. Pay from the browser that created the quote, or create a new quote here.</div>
        {saved.txHash && (
          <div className="actions">
            <BusyButton className="button" type="button" busy={checking} busyLabel="Checking…" onClick={onVerify}>
              Check my payment
            </BusyButton>
          </div>
        )}
      </div>
    );
  }
  const paid = Boolean(saved.txHash);
  return (
    <div className="pay-box">
      <span className="eyebrow">Your quote</span>
      <div className="pay-amount">
        {formatUsdc(saved.amount)} <small>USDC</small>
      </div>
      <dl className="kv">
        <div>
          <dt>Pay to (escrow)</dt>
          <dd>{saved.payTo}</dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>Elysium · chain 99901</dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd>USDC</dd>
        </div>
        <div>
          <dt>Gas</dt>
          <dd>HYPE, paid by you</dd>
        </div>
        <div>
          <dt>From wallet</dt>
          <dd>{short(saved.clientAddress, 8, 6)}</dd>
        </div>
        {paid && (
          <div>
            <dt>Your transaction</dt>
            <dd>
              <TxLink hash={saved.txHash} />
            </dd>
          </div>
        )}
      </dl>
      {paid ? (
        <>
          <div className="notice info">Payment sent. We're waiting for two confirmations on Elysium, then the swarm starts. Don't pay again.</div>
          <div className="actions">
            <BusyButton className="button primary" type="button" busy={checking} busyLabel="Checking…" onClick={onVerify}>
              Check payment now
            </BusyButton>
          </div>
        </>
      ) : (
        <>
          <div className="actions">
            <BusyButton className="button primary wide" type="button" busy={paying} busyLabel="Check your wallet…" onClick={onPay}>
              Pay {formatUsdc(saved.amount)} USDC <span aria-hidden="true">→</span>
            </BusyButton>
          </div>
          <p className="fine">Your wallet will ask you to approve one USDC transfer to the escrow address above.</p>
        </>
      )}
    </div>
  );
}

function RunningBox({ job, n, agents }) {
  const byNumber = new Map(agents.map((a) => [Number(a.agentNumber), a.status]));
  const done = agents.filter((a) => a.status === "completed").length;
  const failed = agents.filter((a) => a.status === "failed").length;
  const allDone = n > 0 && done + failed >= n;
  return (
    <>
      <div className="running-jelly">
        <img src="/media/jelly-mint.png" alt="" />
        <p>
          {job.status === "queued"
            ? "Payment confirmed. Your swarm is getting ready…"
            : allDone
              ? "Every agent is done. Writing your answer now…"
              : "Your agents are working. You can leave this page and come back."}
        </p>
      </div>
      <div className="agents-box">
        <div className="agents-head">
          <span>
            <strong>{done}</strong>of {n} agents done{failed ? ` · ${failed} failed` : ""}
          </span>
          <span>Live</span>
        </div>
        <div className="agent-tiles">
          {Array.from({ length: n }, (_, k) => {
            const s = byNumber.get(k + 1) || "pending";
            return <i className="tile" key={k} data-s={s} title={`Agent ${k + 1}: ${s}`} />;
          })}
        </div>
      </div>
      <dl className="kv" style={{ marginTop: 18 }}>
        <div>
          <dt>Payment</dt>
          <dd>
            <TxLink hash={job.paymentTransactionHash} />
          </dd>
        </div>
      </dl>
    </>
  );
}

function ResultBox({ job, onCopy }) {
  const r = job.result || {};
  const findings = Array.isArray(r.agentFindings) ? r.agentFindings : [];
  return (
    <>
      {job.status !== "settled" && (
        <div className="notice info" style={{ marginBottom: 14 }}>
          Your answer is ready. The payment is still moving from escrow to the treasury, so this job isn't fully settled yet.
        </div>
      )}
      <div className="answer">
        <Markdown text={r.answer} />
      </div>
      <div className="actions" style={{ marginTop: 12 }}>
        <button className="button small" type="button" onClick={() => onCopy(r.answer || "", "Answer copied.")}>
          Copy answer
        </button>
      </div>
      {findings.length > 0 && (
        <div className="findings">
          <h3>What each agent found</h3>
          {findings.map((f, i) => (
            <details key={i}>
              <summary>
                Agent {i + 1}
                <span>{String(f || "").length.toLocaleString()} chars</span>
              </summary>
              <p>{f || "No output."}</p>
            </details>
          ))}
        </div>
      )}
      <dl className="kv" style={{ marginTop: 18 }}>
        <div>
          <dt>Payment</dt>
          <dd>
            <TxLink hash={job.paymentTransactionHash} />
          </dd>
        </div>
        {job.treasuryPayoutTransactionHash && (
          <div>
            <dt>Payout</dt>
            <dd>
              <TxLink hash={job.treasuryPayoutTransactionHash} />
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

function FailedBox({ job, id }) {
  const share = Number(job.settlementShareBps || 0);
  const refunding = job.status === "settlement_pending";
  return (
    <div className="pay-box">
      <div className="notice">
        {refunding
          ? `Your refund${share ? ` of ${share / 100}%` : ""} has been approved and is being sent to your wallet.`
          : "The agents couldn't finish this job. The JellySwarm team reviews every failed job and returns 50%, 70% or 100% of your payment to your wallet."}
      </div>
      <dl className="kv">
        {job.errorCode && (
          <div>
            <dt>Reason</dt>
            <dd>{job.errorCode}</dd>
          </div>
        )}
        <div>
          <dt>Payment</dt>
          <dd>
            <TxLink hash={job.paymentTransactionHash} />
          </dd>
        </div>
        {job.clientPayoutTransactionHash && (
          <div>
            <dt>Refund</dt>
            <dd>
              <TxLink hash={job.clientPayoutTransactionHash} />
            </dd>
          </div>
        )}
      </dl>
      <p className="fine left">Keep this job ID if you contact the team: {id}</p>
    </div>
  );
}
