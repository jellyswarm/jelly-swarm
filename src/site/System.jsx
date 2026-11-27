import React from "react";
import { CtaBand, PageHero, SectionHead, SitePage } from "./Layout.jsx";

const MONEY = [
  ["1 · You pay", "Into escrow", "Your wallet sends the quoted USDC to JellySwarm's escrow wallet. The amount and address come from the quote."],
  ["2 · It's checked", "Verified on chain", "The backend confirms the transfer's token, sender, recipient and exact amount before any agent starts."],
  ["3a · Success", "Paid to the treasury", "When the answer is ready, the payment moves from escrow to the treasury and the job is settled."],
  [
    "3b · Failure",
    "Reviewed by the team",
    "If a job fails, the team reviews it and returns 100%, 70% or 50% of the payment to your wallet. The rest goes to the treasury.",
  ],
];

export default function System() {
  return (
    <SitePage title="The system">
      <PageHero
        eyebrow="The system"
        title={<>Simple parts. <em>Clear rules.</em></>}
        lede="What runs where, who holds what, and where your money goes. No surprises."
        left="jelly-c.png"
        right="jelly-sky.png"
      />

      <section className="section">
        <div className="wrap">
          <SectionHead eyebrow="The money" title={<>Where your payment <em>goes.</em></>}>
            JellySwarm runs on Elysium, Hyperliquid's L2. Jobs are paid in USDC.
          </SectionHead>
          <div className="feature-grid">
            {MONEY.map(([tag, h, p]) => (
              <article className="feature" key={tag}>
                <span className="tag">{tag}</span>
                <h3>{h}</h3>
                <p>{p}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section paper">
        <div className="wrap">
          <SectionHead eyebrow="Keys and access" title={<>Who holds <em>what.</em></>} />
          <div className="promises">
            <article className="card promise">
              <span className="icon yes" aria-hidden="true">✓</span>
              <h3>Your keys stay yours</h3>
              <p>You sign the payment in your own wallet. JellySwarm never asks for or sees your private keys.</p>
            </article>
            <article className="card promise">
              <span className="icon yes" aria-hidden="true">✓</span>
              <h3>Service keys stay on the server</h3>
              <p>The website talks only to its own server, which adds JellySwarm's service key. No secret ever reaches your browser.</p>
            </article>
            <article className="card promise">
              <span className="icon no" aria-hidden="true">✕</span>
              <h3>No trading, ever</h3>
              <p>The agents read and write. There are no tools for orders, swaps or transfers anywhere in a job.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <SectionHead eyebrow="Network details" title={<>Elysium <em>at a glance.</em></>} />
          <div className="feature-grid">
            <article className="feature">
              <span className="tag">Chain</span>
              <h3>Elysium mainnet</h3>
              <p className="mono">Chain ID 99901 · gas in HYPE</p>
            </article>
            <article className="feature">
              <span className="tag">Asset</span>
              <h3>USDC</h3>
              <p className="mono" style={{ wordBreak: "break-all" }}>
                0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65
              </p>
            </article>
          </div>
        </div>
      </section>

      <CtaBand />
    </SitePage>
  );
}
