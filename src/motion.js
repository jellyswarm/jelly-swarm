// Scroll-triggered reveals and the cursor spotlight on cards.
// Headings rise word by word through <Words> (src/site/Words.jsx); everything else is tagged here.

const GROUPS = [
  ".hero-copy",
  ".hero-chips",
  ".grid-copy",
  ".grid-stats",
  ".steps",
  ".price-calc",
  ".promises",
  ".feature-grid",
  ".status-list",
  ".faq-list",
  ".footer-top",
  ".stat-row",
  ".quick-grid",
  ".principles",
  ".bento",
  ".rm-weeks",
  ".outcomes",
  ".paper-hero .inner",
];
const SINGLES = [
  [".section-head > .eyebrow", ""],
  [".section-head > p", ""],
  [".swarm-grid", "scale"],
  [".jelly-portrait", "scale"],
  [".faq-mascot", "scale"],
  [".horizon-crew img", "fade"],
  [".floaters img", "fade"],
  [".footer-word", ""],
  [".footer-bottom", "fade"],
  [".orbit-host", "fade"],
  [".hero-card", "scale"],
  [".hiw-visual", "scale"],
  [".hiw-accordion", ""],
  [".ed-copy", ""],
  [".ed-band p", ""],
  [".ed-outro p", ""],
  [".ed-outro .button", ""],
  [".rm-intro > p", ""],
];

/** Tags and observes everything under `root`. Returns a cleanup function. */
export function reveal(root = document) {
  if (!document.documentElement.classList.contains("js-reveal")) return () => {};
  const targets = new Set();
  const mark = (el, variant = "", i = 0) => {
    // Already tagged by an earlier run (route change, or React re-running the effect):
    // keep watching it, or it would stay hidden.
    if (el.hasAttribute("data-reveal")) {
      targets.add(el);
      return;
    }
    el.setAttribute("data-reveal", variant);
    el.style.setProperty("--i", String(i));
    targets.add(el);
  };
  root.querySelectorAll("[data-reveal='words']").forEach((el) => targets.add(el));
  for (const sel of GROUPS) {
    root.querySelectorAll(sel).forEach((group) => {
      let i = 0;
      for (const child of group.children) {
        if (child.dataset.reveal === "words") {
          i++;
          continue;
        }
        mark(child, "", Math.min(i++, 8));
      }
    });
  }
  for (const [sel, variant] of SINGLES) root.querySelectorAll(sel).forEach((el) => mark(el, variant));
  root.querySelectorAll(".planet").forEach((el) => targets.add(el));

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
  );
  targets.forEach((el) => (el.classList.contains("is-in") ? null : io.observe(el)));
  return () => io.disconnect();
}

/** A soft light follows the cursor across cards. Installed once. */
export function installSpotlight() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !matchMedia("(pointer: fine)").matches) return;
  const SEL = ".step, .feature, .card, .job-row, .stat, details";
  document.addEventListener(
    "pointermove",
    (e) => {
      const el = e.target.closest?.(SEL);
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
    },
    { passive: true },
  );
}
