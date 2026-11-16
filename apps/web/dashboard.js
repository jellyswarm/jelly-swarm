// Dashboard wired to the real JellySwarm API (apps/api). See api.js for the client.
let pendingJob = null; // { task, items, tier, maxAgents, quoteId, quote } between the new-job and review steps
let liveUnsubscribe = null;

function feedback(root, message) {
  const target = root.querySelector('[data-feedback]');
  if (target) target.textContent = message;
}
function addDraftCard(list, title, detail, status, onRemove) {
  const card = document.createElement('article'); card.className = 'draft-card';
  const chip = document.createElement('span'); chip.className = 'draft-meta'; chip.textContent = status;
  const heading = document.createElement('h3'); heading.textContent = title;
  const description = document.createElement('p'); description.textContent = detail;
  card.append(chip, heading, description);
  if (onRemove) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button outline'; remove.textContent = 'Remove draft';
    remove.addEventListener('click', onRemove);
    card.append(remove);
  }
  list.append(card);
}
function parseItems(raw) {
  return raw.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 2000);
}
function errorMessage(e) {
  if (e instanceof JellyApi.ApiError) {
    if (e.code === 'unreachable') return 'Could not reach the JellySwarm service. Check the API is running and reachable from this page.';
    return e.message || 'The service refused that request.';
  }
  return 'Something went wrong. Please try again.';
}

const views = {
  'new-job': { title: 'Plan a job.', html: `<div class="dash-panel"><span class="eyebrow">FANOUT · NEW JOB</span><h2>What can the swarm help with?</h2><p>Your first small job is planned to be free. This asks the real JellySwarm service for a fixed price before anything runs.</p><form id="quote-form"><label for="request">Your request</label><textarea id="request" required maxlength="4000" placeholder="For each item, give a holder count and a source…"></textarea><label for="items">Items (one per line)</label><textarea id="items" required maxlength="20000" rows="4" placeholder="tok-0&#10;tok-1&#10;tok-2"></textarea><label for="columns">Columns to fill (comma separated)</label><input id="columns" maxlength="200" placeholder="result"><div class="two-col"><div><label for="tier">Worker tier</label><select id="tier"><option value="open">Open · $0.005 / agent</option><option value="standard" selected>Standard · $0.015 / agent</option><option value="sealed">Sealed · $0.04 / agent</option></select></div><div><label for="agents">Max agents (up to 247)</label><input id="agents" type="number" min="1" max="247" step="1" value="20" required></div></div><div class="notice">The price is fixed by the service before anything runs; this excludes data and tool charges above the quoted cap.</div><div class="form-actions"><button class="button primary" type="submit">Get a real quote →</button></div><div id="estimate" aria-live="polite"></div><p class="draft-feedback" data-feedback role="status"></p></form></div>` },
  review: { title: 'Review your job.', html: `<div class="dash-panel"><span class="eyebrow">ONE LAST LOOK</span><h2>Ready for the swarm?</h2><p>This is a real, fixed-price quote from the service.</p><dl class="review-details"><div><dt>Request</dt><dd data-detail="request"></dd></div><div><dt>Items</dt><dd data-detail="items"></dd></div><div><dt>Columns</dt><dd data-detail="columns"></dd></div><div><dt>Worker tier</dt><dd data-detail="tier"></dd></div><div><dt>Agents</dt><dd data-detail="agents"></dd></div><div><dt>Fixed price</dt><dd data-detail="price"></dd></div></dl><div class="notice" data-dev-notice hidden>No real chain is connected yet: running this job uses a dev-only stand-in for payment, not a real wallet. No money moves.</div><div class="form-actions"><button class="button outline" data-go="new-job">Edit request</button><button class="button primary" id="run-job">Run this job →</button></div><p class="draft-feedback" data-feedback role="status"></p></div>` },
  jobs: { title: 'My jobs.', html: `<div class="dash-panel"><span class="eyebrow">YOUR SWARM</span><h2>Your jobs, together.</h2><p>Real jobs from the connected service, for the access key stored on this device.</p><div class="draft-list" id="job-list"></div><div class="form-actions"><button class="button outline" data-go="new-job">Plan a job →</button></div><p class="draft-feedback" data-feedback role="status"></p></div>` },
  receipts: { title: 'Receipts.', html: `<div class="dash-panel empty"><img src="assets/05-receipt.webp" alt=""><h3>A clear trail, all in one place.</h3><p>Open a job from "My jobs" to see its receipts and transcript once it has run.</p><div class="form-actions"><button class="button outline" data-go="jobs">Open my jobs →</button></div></div>` },
  watch: { title: 'Picket watch.', html: `<div class="dash-panel"><span class="eyebrow">PICKET · WATCHES</span><h2>Keep a little lookout.</h2><p>Choose what you would like to keep an eye on.</p><form id="watch-form" class="watch-form"><label for="watch-target">What would you like to watch?</label><input id="watch-target" type="text" required maxlength="200" placeholder="Wallet, token, account or topic"><label for="watch-condition">What should we look for?</label><input id="watch-condition" type="text" required maxlength="300" placeholder="Describe the activity or change"><div class="notice">Picket's watch engine isn't built yet. This saves your watch on the service for real; nothing is monitored and no alert will be sent.</div><div class="form-actions"><button class="button primary" type="submit">Save a watch →</button></div><p class="draft-feedback" data-feedback role="status"></p></form><div class="draft-list" id="watch-list"></div></div>` },
};

