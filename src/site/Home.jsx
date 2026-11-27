import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import OrbitGallery from "../components/orbit/OrbitGallery.jsx";
import EyeButton from "../components/eye/EyeButton.jsx";
import { CtaBand, HorizonCrew, Planet, SectionHead, SitePage, media } from "./Layout.jsx";
import { Words } from "./Words.jsx";

const TOTAL = 247;

/** The 247-tile illustration: tiles light up as working, then done, and loop while on screen. */
function SwarmGrid() {
  const tilesRef = useRef(null);
  const [done, setDone] = useState(0);
  useEffect(() => {
    const cells = [...tilesRef.current.children];
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cells.forEach((c) => (c.dataset.s = "done"));
      setDone(TOTAL);
      return;
    }
    let order = [];
    let step = 0;
    let finished = 0;
    let timer = 0;
    let restart = 0;
    const reset = () => {
      order = cells.map((_, i) => i).sort(() => Math.random() - 0.5);
      cells.forEach((c) => delete c.dataset.s);
      step = 0;
      finished = 0;
      setDone(0);
    };
    const tick = () => {
      for (let k = 0; k < 4 && step < TOTAL; k++, step++) cells[order[step]].dataset.s = "working";
      const working = cells.filter((c) => c.dataset.s === "working");
      for (let k = 0; k < 3 && working.length; k++) {
        working.splice(Math.floor(Math.random() * working.length), 1)[0].dataset.s = "done";
        finished++;
      }
      setDone(finished);
      if (finished >= TOTAL) {
        clearInterval(timer);
        restart = setTimeout(() => {
          reset();
          timer = setInterval(tick, 90);
        }, 2600);
      }
    };
    reset();
    const io = new IntersectionObserver(([entry]) => {
      clearInterval(timer);
      if (entry.isIntersecting && finished < TOTAL) timer = setInterval(tick, 90);
    });
    io.observe(tilesRef.current);
    return () => {
      io.disconnect();
      clearInterval(timer);
      clearTimeout(restart);
    };
  }, []);
  return (
    <div className="swarm-grid" aria-label="Illustration of 247 agents working">
      <div className="swarm-grid-head">
        <span>
          <strong>{done}</strong>of 247 agents done
        </span>
        <span>Example</span>
      </div>
      <div className="tiles" ref={tilesRef} aria-hidden="true">
        {Array.from({ length: TOTAL }, (_, i) => (
          <i className="tile" key={i} />
        ))}
      </div>
      <div className="tiles-legend" aria-hidden="true">
        <span>
          <i style={{ background: "var(--space-700)" }} />
          waiting
        </span>
        <span>
          <i style={{ background: "var(--blue)" }} />
          working
        </span>
        <span>
          <i style={{ background: "var(--mint)" }} />
          done
        </span>
      </div>
    </div>
  );
}

function PriceCalc() {
  const [n, setN] = useState(12);
  return (
    <div className="price-calc">
      <div className="card">
        <label htmlFor="calc-range">How many agents?</label>
        <input className="range" id="calc-range" type="range" min="1" max="247" value={n} onChange={(e) => setN(Number(e.target.value))} />
        <div className="calc-count">
          <strong>{n}</strong>
          <span className="muted">of 247 agents</span>
        </div>
      </div>
      <div className="card dark calc-total" aria-live="polite">
        <span className="eyebrow">You pay</span>
        <strong>{((n * 30) / 100).toFixed(2)} USDC</strong>
        <small>Paid once, upfront, in USDC on Elysium. Your wallet also needs a little HYPE for gas.</small>
      </div>
    </div>
  );
}

const ORBIT_ITEMS = ["jelly-mint.png", "jelly-cube.png", "jelly-sky.png", "jelly-a.png", "jelly-c.png"].map((src) => ({
  src: media(src),
  alt: "",
  ratio: 1,
}));
const ORBIT_RINGS = [
  { count: 4, radius: 0.35, size: 0.13, period: 75, direction: 1 },
  { count: 7, radius: 0.52, size: 0.12, period: 115, direction: -1 },
  { count: 9, radius: 0.7, size: 0.13, period: 160, direction: 1 },
];

