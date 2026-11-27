import React from "react";
import { CtaBand, PageHero, SectionHead, SitePage, media } from "./Layout.jsx";

const SIZES = [
  ["1–5 agents", "A quick check", "A short question, a rewrite, or a second opinion. From 0.30 USDC."],
  ["10–30 agents", "A solid comparison", "Weigh options, research a topic, or look at a question from many angles. 3.00–9.00 USDC."],
  ["50–120 agents", "A deep dive", "Broad research where you want lots of independent views to compare. 15.00–36.00 USDC."],
  ["Up to 247 agents", "The full swarm", "The widest view JellySwarm offers on one task. 74.10 USDC at the maximum."],
];

export default function Swarm() {
  return (
    <SitePage title="The swarm">
      <PageHero
        eyebrow="The swarm"
        title={<>Many little agents. <em>One answer.</em></>}
        lede="Every job is a small team you size yourself. The agents work independently, and one synthesis step brings their work together."
        left="jelly-mint.png"
        right="jelly-cube.png"
      />

      <section className="section">
        <div className="wrap split">
          <SectionHead eyebrow="The agents" title={<>Each agent works <em>on its own.</em></>} style={{ margin: 0 }}>
            Every agent gets the same task and answers it independently. They don't copy each other, so you see where they
            agree and where they don't. Choose from 1 agent for a quick take to 247 for the widest view.
          </SectionHead>
          <img className="jelly-portrait" src={media("jelly-mint.png")} alt="A mint JellySwarm agent waving" />
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="wrap split">
          <img className="jelly-portrait" src={media("jelly-cube.png")} alt="A blue cube-shaped JellySwarm jelly" />
          <SectionHead eyebrow="The synthesis" title={<>One step <em>brings it together.</em></>} style={{ margin: 0 }}>
            When every agent has finished, the synthesis step reads all of their findings and writes one clear answer. It
            keeps useful disagreements and uncertainty, and it doesn't add claims the agents didn't make.
          </SectionHead>
        </div>
      </section>

      <section className="section paper">
        <div className="wrap">
          <SectionHead eyebrow="Sizing your swarm" title={<>How many agents <em>do you need?</em></>}>
            More agents means more independent takes. Every agent costs 0.30 USDC.
          </SectionHead>
          <div className="feature-grid">
            {SIZES.map(([tag, h, p]) => (
              <article className="feature" key={tag}>
                <span className="tag">{tag}</span>
                <h3>{h}</h3>
                <p>{p}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <CtaBand />
    </SitePage>
  );
}
