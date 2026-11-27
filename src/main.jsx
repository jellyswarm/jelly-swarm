import React, { useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, defineChain, formatUnits, http, parseAbi } from "viem";
import { createRoot } from "react-dom/client";
import "./style.css";

const ELYSIUM_ID = 99901;
const USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65";
const elysium = defineChain({
  id: ELYSIUM_ID,
  name: "Elysium",
  nativeCurrency: { decimals: 18, name: "HYPE", symbol: "HYPE" },
  rpcUrls: { default: { http: ["https://rpc.elysium.kinetiq.xyz"] } },
  blockExplorers: { default: { name: "Elysium Explorer", url: "https://elysium.kinetiq.xyz/explorer" } },
});
const erc20Abi = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);
const escrowAbi = parseAbi(["function fundJob(bytes32 jobId, uint128 amount)"]);
const publicClient = createPublicClient({ chain: elysium, transport: http() });

async function ensureWallet(walletClient) {
  if (!walletClient || !window.ethereum) throw new Error("Install an EVM wallet to continue.");
  const [address] = await walletClient.requestAddresses();
  const chainId = await walletClient.getChainId();
  if (chainId !== ELYSIUM_ID) {
    try {
      await walletClient.switchChain({ id: ELYSIUM_ID });
    } catch (error) {
      if (error?.code !== 4902 && error?.cause?.code !== 4902) throw error;
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: `0x${ELYSIUM_ID.toString(16)}`,
          chainName: "Elysium",
          nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
          rpcUrls: ["https://rpc.elysium.kinetiq.xyz"],
          blockExplorerUrls: ["https://elysium.kinetiq.xyz/explorer"],
        }],
      });
      await walletClient.switchChain({ id: ELYSIUM_ID });
    }
  }
  return address;
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 402) throw new Error(body.error ?? `Request failed (${response.status})`);
  return { status: response.status, body };
}

