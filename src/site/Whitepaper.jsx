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
  ["Parallel exploration", "Workers approach the same task separately, so the result can preserve useful differences instead of hiding them."],
  ["Price before work", "Every job is quoted up front at 0.30 USDC per agent, synthesis included. Nothing runs until you pay."],
  ["Wallet-controlled payment", "You approve one USDC transfer and sign a gas-free claim that binds it to your job. JellySwarm never receives your keys or asks for token approvals."],
  ["Show the working", "The answer comes with each successful agent's finding, so you can see the basis for the synthesis and where it may be weak."],
];

export default function Whitepaper() {
  return (
    <SitePage title="Whitepaper">
      <PaperHero
        eyebrow="JELLYSWARM · WHITEPAPER"
        title={<>Many takes.<br /><em>One answer.</em></>}
        lede="JellySwarm turns one task into parallel AI work: up to 247 workers contribute separate findings, then a synthesis step brings them into one answer. Jobs are paid in USDC on Elysium."
        aside="VERSION 1.0 · NOVEMBER 2026"
        jelly="jelly-cube.png"
      />

      <section className="ed-section">
        <div className="ed-inner ed-thesis">
          <span className="eyebrow">The thesis</span>
          <div>
            <Words>Hard questions deserve more than one pass.</Words>
            <p>
              Most AI products give a task to one model call and return one polished answer. That is fast, but it can conceal
              missed angles and uncertainty. JellySwarm's thesis is to make useful work parallel: collect separate attempts,
              keep their findings visible, and synthesize them without pretending agreement means certainty.
            </p>
            <p>
              The product is an orchestration layer around that process. You choose the size of the swarm, see the full price
              before work starts, pay from your own wallet, and receive both a consolidated answer and the findings behind it.
              More workers are useful only when the system can coordinate them efficiently and make their output easier to judge;
              improving that balance is the work ahead.
            </p>
          </div>
        </div>
      </section>

      <Split eyebrow="01 — The product" title={<>A whole team,<br />sized to the question.</>}>
        <p>
          You describe a task and choose how many agents work on it, from 1 to 247. In the current system, each worker receives
          the task separately and is asked to make a distinct contribution. A synthesis step reads the successful findings and
          writes one clear answer.
        </p>
        <p>
          The synthesis is instructed to retain useful disagreements and uncertainty, and not to add unsupported claims.
          Individual findings stay available. Today, workers use the configured model and their outputs are not independently
          verified against external sources, so the swarm helps explore a question; it does not guarantee correctness.
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
            <b>Bind and verify.</b> You sign a gas-free typed-data claim tying the transaction to this job. After two
            confirmations, the backend checks the token, sender, recipient, exact amount and quote time before anything runs.
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
            Connecting a wallet shares only your public address. Each job needs one USDC transfer that you approve, plus a
            gas-free typed-data signature so the backend can verify that the payment belongs to this job. JellySwarm never asks
            for token approvals or your private key.
          </p>
          <p>
            Today, payments are held by JellySwarm's EOA escrow wallet, so custody depends on the security of that wallet. When a
            job succeeds, proceeds go to the treasury. If some agents fail but enough work completes, their share is refunded
            automatically; jobs below the success threshold go to operator review. For reviewed settlements, an authorized
            operator decision must be signed by the treasury wallet and can return 100%, 70% or 50% to the client.
          </p>
        </div>
      </section>

      <Split eyebrow="04 — The network" title={<>Built on Elysium,<br />by Kinetiq.</>}>
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
          <b>Custody is centralized today.</b> The escrow is a wallet, not a smart contract. The treasury/operator key controls
          settlement decisions and the escrow wallet executes transfers.
        </p>
        <p>
          <b>Agents run in batches.</b> A 247-agent job runs in parallel batches, so larger swarms take longer to finish.
        </p>
      </Split>

      <EdOutro
        eyebrow="The next chapter"
        title={<>Easier to reach.<br /><em>Easier to trust.</em></>}
        lede="The next work focuses on better model routing, less duplicated agent work, and answers that are easier to evaluate."
        to="/roadmap"
        label="Read the roadmap"
        jelly="jelly-mint.png"
      />
    </SitePage>
  );
}