function jobDetailHtml(jobKey) {
  return `<div class="dash-panel"><span class="eyebrow">JOB</span><h2>${jobKey.slice(0, 10)}…${jobKey.slice(-6)}</h2><div id="job-detail-body"><p>Loading…</p></div><div class="form-actions"><button class="button outline" data-go="jobs">Back to my jobs</button></div></div>`;
}

function renderJobState(root, view) {
  const body = root.querySelector('#job-detail-body');
  if (!body) return;
  const rows = view.rows || { total: 0, passed: 0, refunded: 0 };
  const lines = [
    `<p><strong>State:</strong> ${view.state}</p>`,
    `<p><strong>Agents:</strong> ${view.agents} of ${view.of}</p>`,
    `<p><strong>Quoted price:</strong> $${view.quoteUsd}</p>`,
    `<p><strong>Rows:</strong> ${rows.total} total · ${rows.passed} passed · ${rows.refunded} refunded</p>`,
  ];
  if (view.spentUsd) lines.push(`<p><strong>Spent so far:</strong> $${view.spentUsd}</p>`);
  if (view.paidUsd) lines.push(`<p><strong>Paid:</strong> $${view.paidUsd}</p>`);
  if (view.refundedUsd) lines.push(`<p><strong>Refunded:</strong> $${view.refundedUsd}</p>`);
  if (view.error) lines.push(`<p><strong>Error:</strong> ${view.error}</p>`);
  body.innerHTML = lines.join('');
  if (view.state === 'settled' || view.state === 'finalized') {
    JellyApi.result(view.jobKey, 'json').then((result) => {
      const resultBox = document.createElement('div');
      resultBox.innerHTML = `<h3>Result</h3><p>${result.summary ? result.summary : ''}</p><p>${result.passed} passed, ${result.refunded} refunded, ${result.unverifiedCells} unverified cells.</p>`;
      try {
        const parsed = JSON.parse(result.content);
        const pre = document.createElement('pre');
        pre.style.whiteSpace = 'pre-wrap';
        pre.textContent = JSON.stringify(parsed, null, 2).slice(0, 4000);
        resultBox.append(pre);
      } catch { /* content wasn't JSON for this format */ }
      body.append(resultBox);
    }).catch(() => {});
  }
}

async function startJobWatch(root, jobKey) {
  if (liveUnsubscribe) { liveUnsubscribe(); liveUnsubscribe = null; }
  let done = false;
  const refresh = () =>
    JellyApi.status(jobKey).then((view) => {
      renderJobState(root, view);
      if (['settled', 'finalized', 'refunded', 'failed'].includes(view.state)) done = true;
    }).catch((e) => feedback(root, errorMessage(e)));
  await refresh();
  const closeSse = JellyApi.subscribe(jobKey, () => refresh());
  // SSE carries most updates instantly; this poll is just a safety net in case a connection drops.
  const interval = setInterval(() => { if (done) clearInterval(interval); else refresh(); }, 4000);
  liveUnsubscribe = () => { closeSse(); clearInterval(interval); };
}

