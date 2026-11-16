// The dashboard stores request and watch drafts locally until a service exists.
const DRAFT_KEYS = {jobs:'jellyswarm-job-drafts-v1', watches:'jellyswarm-watch-drafts-v1'};
const tiers = {'.005':'Open', '.015':'Standard', '.04':'Sealed'};
let pendingJob = null;
function readDrafts(kind) {
  try { const value=JSON.parse(localStorage.getItem(DRAFT_KEYS[kind]) || '[]'); return Array.isArray(value) ? value : []; }
  catch { return []; }
}
function writeDrafts(kind, value) {
  try { localStorage.setItem(DRAFT_KEYS[kind], JSON.stringify(value)); return true; }
  catch { return false; }
}
function feedback(root, message) {
  const target=root.querySelector('[data-feedback]');
  if(target) target.textContent=message;
}
function addDraftCard(list, title, detail, status, onRemove) {
  const card=document.createElement('article'); card.className='draft-card';
  const chip=document.createElement('span'); chip.className='draft-meta'; chip.textContent=status;
  const heading=document.createElement('h3'); heading.textContent=title;
  const description=document.createElement('p'); description.textContent=detail;
  const remove=document.createElement('button'); remove.type='button'; remove.className='button outline'; remove.textContent='Remove draft';
  remove.addEventListener('click',onRemove);
  card.append(chip,heading,description,remove); list.append(card);
}
const views={
 'new-job':{title:'Plan a job.',html:`<div class="dash-panel"><span class="eyebrow">FANOUT · NEW JOB</span><h2>What can the swarm help with?</h2><p>Your first small job is planned to be free. Estimate fees for later jobs below; a final quote requires the JellySwarm service.</p><form id="quote-form"><label for="request">Your request</label><textarea id="request" required maxlength="4000" placeholder="Compare these items and include a source for each result…"></textarea><div class="two-col"><div><label for="tier">Worker tier</label><select id="tier"><option value=".005">Open · $0.005 / agent</option><option value=".015">Standard · $0.015 / agent</option><option value=".04">Sealed · $0.04 / agent</option></select></div><div><label for="agents">Number of agents</label><input id="agents" type="number" min="1" max="247" step="1" value="20" required></div></div><div class="notice">The estimate excludes data and tool charges. Running work and taking payment require the service to be connected.</div><div class="form-actions"><button class="button outline" type="submit">Calculate estimate</button><button class="button primary" type="button" id="review-job">Run job →</button></div><div id="estimate" aria-live="polite"></div><p class="draft-feedback" data-feedback role="status"></p></form></div>`},
 review:{title:'Review your job.',html:`<div class="dash-panel"><span class="eyebrow">ONE LAST LOOK</span><h2>Ready for the swarm?</h2><p>Check your request and save it for later.</p><dl class="review-details"><div><dt>Request</dt><dd data-detail="request"></dd></div><div><dt>Worker tier</dt><dd data-detail="tier"></dd></div><div><dt>Agents</dt><dd data-detail="agents"></dd></div><div><dt>Estimate</dt><dd data-detail="estimate"></dd></div></dl><div class="notice">The service isn't connected yet. Saving keeps this request on this device; no work will run and no payment will be taken.</div><div class="form-actions"><button class="button outline" data-go="new-job">Edit request</button><button class="button primary" id="save-job">Save job draft →</button></div><p class="draft-feedback" data-feedback role="status"></p></div>`},
 jobs:{title:'My jobs.',html:`<div class="dash-panel"><span class="eyebrow">YOUR SWARM</span><h2>Your jobs, together.</h2><p>Saved requests stay on this device until the service is connected.</p><div class="draft-list" id="job-list"></div><div class="form-actions"><button class="button outline" data-go="new-job">Plan a job →</button></div><p class="draft-feedback" data-feedback role="status"></p></div>`},
 receipts:{title:'Receipts.',html:`<div class="dash-panel empty"><img src="assets/05-receipt.webp" alt=""><h3>A clear trail, all in one place.</h3><p>Receipts will appear here when the receipt service is connected and a real job has run.</p></div>`},
 watch:{title:'Picket watch.',html:`<div class="dash-panel"><span class="eyebrow">PICKET · WATCHES</span><h2>Keep a little lookout.</h2><p>Choose what you would like to keep an eye on.</p><form id="watch-form" class="watch-form"><label for="watch-target">What would you like to watch?</label><input id="watch-target" type="text" required maxlength="200" placeholder="Wallet, token, account or topic"><label for="watch-condition">What should we look for?</label><input id="watch-condition" type="text" required maxlength="300" placeholder="Describe the activity or change"><div class="notice">Watches are saved on this device. Monitoring and alerts start only when the service is connected.</div><div class="form-actions"><button class="button primary" type="submit">Create a watch →</button></div><p class="draft-feedback" data-feedback role="status"></p></form><div class="draft-list" id="watch-list"></div></div>`}
};
function render(id) {
  if(id!=='overview'&&!views[id]) id='overview';
  const drawer=document.querySelector('#view');
  document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('is-current',el.dataset.view===id));
  history.replaceState(null,'','#'+id);
  if(id==='overview'){drawer.hidden=true;drawer.innerHTML='';return;}
  drawer.hidden=false;
  drawer.innerHTML=`<div class="drawer-header"><h2>${views[id].title}</h2><button class="drawer-close" aria-label="Close panel">×</button></div>${views[id].html}`;
  drawer.scrollTop=0;
  drawer.querySelector('.drawer-close').addEventListener('click',()=>render('overview'));
  drawer.querySelector('.drawer-close').focus({preventScroll:true});
  drawer.querySelectorAll('[data-go]').forEach(el=>el.addEventListener('click',()=>render(el.dataset.go)));
  if(id==='new-job') {
    const request=drawer.querySelector('#request'),form=drawer.querySelector('#quote-form');
    try { request.value=pendingJob?.request || sessionStorage.getItem('jelly-draft') || ''; request.addEventListener('input',()=>{try{sessionStorage.setItem('jelly-draft',request.value)}catch{}}); } catch {}
    if(pendingJob){drawer.querySelector('#tier').value=pendingJob.rate;drawer.querySelector('#agents').value=pendingJob.agents;}
    const details=()=>{const rate=drawer.querySelector('#tier').value,agents=Number(drawer.querySelector('#agents').value);return {request:request.value.trim(),rate,tier:tiers[rate],agents,estimate:(.25+agents*Number(rate)).toFixed(2)};};
    form.addEventListener('submit',event=>{event.preventDefault();const job=details();if(!job.request){feedback(drawer,'Please enter a request.');return;}drawer.querySelector('#estimate').textContent=`$${job.estimate} estimated base + agent fees; excludes data and tools.`;});
    drawer.querySelector('#review-job').addEventListener('click',()=>{if(!form.reportValidity())return;const job=details();if(!job.request){feedback(drawer,'Please enter a request.');return;}pendingJob=job;render('review');});
  }
  if(id==='review') {
    if(!pendingJob){render('new-job');return;}
    for(const [key,value] of Object.entries({request:pendingJob.request,tier:pendingJob.tier,agents:String(pendingJob.agents),estimate:`$${pendingJob.estimate} before data and tools`})) drawer.querySelector(`[data-detail="${key}"]`).textContent=value;
    drawer.querySelector('#save-job').addEventListener('click',()=>{const jobs=readDrafts('jobs');jobs.unshift({...pendingJob,id:`${Date.now()}-${Math.random().toString(36).slice(2,9)}`});if(!writeDrafts('jobs',jobs)){feedback(drawer,'Could not save on this device. Check your browser storage settings.');return;}pendingJob=null;try{sessionStorage.removeItem('jelly-draft')}catch{}render('jobs');});
  }
  if(id==='jobs') {
    const list=drawer.querySelector('#job-list'), jobs=readDrafts('jobs');
    if(!jobs.length){const p=document.createElement('p');p.textContent='No saved jobs yet. Plan one whenever you are ready.';list.append(p);}
    jobs.forEach(job=>addDraftCard(list,job.request,`${job.tier} · ${job.agents} agents · $${job.estimate} estimate before data and tools`,'Draft · not run',()=>{if(writeDrafts('jobs',readDrafts('jobs').filter(item=>item.id!==job.id)))render('jobs');else feedback(drawer,'Could not update drafts on this device.');}));
  }
  if(id==='watch') {
    const list=drawer.querySelector('#watch-list');
    readDrafts('watches').forEach(watch=>addDraftCard(list,watch.target,watch.condition,'Saved locally · not monitoring',()=>{if(writeDrafts('watches',readDrafts('watches').filter(item=>item.id!==watch.id)))render('watch');else feedback(drawer,'Could not update watches on this device.');}));
    drawer.querySelector('#watch-form').addEventListener('submit',event=>{event.preventDefault();const target=drawer.querySelector('#watch-target').value.trim(),condition=drawer.querySelector('#watch-condition').value.trim();if(!target||!condition){feedback(drawer,'Please complete both fields.');return;}const watches=readDrafts('watches');watches.unshift({id:`${Date.now()}-${Math.random().toString(36).slice(2,9)}`,target,condition});if(!writeDrafts('watches',watches)){feedback(drawer,'Could not save on this device. Check your browser storage settings.');return;}render('watch');feedback(drawer,'Watch saved on this device. Monitoring is not active yet.');});
  }
}
document.querySelectorAll('[data-view]').forEach(el=>el.addEventListener('click',()=>render(el.dataset.view)));
window.addEventListener('hashchange',()=>render(location.hash.slice(1)));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.querySelector('#view').hidden)render('overview')});
document.querySelector('#zoom-scene').addEventListener('click',e=>{const v=document.querySelector('.dashboard-bg').classList.toggle('zoomed');e.currentTarget.setAttribute('aria-pressed',String(v));e.currentTarget.setAttribute('aria-label',v?'Reset scene zoom':'Zoom scene')});
document.querySelector('#tint-scene').addEventListener('click',e=>{const v=document.querySelector('.dashboard-bg').classList.toggle('contrast');e.currentTarget.setAttribute('aria-pressed',String(v))});
const video=document.querySelector('#dash-video');const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;if(reduced){video.pause();video.removeAttribute('autoplay')}document.addEventListener('visibilitychange',()=>{if(document.hidden)video.pause();else if(!reduced)video.play().catch(()=>{})});render(location.hash.slice(1));
