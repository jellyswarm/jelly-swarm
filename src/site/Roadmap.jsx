import React from "react";
import { EdOutro, PaperHero, SitePage } from "./Layout.jsx";
import { Words } from "./Words.jsx";

const PHASES = [
  [
    "NOW",
    "What is in the app today",
    [
      ["live", "Live", "Paid jobs on Elysium", "Choose 1–247 workers, see the exact quote at 0.30 USDC per worker, and pay with USDC from your wallet. You supply HYPE for gas."],
      ["live", "Live", "Parallel work and results", "Workers run in parallel batches; the app shows job progress and returns a synthesized answer alongside successful worker findings."],
    ],
  ],
  [
    "MONTH 01 · DEC 2026",
    "Get more useful work from every model call",
    [
      ["next", "Weeks 1–2", "Model quality and cost bench", "Build a repeatable evaluation set and compare candidate OpenRouter models on answer quality, latency, reliability, and cost. Use the results to choose a better default without guessing from model names."],
      ["planned", "Weeks 3–4", "Task-aware model routing", "Route work to a low-cost fast model by default and reserve stronger models for tasks that benefit from them. Keep the customer quote clear and track provider spend per job."],
    ],
  ],
  [
    "MONTH 02 · JAN 2027",
    "Make the swarm faster and its answer easier to judge",
    [
      ["planned", "Weeks 5–6", "Less duplicated swarm work", "Give workers complementary roles, split broad tasks into focused sub-questions, and tune concurrency to provider limits. Reuse completed work on retries and surface progress as it arrives."],
      ["planned", "Weeks 7–8", "A review pass and usable exports", "Add a critic pass that flags unsupported claims and unresolved disagreements before synthesis. Let people copy or export the final answer together with the worker findings."],
    ],
  ],
];
const STATUS_LABEL = { live: "LIVE", next: "UP NEXT", planned: "PLANNED" };

export default function Roadmap() {
  return (
    <SitePage title="Roadmap">
      <PaperHero
        eyebrow="JELLYSWARM · ROADMAP"
        title={<>Bigger swarms.<br /><em>More trust.</em></>}
        lede="Over the next two months, we plan to make the swarm easier to reach from anywhere, and its answers easier to trust."
        aside="DEC 2026 – JAN 2027 · 8 WEEKS"
        jelly="jelly-mint.png"
      />

      <section className="ed-section">
        <div className="ed-inner rm-intro">
          <span className="eyebrow">The focus</span>
          <p>
            We will first measure which models give us the best quality, speed and cost for real JellySwarm tasks. Then we will
            improve routing and divide work so agents cover more ground with less repetition, before adding a review pass and
            better ways to keep and share results.
          </p>
            <span className="rm-note">Planned sequence, not a delivery guarantee. We will adjust scope as evaluation results and user feedback come in.</span>
        </div>
      </section>

      <section className="ed-section" style={{ paddingTop: 30 }}>
        <div className="ed-inner">
          {PHASES.map(([label, title, weeks], i) => (
            <section className="rm-phase" key={label}>
              <header>
                <span>{label}</span>
                <Words>{title}</Words>
                <b>0{i}</b>
              </header>
              <div className="rm-weeks">
                {weeks.map(([status, period, h, p]) => (
                  <article data-status={status} key={h}>
                    <span className="rm-period">{period}</span>
                    <div>
                      <h3>{h}</h3>
                      <p>{p}</p>
                    </div>
                    <span className={`rm-status ${status}`}>{STATUS_LABEL[status]}</span>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>

      <section className="ed-section paper">
        <div className="ed-inner">
          <span className="eyebrow">What this enables</span>
          <div className="outcomes">
            <article>
              <span>Quality per dollar</span>
              <p>Choose models by measured task quality, speed and provider cost instead of relying on a single default.</p>
            </article>
            <article>
              <span>Useful parallelism</span>
              <p>Give workers complementary jobs, reduce repeated effort, and recover work without starting over.</p>
            </article>
            <article>
              <span>Clearer answers</span>
              <p>Keep disagreements visible, flag weak support, and take the result and findings with you.</p>
            </article>
          </div>
        </div>
      </section>

      <EdOutro
        eyebrow="Read the thesis"
        title={<>Many takes in.<br /><em>One answer out.</em></>}
        lede="See how JellySwarm runs a job, handles your payment and where its limits are."
        to="/whitepaper"
        label="Read the whitepaper"
        jelly="jelly-cube.png"
      />
    </SitePage>
  );
}
