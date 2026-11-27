import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ACTIVE, ERRORS, JOB_ID, useJobs } from "../lib.js";
import { useToast } from "../Toasts.jsx";
import { EmptyState, JobRows } from "./parts.jsx";

const FILTERS = [
  ["all", "All"],
  ["active", "Active"],
  ["done", "Done"],
];

export default function Jobs() {
  const all = useJobs();
  const navigate = useNavigate();
  const toast = useToast();
  const [filter, setFilter] = useState("all");
  const [lookup, setLookup] = useState("");
  const jobs = all.filter((j) => filter === "all" || (filter === "active" ? ACTIVE.has(j.status) : !ACTIVE.has(j.status)));

  const open = (e) => {
    e.preventDefault();
    const raw = lookup.trim();
    const id = raw.startsWith("0x") ? raw : `0x${raw}`;
    if (!JOB_ID.test(id)) return toast(ERRORS.invalid_job_id, "warn");
    navigate(`/app/job/${id}`);
  };

  return (
    <>
      <div className="jobs-toolbar">
        <div className="segmented tabs" role="tablist" aria-label="Filter jobs">
          {FILTERS.map(([value, label]) => (
            <button type="button" role="tab" key={value} aria-selected={filter === value} onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
        </div>
        <form className="lookup" onSubmit={open}>
          <label className="sr-only" htmlFor="lookup-id">
            Job ID
          </label>
          <input
            id="lookup-id"
            placeholder="Open a job by ID (0x…)"
            autoComplete="off"
            spellCheck="false"
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
          />
          <button className="button" type="submit">
            Open
          </button>
        </form>
      </div>
      <div className="job-rows">
        {jobs.length ? (
          <JobRows jobs={jobs} />
        ) : all.length ? (
          <EmptyState title={filter === "active" ? "Nothing running" : "Nothing finished yet"} body="Try another filter, or start a new job." />
        ) : (
          <EmptyState title="No jobs yet" body="Your quotes and jobs from this browser will show up here." />
        )}
      </div>
      <p className="fine left">Jobs are remembered in this browser. Keep a job's ID to open it anywhere.</p>
    </>
  );
}
