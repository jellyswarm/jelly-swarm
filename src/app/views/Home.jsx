import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { ACTIVE, STATUS, clip, formatUsdc, useJobs } from "../lib.js";
import { JobRows, EmptyState } from "./parts.jsx";

const media = (n) => `/media/${n}`;

const ICON = {
  jobs: <path d="M5 6h14M5 12h14M5 18h9" />,
  agents: (
    <>
      <circle cx="9" cy="9" r="3" />
      <circle cx="17" cy="10" r="2.4" />
      <path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5M14.5 15.2c.8-.5 1.6-.7 2.5-.7 2 0 3.5 1.1 4 3.5" />
    </>
  ),
  usdc: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M14.6 9.4c-.4-.9-1.4-1.4-2.6-1.4-1.6 0-2.7.8-2.7 2s1 1.7 2.7 2 2.8.8 2.8 2.1-1.2 2-2.8 2c-1.3 0-2.3-.6-2.7-1.5M12 6.5v1.5M12 16v1.5" />
    </>
  ),
  answer: (
    <>
      <path d="M5 5h14v10H9l-4 4z" />
      <path d="M9 9h6M9 12h4" />
    </>
  ),
  compare: <path d="M7 4v16M17 4v16M3 8h8M13 16h8" />,
  research: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.5-4.5" />
    </>
  ),
  check: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.4 3.1 8.2 7.5 9.5 4.4-1.3 7.5-5.1 7.5-9.5V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  explain: <path d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5Zm0 0V19" />,
};
const Svg = ({ name }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {ICON[name]}
  </svg>
);

export const QUICK = [
  ["compare", "Compare options", "Weigh choices side by side", "#e4fbf3", "#13806f", "Compare these options and recommend one, with clear reasons and trade-offs:\n\n1. \n2. \n3. "],
  ["research", "Research a topic", "Get many angles at once", "#e3f3fd", "#1f6fae", "Research this topic and summarise what matters most, noting where sources disagree:\n\n"],
  ["check", "Check a claim", "See if it holds up", "#efeafd", "#6b4fc4", "Check whether this claim holds up. Explain the evidence for and against:\n\n"],
  ["explain", "Explain simply", "Make it easy to follow", "#fdf3dc", "#9a6a07", "Explain this in plain words for someone new to the topic, with a short example:\n\n"],
];

const STEP_OF = { payment_pending: 1, queued: 2, running: 2, payout_pending: 3, settled: 4, failed: 2, settlement_pending: 3 };

export default function AppHome() {
  const jobs = useJobs();
  const navigate = useNavigate();
  const paid = jobs.filter((j) => j.status && j.status !== "payment_pending");
  const spent = paid.reduce((s, j) => s + BigInt(j.amount || 0), 0n);
  const agentsHired = paid.reduce((s, j) => s + Number(j.agentCount || 0), 0);
  const answers = jobs.filter((j) => j.status === "payout_pending" || j.status === "settled").length;
  const stats = [
    ["jobs", String(paid.length), "Jobs run", "rgb(110 243 207 / 0.14)", "var(--mint)"],
    ["agents", agentsHired.toLocaleString(), "Agents hired", "rgb(89 195 245 / 0.14)", "var(--sky)"],
    ["usdc", formatUsdc(spent), "USDC spent", "rgb(255 212 121 / 0.14)", "var(--amber)"],
    ["answer", String(answers), "Answers ready", "rgb(196 170 255 / 0.16)", "#c4aaff"],
  ];
  const active = jobs.find((j) => ACTIVE.has(j.status)) || jobs[0];
  const step = active ? STEP_OF[active.status] ?? 1 : 0;

  return (
    <>
      <div className="hero-card">
        <div className="hero-card-copy">
          <span className="eyebrow">Live on Elysium</span>
          <h2>Put a whole swarm on your next question.</h2>
          <p>Up to 247 agents work on it independently. One synthesis brings it together.</p>
          <Link className="button light" to="/app/new">
            Start a job <span aria-hidden="true">→</span>
          </Link>
        </div>
        <div className="hero-card-art" aria-hidden="true">
          <img className="art-a" src={media("jelly-mint.png")} alt="" />
          <img className="art-b" src={media("jelly-cube.png")} alt="" />
          <img className="art-c" src={media("jelly-sky.png")} alt="" />
        </div>
      </div>

      <div className="stat-row">
        {stats.map(([ic, value, label, tint, tone]) => (
          <div className="stat" key={label}>
            <span className="stat-icon" style={{ "--tint": tint, "--tone": tone }}>
              <Svg name={ic} />
            </span>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>

      <div className="home-grid">
        <div className="block">
          <div className="block-head">
            <h2>Continue</h2>
            <Link to="/app/jobs" className="text-link">
              All jobs <span aria-hidden="true">→</span>
            </Link>
          </div>
          {active ? (
            <Link className="continue" to={`/app/job/${active.jobId}`}>
              <span className="eyebrow">{STATUS[active.status]?.label || "Continue"}</span>
              <h3>{clip(active.task || "Your job", 90)}</h3>
              <img src={media("jelly-cube.png")} alt="" />
              <div className="continue-foot">
                <span className="go-dot" aria-hidden="true">
                  →
                </span>
                <div className="bar">
                  <i style={{ "--p": `${(step / 4) * 100}%` }} />
                </div>
                <small>{step} / 4 steps</small>
              </div>
            </Link>
          ) : (
            <Link className="continue" to="/app/new">
              <span className="eyebrow">Your first job</span>
              <h3>Give the swarm something to work on.</h3>
              <img src={media("jelly-mint.png")} alt="" />
              <div className="continue-foot">
                <span className="go-dot" aria-hidden="true">
                  →
                </span>
                <div className="bar">
                  <i style={{ "--p": "0%" }} />
                </div>
                <small>0 / 4 steps</small>
              </div>
            </Link>
          )}
        </div>
        <div className="block">
          <div className="block-head">
            <h2>Quick starts</h2>
          </div>
          <div className="quick-grid" id="quick-grid">
            {QUICK.map(([ic, title, sub, bg, ink, prefill]) => (
              <button
                type="button"
                className="quick"
                key={title}
                style={{ "--q-bg": bg, "--q-ink": ink }}
                onClick={() => navigate("/app/new", { state: { prefill } })}
              >
                <span className="q-icon">
                  <Svg name={ic} />
                </span>
                <strong>{title}</strong>
                <span>{sub}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="block">
        <div className="block-head">
          <h2>Recent jobs</h2>
          <Link to="/app/jobs" className="text-link">
            See all <span aria-hidden="true">→</span>
          </Link>
        </div>
        <div className="job-rows">
          {jobs.length ? <JobRows jobs={jobs.slice(0, 4)} /> : <EmptyState title="No jobs yet" body="Your quotes and jobs will show up here." />}
        </div>
      </div>
    </>
  );
}
