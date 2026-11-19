// Dashboard wired to the real JellySwarm API (apps/api). See api.js for the client.
let pendingJob = null; // { task, items, tier, maxAgents, quoteId, quote } between the new-job and review steps
let liveUnsubscribe = null;

function feedback(root, message) {
  const target = root.querySelector('[data-feedback]');
  if (target) target.textContent = message;
}
function addDraftCard(list, title, detail, status, onRemove) {
  const card = document.createElement('article'); card.className = 'draft-card';
  const chip = document.createElement('span'); chip.className = 'draft-meta'; chip.dataset.tone = 'idle'; chip.textContent = status;
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
  review: { title: 'Review your job.', html: `<div class="dash-panel"><span class="eyebrow">ONE LAST LOOK</span><h2>Ready for the swarm?</h2><p>This is a real, fixed-price quote from the service.</p><dl class="review-details"><div><dt>Request</dt><dd data-detail="request"></dd></div><div><dt>Items</dt><dd data-detail="items"></dd></div><div><dt>Columns</dt><dd data-detail="columns"></dd></div><div><dt>Worker tier</dt><dd data-detail="tier"></dd></div><div><dt>Agents</dt><dd data-detail="agents"></dd></div><div><dt>Fixed price</dt><dd data-detail="price"></dd></div></dl><div class="notice" data-dev-notice hidden>No real chain is connected yet: running this job uses a dev-only stand-in for payment, not a real wallet. No money moves.</div><div class="form-actions"><button class="button outline" data-go="new-job">Edit request</button><button class="button outline" id="run-job-x402" type="button">Pay with wallet (x402) →</button><button class="button primary" id="run-job">Run this job →</button></div><p class="draft-feedback" data-feedback role="status"></p></div>` },
  jobs: { title: 'My jobs.', html: `<div class="dash-panel"><span class="eyebrow">YOUR SWARM</span><h2>Your jobs, together.</h2><p>Real jobs from the connected service, for the access key stored on this device.</p><div class="draft-list" id="job-list"></div><div class="form-actions"><button class="button outline" data-go="new-job">Plan a job →</button></div><p class="draft-feedback" data-feedback role="status"></p></div>` },
  watch: { title: 'Picket watch.', html: `<div class="dash-panel"><span class="eyebrow">PICKET · WATCHES</span><h2>Keep a little lookout.</h2><p>Choose what you would like to keep an eye on.</p><form id="watch-form" class="watch-form"><label for="watch-target">What would you like to watch?</label><input id="watch-target" type="text" required maxlength="200" placeholder="Wallet, token, account or topic"><label for="watch-condition">What should we look for?</label><input id="watch-condition" type="text" required maxlength="300" placeholder="Describe the activity or change"><div class="notice">Picket's watch engine isn't built yet. This saves your watch on the service for real; nothing is monitored and no alert will be sent.</div><div class="form-actions"><button class="button primary" type="submit">Save a watch →</button></div><p class="draft-feedback" data-feedback role="status"></p></form><div class="draft-list" id="watch-list"></div></div>` },
  account: { title: 'Your account.', html: `<div class="dash-panel"><span class="eyebrow">ACCOUNT</span><h2>Credits and referrals.</h2><p>Real balances and codes from the connected service, for the access key stored on this device.</p><dl class="review-details"><div><dt>Credit balance</dt><dd id="credit-balance">…</dd></div><div><dt>Your referral code</dt><dd id="referral-code">…</dd></div></dl><div class="notice">Referring yourself (same device, same funding wallet) is blocked and recorded, but never credited. Referrer credit pays out once the referee's first job over $1 finalizes.</div><form id="referral-form"><label for="referral-input">Have a referral code?</label><div class="two-col"><input id="referral-input" type="text" maxlength="20" placeholder="Their code"><button class="button outline" type="submit">Use code</button></div></form><p class="draft-feedback" data-feedback role="status"></p><h3 style="margin-top:1.5rem">Sign in</h3><p>Passkey, wallet and email link all sign in for real, on the connected service. Each replaces the key stored on this device — jobs made anonymously under the old key stay there, not under the signed-in identity.</p><div class="two-col"><button class="button outline" type="button" id="passkey-register">Create a passkey</button><button class="button outline" type="button" id="passkey-login">Sign in with passkey</button></div><div class="form-actions"><button class="button outline" type="button" id="wallet-login">Sign in with wallet</button></div><div class="two-col"><input id="email-input" type="email" maxlength="200" placeholder="you@example.com"><button class="button outline" type="button" id="email-request">Email me a link</button></div><div id="email-dev-link"></div><p id="signin-result" class="draft-feedback" role="status"></p><h3 style="margin-top:1.5rem">Top up a wallet-bound key</h3><p>Pays over x402 from the wallet you connect at the top of the dashboard (real USDC on Base). This moves real funds once a real chain is wired in.</p><div class="two-col"><input id="topup-owner" type="text" maxlength="42" placeholder="Owner wallet address (0x…)"><input id="topup-amount" type="text" maxlength="12" placeholder="Amount USD (min 5)"></div><div class="form-actions"><button class="button outline" id="topup-submit" type="button">Pay with wallet (x402)</button></div><div id="topup-result"></div></div>` },
  stats: { title: 'Public stats.', html: `<div class="dash-panel"><span class="eyebrow">A PUBLIC METER</span><h2>Real paid volume, in the open.</h2><p>No login needed — this is the same data anyone can read at <code>GET /stats</code>.</p><div id="stats-body"><p>Loading…</p></div></div>` },
};

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function jobDetailHtml(jobKey) {
  return `<div class="dash-panel"><span class="eyebrow">JOB</span><h2>${jobKey.slice(0, 10)}…${jobKey.slice(-6)}</h2><div id="job-detail-body"><p>Loading…</p></div><div class="form-actions"><button class="button outline" data-go="jobs">Back to my jobs</button></div></div>`;
}

