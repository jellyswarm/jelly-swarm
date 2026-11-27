// First-run guided tour for the app: a moving spotlight and a coach card per control.
// It starts automatically on a first visit; the "Take the tour" and "?" buttons replay it.

const ROUTES = { home: "/app", new: "/app/new", jobs: "/app/jobs", wallet: "/app/wallet" };
let navigateTo = (path) => {
  location.assign(path);
};

  const DONE_KEY = "jellyswarm-tour-v1";

  // Each step names a route to show (optional) and candidate targets; the first visible one is used,
  // so the same step points at the sidebar on desktop and the bottom tab bar on mobile.
  const STEPS = [
    {
      route: "home",
      title: "Welcome to JellySwarm",
      body: "Give one task to up to 247 AI agents and get one clear answer back. Here are the few things worth knowing.",
      jelly: "jelly-mint.png",
    },
    {
      route: "home",
      target: ["#quick-grid"],
      title: "Not sure what to ask?",
      body: "Tap a quick start and we'll fill in a task you can edit.",
    },
    {
      route: "new",
      target: ["#task"],
      title: "Describe your task",
      body: "Plain words work best. Compare options, research a topic or check a claim, in up to 12,000 characters.",
    },
    {
      route: "new",
      target: [".field-row > div:first-child"],
      title: "Size your swarm",
      body: "More agents means more independent takes. Use the buttons, slider or presets, from 1 to 247.",
    },
    {
      route: "new",
      target: [".summary"],
      title: "See the price first",
      body: "Each agent costs 0.30 USDC with the synthesis included. Your total updates as you go, and nothing is charged until you approve it.",
    },
    {
      route: "new",
      target: ["#quote-button"],
      title: "Quote, then pay",
      body: "JellySwarm confirms the exact price. You pay with one USDC transfer on Elysium. Keep a little HYPE for gas.",
    },
    {
      route: "new",
      target: ["#wallet-connect"],
      title: "Any EVM wallet",
      body: "Connect the wallet you already use. You approve every payment yourself, and we never see your keys.",
    },
    {
      route: "jobs",
      target: ['.sidebar [data-nav="jobs"]', '.tabbar [data-nav="jobs"]'],
      title: "Your jobs live here",
      body: "Open a job to watch the agents work, then read the answer and every agent's findings.",
    },
    {
      route: "wallet",
      target: ['.sidebar [data-nav="wallet"]', '.tabbar [data-nav="wallet"]'],
      title: "Your wallet",
      body: "Check your USDC and HYPE balances on Elysium. Replay this tour any time from the ? button.",
      jelly: "jelly-cube.png",
      finish: true,
    },
  ];

  let layer, spot, card, index = 0, active = false, lastFocus = null, raf = 0;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const pick = (sels = []) => sels.map((s) => document.querySelector(s)).find(visible) || null;
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function build() {
    layer = document.createElement("div");
    layer.className = "tour-layer";
    layer.innerHTML = `<div class="tour-spot" aria-hidden="true"></div>
      <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body" tabindex="-1">
        <img class="tour-jelly" alt="" />
        <div class="tour-top"><span class="eyebrow" id="tour-count"></span><button type="button" class="tour-skip" data-t="skip">Skip tour</button></div>
        <h2 id="tour-title"></h2>
        <p id="tour-body"></p>
        <div class="tour-foot">
          <div class="tour-dots" aria-hidden="true"></div>
          <div class="tour-btns">
            <button type="button" class="button small" data-t="back">Back</button>
            <button type="button" class="button primary small" data-t="next">Next <span aria-hidden="true">→</span></button>
          </div>
        </div>
      </div>`;
    document.body.append(layer);
    spot = layer.querySelector(".tour-spot");
    card = layer.querySelector(".tour-card");
    layer.querySelector(".tour-dots").innerHTML = STEPS.map(() => "<i></i>").join("");
    layer.addEventListener("click", (e) => {
      const t = e.target.closest("[data-t]")?.dataset.t;
      if (t === "next") next();
      if (t === "back") go(index - 1);
      if (t === "skip") end(true);
    });
    document.addEventListener("keydown", onKey);
    addEventListener("resize", place);
    addEventListener("scroll", place, { passive: true });
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === "Escape") return end(true);
    if (e.key === "ArrowRight") return next();
    if (e.key === "ArrowLeft") return go(index - 1);
    if (e.key === "Tab") {
      // Keep focus inside the coach card.
      const items = [...card.querySelectorAll("button:not([disabled])")];
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function next() {
    if (STEPS[index].finish) {
      end(false);
      navigateTo(ROUTES.new);
      return;
    }
    go(index + 1);
  }

  async function go(i) {
    if (i < 0 || i >= STEPS.length) return;
    index = i;
    const step = STEPS[i];
    if (step.route && location.pathname.replace(/\/$/, "") !== ROUTES[step.route]) {
      navigateTo(ROUTES[step.route]);
      await frame();
      await new Promise((r) => setTimeout(r, 120));
    }
    const target = pick(step.target);
    if (target) {
      target.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
      await new Promise((r) => setTimeout(r, reduced ? 0 : 320));
    }

    card.querySelector("#tour-count").textContent = `${i + 1} of ${STEPS.length}`;
    card.querySelector("#tour-title").textContent = step.title;
    card.querySelector("#tour-body").textContent = step.body;
    const jelly = card.querySelector(".tour-jelly");
    jelly.src = `/media/${step.jelly || ["jelly-sky.png", "jelly-a.png", "jelly-c.png"][i % 3]}`;
    layer.querySelectorAll(".tour-dots i").forEach((d, n) => d.classList.toggle("on", n === i));
    card.querySelector('[data-t="back"]').disabled = i === 0;
    const nextBtn = card.querySelector('[data-t="next"]');
    nextBtn.innerHTML = step.finish ? 'Start a job <span aria-hidden="true">→</span>' : i === 0 ? 'Show me around <span aria-hidden="true">→</span>' : 'Next <span aria-hidden="true">→</span>';
    card.querySelector(".tour-skip").hidden = Boolean(step.finish);

    layer.dataset.centered = target ? "false" : "true";
    layer.target = target;
    card.classList.remove("in");
    place();
    await frame();
    card.classList.add("in");
    nextBtn.focus({ preventScroll: true });
  }

  function place() {
    if (!active) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const target = layer.target;
      const pad = 8;
      const vw = innerWidth;
      const vh = innerHeight;
      if (!target) {
        Object.assign(spot.style, { top: `${vh / 2}px`, left: `${vw / 2}px`, width: "0px", height: "0px", borderRadius: "50%" });
        card.style.top = "";
        card.style.left = "";
        return;
      }
      const r = target.getBoundingClientRect();
      const radius = Math.min(26, parseFloat(getComputedStyle(target).borderRadius) + pad || 18);
      Object.assign(spot.style, {
        top: `${r.top - pad}px`,
        left: `${r.left - pad}px`,
        width: `${r.width + pad * 2}px`,
        height: `${r.height + pad * 2}px`,
        borderRadius: `${radius}px`,
      });
      // On phones the card is a bottom sheet (CSS); on wider screens it sits beside the target.
      if (vw <= 640) {
        card.style.top = "";
        card.style.left = "";
        return;
      }
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      const gap = 18;
      let top;
      let left;
      if (r.right + gap + cw <= vw - 16 && r.width < vw * 0.4) {
        left = r.right + gap;
        top = r.top + r.height / 2 - ch / 2;
      } else if (r.bottom + gap + ch <= vh - 16) {
        top = r.bottom + gap;
        left = r.left + r.width / 2 - cw / 2;
      } else if (r.top - gap - ch >= 16) {
        top = r.top - gap - ch;
        left = r.left + r.width / 2 - cw / 2;
      } else {
        left = r.left - gap - cw;
        top = r.top + r.height / 2 - ch / 2;
      }
      card.style.left = `${Math.max(16, Math.min(left, vw - cw - 16))}px`;
      card.style.top = `${Math.max(16, Math.min(top, vh - ch - 16))}px`;
    });
  }

  function start() {
    if (active) return;
    if (!layer) build();
    active = true;
    lastFocus = document.activeElement;
    document.documentElement.classList.add("touring");
    layer.hidden = false;
    requestAnimationFrame(() => layer.classList.add("on"));
    go(0);
  }

  function end(skipped) {
    if (!active) return;
    active = false;
    try {
      localStorage.setItem(DONE_KEY, skipped ? "skipped" : "done");
    } catch {}
    layer.classList.remove("on");
    document.documentElement.classList.remove("touring");
    setTimeout(() => (layer.hidden = true), reduced ? 0 : 280);
    lastFocus?.focus?.({ preventScroll: true });
  }

export function startTour(navigate) {
  if (navigate) navigateTo = navigate;
  start();
}

/** Opens the tour on a first visit (not when the link points straight at a job). Returns a cleanup. */
export function autoStartTour(navigate) {
  if (navigate) navigateTo = navigate;
  let seen = false;
  try {
    seen = Boolean(localStorage.getItem(DONE_KEY));
  } catch {
    seen = true; // storage blocked: don't nag on every visit
  }
  if (seen || location.pathname.startsWith("/app/job/")) return () => {};
  const timer = setTimeout(start, 900);
  return () => clearTimeout(timer);
}