function render(id) {
  if (liveUnsubscribe) { liveUnsubscribe(); liveUnsubscribe = null; }
  const isJobDetail = id && id.startsWith('job:');
  if (id !== 'overview' && !views[id] && !isJobDetail) id = 'overview';
  const drawer = document.querySelector('#view');
  document.querySelectorAll('[data-view]').forEach((el) => el.classList.toggle('is-current', el.dataset.view === id));
  history.replaceState(null, '', '#' + id);
  if (id === 'overview') { drawer.hidden = true; drawer.innerHTML = ''; return; }
  drawer.hidden = false;

  if (isJobDetail) {
    const jobKey = id.slice('job:'.length);
    drawer.innerHTML = `<div class="drawer-header"><h2>Job</h2><button class="drawer-close" aria-label="Close panel">×</button></div>${jobDetailHtml(jobKey)}`;
    drawer.scrollTop = 0;
    drawer.querySelector('.drawer-close').addEventListener('click', () => render('overview'));
    drawer.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => render(el.dataset.go)));
    startJobWatch(drawer, jobKey);
    return;
  }

  drawer.innerHTML = `<div class="drawer-header"><h2>${views[id].title}</h2><button class="drawer-close" aria-label="Close panel">×</button></div>${views[id].html}`;
  drawer.scrollTop = 0;
  drawer.querySelector('.drawer-close').addEventListener('click', () => render('overview'));
  drawer.querySelector('.drawer-close').focus({ preventScroll: true });
  drawer.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => render(el.dataset.go)));

  if (id === 'new-job') {
    const request = drawer.querySelector('#request'), form = drawer.querySelector('#quote-form');
    try {
      request.value = (pendingJob && pendingJob.task) || sessionStorage.getItem('jelly-draft') || '';
      request.addEventListener('input', () => { try { sessionStorage.setItem('jelly-draft', request.value); } catch {} });
    } catch {}
    if (pendingJob) {
      drawer.querySelector('#items').value = (pendingJob.items || []).join('\n');
      drawer.querySelector('#columns').value = (pendingJob.columns || []).join(', ');
      drawer.querySelector('#tier').value = pendingJob.tier;
      drawer.querySelector('#agents').value = pendingJob.maxAgents;
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const task = request.value.trim();
      const items = parseItems(drawer.querySelector('#items').value);
      const columns = (drawer.querySelector('#columns').value.trim() || 'result').split(',').map((s) => s.trim()).filter(Boolean);
      const tier = drawer.querySelector('#tier').value;
      const maxAgents = Number(drawer.querySelector('#agents').value);
      if (!task) return feedback(drawer, 'Please enter a request.');
      if (!items.length) return feedback(drawer, 'Please list at least one item, one per line.');
      feedback(drawer, 'Asking the service for a quote…');
      try {
        const quote = await JellyApi.quote({
          task, items, tier, maxAgents,
          columns: columns.map((name) => ({ name, type: 'text', needsSource: true })),
        });
        if (quote.accessKey) JellyApi.setAccessKey(quote.accessKey);
        pendingJob = { task, items, columns, tier, maxAgents, quoteId: quote.quoteId, quote };
        drawer.querySelector('#estimate').textContent = `$${quote.priceUsd} fixed price for ${quote.agents} of ${quote.of} agents. Expires ${new Date(quote.expiresAt).toLocaleString()}.`;
        feedback(drawer, '');
        render('review');
      } catch (e) {
        feedback(drawer, errorMessage(e));
      }
    });
  }

  if (id === 'review') {
    if (!pendingJob) { render('new-job'); return; }
    const q = pendingJob.quote;
    const fields = {
      request: pendingJob.task,
      items: `${pendingJob.items.length} item${pendingJob.items.length === 1 ? '' : 's'}`,
      columns: pendingJob.columns.join(', '),
      tier: q.tier,
      agents: `${q.agents} of ${q.of}`,
      price: `$${q.priceUsd}`,
    };
    for (const [k, v] of Object.entries(fields)) drawer.querySelector(`[data-detail="${k}"]`).textContent = v;
    drawer.querySelector('[data-dev-notice]').hidden = false; // shown until a real chain is wired in; see bootstrap.ts's devFunding
    drawer.querySelector('#run-job').addEventListener('click', async () => {
      feedback(drawer, 'Starting the job…');
      try {
        const payer = JellyApi.randomAddress();
        const prepared = await JellyApi.run(pendingJob.quoteId, payer);
        const jobKey = prepared.job.jobKey;
        await JellyApi.devFund(jobKey);
        await JellyApi.confirm(jobKey);
        pendingJob = null;
        try { sessionStorage.removeItem('jelly-draft'); } catch {}
        render('job:' + jobKey);
      } catch (e) {
        feedback(drawer, errorMessage(e));
      }
    });
  }

  if (id === 'jobs') {
    const list = drawer.querySelector('#job-list');
    JellyApi.list().then(({ jobs }) => {
      if (!jobs.length) { const p = document.createElement('p'); p.textContent = 'No jobs yet. Plan one whenever you are ready.'; list.append(p); return; }
      jobs.forEach((job) => {
        const card = document.createElement('article'); card.className = 'draft-card';
        const chip = document.createElement('span'); chip.className = 'draft-meta'; chip.textContent = job.state;
        const heading = document.createElement('h3'); heading.textContent = job.jobKey.slice(0, 10) + '…';
        const description = document.createElement('p'); description.textContent = `${job.agents} of ${job.of} agents · $${job.quoteUsd}`;
        const open = document.createElement('button'); open.type = 'button'; open.className = 'button outline'; open.textContent = 'Open';
        open.addEventListener('click', () => render('job:' + job.jobKey));
        card.append(chip, heading, description, open); list.append(card);
      });
    }).catch((e) => feedback(drawer, errorMessage(e)));
  }

  if (id === 'watch') {
    const list = drawer.querySelector('#watch-list');
    JellyApi.listWatches().then((watches) => {
      watches.forEach((watch) => addDraftCard(list, watch.target, watch.condition, 'Saved · not monitoring', () => {
        JellyApi.deleteWatch(watch.id).then(() => render('watch')).catch((e) => feedback(drawer, errorMessage(e)));
      }));
    }).catch((e) => feedback(drawer, errorMessage(e)));
    drawer.querySelector('#watch-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const target = drawer.querySelector('#watch-target').value.trim(), condition = drawer.querySelector('#watch-condition').value.trim();
      if (!target || !condition) { feedback(drawer, 'Please complete both fields.'); return; }
      try {
        await JellyApi.createWatch(target, condition);
        render('watch');
        feedback(drawer, 'Watch saved on the service. Monitoring is not built yet, so nothing will be checked or sent.');
      } catch (e) {
        feedback(drawer, errorMessage(e));
      }
    });
  }
}

