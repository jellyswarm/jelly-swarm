import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { JELLIES, STATUS, formatUsdc, short } from "../lib.js";

export function StatePill({ status, raw = false }) {
  const st = STATUS[status] || { label: status || "Unknown", tone: "" };
  return (
    <span className="state-pill" data-tone={st.tone}>
      {raw ? String(status).replaceAll("_", " ") : st.label}
    </span>
  );
}

export function JobRows({ jobs }) {
  const navigate = useNavigate();
  return jobs.map((j, i) => (
    <button type="button" className="job-row" key={j.jobId} onClick={() => navigate(`/app/job/${j.jobId}`)}>
      <span className="avatar">
        <img src={`/media/${JELLIES[i % JELLIES.length]}`} alt="" />
      </span>
      <span className="row-main">
        <p>{j.task || "Untitled job"}</p>
        <small>
          {j.agentCount ? `${j.agentCount} agents · ` : ""}
          {new Date(j.createdAt || Date.now()).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · {short(j.jobId, 6, 4)}
        </small>
      </span>
      <StatePill status={j.status} />
      <span className="row-amt">
        {j.amount ? (
          <>
            {formatUsdc(j.amount)} <small>USDC</small>
          </>
        ) : null}
      </span>
    </button>
  ));
}

export function EmptyState({ title, body, cta = true }) {
  return (
    <div className="empty-state">
      <img src="/media/jelly-sky.png" alt="" />
      <strong>{title}</strong>
      <p>{body}</p>
      {cta && (
        <Link className="button primary small" to="/app/new">
          Start a job <span aria-hidden="true">→</span>
        </Link>
      )}
    </div>
  );
}

/** Replaces a button's label with a spinner while `busy` is set. */
export function BusyButton({ busy, busyLabel, children, ...props }) {
  return (
    <button {...props} disabled={busy || props.disabled}>
      {busy ? (
        <>
          <span className="spinner" aria-hidden="true" /> {busyLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}
