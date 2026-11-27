import React from "react";
import { EdOutro, PaperHero, SitePage } from "./Layout.jsx";
import { Words } from "./Words.jsx";

function Split({ eyebrow, title, children }) {
  return (
    <section className="ed-section">
      <div className="ed-inner ed-split">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <Words>{title}</Words>
        </div>
        <div className="ed-copy">{children}</div>
      </div>
    </section>
  );
}

const PRINCIPLES = [
  ["Independent takes", "Agents don't see each other's work, so agreement means something and disagreement is visible."],
  ["Price before work", "Every job is quoted up front at 0.30 USDC per agent, synthesis included. Nothing runs until you pay."],
  ["Your wallet signs", "Payment is one USDC transfer you approve yourself. JellySwarm never receives your keys or asks for approvals."],
  ["Show the working", "The answer comes with every agent's finding, so you can see how it was reached and where it might be weak."],
];

export default function Whitepaper() {
  return (
    <SitePage title="Whitepaper">
      <PaperHero
        eyebrow="JELLYSWARM · WHITEPAPER"
        title={<>Many takes.<br /><em>One answer.</em></>}
        lede="JellySwarm gives one task to up to 247 independent AI agents and brings their findings together into one answer, paid in USDC on Elysium."
        aside="VERSION 1.0 · NOVEMBER 2026"
        jelly="jelly-cube.png"
      />

      <section className="ed-section">
        <div className="ed-inner ed-thesis">
          <span className="eyebrow">The thesis</span>
          <div>
            <Words>One model gives you one guess. A swarm shows you the range.</Words>
            <p>
              Ask a single AI a hard question and you get one confident answer, with no sense of how settled it is. Ask many
              independent agents and patterns appear: where they agree, where they split, and what only a few noticed.
              JellySwarm runs that swarm for you, prices it up front, and turns it into one answer without hiding the working.
            </p>
          </div>
        </div>
      </section>

      <Split eyebrow="01 — The product" title={<>A whole team,<br />sized to the question.</>}>
        <p>
          You describe a task and choose how many agents work on it, from 1 to 247. Every agent receives the same task and
          answers it independently. A synthesis step then reads all of their findings and writes one clear answer.
        </p>
        <p>
          The synthesis keeps useful disagreements and uncertainty, and it is instructed not to add claims the agents didn't
          make. Every individual finding stays available, so you can check the answer against the work behind it.
        </p>
      </Split>

      <section className="principles" aria-label="Principles">
        {PRINCIPLES.map(([h, p], i) => (
          <article key={h}>
            <span>0{i + 1}</span>
            <h3>{h}</h3>
            <p>{p}</p>
          </article>
        ))}
      </section>

      <Split eyebrow="02 — How a job runs" title={<>Quote, pay,<br />work, answer.</>}>
        <ol className="ed-flow">
          <li>
            <b>Quote.</b> The app sends your task, agent count and wallet address. JellySwarm returns a job ID, the exact USDC
            amount and the escrow address.
          </li>
          <li>
            <b>Pay.</b> Your wallet sends that USDC to the escrow address on Elysium. You pay the gas in HYPE.
          </li>
          <li>
            <b>Verify.</b> After two confirmations, the backend checks the transfer's token, sender, recipient and exact amount
            before anything runs.
          </li>
          <li>
            <b>Work.</b> The agents run in parallel batches. Each one's status is visible as it finishes.
          </li>
          <li>
            <b>Synthesize.</b> When every agent is done, one synthesis step writes the answer from all of the findings.
          </li>
          <li>
            <b>Settle.</b> A successful job's payment moves from escrow to the treasury.
          </li>
        </ol>
      </Split>

      <section className="ed-band">
        <div className="ed-inner">
          <span className="eyebrow">03 — Payments and custody</span>
          <Words>Your keys stay yours. Your payment is held in escrow.</Words>
          <p>
            Connecting a wallet shares only your public address. Each job needs exactly one transfer that you approve, and
            JellySwarm never asks for token approvals or signatures beyond it.
          </p>
          <p>
            Today, payments are held by JellySwarm's escrow wallet. When a job succeeds, the payment moves to the treasury. When a
            job fails, the team reviews it and returns 100%, 70% or 50% of the payment to your wallet, with the rest going to the
            treasury. Moving custody into an audited escrow contract, with a refund anyone can trigger, is on the roadmap.
          </p>
        </div>
      </section>

      <Split eyebrow="04 — The network" title={<>Built on Elysium,<br />Hyperliquid's L2.</>}>
        <p>
          JellySwarm runs on Elysium mainnet (chain ID 99901). Jobs are priced and paid in USDC, and gas is paid in HYPE. The
          app connects through RainbowKit, so you can use the EVM wallet you already have.
        </p>
        <p>
          The website and app never hold service credentials. Every request goes through JellySwarm's own server, which adds
          its key on the server side and exposes only job creation, payment verification and job reads.
        </p>
      </Split>

      <Split eyebrow="05 — Honest limits" title={<>What a swarm<br />can't promise.</>}>
        <p>
          <b>Answers can be wrong.</b> Many agents agreeing makes an answer more likely, not certain. Check anything important
          against the findings and your own sources.
        </p>
        <p>
          <b>It is not advice.</b> JellySwarm is a research tool. It never trades, and nothing it writes is financial advice.
        </p>
        <p>
          <b>Refunds are reviewed.</b> Failed jobs are refunded by a team decision today, not automatically by a contract. That
          changes with the on-chain escrow on the roadmap.
        </p>
        <p>
          <b>Agents run in batches.</b> A 247-agent job runs in parallel batches, so larger swarms take longer to finish.
        </p>
      </Split>

      <EdOutro
        eyebrow="The next chapter"
        title={<>Easier to reach.<br /><em>Easier to trust.</em></>}
        lede="Accounts, a public API and MCP tool, checked findings and an on-chain escrow are next."
        to="/roadmap"
        label="Read the roadmap"
        jelly="jelly-mint.png"
      />
    </SitePage>
  );
}
