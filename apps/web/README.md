# JellySwarm website — current build

This is a local website build with a landing page, three supporting pages and a separate dashboard. Serve this directory over HTTP (for example: `python3 -m http.server 4173 --directory site` from the parent directory) and open `http://127.0.0.1:4173/`. The browser-ready bundles are included; no package installation is needed to view the site.

The user-supplied Glass Tabs source is adapted in `source/glass` and bundled in `assets/glass-nav.js`. The supplied runway loader has been adapted in `source/runway-loader.tsx`; the generated four-frame mascot is in `assets/mascot-run-strip.png` and the loader bundle is `assets/runway-loader.js`. The six source mascot PNGs remain in the assets folder; their compressed WebP variants are used by the pages.

## Status and limits

This is not a production JellySwarm service. There is no model provider, job orchestrator, checker, account system, database, API, payment, wallet, escrow contracts, receipts or Picket monitoring service. The dashboard calculates a local arithmetic estimate and can save job and watch drafts on the device; it does not produce a final quote, run a job, or monitor a watch. Do not use it to receive funds or describe it as live. It needs the backend described in the internal build document, infrastructure, provider credentials, integration work, security review and real end-to-end testing.

The 3D-looking mascot art is a set of raster renders animated as images, not rigged 3D characters. The dashboard and the Team, How It Works and System heroes use distinct short videos generated with Higgsfield; the site plays them muted. The three page-hero files retain audio; the replacement dashboard loop was generated without audio. The landing page is a reconstruction using the live Framer reference, not a pixel-perfect source export. The supplied recordings were reviewed alongside the live Framer reference; the rebuild is a visual reconstruction, not the original source export. The commercial Bonbon source was not available; the user selected the Framer hero instead. See `ASSETS.md` for photography sources.

The dashboard call-to-action uses the Scrolltide Eye Button component, adapted to JellySwarm colors. The first small job is planned to be free; later jobs may incur fees according to the supplied overview. The pricing page has been removed.

## Developer handoff

See `BACKEND-HANDOFF.md` for the current implementation, build instructions, integration points and known limits. The browser bundles are already included. From this directory, developers can also install the pinned direct dependencies with `npm install` and rebuild them with `npm run build`.
