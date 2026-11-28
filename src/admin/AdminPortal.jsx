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
    throw error;
  }
  return body;
}

function AdminPortal() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [filter, setFilter] = useState("failed");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [treasury, setTreasury] = useState("");
  const [shareBps, setShareBps] = useState(7_000);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const account = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChain } = useSwitchChain();

  const loadDashboard = useCallback(async (status = "failed", query = "") => {
    setError("");
    try {
      const [overview, list] = await Promise.all([
        adminApi("/summary"),
        adminApi(`/jobs?status=${encodeURIComponent(status)}&q=${encodeURIComponent(query)}&limit=100`),
      ]);
      setSummary(overview);
      setJobs(list.jobs || []);
      const configData = await adminApi("/config");
      setTreasury(configData.treasuryPublicKey || "");
    } catch (err) {
      if (err.status === 401) setAuthenticated(false);
      setError(err.message || "Could not load admin data.");
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
      .catch(() => {})
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, [loadDashboard]);

  useEffect(() => {
    if (!authenticated) return undefined;
    const timer = window.setTimeout(() => { void loadDashboard(filter, search); }, 250);
    return () => window.clearTimeout(timer);
  }, [authenticated, filter, search, loadDashboard]);

  useEffect(() => {
    document.title = authenticated ? "Admin — JellySwarm" : "Admin sign in — JellySwarm";
  }, [authenticated]);

  const signIn = async (event) => {
    event.preventDefault();
    setBusy(true);
    setLoginError("");
    try {
      await adminApi("/session", { method: "POST", body: { password } });
      setPassword("");
      setAuthenticated(true);
      await loadDashboard(filter, search);
    } catch (err) {
      setPassword("");
      setLoginError(err.status === 429 ? "Too many attempts. Wait a minute and try again." :
        err.status === 503 ? "Admin access is not configured on the backend." :
          err.status === 401 ? "That password did not match." : err.message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await adminApi("/session", { method: "DELETE" }).catch(() => {});
    setAuthenticated(false);
    setSelected(null);
    setDetail(null);
    setSummary(null);
    setJobs([]);
  };

  const switchToElysium = async () => {
    try {
      await switchChain({ chainId: elysium.id });
    } catch {
      setError("The wallet could not switch to Elysium.");
    }
  };

  const openJob = async (job) => {
    setSelected(job);
    setDetail(null);
    setNotice("");
    try {
      setDetail(await adminApi(`/jobs/${encodeURIComponent(job.id)}`));
    } catch (err) {
      if (err.status === 401) setAuthenticated(false);
      setError(err.message || "Could not load job details.");
    }
  };

  const issueRefund = async () => {
    if (!selected || !treasury) return;
    const signer = account.address;
    if (!signer) return setError("Connect the treasury wallet to sign this decision.");
    if (signer.toLowerCase() !== treasury.toLowerCase()) return setError(`Connect the treasury wallet (${short(treasury)}).`);
    if (account.chainId !== elysium.id) return setError("Switch the treasury wallet to Elysium to sign this decision.");
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const typed = await adminApi(`/jobs/${encodeURIComponent(selected.id)}/settlement/typed-data?clientShareBps=${shareBps}&deadline=${deadline}`);
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
      const result = await adminApi(`/jobs/${encodeURIComponent(selected.id)}/settlement`, {
        method: "POST",
        body: { clientShareBps: shareBps, deadline, signature },
      });
      setNotice(result.status === "settled" ? "Refund decision signed and payout settled." : "Decision recorded. Payout remains pending and will retry automatically.");
      await loadDashboard(filter, search);
      await openJob({ ...selected, status: result.status });
    } catch (err) {
      setError(err.message || "Could not submit the treasury decision.");
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

  if (checkingSession) return <div className="admin-lock"><div className="admin-lock-card"><span className="admin-kicker">JELLYSWARM / ADMIN</span><p>Checking session…</p></div></div>;

  if (!authenticated) return (
    <main className="admin-lock">
      <form className="admin-lock-card" onSubmit={signIn}>
        <a className="admin-brand" href="/"><img src="/media/brand-pfp.png" alt="" /> JellySwarm</a>
        <span className="admin-kicker">PRIVATE OPERATIONS</span>
        <h1>Admin access</h1>
        <p>Sign in to review jobs and operator decisions.</p>
        <label htmlFor="admin-password">Admin password</label>
        <input id="admin-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required autoFocus />
        {loginError && <p className="admin-error" role="alert">{loginError}</p>}
        <button className="admin-primary" type="submit" disabled={busy || !password}>{busy ? "Checking…" : "Unlock admin"}</button>
        <small>Password verification happens on the backend. This browser keeps only a short-lived, HTTP-only session cookie.</small>
      </form>
    </main>
  );

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div><a className="admin-brand" href="/"><img src="/media/brand-pfp.png" alt="" /> JellySwarm</a><span className="admin-kicker">OPERATIONS</span></div>
        <div className="admin-header-actions"><ConnectButton /><button className="admin-quiet" type="button" onClick={signOut}>Lock</button></div>
      </header>
      <div className="admin-content">
        <div className="admin-heading"><div><span className="admin-kicker">PRIVATE OPERATIONS</span><h1>Swarm control room</h1><p>Find stalled work, review failed jobs, and sign treasury-approved refund decisions.</p></div><button className="admin-quiet" type="button" onClick={() => loadDashboard(filter, search)} disabled={busy}>Refresh</button></div>
        {error && <div className="admin-alert" role="alert">{error}</div>}
        {notice && <div className="admin-notice" role="status">{notice}</div>}
        <section className="admin-stat-grid" aria-label="Job summary">
          {statusCards.map(([label, count]) => <article className="admin-stat" key={label}><span>{label}</span><strong>{count}</strong></article>)}
        </section>
        <div className="admin-columns">
          <section className="admin-panel">
            <div className="admin-panel-head"><div><span className="admin-kicker">QUEUE</span><h2>Jobs</h2></div>
              <div className="admin-job-filters">
                <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find by job ID, wallet, or task" aria-label="Search jobs" />
                <select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter jobs">
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
            {selected && !detail && <div className="admin-empty">Loading job…</div>}
            {detail && <>
              <div className="admin-panel-head"><div><span className="admin-kicker">JOB DETAIL</span><h2>{detail.job.status.replaceAll("_", " ")}</h2></div><code>{short(detail.job.id, 10, 8)}</code></div>
              <dl className="admin-facts"><div><dt>Client</dt><dd><code>{detail.job.clientAddress}</code></dd></div><div><dt>Workers</dt><dd>{detail.job.successfulAgentCount ?? 0} / {detail.job.agentCount}</dd></div><div><dt>Paid</dt><dd>{formatUsdc(detail.job.amountBaseUnits)} USDC</dd></div><div><dt>Automatic refund</dt><dd>{formatUsdc(detail.job.automaticRefundBaseUnits)} USDC</dd></div><div><dt>Created</dt><dd>{new Date(detail.job.createdAt).toLocaleString()}</dd></div></dl>
              <div className="admin-task"><b>Task</b><p>{detail.job.task}</p></div>
              {detail.job.errorCode && <div className="admin-alert">{detail.job.errorCode}</div>}
              {detail.job.result?.answer && <div className="admin-task"><b>Result</b><p>{detail.job.result.answer}</p></div>}
              <div className="admin-task"><b>Transactions</b><p>Payment: <code>{detail.job.paymentTransactionHash || "—"}</code></p>{detail.payouts.map((payout) => <p key={payout.kind}>{payout.kind}: {payout.status} · <code>{payout.transactionHash || "—"}</code></p>)}</div>
              {detail.job.status === "failed" && <div className="admin-refund"><b>Resolve failed job</b><p>Choose the client refund share. The treasury wallet must approve and sign the decision.</p><label htmlFor="refund-share">Client share</label><select id="refund-share" value={shareBps} onChange={(event) => setShareBps(Number(event.target.value))}><option value={10000}>100% client refund</option><option value={7000}>70% client / 30% treasury</option><option value={5000}>50% client / 50% treasury</option></select>
                {account.address ? <div className={`admin-signer ${account.address.toLowerCase() === treasury.toLowerCase() ? "is-valid" : "is-invalid"}`}><span>{account.address.toLowerCase() === treasury.toLowerCase() ? "Treasury wallet connected" : "Connected wallet does not match treasury"}</span><code>{short(account.address, 8, 6)}</code>{account.chainId !== elysium.id && <button className="admin-quiet" type="button" onClick={() => void switchToElysium()}>Switch to Elysium</button>}</div> : <button className="admin-quiet" type="button" onClick={() => openConnectModal?.()}>Connect treasury wallet</button>}
                <button className="admin-primary" type="button" onClick={() => void issueRefund()} disabled={busy || !treasury || !account.address || account.address.toLowerCase() !== treasury.toLowerCase() || account.chainId !== elysium.id}>{busy ? "Waiting for signature…" : "Review and sign refund"}</button><small>Requires an admin session and a signature from the configured treasury wallet.</small></div>}
              <details className="admin-agents"><summary>Agent work ({detail.agents.length})</summary>{detail.agents.map((agent) => <article key={agent.agentNumber}><b>Agent {agent.agentNumber} · {agent.status}</b>{agent.errorCode && <p>{agent.errorCode}</p>}{agent.output && <p>{agent.output}</p>}</article>)}</details>
            </>}
          </section>
        </div>
      </div>
    </main>
  );
}

export default function AdminPortalEntry() {
  return <WagmiProvider config={config}><QueryClientProvider client={queryClient}><RainbowKitProvider theme={rkTheme}><AdminPortal /></RainbowKitProvider></QueryClientProvider></WagmiProvider>;
}