const FAQS = [
  [
    "How much does a job cost?",
    "0.30 USDC for each agent, with the synthesis step included. 12 agents cost 3.60 USDC, and the maximum of 247 agents costs 74.10 USDC. The app always shows the exact amount before you pay.",
  ],
  [
    "What do I need to pay?",
    "An EVM wallet on Elysium with enough USDC for the job and a little HYPE for gas. The app can add the Elysium network to your wallet for you.",
  ],
  [
    "Where does my payment go?",
    "Your USDC goes to JellySwarm's escrow wallet. When the job succeeds, it moves on to the treasury. If the job fails, the team reviews it and returns 50%, 70% or 100% of the payment to you.",
  ],
  [
    "Do all 247 agents work at once?",
    "You choose how many agents work on your task, up to 247. They run in parallel batches, and the synthesis step waits until every agent has finished.",
  ],
  ["Can the swarm trade for me?", "No. JellySwarm is a research tool. It never trades, never holds your keys, and is not financial advice."],
];

export default function Home() {
  return (
    <SitePage footerWord>
      <section className="hero">
        <div className="hero-orbit" aria-hidden="true" />
        <div className="floaters" aria-hidden="true">
          <img src={media("jelly-sky.png")} alt="" style={{ "--x": "8%", "--y": "16%", "--w": "54px", "--t": "7s" }} />
          <img src={media("jelly-cube.png")} alt="" style={{ "--x": "86%", "--y": "12%", "--w": "48px", "--t": "6s", "--d": "-2s" }} />
          <img src={media("jelly-c.png")} alt="" style={{ "--x": "78%", "--y": "46%", "--w": "40px", "--t": "8s", "--d": "-3s" }} />
          <img src={media("jelly-a.png")} alt="" style={{ "--x": "14%", "--y": "52%", "--w": "36px", "--t": "6.5s", "--d": "-1s" }} />
        </div>
        <div className="hero-copy">
          <span className="eyebrow">On Elysium · Hyperliquid's L2</span>
          <div className="wordmark" role="img" aria-label="JellySwarm">
            JellySwarm
          </div>
          <Words as="h1">
            Little agents. <em>Big teamwork.</em>
          </Words>
          <p>
            Give one task to up to 247 AI agents. Each one works on it independently, then a synthesis step brings their
            findings together into one clear answer.
          </p>
          <div className="hero-chips">
            <span className="pill">
              <span className="live-dot" aria-hidden="true" /> Live on Elysium
            </span>
            <span className="pill">
              Up to <span className="mono">247</span> agents
            </span>
            <span className="pill">
              <span className="mono">0.30</span> USDC per agent
            </span>
          </div>
          <div className="hero-actions">
            <Link className="button primary" to="/app">
              Start a job <span aria-hidden="true">→</span>
            </Link>
            <Link className="button" to="/how-it-works">
              How it works
            </Link>
          </div>
        </div>
        <HorizonCrew
          items={[
            ["jelly-sky.png", { "--x": "6%", "--y": "30px", "--w": "96px", "--t": "4.6s" }],
            ["jelly-mint.png", { "--x": "18%", "--y": "70px", "--w": "150px", "--t": "5s", "--d": "-1.2s" }],
            ["jelly-cube.png", { "--x": "70%", "--y": "72px", "--w": "150px", "--t": "4.4s", "--d": "-2s", "--r": "-2deg" }],
            ["jelly-c.png", { "--x": "86%", "--y": "26px", "--w": "104px", "--t": "5.4s", "--d": "-0.6s" }],
          ]}
        />
        <Planet />
      </section>

      <section className="section">
        <div className="wrap grid-stage">
          <div className="grid-copy">
            <span className="eyebrow">The swarm at work</span>
            <Words>
              One task. <em>A whole swarm.</em>
            </Words>
            <p>
              Pick how many agents you want, from 1 to 247. Each one takes on your task independently, so you get many
              takes instead of one. When they finish, a synthesis step reads every finding and writes the answer.
            </p>
            <div className="grid-stats">
              <div>
                <strong>247</strong>
                <span>Most agents per job</span>
              </div>
              <div>
                <strong>1</strong>
                <span>Answer at the end</span>
              </div>
            </div>
          </div>
          <SwarmGrid />
        </div>
      </section>

      <section className="section" id="how">
        <div className="wrap">
          <SectionHead eyebrow="How it works" title={<>Four steps. <em>About a minute to start.</em></>}>
            You sign every payment yourself. Nothing runs until your USDC arrives.
          </SectionHead>
          <div className="steps">
            {[
              ["Describe the task", "Write what you need in plain words. Compare options, research a topic, check a claim."],
              ["Pick your swarm", "Choose 1 to 247 agents. You see the exact price in USDC before you pay."],
              ["Pay on Elysium", "Approve one USDC transfer from your own wallet. Gas is paid in HYPE."],
              ["Get one answer", "Watch the agents finish, then read the combined answer and every agent's findings."],
            ].map(([t, p], i) => (
              <article className="step" key={t}>
                <span className="step-num">{i + 1}</span>
                <h3>{t}</h3>
                <p>{p}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section paper" id="pricing">
        <div className="wrap">
          <SectionHead eyebrow="Simple pricing" title={<>0.30 USDC per agent. <em>That's it.</em></>}>
            The synthesis step is included. More agents means more independent takes on your task.
          </SectionHead>
          <PriceCalc />
        </div>
      </section>

      <section className="section paper" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <SectionHead eyebrow="Use it the right way" title={<>JellySwarm <em>researches.</em></>} />
          <div className="promises">
            <article className="card promise">
              <span className="icon yes" aria-hidden="true">✓</span>
              <h3>You hold your keys</h3>
              <p>Payments are a plain USDC transfer you sign in your own wallet. We never see your keys.</p>
            </article>
            <article className="card promise">
              <span className="icon yes" aria-hidden="true">✓</span>
              <h3>Failed jobs are reviewed</h3>
              <p>If the agents can't finish, the team reviews the job and sends back at least half of your payment.</p>
            </article>
            <article className="card promise">
              <span className="icon no" aria-hidden="true">✕</span>
              <h3>Never trades</h3>
              <p>No orders, no swaps, no advice. The swarm reads and writes answers. That's all it does.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap orbit-host">
          <OrbitGallery
            className="swarm-orbit"
            label="JellySwarm mascot orbit. Drag or use the left and right arrow keys to spin."
            tabIndex={0}
            items={ORBIT_ITEMS}
            rings={ORBIT_RINGS}
            eyebrow="MEET THE SWARM"
            title={"Little helpers for\nyour next big question."}
            subtitle="Up to 247 of them on one task. Drag to give them a spin."
            theme={{ background: "#06191f", card: "transparent", eyebrow: "#6ef3cf", title: "#eafcf8", subtitle: "#9ac4c0", shadow: "rgba(0,0,0,0)" }}
            copyWidth={0.6}
            grain={0}
            edgeFade={0.9}
            lean={15}
            hoverScale={1.18}
          />
        </div>
      </section>

      <section className="section">
        <div className="wrap faq">
          <div>
            <span className="eyebrow">FAQ</span>
            <Words>
              Questions, <em>answered.</em>
            </Words>
            <img className="faq-mascot" src={media("jelly-cube.png")} alt="" />
          </div>
          <div className="faq-list">
            {FAQS.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <CtaBand
        eyebrow="Get started"
        title={<>Meet your <em>little swarm.</em></>}
        lede="Big questions are easier with a team."
        crew={[
          ["jelly-a.png", { "--x": "10%", "--y": "34px", "--w": "110px" }],
          ["jelly-cube.png", { "--x": "78%", "--y": "38px", "--w": "118px", "--d": "-1.5s" }],
        ]}
      >
        <EyeButton
          href="/app"
          className="jelly-eye-cta"
          fontSize={19}
          paddingX={28}
          paddingY={12}
          eyeSize={35}
          eyeGap={4}
          theme={{ button: "#6ef3cf", text: "#0a1f24", eye: "#ffffff", pupil: "#0a1f24", shadow: "rgb(110 243 207 / 0.45)" }}
        >
          Start a job
        </EyeButton>
      </CtaBand>
    </SitePage>
  );
}
