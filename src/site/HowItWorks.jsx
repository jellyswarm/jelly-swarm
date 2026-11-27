import React, { useState } from "react";
import { CtaBand, PageHero, SectionHead, SitePage, media } from "./Layout.jsx";

const ROWS = [
  [
    "Describe the task",
    "Write what you need in plain words, from 3 to 12,000 characters. Compare options, research a topic, check a claim, or ask for an explanation.",
    "Plain words in. No setup.",
  ],
  [
    "Size the swarm and see the price",
    "Choose 1 to 247 agents. Each one costs 0.30 USDC with the synthesis included, and JellySwarm confirms the exact total before you pay anything.",
    "The price is set before any work",
  ],
  [
    "Pay once, on Elysium",
    "Approve one USDC transfer from your own wallet to JellySwarm's escrow address. The backend checks the token, sender, recipient and amount on chain, after two confirmations.",
    "You sign every payment yourself",
  ],
  [
    "The agents get to work",
    "Each agent takes your task on its own, so their answers stay independent. You can watch every agent finish in real time, and leave and come back whenever you like.",
    "Independent takes, not one guess",
  ],
  [
    "One answer, every finding",
    "A synthesis step reads all the findings and writes one clear answer. It keeps useful disagreements and adds nothing the agents didn't say. Every individual finding stays open to read.",
    "The full working, not just a summary",
  ],
];

function MiniBar({ label }) {
  return (
    <div className="mini-bar">
      <img src={media("brand-pfp.png")} alt="" />
      JELLYSWARM / {label}
      <i />
    </div>
  );
}

/** The mock product window for each step. */
function Mini({ i }) {
  if (i === 0)
    return (
      <>
        <MiniBar label="NEW JOB" />
        <h4>What should the swarm work on?</h4>
        <div className="mini-field">
          Compare the three most-used bridges to Elysium and recommend one, with reasons.
          <span className="caret" />
        </div>
        <div className="mini-meta">
          <span>3 to 12,000 characters</span>
          <span>84 / 12,000</span>
        </div>
      </>
    );
  if (i === 1)
    return (
      <>
        <MiniBar label="YOUR SWARM" />
        <div className="mini-big">
          <strong>12</strong>
          <span>of 247 agents</span>
        </div>
        <div className="mini-range">
          <i />
        </div>
        <div className="mini-row" style={{ marginTop: 14 }}>
          <span>12 agents × 0.30 USDC</span>
          <b>3.60 USDC</b>
        </div>
        <div className="mini-row">
          <span>Synthesis</span>
          <b>Included</b>
        </div>
        <span className="mini-ok">✓ Quote confirmed before you pay</span>
      </>
    );
  if (i === 2)
    return (
      <>
        <MiniBar label="PAYMENT" />
        <h4>Approve 3.60 USDC</h4>
        <div className="mini-row">
          <span>Network</span>
          <b>Elysium · 99901</b>
        </div>
        <div className="mini-row">
          <span>To</span>
          <b>JellySwarm escrow</b>
        </div>
        <div className="mini-row">
          <span>Gas</span>
          <b>HYPE</b>
        </div>
        <span className="mini-ok">✓ Confirmed · 2 blocks</span>
      </>
    );
  if (i === 3)
    return (
      <>
        <MiniBar label="LIVE" />
        <h4>Your swarm is working</h4>
        <div className="mini-tiles">
          {Array.from({ length: 24 }, (_, k) => (
            <i key={k} style={{ "--k": k }} />
          ))}
        </div>
        <div className="mini-meta">
          <span>waiting · working · done</span>
          <span>LIVE</span>
        </div>
      </>
    );
  return (
    <>
      <MiniBar label="ANSWER" />
      <h4>Recommended: Bridge B</h4>
      <div className="mini-answer">
        <p>9 of 12 agents favour Bridge B for lower fees and faster finality.</p>
        <p>Three agents flagged its shorter track record. Worth weighing if you move large amounts.</p>
      </div>
      <span className="mini-chip">AGENT 1</span>
      <span className="mini-chip">AGENT 2</span>
      <span className="mini-chip">+10 FINDINGS</span>
    </>
  );
}

