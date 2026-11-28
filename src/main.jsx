import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import "./styles/site.css";
import { installSpotlight } from "./motion.js";
import Home from "./site/Home.jsx";
import Swarm from "./site/Swarm.jsx";
import HowItWorks from "./site/HowItWorks.jsx";
import System from "./site/System.jsx";
import Roadmap from "./site/Roadmap.jsx";
import Whitepaper from "./site/Whitepaper.jsx";

// The app (RainbowKit, wagmi, viem) loads only when someone opens it.
const AppRoot = lazy(() => import("./app/AppRoot.jsx"));
const AdminPortal = lazy(() => import("./admin/AdminPortal.jsx"));

function AppLoading() {
  return (
    <div className="app-loading" role="status">
      <img src="/media/jelly-mint.png" alt="" />
      <span>Waking up the swarm…</span>
    </div>
  );
}

/** Old static-site URLs keep working. */
const OLD_PAGES = { agents: "/swarm", "how-it-works": "/how-it-works", system: "/system", roadmap: "/roadmap", whitepaper: "/whitepaper" };
function OldPage() {
  const { slug = "" } = useParams();
  return <Navigate to={OLD_PAGES[slug.replace(/\.html$/, "")] || "/"} replace />;
}

installSpotlight();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/swarm" element={<Swarm />} />
        <Route path="/how-it-works" element={<HowItWorks />} />
        <Route path="/system" element={<System />} />
        <Route path="/roadmap" element={<Roadmap />} />
        <Route path="/whitepaper" element={<Whitepaper />} />
        <Route path="/admin" element={<Suspense fallback={<AppLoading />}><AdminPortal /></Suspense>} />
        <Route
          path="/app/*"
          element={
            <Suspense fallback={<AppLoading />}>
              <AppRoot />
            </Suspense>
          }
        />
        <Route path="/dashboard" element={<Navigate to="/app" replace />} />
        <Route path="/pages/:slug" element={<OldPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
