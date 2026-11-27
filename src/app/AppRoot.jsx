import React, { useEffect, useRef } from "react";
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, useAccount } from "wagmi";
import { ConnectButton, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import "../styles/app.css";
import { config, elysium, rkTheme } from "./wallet.js";
import { WalletGate } from "./WalletGate.jsx";
import { ToastProvider } from "./Toasts.jsx";
import { LIVE, useJobs } from "./lib.js";
import { reveal } from "../motion.js";
import { startTour, autoStartTour } from "./tour.js";
import AppHome from "./views/Home.jsx";
import NewJob from "./views/NewJob.jsx";
import Jobs from "./views/Jobs.jsx";
import Job from "./views/Job.jsx";
import WalletView from "./views/Wallet.jsx";

const queryClient = new QueryClient();
const media = (n) => `/media/${n}`;

const Icon = ({ d, children }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {d ? <path d={d} /> : children}
  </svg>
);
const ICONS = {
  home: <Icon d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z" />,
  new: <Icon d="M12 5v14M5 12h14" />,
  jobs: <Icon d="M5 6h14M5 12h14M5 18h9" />,
  wallet: (
    <Icon>
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9H6.5A2.5 2.5 0 0 1 4 7.5Z" />
      <circle cx="16" cy="14" r="1.2" />
    </Icon>
  ),
  learn: <Icon d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5Zm0 0V19" />,
  roadmap: <Icon d="M4 18 9 6l5 9 2-4 4 7" />,
  paper: <Icon d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5" />,
};

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
function titleFor(pathname) {
  if (pathname.startsWith("/app/new")) return ["New job", "Describe the task and size your swarm."];
  if (pathname.startsWith("/app/jobs")) return ["My jobs", "Everything you've run from this browser."];
  if (pathname.startsWith("/app/job/")) return ["Your job", "Live progress, payment and the answer."];
  if (pathname.startsWith("/app/wallet")) return ["Wallet", "Your Elysium wallet for paying jobs."];
  return [greeting(), "Ready to put the swarm to work?"];
}

function WalletButton() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        if (!mounted)
          return (
            <button className="button primary" type="button" disabled>
              Connect wallet
            </button>
          );
        if (!account)
          return (
            <button className="button primary" type="button" onClick={openConnectModal}>
              Connect wallet
            </button>
          );
        if (chain?.unsupported)
          return (
            <button className="button warn-btn" type="button" onClick={openChainModal}>
              Switch to Elysium
            </button>
          );
        return (
          <button className="button wallet-chip" type="button" onClick={openAccountModal}>
            <span className="wallet-dot" aria-hidden="true" />
            {account.displayName}
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}

function Shell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const jobs = useJobs();
  const { isConnected, chainId } = useAccount();
  const wrongNet = isConnected && chainId !== elysium.id;
  const live = jobs.filter((j) => LIVE.has(j.status)).length;
  const [title, sub] = titleFor(pathname);
  const mainRef = useRef(null);
  const onJob = pathname.startsWith("/app/job/");

  useEffect(() => {
    document.title = `${title} — JellySwarm`;
    window.scrollTo(0, 0);
    return reveal(mainRef.current);
  }, [pathname, title]);

  useEffect(() => autoStartTour(navigate), [navigate]);

  const navClass = (key) => ({ isActive }) => (isActive || (key === "jobs" && onJob) ? "active" : undefined);

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="App navigation">
        <Link className="brand" to="/">
          <img src={media("brand-pfp.png")} alt="" />
          <span>JellySwarm</span>
        </Link>
        <nav className="side-nav">
          <NavLink to="/app" end data-nav="home" className={navClass("home")}>
            {ICONS.home}Home
          </NavLink>
          <NavLink to="/app/new" data-nav="new" className={navClass("new")}>
            {ICONS.new}New job
          </NavLink>
          <NavLink to="/app/jobs" data-nav="jobs" className={navClass("jobs")}>
            {ICONS.jobs}My jobs
            {live > 0 && <span className="nav-badge">{live}</span>}
          </NavLink>
          <NavLink to="/app/wallet" data-nav="wallet" className={navClass("wallet")}>
            {ICONS.wallet}Wallet
          </NavLink>
        </nav>
        <p className="side-label">Learn</p>
        <nav className="side-nav quiet">
          <Link to="/how-it-works">{ICONS.learn}How it works</Link>
          <Link to="/roadmap">{ICONS.roadmap}Roadmap</Link>
          <Link to="/whitepaper">{ICONS.paper}Whitepaper</Link>
        </nav>
        <div className="side-card">
          <img src={media("jelly-cube.png")} alt="" />
          <strong>First time here?</strong>
          <p>A one-minute tour of every button, so you know your way around.</p>
          <button className="button small" type="button" onClick={() => startTour(navigate)}>
            Take the tour
          </button>
        </div>
      </aside>

      <div className="main" ref={mainRef}>
        <header className="app-top">
          <div className="app-title">
            <Link className="brand mobile-brand" to="/">
              <img src={media("brand-pfp.png")} alt="JellySwarm" />
            </Link>
            <div>
              <h1>{title}</h1>
              <p className="muted">{sub}</p>
            </div>
          </div>
          <div className="top-actions">
            <button className="icon-btn" type="button" aria-label="Take the tour" title="Take the tour" onClick={() => startTour(navigate)}>
              ?
            </button>
            <span className={`pill net-pill${wrongNet ? " warn" : ""}`}>
              <span className="live-dot" aria-hidden="true" />
              <span>{wrongNet ? "Wrong network" : "Elysium"}</span>
            </span>
            <div id="wallet-connect" className="wallet-slot">
              <WalletButton />
            </div>
          </div>
        </header>
        <div className="route" key={pathname}>
          <Outlet />
        </div>
      </div>

      <nav className="tabbar" aria-label="App navigation">
        <NavLink to="/app" end data-nav="home">
          {ICONS.home}Home
        </NavLink>
        <NavLink to="/app/jobs" data-nav="jobs" className={navClass("jobs")}>
          {ICONS.jobs}Jobs
        </NavLink>
        <NavLink to="/app/new" data-nav="new" className="tab-new" aria-label="New job">
          {ICONS.new}
        </NavLink>
        <NavLink to="/app/wallet" data-nav="wallet">
          {ICONS.wallet}Wallet
        </NavLink>
        <Link to="/how-it-works">{ICONS.learn}Learn</Link>
      </nav>
    </div>
  );
}

export default function AppRoot() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={rkTheme} initialChain={elysium} modalSize="compact" appInfo={{ appName: "JellySwarm" }}>
          <ToastProvider>
            <WalletGate>
              <Routes>
                <Route element={<Shell />}>
                  <Route index element={<AppHome />} />
                  <Route path="new" element={<NewJob />} />
                  <Route path="jobs" element={<Jobs />} />
                  <Route path="job/:id" element={<Job />} />
                  <Route path="wallet" element={<WalletView />} />
                  <Route path="*" element={<Navigate to="/app" replace />} />
                </Route>
              </Routes>
            </WalletGate>
          </ToastProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