const STATUSES = [
  ["payment_pending", "Your quote is ready. Waiting for your USDC payment."],
  ["queued", "Payment confirmed. The agents are about to start."],
  ["running", "The agents are working, then the synthesis step writes the answer."],
  ["payout_pending", "Your answer is ready. The payment is moving from escrow to the treasury."],
  ["settled", "All done. The job is complete and paid out."],
  ["failed", "The agents couldn't finish. The team reviews the job and decides your refund."],
  ["settlement_pending", "A refund decision has been made and is being paid out."],
];

export default function HowItWorks() {
  const [active, setActive] = useState(0);
  return (
    <SitePage title="How it works">
      <PageHero
        eyebrow="How it works"
        title={<>From one task <em>to one answer.</em></>}
        lede="Five steps, about a minute to start, and you approve every payment yourself."
      />

      <section className="section">
        <div className="wrap hiw-top">
          <div>
            <SectionHead eyebrow="The flow" title={<>Good answers deserve <em>a better system.</em></>} style={{ margin: 0 }}>
              Clear pricing, a payment you sign, and the full working behind every answer.
            </SectionHead>
            <div className="hiw-accordion">
              {ROWS.map(([title, body], i) => (
                <div className={`hiw-row${active === i ? " active" : ""}`} key={title}>
                  <button type="button" aria-expanded={active === i} aria-controls={`hiw-${i}`} onClick={() => setActive(i)}>
                    <span className="n">0{i + 1}</span>
                    {title}
                    <span className="pm" aria-hidden="true">
                      +
                    </span>
                  </button>
                  <div id={`hiw-${i}`}>
                    <div>
                      <p>{body}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="hiw-visual" aria-hidden="true">
            <img className="hiw-jelly" src={media("jelly-mint.png")} alt="" />
            <div className="mini on" key={active}>
              <Mini i={active} />
            </div>
            <div className="hiw-float">
              <span>✓</span>
              <b>{ROWS[active][2]}</b>
            </div>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <SectionHead eyebrow="A job with JellySwarm" title={<>One question. <em>A whole team on it.</em></>}>
            An example run, from the first words to the final answer.
          </SectionHead>
          <div className="bento">
            <article className="cell mint">
              <span className="mono">01 / A FEW WORDS</span>
              <strong>
                Ask.
                <br />
                Size.
                <br />
                Go.
              </strong>
              <p>Type the task, pick your swarm, get a quote.</p>
            </article>
            <article className="cell sky">
              <span className="mono">02 / CLEAR PRICE</span>
              <strong>0.30</strong>
              <p>USDC per agent. Synthesis included. No surprises later.</p>
            </article>
            <article className="cell character">
              <img src={media("jelly-cube.png")} alt="" />
              <div>
                <span className="mono">ILLUSTRATIVE RUN</span>
                <h3>
                  Meet Juno.
                  <br />
                  Twelve agents strong.
                </h3>
                <p className="muted">Juno wanted a second opinion on which bridge to use, and got twelve.</p>
              </div>
            </article>
            <article className="cell lilac">
              <span className="mono">03 / ON CHAIN</span>
              <strong>USDC</strong>
              <p>One transfer on Elysium, checked after two confirmations.</p>
            </article>
            <article className="cell wide">
              <span className="mono">04 / THE SWARM AT WORK</span>
              <div>
                <h3 style={{ fontSize: 26, marginBottom: 10 }}>
                  Independent takes,
                  <br />
                  all at once.
                </h3>
                <p className="muted">Every agent works on its own, then one synthesis brings it together.</p>
              </div>
              <div className="journey">
                <span>Quote</span>
                <i />
                <span>Pay</span>
                <i />
                <span>Work</span>
                <i />
                <span>Answer</span>
              </div>
            </article>
            <article className="cell sand">
              <span className="mono">05 / IF IT FAILS</span>
              <strong>50–100%</strong>
              <p>Failed jobs are reviewed by the team and refunded to your wallet.</p>
            </article>
          </div>
          <p className="bento-caption">Example scenario for illustration, not a customer testimonial.</p>
        </div>
      </section>

      <section className="section paper">
        <div className="wrap">
          <SectionHead eyebrow="Job status" title={<>What each status <em>means.</em></>} />
          <ul className="status-list">
            {STATUSES.map(([code, text]) => (
              <li key={code}>
                <code>{code}</code>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <CtaBand />
    </SitePage>
  );
}