function resultTableHtml(parsed) {
  const head = `<tr><th>Item</th>${parsed.columns.map((c) => `<th>${escapeHtml(c.name)}</th>`).join('')}</tr>`;
  const body = parsed.rows.map((r) => {
    const cells = parsed.columns.map((c) => {
      const cell = r.cells[c.name] || {};
      const value = escapeHtml(cell.value === undefined || cell.value === null ? '' : String(cell.value));
      return cell.sourceUrl ? `<td>${value} <a href="${escapeHtml(cell.sourceUrl)}" target="_blank" rel="noopener">source</a></td>` : `<td>${value}</td>`;
    }).join('');
    return `<tr><td>${escapeHtml(r.item)}</td>${cells}</tr>`;
  }).join('');
  return `<table class="result-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function disputeSectionHtml() {
  return `<div class="dash-panel" style="margin-top:1rem"><h3>Dispute a row</h3><p>Only passed rows can be disputed, inside the dispute window. This asks the service to build the on-chain call; sending it needs your connected wallet.</p><div class="two-col"><input id="dispute-rows" type="text" placeholder="Row numbers, comma separated (e.g. 0,2)"><button class="button outline" id="dispute-submit">Build dispute call</button></div><input id="dispute-evidence" type="text" maxlength="4000" placeholder="Evidence (optional)" style="margin-top:0.5rem;width:100%"><div id="dispute-result"></div></div>`;
}

function shareSectionHtml() {
  return `<div class="dash-panel" style="margin-top:1rem"><h3>Share this job</h3><div class="two-col"><select id="share-visibility"><option value="private">Private</option><option value="unlisted" selected>Unlisted (anyone with the link)</option><option value="public">Public</option></select><button class="button outline" id="share-submit">Create share link</button></div><div id="share-result"></div></div>`;
}

function wireDisputeAndShare(root, jobKey) {
  const disputeBtn = root.querySelector('#dispute-submit');
  if (disputeBtn) {
    disputeBtn.addEventListener('click', async () => {
      const rowIdx = root.querySelector('#dispute-rows').value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0);
      const evidence = root.querySelector('#dispute-evidence').value.trim();
      const out = root.querySelector('#dispute-result');
      if (!rowIdx.length) { out.textContent = 'Enter at least one row number.'; return; }
      try {
        const result = await JellyApi.dispute(jobKey, rowIdx, evidence);
        out.innerHTML = `<p>Fee: $${result.feeUsd}. Send this from the client's own wallet to RowSplit.disputeRows:</p><pre style="white-space:pre-wrap">${escapeHtml(JSON.stringify(result.onchain, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2))}</pre>`;
      } catch (e) {
        out.textContent = errorMessage(e);
      }
    });
  }
  const shareBtn = root.querySelector('#share-submit');
  if (shareBtn) {
    shareBtn.addEventListener('click', async () => {
      const visibility = root.querySelector('#share-visibility').value;
      const out = root.querySelector('#share-result');
      try {
        const { slug } = await JellyApi.createShare(jobKey, visibility);
        out.innerHTML = `<p>Share slug: <code>${escapeHtml(slug)}</code> (${escapeHtml(visibility)}) — <a href="#" data-check-share="${escapeHtml(slug)}">check it reads back</a></p>`;
        out.querySelector('[data-check-share]').addEventListener('click', async (e) => {
          e.preventDefault();
          try {
            const read = await JellyApi.getShare(slug);
            out.innerHTML += `<p>Confirmed: visibility is "${escapeHtml(read.visibility)}" on the service.</p>`;
          } catch (err) {
            out.innerHTML += `<p>${escapeHtml(errorMessage(err))}</p>`;
          }
        });
      } catch (e) {
        out.textContent = errorMessage(e);
      }
    });
  }
}

