import React from "react";
import { EdOutro, PaperHero, SitePage } from "./Layout.jsx";
import { Words } from "./Words.jsx";

const PHASES = [
  [
    "NOW",
    "Live on Elysium",
    [
      ["live", "Shipped", "Paid swarm jobs", "Up to 247 agents per task, one synthesis step, 0.30 USDC per agent. Paid with one USDC transfer on Elysium and verified on chain."],
      ["live", "Shipped", "The JellySwarm app", "Quotes, wallet payments through any EVM wallet, live agent progress, answers with every finding, and a job history in your browser."],
    ],
  ],
  [
    "MONTH 01",
    "Make the swarm easier to reach",
    [
      ["next", "Weeks 1–2", "Accounts and shareable results", "Sign in to keep your jobs across devices, and share an answer with a link, kept private until you choose otherwise."],
      ["planned", "Weeks 3–4", "Public API and MCP tool", "Let apps and AI clients such as Claude, ChatGPT and Cursor quote and run swarm jobs, with payment still signed by the user's own wallet."],
    ],
  ],
  [
    "MONTH 02",
    "Make every answer easier to trust",
    [
      ["planned", "Weeks 5–6", "Checked findings", "Add a checking pass from a different model family that reviews each agent's work before the synthesis, so weak findings are flagged, not blended in."],
      ["planned", "Weeks 7–8", "On-chain escrow", "Move job payments from the escrow wallet into an audited escrow contract on Elysium, with a refund anyone can trigger if a job never finishes."],
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
        aside="2-MONTH PLAN · 8 WEEKS"
        jelly="jelly-mint.png"
      />

      <section className="ed-section">
        <div className="ed-inner rm-intro">
          <span className="eyebrow">The focus</span>
          <p>
            First, bring the swarm to more places: accounts, share links, a public API and an MCP tool. Then raise the bar on
            every answer with checked findings and an escrow contract you can verify.
          </p>
          <span className="rm-note">Planned sequence. Scope and timing may change as we build and as you tell us what you need.</span>
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
              <span>Reach</span>
              <p>Run a swarm from the app, your own product, or straight from your AI assistant.</p>
            </article>
            <article>
              <span>Trust</span>
              <p>Findings checked by a different model family before they shape the answer.</p>
            </article>
            <article>
              <span>Custody</span>
              <p>Payments held by a contract with rules you can read, not by a wallet you have to trust.</p>
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
