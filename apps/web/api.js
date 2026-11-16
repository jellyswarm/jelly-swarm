// Thin client for the JellySwarm REST API (apps/api). No build step: loaded as a plain script.
const API_URL_KEY = 'jellyswarm-api-url-v1';
const ACCESS_KEY_KEY = 'jellyswarm-access-key-v1';

function apiUrl() {
  try { return localStorage.getItem(API_URL_KEY) || window.JELLY_API_URL || 'http://localhost:3000'; }
  catch { return window.JELLY_API_URL || 'http://localhost:3000'; }
}
function setApiUrl(url) { try { localStorage.setItem(API_URL_KEY, url); } catch {} }
function accessKey() { try { return localStorage.getItem(ACCESS_KEY_KEY) || ''; } catch { return ''; } }
function setAccessKey(key) { try { localStorage.setItem(ACCESS_KEY_KEY, key); } catch {} }

class ApiError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

async function request(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  const key = accessKey();
  if (key && !headers.authorization) headers.authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(apiUrl() + path, { ...opts, headers });
  } catch {
    throw new ApiError('Could not reach the JellySwarm service. Is it running?', 'unreachable', 0);
  }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* not JSON (e.g. an SSE or empty body) */ } }
  if (!res.ok) throw new ApiError((data && data.message) || res.statusText, data && data.error, res.status);
  return data;
}

/** A syntactically valid throwaway address, for the wallet route's `payer` field when no wallet is connected. */
function randomAddress() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return '0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const JellyApi = {
  apiUrl, setApiUrl, accessKey, setAccessKey, randomAddress, ApiError,

  /** True if the service answers at all; used for the "connected" indicator, not as an auth check. */
  async health() {
    try { await request('/stats'); return true; } catch { return false; }
  },

  quote(input) { return request('/v1/quotes', { method: 'POST', body: JSON.stringify(input) }); },
  run(quoteId, payer) { return request('/v1/jobs', { method: 'POST', body: JSON.stringify({ quoteId, route: 'wallet', payer }) }); },
  confirm(jobKey) { return request(`/v1/jobs/${jobKey}/confirm`, { method: 'POST' }); },
  /** Dev-only: stands in for a real wallet signature while escrow is MemoryEscrow. The service refuses this once a real chain is wired in. */
  devFund(jobKey) { return request(`/v1/jobs/${jobKey}/dev-fund`, { method: 'POST' }); },
  status(jobKey, sinceSeq) { return request(`/v1/jobs/${jobKey}${sinceSeq ? `?sinceSeq=${sinceSeq}` : ''}`); },
  list() { return request('/v1/jobs'); },
  result(jobKey, format) { return request(`/v1/jobs/${jobKey}/result?format=${format || 'json'}`); },
  transcript(jobKey, rowIdx) { return request(`/v1/jobs/${jobKey}/transcript${rowIdx !== undefined ? `?row=${rowIdx}` : ''}`); },

  /** Picket watch: saved for real on the service, but nothing monitors it yet — there is no watch engine. */
  async createWatch(target, condition) {
    const result = await request('/v1/watches', { method: 'POST', body: JSON.stringify({ target, condition }) });
    if (result.accessKey) setAccessKey(result.accessKey);
    return result.watch;
  },
  listWatches() { return request('/v1/watches').then((r) => r.watches); },
  deleteWatch(id) { return request(`/v1/watches/${id}`, { method: 'DELETE' }); },

  /** Live progress via SSE, with Last-Event-ID resume built in by the browser's EventSource. EventSource can't set headers, so the key travels as a query param. */
  subscribe(jobKey, onEvent) {
    const key = accessKey();
    const es = new EventSource(`${apiUrl()}/v1/jobs/${jobKey}/events${key ? `?key=${encodeURIComponent(key)}` : ''}`);
    const types = ['eta', 'cost', 'job.quoted', 'job.funded', 'job.merged', 'job.sealed', 'job.settled', 'job.failed', 'tile', 'tiles.batch', 'wave.started'];
    for (const type of types) es.addEventListener(type, (e) => onEvent(type, e.data ? JSON.parse(e.data) : null));
    return () => es.close();
  },
};

window.JellyApi = JellyApi;