function renderJobState(root, view) {
  const body = root.querySelector('#job-detail-body');
  if (!body) return;
  const rows = view.rows || { total: 0, passed: 0, refunded: 0 };
  const lines = [
    `<p><strong>State:</strong> <span class="draft-meta" data-tone="${chipTone(view.state)}">${escapeHtml(view.state.replace(/_/g, ' '))}</span></p>`,
    `<p><strong>Agents:</strong> ${view.agents} of ${view.of}</p>`,
    `<p><strong>Quoted price:</strong> $${view.quoteUsd}</p>`,
    `<p><strong>Rows:</strong> ${rows.total} total · ${rows.passed} passed · ${rows.refunded} refunded</p>`,
  ];
  if (view.spentUsd) lines.push(`<p><strong>Spent so far:</strong> $${view.spentUsd}</p>`);
  if (view.paidUsd) lines.push(`<p><strong>Paid:</strong> $${view.paidUsd}</p>`);
  if (view.refundedUsd) lines.push(`<p><strong>Refunded:</strong> $${view.refundedUsd}</p>`);
  if (view.error) lines.push(`<p><strong>Error:</strong> ${view.error}</p>`);
  // Lines live in their own node so repeated refreshes (polling, replayed SSE) never wipe the
  // result/share/dispute section below, which is fetched and appended only once per job.
  let linesBox = body.querySelector('#job-detail-lines');
  if (!linesBox) {
    body.innerHTML = '<div id="job-detail-lines"></div><div id="job-detail-extras"></div>';
    linesBox = body.querySelector('#job-detail-lines');
  }
  linesBox.innerHTML = lines.join('');
  const terminal = view.state === 'settled' || view.state === 'finalized' || view.state === 'refunded';
  const extras = body.querySelector('#job-detail-extras');
  if (terminal && extras && !extras.dataset.loaded) {
    extras.dataset.loaded = '1';
    JellyApi.result(view.jobKey, 'json').then((result) => {
      const resultBox = document.createElement('div');
      resultBox.innerHTML = `<h3>Result</h3><p>${escapeHtml(result.summary || '')}</p><p>${result.passed} passed, ${result.refunded} refunded, ${result.unverifiedCells} unverified cells.</p>`;
      try {
        const parsed = JSON.parse(result.content);
        resultBox.innerHTML += resultTableHtml(parsed);
      } catch { /* content wasn't JSON for this format */ }
      extras.append(resultBox);
      const extrasForm = document.createElement('div');
      extrasForm.innerHTML = shareSectionHtml() + (rows.passed > 0 ? disputeSectionHtml() : '');
      extras.append(extrasForm);
      wireDisputeAndShare(extrasForm, view.jobKey);
    }).catch(() => { delete extras.dataset.loaded; });
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
  if (id === 'receipts') id = 'jobs'; // receipts live on each job's page now
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
        const payer = (window.JellyWallet && JellyWallet.address) || JellyApi.randomAddress();
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
    drawer.querySelector('#run-job-x402').addEventListener('click', async () => {
      feedback(drawer, 'Asking your wallet to sign the payment…');
      try {
        const { address: payer } = await JellyWallet.require();
        const result = await JellyApi.runWithX402(pendingJob.quoteId, payer);
        const jobKey = result.job.jobKey;
        pendingJob = null;
        try { sessionStorage.removeItem('jelly-draft'); } catch {}
        render('job:' + jobKey);
      } catch (e) {
        feedback(drawer, e.message || errorMessage(e));
      }
    });
  }

  if (id === 'jobs') {
    const list = drawer.querySelector('#job-list');
    JellyApi.list().then(({ jobs }) => {
      if (!jobs.length) { const p = document.createElement('p'); p.textContent = 'No jobs yet. Plan one whenever you are ready.'; list.append(p); return; }
      jobs.forEach((job) => {
        const card = document.createElement('article'); card.className = 'draft-card';
        const chip = document.createElement('span'); chip.className = 'draft-meta'; chip.dataset.tone = chipTone(job.state); chip.textContent = job.state.replace(/_/g, ' ');
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

  if (id === 'account') {
    const noAccountYet = () => 'Plan a job, save a watch, or use a referral code first — there is no account on this device yet.';
    JellyApi.creditBalance().then((v) => { drawer.querySelector('#credit-balance').textContent = `$${v}`; })
      .catch(() => { drawer.querySelector('#credit-balance').textContent = noAccountYet(); });
    JellyApi.referralCode().then((code) => { drawer.querySelector('#referral-code').textContent = code; })
      .catch(() => { drawer.querySelector('#referral-code').textContent = noAccountYet(); });
    drawer.querySelector('#referral-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const refCode = drawer.querySelector('#referral-input').value.trim();
      if (!refCode) return;
      try {
        const result = await JellyApi.registerReferral(refCode);
        feedback(drawer, result.state === 'blocked' ? `Recorded, but not credited: ${result.blockReason}.` : 'Referral recorded — your $0.50 signup credit has been added.');
        render('account');
      } catch (e) {
        feedback(drawer, errorMessage(e));
      }
    });
    const signin = drawer.querySelector('#signin-result');
    const signedIn = (result) => {
      signin.textContent = `Signed in. Account: ${result.accountId}.`;
      render('account');
    };
    drawer.querySelector('#passkey-register').addEventListener('click', async () => {
      try { signedIn(await JellyApi.registerPasskey()); } catch (e) { signin.textContent = e.message || errorMessage(e); }
    });
    drawer.querySelector('#passkey-login').addEventListener('click', async () => {
      try { signedIn(await JellyApi.loginPasskey()); } catch (e) { signin.textContent = e.message || errorMessage(e); }
    });
    drawer.querySelector('#wallet-login').addEventListener('click', async () => {
      try { signedIn(await JellyApi.loginWithWallet()); } catch (e) { signin.textContent = e.message || errorMessage(e); }
    });
    drawer.querySelector('#email-request').addEventListener('click', async () => {
      const email = drawer.querySelector('#email-input').value.trim();
      const devLink = drawer.querySelector('#email-dev-link');
      if (!email) { signin.textContent = 'Enter an email address.'; return; }
      try {
        const result = await JellyApi.requestEmailLink(email);
        if (result.sent) {
          devLink.innerHTML = `<p>Check ${escapeHtml(email)} for a sign-in link.</p>`;
          return;
        }
        devLink.innerHTML = `<p>${escapeHtml(result.devNote)}</p><button class="button outline" type="button" id="email-use-link">Use this link</button>`;
        devLink.querySelector('#email-use-link').addEventListener('click', async () => {
          try { signedIn(await JellyApi.verifyEmailLink(result.devToken)); } catch (e) { signin.textContent = e.message || errorMessage(e); }
        });
      } catch (e) {
        signin.textContent = errorMessage(e);
      }
    });
    const ownerInput = drawer.querySelector('#topup-owner');
    if (window.JellyWallet && JellyWallet.address && !ownerInput.value) ownerInput.value = JellyWallet.address;
    drawer.querySelector('#topup-submit').addEventListener('click', async () => {
      const owner = drawer.querySelector('#topup-owner').value.trim();
      const amountUsd = drawer.querySelector('#topup-amount').value.trim();
      const out = drawer.querySelector('#topup-result');
      if (!owner || !amountUsd) { out.textContent = 'Enter an owner address and an amount.'; return; }
      out.textContent = 'Asking your wallet to sign the payment…';
      try {
        const result = await JellyApi.topUpKey(owner, amountUsd);
        out.innerHTML = `<p>Key issued: <code>${escapeHtml(result.keyId)}</code>. ${escapeHtml(result.note || '')}</p>`;
      } catch (e) {
        out.textContent = errorMessage(e);
      }
    });
  }

  if (id === 'stats') {
    const body = drawer.querySelector('#stats-body');
    JellyApi.stats().then((view) => {
      const tierRows = (['open', 'standard', 'sealed']).map((tier) =>
        `<tr><td>${tier}</td><td>${view.p95SettleSeconds[tier] === null ? '—' : `${view.p95SettleSeconds[tier]}s`}</td></tr>`).join('');
      const volumeRows = view.volume.length
        ? view.volume.map((r) => `<tr><td>${escapeHtml(r.day)}</td><td>${escapeHtml(r.product)}</td><td>${escapeHtml(r.chain)}</td><td>${Object.entries(r.totals).map(([k, v]) => `${escapeHtml(k)}: $${escapeHtml(v)}`).join(', ')}</td></tr>`).join('')
        : '<tr><td colspan="4">No settled volume yet.</td></tr>';
      const burnsHtml = view.burns.length
        ? `<ul>${view.burns.map((b) => `<li>$${escapeHtml(b.stableInUsd)} → ${escapeHtml(b.tokenBurned)} burned (<code>${escapeHtml(b.tx)}</code>)</li>`).join('')}</ul>`
        : '<p>No burns recorded yet.</p>';
      body.innerHTML = `
        <dl class="review-details">
          <div><dt>Refund rate</dt><dd>${(view.refundRateBps / 100).toFixed(2)}%</dd></div>
        </dl>
        <h3>Settle time (p95) by tier</h3>
        <table class="result-table"><thead><tr><th>Tier</th><th>p95</th></tr></thead><tbody>${tierRows}</tbody></table>
        <h3>Volume by day / product / chain</h3>
        <table class="result-table"><thead><tr><th>Day</th><th>Product</th><th>Chain</th><th>Totals</th></tr></thead><tbody>${volumeRows}</tbody></table>
        <h3>Token burns</h3>
        ${burnsHtml}
        <h3>Disclosures</h3>
        <ul>${view.disclosures.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>
      `;
    }).catch((e) => { body.textContent = errorMessage(e); });
  }
}

/** Service status bubbles: checking → online / offline, rechecked every 20s and when the tab comes back. */
function updateConnectionStatus() {
  const els = document.querySelectorAll('[data-connection-status]');
  els.forEach((el) => { if (!el.dataset.state) { el.dataset.state = 'checking'; el.textContent = 'Checking service…'; } });
  JellyApi.health().then((ok) => {
    els.forEach((el) => {
      el.dataset.state = ok ? 'online' : 'offline';
      el.textContent = ok ? 'Service online' : 'Service offline';
      el.title = ok ? 'The JellySwarm service is answering.' : 'The JellySwarm service is not answering. Quotes and jobs will fail until it is back.';
    });
  }).catch(() => {});
}
setInterval(() => { if (!document.hidden) updateConnectionStatus(); }, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateConnectionStatus(); });

/** Colour family for a job or watch state chip. */
function chipTone(state) {
  if (['settled', 'finalized'].includes(state)) return 'good';
  if (['failed', 'refunded', 'expired'].includes(state)) return 'bad';
  if (state === 'awaiting_payment') return 'idle';
  return 'live';
}

document.querySelectorAll('[data-view]').forEach((el) => el.addEventListener('click', () => render(el.dataset.view)));

/** The ⋯ menu: account, stats and the way back to the website, out of the main bar. */
(function moreMenu() {
  const btn = document.querySelector('#more-button'), menu = document.querySelector('#more-menu');
  if (!btn || !menu) return;
  const set = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', () => { set(menu.hidden); if (!menu.hidden) menu.querySelector('[role=menuitem]').focus(); });
  menu.addEventListener('click', (e) => { if (e.target.closest('[role=menuitem]')) set(false); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.parentElement.contains(e.target)) set(false); });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('[role=menuitem]')], i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.stopPropagation(); set(false); btn.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
})();
window.addEventListener('hashchange', () => render(location.hash.slice(1)));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('#view').hidden) render('overview'); });
document.querySelector('#zoom-scene').addEventListener('click', (e) => { const v = document.querySelector('.dashboard-bg').classList.toggle('zoomed'); e.currentTarget.setAttribute('aria-pressed', String(v)); e.currentTarget.setAttribute('aria-label', v ? 'Reset scene zoom' : 'Zoom scene'); });
document.querySelector('#tint-scene').addEventListener('click', (e) => { const v = document.querySelector('.dashboard-bg').classList.toggle('contrast'); e.currentTarget.setAttribute('aria-pressed', String(v)); });
const video = document.querySelector('#dash-video'); const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reduced) { video.pause(); video.removeAttribute('autoplay'); }
document.addEventListener('visibilitychange', () => { if (document.hidden) video.pause(); else if (!reduced) video.play().catch(() => {}); });

/** A real emailed sign-in link lands here as ?emailToken=…; verify it once, then drop it from the URL. */
function initialRender() {
  const emailToken = new URLSearchParams(location.search).get('emailToken');
  if (!emailToken) { render(location.hash.slice(1)); return; }
  history.replaceState(null, '', location.pathname + '#account');
  JellyApi.verifyEmailLink(emailToken)
    .then((result) => { render('account'); document.querySelector('#signin-result').textContent = `Signed in. Account: ${result.accountId}.`; })
    .catch((e) => { render('account'); document.querySelector('#signin-result').textContent = errorMessage(e); });
}
if (window.JellyWallet) JellyWallet.mountButton(document.querySelector('#wallet-slot'));
initialRender();
updateConnectionStatus();