function updateConnectionStatus() {
  JellyApi.health().then((ok) => {
    document.querySelectorAll('[data-connection-status]').forEach((el) => { el.textContent = ok ? 'Connected' : 'Not connected'; });
  }).catch(() => {});
}

document.querySelectorAll('[data-view]').forEach((el) => el.addEventListener('click', () => render(el.dataset.view)));
window.addEventListener('hashchange', () => render(location.hash.slice(1)));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('#view').hidden) render('overview'); });
document.querySelector('#zoom-scene').addEventListener('click', (e) => { const v = document.querySelector('.dashboard-bg').classList.toggle('zoomed'); e.currentTarget.setAttribute('aria-pressed', String(v)); e.currentTarget.setAttribute('aria-label', v ? 'Reset scene zoom' : 'Zoom scene'); });
document.querySelector('#tint-scene').addEventListener('click', (e) => { const v = document.querySelector('.dashboard-bg').classList.toggle('contrast'); e.currentTarget.setAttribute('aria-pressed', String(v)); });
const video = document.querySelector('#dash-video'); const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reduced) { video.pause(); video.removeAttribute('autoplay'); }
document.addEventListener('visibilitychange', () => { if (document.hidden) video.pause(); else if (!reduced) video.play().catch(() => {}); });
render(location.hash.slice(1));
updateConnectionStatus();
