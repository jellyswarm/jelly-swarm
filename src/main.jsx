import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

function App() {
  return (
    <main className="shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="JellySwarm home">
          <span className="mark" aria-hidden="true"><i /><i /><i /></span>
          JellySwarm
        </a>
        <span className="status"><span /> Fresh start</span>
      </header>

      <section className="intro" aria-labelledby="title">
        <p className="eyebrow">A NEW PROJECT SCAFFOLD</p>
        <h1 id="title">Room to rethink<br /><em>the swarm.</em></h1>
        <p className="summary">The previous implementation is preserved in <code>legacy/</code>. This is a clean starting point for JellySwarm’s next direction.</p>
        <div className="rule" />
        <p className="footnote">Product definition in progress <span>·</span> Frontend, API, and contracts are scaffolded separately.</p>
      </section>
      <footer><span>JELLYSWARM</span><span>BUILT TO BE REBUILT</span></footer>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
