import React, { useCallback, useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, ConnectButton, useConnectModal } from "@rainbow-me/rainbowkit";
import { WagmiProvider, useAccount, useSwitchChain } from "wagmi";
import { signTypedData } from "wagmi/actions";
import { config, elysium, rkTheme } from "../app/wallet.js";
import { formatUsdc, short } from "../app/lib.js";
import "@rainbow-me/rainbowkit/styles.css";
import "../styles/site.css";
import "../styles/admin.css";

const queryClient = new QueryClient();

async function adminApi(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api/admin${path}`, {
      method: options.method || "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: options.body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new Error("The admin service could not be reached.");
  }
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = body.error;
    error.requestId = response.headers.get("x-request-id");
    throw error;
  }
  return body;
}

function AdminModal({ dialog, onClose }) {
  if (!dialog) return null;
  return (
    <div className="admin-modal-backdrop">
      <section className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-modal-title" aria-busy={dialog.kind === "loading"}>
        <span className={`admin-modal-mark ${dialog.kind}`} aria-hidden="true">{dialog.kind === "loading" ? <i /> : dialog.kind === "success" ? "✓" : dialog.kind === "error" ? "!" : "i"}</span>
        <span className="admin-kicker">{dialog.kind === "loading" ? "PLEASE WAIT" : dialog.kind === "success" ? "COMPLETE" : dialog.kind === "error" ? "ACTION NEEDED" : "PAYOUT STATUS"}</span>
        <h2 id="admin-modal-title">{dialog.title}</h2>
        <p>{dialog.message}</p>
        {dialog.requestId && <small>Request reference <code>{dialog.requestId}</code></small>}
        {dialog.kind !== "loading" && <button className="admin-primary" type="button" onClick={onClose}>{dialog.actionLabel || "Close"}</button>}
      </section>
    </div>
  );
}

function AdminPortal() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [summary, setSummary] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [filter, setFilter] = useState("failed");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [treasury, setTreasury] = useState("");
  const [shareBps, setShareBps] = useState(7_000);
  const account = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChain } = useSwitchChain();

  const loadDashboard = useCallback(async (status = "failed", query = "", showLoading = true) => {
    if (showLoading) setDialog({ kind: "loading", title: "Loading operations", message: "Fetching the latest jobs and payout status." });
    try {
      const [overview, list] = await Promise.all([
        adminApi("/summary"),
        adminApi(`/jobs?status=${encodeURIComponent(status)}&q=${encodeURIComponent(query)}&limit=100`),
      ]);
      setSummary(overview);
      setJobs(list.jobs || []);
      const configData = await adminApi("/config");
      setTreasury(configData.treasuryPublicKey || "");
      if (showLoading) setDialog(null);
      return true;
    } catch (err) {
      if (err.status === 401) setAuthenticated(false);
      setDialog({ kind: "error", title: "Could not load operations", message: err.message || "Could not load admin data.", requestId: err.requestId });
      return false;
    }
  }, []);

  useEffect(() => {
    let active = true;
    adminApi("/session")
      .then(() => {
        if (!active) return;
        setAuthenticated(true);
        void loadDashboard("failed", "");
      })
      .catch((err) => {
        if (err.status !== 401) setDialog({ kind: "error", title: "Could not check admin session", message: err.message || "The admin service could not be reached.", requestId: err.requestId });
      })
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, [loadDashboard]);

  useEffect(() => {
    document.title = authenticated ? "Admin — JellySwarm" : "Admin sign in — JellySwarm";
  }, [authenticated]);

  const signIn = async (event) => {
    event.preventDefault();
    setBusy(true);
    setDialog({ kind: "loading", title: "Checking admin access", message: "Verifying your password securely with the backend." });
    try {
      await adminApi("/session", { method: "POST", body: { password } });
      setPassword("");
      setAuthenticated(true);
      if (await loadDashboard(filter, appliedSearch)) {
        setDialog({ kind: "success", title: "Admin access granted", message: "Your secure admin session is active." });
      }
    } catch (err) {
      setPassword("");
      setDialog({ kind: "error", title: "Could not unlock admin", message: err.status === 429 ? "Too many attempts. Wait a minute and try again." :
        err.status === 503 ? "Admin access is not configured on the backend." :
          err.status === 401 ? "That password did not match." : err.message, requestId: err.requestId });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setDialog({ kind: "loading", title: "Locking admin", message: "Ending the secure session." });
    try {
      await adminApi("/session", { method: "DELETE" });
      setAuthenticated(false);
      setSelected(null);
      setDetail(null);
      setSummary(null);
      setJobs([]);
      setDialog({ kind: "success", title: "Admin locked", message: "Your admin session has ended." });
    } catch (err) {
      setDialog({ kind: "error", title: "Could not lock admin", message: err.message || "The session could not be closed.", requestId: err.requestId });
    } finally {
      setBusy(false);
    }
  };

  const switchToElysium = async () => {
    try {
      await switchChain({ chainId: elysium.id });
    } catch {
      setDialog({ kind: "error", title: "Could not switch networks", message: "The wallet could not switch to Elysium." });
    }
  };

  const openJob = async (job) => {
    setSelected(job);
    setDetail(null);
    setDialog({ kind: "loading", title: "Loading job", message: "Fetching the job, agent results, and payout details." });
    try {
      setDetail(await adminApi(`/jobs/${encodeURIComponent(job.id)}`));
      setDialog(null);
    } catch (err) {
      if (err.status === 401) setAuthenticated(false);
      setDialog({ kind: "error", title: "Could not load job", message: err.message || "Could not load job details.", requestId: err.requestId });
    }
  };

  const issueRefund = async () => {
    if (!selected || !treasury) return;
    const signer = account.address;
    if (!signer) return setDialog({ kind: "error", title: "Connect the treasury wallet", message: "Connect the configured treasury wallet before signing this decision." });
    if (signer.toLowerCase() !== treasury.toLowerCase()) return setDialog({ kind: "error", title: "Wrong wallet connected", message: `Connect the configured treasury wallet (${short(treasury)}).` });
    if (account.chainId !== elysium.id) return setDialog({ kind: "error", title: "Switch to Elysium", message: "The treasury decision must be signed on Elysium." });
    setBusy(true);
    let decisionSubmitted = false;
    try {
      const deadline = Math.floor(Date.now() / 1000) + 300;
      setDialog({ kind: "loading", title: "Preparing treasury decision", message: "Checking the job and preparing the signed refund details." });
      const typed = await adminApi(`/jobs/${encodeURIComponent(selected.id)}/settlement/typed-data?clientShareBps=${shareBps}&deadline=${deadline}`);
      setDialog({ kind: "loading", title: "Approve in your treasury wallet", message: "Confirm the refund decision in your connected wallet. The wallet address and refund split will be verified by the backend." });
      const signature = await signTypedData(config, {
        account: signer,
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: {
          ...typed.message,
          amount: BigInt(typed.message.amount),
          nonce: BigInt(typed.message.nonce),
          deadline: BigInt(typed.message.deadline),
        },
      });
      setDialog({ kind: "loading", title: "Treasury signature received", message: "Recording the decision and starting the USDC payout. Network confirmation can take a little while; please keep this page open." });
      try {
        await adminApi(`/jobs/${encodeURIComponent(selected.id)}/settlement`, {
          method: "POST",
          body: { clientShareBps: shareBps, deadline, signature },
        });
        decisionSubmitted = true;
      } catch (err) {
        if (err.code !== "payout_pending_retry_required") throw err;
        // Older backend versions wait for an on-chain receipt before responding.
        // This response means the signed decision is stored and retries are scheduled.
        decisionSubmitted = true;
      }

      setDialog({ kind: "loading", title: "Refund payout processing", message: "The signed decision is recorded. The escrow wallet is sending the payout and waiting for Elysium confirmations." });
      const latest = await adminApi(`/jobs/${encodeURIComponent(selected.id)}`);
      setDetail(latest);
      await loadDashboard(filter, appliedSearch, false);
      if (latest?.job.status === "settled") {
        setDialog({ kind: "success", title: "Refund settled", message: "The treasury-approved decision completed and payout transactions are confirmed." });
      } else {
        setDialog({ kind: "info", title: "Refund decision recorded", message: "The treasury signature is accepted and the payout is processing in the background. You can close this message; refresh the job later to see its latest status." });
      }
    } catch (err) {
      if (decisionSubmitted) {
        setDialog({ kind: "info", title: "Refund decision recorded", message: "The treasury decision was accepted, but the latest payout status could not be fetched. The backend will keep processing it; refresh this job later.", requestId: err.requestId });
      } else {
        setDialog({ kind: "error", title: "Could not resolve this job", message: err.message || "The treasury decision could not be submitted.", requestId: err.requestId });
      }
    } finally {
      setBusy(false);
    }
  };

  const statusCards = useMemo(() => [
    ["Running", ["queued", "running"]],
    ["Needs review", ["failed"]],
    ["Payout pending", ["payout_pending", "settlement_pending"]],
    ["Settled", ["settled"]],
  ].map(([label, statuses]) => [label, statuses.reduce((sum, status) => sum + (summary?.statuses?.[status]?.count || 0), 0)])
    .concat([["Stuck 15m+", summary?.stuckCount || 0]]), [summary]);

  if (checkingSession) return <main className="admin-lock"><AdminModal dialog={{ kind: "loading", title: "Checking admin session", message: "Securely checking for an active session." }} /></main>;

  if (!authenticated) return (
    <main className="admin-lock">
      <form className="admin-lock-card" onSubmit={signIn}>
        <a className="admin-brand" href="/"><img src="/media/brand-pfp.png" alt="" /> JellySwarm</a>
        <span className="admin-kicker">PRIVATE OPERATIONS</span>
        <h1>Admin access</h1>
        <p>Sign in to review jobs and operator decisions.</p>
        <label htmlFor="admin-password">Admin password</label>
        <input id="admin-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required autoFocus />
        <button className="admin-primary" type="submit" disabled={busy || !password}>Unlock admin</button>
        <small>Password verification happens on the backend. This browser keeps only a short-lived, HTTP-only session cookie.</small>
      </form>
      <AdminModal dialog={dialog} onClose={() => setDialog(null)} />
    </main>
  );

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div><a className="admin-brand" href="/"><img src="/media/brand-pfp.png" alt="" /> JellySwarm</a><span className="admin-kicker">OPERATIONS</span></div>
        <div className="admin-header-actions"><ConnectButton /><button className="admin-quiet" type="button" onClick={signOut} disabled={busy}>Lock</button></div>
      </header>
      <div className="admin-content">
        <div className="admin-heading"><div><span className="admin-kicker">PRIVATE OPERATIONS</span><h1>Swarm control room</h1><p>Find stalled work, review failed jobs, and sign treasury-approved refund decisions.</p></div><button className="admin-quiet" type="button" onClick={() => void loadDashboard(filter, appliedSearch)} disabled={busy}>Refresh</button></div>
        <section className="admin-stat-grid" aria-label="Job summary">
          {statusCards.map(([label, count]) => <article className="admin-stat" key={label}><span>{label}</span><strong>{count}</strong></article>)}
        </section>
        <div className="admin-columns">
          <section className="admin-panel">
            <div className="admin-panel-head"><div><span className="admin-kicker">QUEUE</span><h2>Jobs</h2></div>
              <div className="admin-job-filters">
                <form className="admin-search" onSubmit={(event) => { event.preventDefault(); setAppliedSearch(search); void loadDashboard(filter, search); }}>
                  <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find by job ID, wallet, or task" aria-label="Search jobs" />
                  <button className="admin-quiet" type="submit">Search</button>
                </form>
                <select value={filter} onChange={(event) => { setFilter(event.target.value); void loadDashboard(event.target.value, appliedSearch); }} aria-label="Filter jobs">
                  <option value="stuck">Stuck · needs attention</option><option value="failed">Failed · resolve dispute</option><option value="settlement_pending">Refund pending</option><option value="payout_pending">Payout pending</option><option value="running">Running</option><option value="queued">Queued</option><option value="settled">Settled</option><option value="all">All jobs</option>
                </select>
              </div>
            </div>
            <div className="admin-job-list">
              {jobs.map((job) => <button className={`admin-job${selected?.id === job.id ? " selected" : ""}`} type="button" key={job.id} onClick={() => void openJob(job)}>
                <span className="admin-job-main"><strong>{job.status.replaceAll("_", " ")}{job.isStuck ? " · stuck" : ""}</strong><code>{short(job.id, 10, 8)}</code><span>{job.agentCount} agents · {formatUsdc(job.amountBaseUnits)} USDC</span></span>
                <span className="admin-job-date">{new Date(job.createdAt).toLocaleString()}</span>
              </button>)}
              {!jobs.length && <div className="admin-empty">No jobs in this view.</div>}
            </div>
          </section>

          <section className="admin-panel admin-detail">
            {!selected && <div className="admin-empty admin-detail-empty"><span className="admin-kicker">JOB DETAIL</span><h2>Select a job</h2><p>Payment, result, agent, and payout details will appear here.</p></div>}
            {detail && <>
              <div className="admin-panel-head"><div><span className="admin-kicker">JOB DETAIL</span><h2>{detail.job.status.replaceAll("_", " ")}</h2></div><code>{short(detail.job.id, 10, 8)}</code></div>
              <dl className="admin-facts"><div><dt>Client</dt><dd><code>{detail.job.clientAddress}</code></dd></div><div><dt>Workers</dt><dd>{detail.job.successfulAgentCount ?? 0} / {detail.job.agentCount}</dd></div><div><dt>Paid</dt><dd>{formatUsdc(detail.job.amountBaseUnits)} USDC</dd></div><div><dt>Automatic refund</dt><dd>{formatUsdc(detail.job.automaticRefundBaseUnits)} USDC</dd></div><div><dt>Created</dt><dd>{new Date(detail.job.createdAt).toLocaleString()}</dd></div></dl>
              <div className="admin-task"><b>Task</b><p>{detail.job.task}</p></div>
              {detail.job.errorCode && <div className="admin-task"><b>Failure reason</b><p>{detail.job.errorCode}</p></div>}
              {detail.job.result?.answer && <div className="admin-task"><b>Result</b><p>{detail.job.result.answer}</p></div>}
              <div className="admin-task"><b>Transactions</b><p>Payment: <code>{detail.job.paymentTransactionHash || "—"}</code></p>{detail.payouts.map((payout) => <p key={payout.kind}>{payout.kind}: {payout.status} · <code>{payout.transactionHash || "—"}</code></p>)}</div>
              {detail.job.status === "failed" && <div className="admin-refund"><b>Resolve failed job</b><p>Choose the client refund share. The treasury wallet must approve and sign the decision.</p><label htmlFor="refund-share">Client share</label><select id="refund-share" value={shareBps} onChange={(event) => setShareBps(Number(event.target.value))}><option value={10000}>100% client refund</option><option value={7000}>70% client / 30% treasury</option><option value={5000}>50% client / 50% treasury</option></select>
                {account.address ? <div className={`admin-signer ${account.address.toLowerCase() === treasury.toLowerCase() ? "is-valid" : "is-invalid"}`}><span>{account.address.toLowerCase() === treasury.toLowerCase() ? "Treasury wallet connected" : "Connected wallet does not match treasury"}</span><code>{short(account.address, 8, 6)}</code>{account.chainId !== elysium.id && <button className="admin-quiet" type="button" onClick={() => void switchToElysium()}>Switch to Elysium</button>}</div> : <button className="admin-quiet" type="button" onClick={() => openConnectModal?.()}>Connect treasury wallet</button>}
                <button className="admin-primary" type="button" onClick={() => void issueRefund()} disabled={busy || !treasury || !account.address || account.address.toLowerCase() !== treasury.toLowerCase() || account.chainId !== elysium.id}>Review and sign refund</button><small>Requires an admin session and a signature from the configured treasury wallet.</small></div>}
              <details className="admin-agents"><summary>Agent work ({detail.agents.length})</summary>{detail.agents.map((agent) => <article key={agent.agentNumber}><b>Agent {agent.agentNumber} · {agent.status}</b>{agent.errorCode && <p>{agent.errorCode}</p>}{agent.output && <p>{agent.output}</p>}</article>)}</details>
            </>}
          </section>
        </div>
      </div>
      <AdminModal dialog={dialog} onClose={() => setDialog(null)} />
    </main>
  );
}

export default function AdminPortalEntry() {
  return <WagmiProvider config={config}><QueryClientProvider client={queryClient}><RainbowKitProvider theme={rkTheme}><AdminPortal /></RainbowKitProvider></QueryClientProvider></WagmiProvider>;
}
