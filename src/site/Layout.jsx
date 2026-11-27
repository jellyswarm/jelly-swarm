import React, { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { reveal } from "../motion.js";
import { Words } from "./Words.jsx";

export const media = (name) => `/media/${name}`;

const NAV = [
  ["/swarm", "The swarm"],
  ["/how-it-works", "How it works"],
  ["/roadmap", "Roadmap"],
  ["/whitepaper", "Whitepaper"],
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const navRef = useRef(null);
  const btnRef = useRef(null);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    const onClick = (e) => {
      if (!navRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [open]);
  return (
    <header className="topbar">
      <Link className="brand" to="/">
        <img src={media("brand-pfp.png")} alt="" />
        <span>JellySwarm</span>
      </Link>
      <button
        ref={btnRef}
        className="menu-button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls="navigation"
        onClick={() => setOpen((v) => !v)}
      >
        <span></span>
        <span></span>
      </button>
      <nav ref={navRef} className={`navlinks${open ? " open" : ""}`} id="navigation" aria-label="Main navigation">
        {NAV.map(([to, label]) => (
          <NavLink key={to} to={to}>
            {label}
          </NavLink>
        ))}
        <Link className="button primary" to="/app">
          Launch app <span aria-hidden="true">→</span>
        </Link>
      </nav>
    </header>
  );
}

export function SiteFooter({ word = true }) {
  return (
    <footer>
      <div className="footer-top">
        <Link className="brand" to="/">
          <img src={media("brand-pfp.png")} alt="" />
          JellySwarm
        </Link>
        <span className="muted">Little agents. Big teamwork.</span>
        <nav aria-label="Footer">
          <Link to="/swarm">The swarm</Link>
          <Link to="/how-it-works">How it works</Link>
          <Link to="/system">The system</Link>
          <Link to="/roadmap">Roadmap</Link>
          <Link to="/whitepaper">Whitepaper</Link>
          <Link to="/app">Launch app</Link>
        </nav>
      </div>
      {word && (
        <div className="footer-word wordmark" aria-hidden="true">
          JellySwarm
        </div>
      )}
      <div className="footer-bottom">
        <span>© 2026 JellySwarm · Live on Elysium</span>
        <span>Research tool. Not financial advice.</span>
      </div>
    </footer>
  );
}

/** Wraps a marketing page: header, main content with scroll reveals, footer. */
export function SitePage({ title, children, footerWord = false }) {
  const mainRef = useRef(null);
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = title ? `${title} — JellySwarm` : "JellySwarm — Little agents. Big teamwork.";
  }, [title]);
  useEffect(() => {
    window.scrollTo(0, 0);
    return reveal(mainRef.current);
  }, [pathname]);
  return (
    <>
      <SiteHeader />
      <main ref={mainRef}>{children}</main>
      <SiteFooter word={footerWord} />
    </>
  );
}

/** A row of bobbing jellies sitting on the planet horizon. */
export function HorizonCrew({ items }) {
  return (
    <div className="horizon-crew" aria-hidden="true">
      {items.map(([img, style], i) => (
        <img key={i} src={media(img)} alt="" style={style} />
      ))}
    </div>
  );
}

export const Planet = () => <div className="planet" aria-hidden="true" />;

/** Dark hero used by the content pages. */
export function PageHero({ eyebrow, title, lede, left = "jelly-sky.png", right = "jelly-c.png" }) {
  return (
    <section className="page-hero">
      <div className="hero-copy">
        <span className="eyebrow">{eyebrow}</span>
        <Words as="h1">{title}</Words>
        <p>{lede}</p>
      </div>
      <HorizonCrew
        items={[
          [left, { "--x": "8%", "--y": "26px", "--w": "120px" }],
          [right, { "--x": "80%", "--y": "30px", "--w": "124px", "--d": "-1.6s" }],
        ]}
      />
      <Planet />
    </section>
  );
}

/** Light editorial hero used by the Roadmap and Whitepaper. */
export function PaperHero({ eyebrow, title, lede, aside, jelly }) {
  return (
    <section className="paper-hero">
      <div className="inner">
        <span className="eyebrow">{eyebrow}</span>
        <Words as="h1">{title}</Words>
        <p>{lede}</p>
      </div>
      <img className="hero-jelly" src={media(jelly)} alt="" />
      <span className="aside">{aside}</span>
    </section>
  );
}

/** "Start a job" band with the planet horizon, used at the end of most pages. */
export function CtaBand({ eyebrow = "Ready?", title, lede = "From 0.30 USDC, paid on Elysium.", children, crew }) {
  return (
    <section className="cta">
      <span className="eyebrow">{eyebrow}</span>
      <Words>{title || (<>Give the swarm <em>a task.</em></>)}</Words>
      <p>{lede}</p>
      {children || (
        <Link className="button primary" to="/app">
          Start a job <span aria-hidden="true">→</span>
        </Link>
      )}
      <HorizonCrew
        items={
          crew || [
            ["jelly-sky.png", { "--x": "12%", "--y": "30px", "--w": "96px" }],
            ["jelly-mint.png", { "--x": "78%", "--y": "34px", "--w": "118px", "--d": "-1.2s" }],
          ]
        }
      />
      <Planet />
    </section>
  );
}

/** Closing on paper that points to the next document. */
export function EdOutro({ eyebrow, title, lede, to, label, jelly }) {
  return (
    <section className="ed-outro">
      <span className="eyebrow">{eyebrow}</span>
      <Words>{title}</Words>
      <p>{lede}</p>
      <Link className="button" to={to}>
        {label} <span aria-hidden="true">→</span>
      </Link>
      <img src={media(jelly)} alt="" />
    </section>
  );
}

export function SectionHead({ eyebrow, title, children, center = false, style }) {
  return (
    <div className={`section-head${center ? " center" : ""}`} style={style}>
      <span className="eyebrow">{eyebrow}</span>
      <Words>{title}</Words>
      {children && <p>{children}</p>}
    </div>
  );
}