function App() {
  const [task, setTask] = useState("");
  const [agentCount, setAgentCount] = useState(12);
  const [paymentMode, setPaymentMode] = useState("x402");
  const [account, setAccount] = useState("");
  const [quote, setQuote] = useState(null);
  const [jobId, setJobId] = useState("");
  const [job, setJob] = useState(null);
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");

  const walletClient = useMemo(() => {
    if (!window.ethereum) return null;
    return createWalletClient({ chain: elysium, transport: custom(window.ethereum) });
  }, []);

  useEffect(() => {
    if (!jobId || !["queued", "running"].includes(job?.status)) return;
    const poll = async () => {
      try {
        const { body } = await api(`/jobs/${jobId}`);
        setJob(body);
      } catch (err) {
        setError(err.message);
      }
    };
    const timer = window.setInterval(poll, 2500);
    void poll();
    return () => window.clearInterval(timer);
  }, [jobId, job?.status]);

  useEffect(() => {
    if (["completed", "failed", "settled"].includes(job?.status)) {
      setQuote(null);
      setPhase("idle");
    }
  }, [job?.status]);

  async function connectWallet() {
    const address = await ensureWallet(walletClient);
    setAccount(address);
    return address;
  }

  async function submitJob(event) {
    event.preventDefault();
    setError("");
    setJob(null);
    setJobId("");
    setQuote(null);
    try {
      setPhase("connecting");
      const address = await ensureWallet(walletClient);
      setAccount(address);

      setPhase("quoting");
      const quote = await api("/jobs", {
        method: "POST",
        body: JSON.stringify({ task, agentCount: Number(agentCount), clientAddress: address, paymentMode }),
      });
      if (quote.status !== 402 && quote.status !== 201) throw new Error("Payment quote was not returned.");
      setJobId(quote.body.jobId);
      setQuote(quote.body);
      setPhase("quoted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("idle");
    }
  }

  async function confirmPayment() {
    if (!quote || !walletClient) return;
    setError("");
    try {
      const address = await ensureWallet(walletClient);
      if (address.toLowerCase() !== quote.payment.accepts[0].extra.clientAddress.toLowerCase()) {
        throw new Error("Reconnect the wallet used to create this quote.");
      }
      const payment = quote.payment.accepts[0];
      setPhase("approving");
      const approvalHash = await walletClient.writeContract({
        account: address,
        address: USDC,
        abi: erc20Abi,
        functionName: "approve",
        args: [payment.payTo, BigInt(payment.amount)],
      });
      const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash });
      if (approvalReceipt.status !== "success") throw new Error("USDC approval failed.");

      setPhase("funding");
      const fundHash = await walletClient.writeContract({
        account: address,
        address: quote.fundCall.contract,
        abi: escrowAbi,
        functionName: "fundJob",
        args: [quote.fundCall.args[0], BigInt(quote.fundCall.args[1])],
      });
      const fundingReceipt = await publicClient.waitForTransactionReceipt({ hash: fundHash });
      if (fundingReceipt.status !== "success") throw new Error("Escrow funding failed.");

      setPhase("confirming");
      let confirmed = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const paid = await api(`/jobs/${quote.jobId}/payment`, {
            method: "POST",
            body: JSON.stringify({ transactionHash: fundHash }),
          });
          if (paid.status === 202) {
            confirmed = true;
            break;
          }
        } catch (err) {
          if (err.message !== "payment_not_confirmed") throw err;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
      if (!confirmed) throw new Error("Payment is still confirming. Your job is saved; check its ID again shortly.");
      setPhase("queued");
      setJob({ status: "queued", agentCount: quote.agentCount });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("quoted");
    }
  }

  const busy = ["connecting", "quoting", "approving", "funding", "confirming"].includes(phase);
  const status = job?.status ?? (phase === "quoted" ? "payment_pending" : phase);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="JellySwarm home">
          <span className="mark" aria-hidden="true"><i /><i /><i /></span>
          JellySwarm
        </a>
        <div className="network"><span className="online-dot" /> ELYSIUM MAINNET <span className="divider">/</span> USDC</div>
        <button className="wallet-button" onClick={() => connectWallet().catch((err) => setError(err.message))}>
          {account ? `${account.slice(0, 6)}…${account.slice(-4)}` : "Connect wallet"}
        </button>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow"><span>01</span> INTELLIGENCE, IN PARALLEL</p>
          <h1>One task.<br /><em>A whole swarm.</em></h1>
          <p className="hero-summary">Give your job to independent agents. They work in parallel, then bring their findings together into one clear result.</p>
          <div className="proof-row">
            <div><strong>247</strong><span>AGENTS, MAX</span></div>
            <div><strong>USDC</strong><span>PAID UP FRONT</span></div>
            <div><strong>ELY</strong><span>SETTLED ON ELYSIUM</span></div>
          </div>
        </div>
        <div className="swarm-card" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" />
          <div className="swarm-core"><span className="mark large"><i /><i /><i /></span><b>YOUR JOB</b></div>
          {Array.from({ length: 14 }, (_, i) => <span key={i} className={`agent-node node-${i + 1}`} />)}
          <div className="swarm-label label-left">PARALLEL WORK</div><div className="swarm-label label-right">ONE RESULT</div>
        </div>
      </section>

      <section className="workspace" aria-label="Create a job">
        <div className="section-heading"><div><p className="eyebrow"><span>02</span> START A JOB</p><h2>What should the swarm work on?</h2></div><p className="micro-copy">UP TO 247 AGENTS<br />ONE SYNTHESIZED RESULT</p></div>
        <form className="job-form" onSubmit={submitJob}>
          <label className="field-label" htmlFor="task">YOUR TASK <span>Be specific. The agents will work independently.</span></label>
          <textarea id="task" value={task} onChange={(event) => setTask(event.target.value)} maxLength={12000} minLength={3} required disabled={Boolean(quote)} placeholder="Example: Compare the leading open-source vector databases for a small team. Evaluate cost, operational complexity, and performance, then recommend one." />
          <div className="form-controls">
            <div className="agents-control">
              <label className="field-label" htmlFor="agent-count">AGENTS</label>
              <div className="count-picker"><button type="button" disabled={Boolean(quote)} aria-label="Decrease agent count" onClick={() => setAgentCount((count) => Math.max(1, Number(count) - 1))}>−</button><input id="agent-count" type="number" min="1" max="247" disabled={Boolean(quote)} value={agentCount} onChange={(event) => setAgentCount(Math.min(247, Math.max(1, Number(event.target.value))))} /><button type="button" disabled={Boolean(quote)} aria-label="Increase agent count" onClick={() => setAgentCount((count) => Math.min(247, Number(count) + 1))}>+</button></div>
            </div>
            <div className="payment-control">
              <label className="field-label">PAYMENT METHOD</label>
              <div className="payment-switch" role="group" aria-label="Payment method">
                <button type="button" disabled={Boolean(quote)} className={paymentMode === "x402" ? "selected" : ""} onClick={() => setPaymentMode("x402")}>x402 checkout</button>
                <button type="button" disabled={Boolean(quote)} className={paymentMode === "direct" ? "selected" : ""} onClick={() => setPaymentMode("direct")}>Direct USDC</button>
              </div>
            </div>
            <button className="submit-button" type="submit" disabled={busy || Boolean(quote) || task.trim().length < 3}>
              {busy ? <><span className="spinner" /> {phaseLabel(phase)}</> : <>Get payment quote <span aria-hidden="true">↗</span></>}
            </button>
          </div>
          <div className="payment-note"><span className="lock-mark">⌑</span> USDC is held in escrow until an operator signs a settlement decision. You’ll need HYPE for approval and funding gas.</div>
        </form>
      </section>

      {(jobId || error) && <section className="job-state" aria-live="polite">
        {jobId && <div className="job-state-head"><div><p className="eyebrow"><span>03</span> JOB STATUS</p><h2>{statusLabel(status)}</h2></div><span className={`state-pill state-${status}`}>{status.replaceAll("_", " ")}</span></div>}
        {jobId && <p className="job-reference">JOB <code>{jobId}</code></p>}
        {quote && phase === "quoted" && <div className="quote-panel">
          <div><span>UPFRONT TOTAL</span><strong>{formatUnits(BigInt(quote.payment.accepts[0].amount), 6)} USDC</strong><small>{quote.agentCount} agents + 1 synthesis call</small></div>
          <div className="quote-actions"><button className="submit-button" onClick={confirmPayment} disabled={busy}>{busy ? <><span className="spinner" /> {phaseLabel(phase)}</> : <>Approve &amp; fund <span aria-hidden="true">↗</span></>}</button></div>
        </div>}
        {job?.status === "running" && <div className="running-line"><span /><span /><span /><span /><span /><small>{job.agentCount ?? agentCount} agents are working</small></div>}
        {job?.result?.answer && <article className="result"><div className="result-title">SWARM RESULT</div><p>{job.result.answer}</p><details><summary>View agent findings</summary><ol>{job.result.agentFindings?.map((finding, index) => <li key={index}>{finding}</li>)}</ol></details></article>}
        {error && <p className="error-message">{error}</p>}
      </section>}

      <footer className="footer"><span>JELLYSWARM</span><span>INDEPENDENT WORK. ONE ANSWER.</span><a href="https://elysium.kinetiq.xyz/docs/connecting-to-elysium" target="_blank" rel="noreferrer">ELYSiUM NETWORK ↗</a></footer>
    </main>
  );
}

function phaseLabel(phase) {
  return ({ connecting: "Connecting wallet", quoting: "Getting quote", approving: "Approve USDC", funding: "Funding escrow", confirming: "Confirming payment", queued: "Starting agents" })[phase] ?? "Working";
}

function statusLabel(status) {
  return ({ payment_pending: "Awaiting payment", queued: "Your swarm is queued", running: "The swarm is working", completed: "Your result is ready", failed: "The job needs review", settlement_ready: "Settlement ready", settled: "Job settled" })[status] ?? "Job in progress";
}

createRoot(document.getElementById("root")).render(<App />);
