// Thin client for the JellySwarm REST API (apps/api). No build step: loaded as a plain script.
const API_URL_KEY = 'jellyswarm-api-url-v1';
const ACCESS_KEY_KEY = 'jellyswarm-access-key-v1';

/**
 * Every call goes to `/api` on this same site. serve.ts makes the real call to the API
 * server-side, so the browser never makes a cross-origin request and never hits CORS.
 */
function apiUrl() { return '/api'; }
// An absolute API URL saved by an older build would bypass the proxy and bring CORS back.
try { localStorage.removeItem(API_URL_KEY); } catch {}
function setApiUrl() {}
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
function randomNonce32() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return '0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64uToBuf(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}
function bufToB64u(buf) {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The wallet picked in the dashboard's Connect wallet button (wallet.js); opens the picker if none is connected. */
async function connectedWallet() {
  if (!window.JellyWallet) throw new ApiError('Wallet support did not load. Reload the page.', 'no_wallet', 0);
  try {
    const { provider, address } = await window.JellyWallet.require();
    if (!provider || !address) throw new Error();
    return { provider, address };
  } catch {
    throw new ApiError('Connect a wallet first.', 'no_wallet', 0);
  }
}

/**
 * x402: calls `path`, and if the service answers 402, asks the browser's own wallet
 * (the connected wallet) to sign an EIP-3009 transferWithAuthorization for exactly what
 * the 402 response asked for, then retries once with the signed `X-Payment` header.
 * This moves real funds on a real chain once the service has one wired in — it never
 * happens without the wallet's own on-screen approval.
 */
async function payX402(path, requestBody, fixedHeaders) {
  const key = accessKey();
  const headers = { 'content-type': 'application/json', ...(fixedHeaders || {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  const send = (extraHeaders) => fetch(apiUrl() + path, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(requestBody) });
  const parse = async (res) => {
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError((data && data.message) || res.statusText, data && data.error, res.status);
    return data;
  };
  let res;
  try { res = await send(); } catch { throw new ApiError('Could not reach the JellySwarm service. Is it running?', 'unreachable', 0); }
  if (res.status !== 402) return parse(res);

  const required = await res.json();
  const req = required.accepts && required.accepts[0];
  if (!req) throw new ApiError('The service did not say what payment it needs.', 'invalid', 402);
  const { provider, address: from } = await connectedWallet();
  const nowSec = Math.floor(Date.now() / 1000);
  const authorization = {
    from, to: req.payTo, value: req.maxAmountRequired,
    validAfter: String(nowSec - 60), validBefore: String(nowSec + req.maxTimeoutSeconds), nonce: randomNonce32(),
  };
  const chainId = Number(String(req.network).split(':')[1]);
  const typedData = {
    domain: { name: req.extra.name, version: req.extra.version, chainId, verifyingContract: req.asset },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  };
  const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [from, JSON.stringify(typedData)] });
  const payment = { x402Version: 1, scheme: 'exact', network: req.network, payload: { signature, authorization } };
  const paymentHeader = btoa(JSON.stringify(payment));
  let res2;
  try { res2 = await send({ 'x-payment': paymentHeader }); } catch { throw new ApiError('Could not reach the JellySwarm service. Is it running?', 'unreachable', 0); }
  return parse(res2);
}

const JellyApi = {
  apiUrl, setApiUrl, accessKey, setAccessKey, randomAddress, ApiError,

  /** True if the service answers at all; used for the "connected" indicator, not as an auth check. */
  async health() {
    try { const res = await fetch('/api/health'); return res.ok; } catch { return false; }
  },
  /** Public volume/refund/burn meter — no auth, same data anyone sees at GET /stats. */
  stats(days) { return request(`/stats${days ? `?days=${days}` : ''}`); },

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

  /** Returns the on-chain call (RowSplit.disputeRows args) the client's own wallet would need to send; nothing here submits it. */
  dispute(jobKey, rowIdx, evidence) { return request(`/v1/jobs/${jobKey}/disputes`, { method: 'POST', body: JSON.stringify({ rowIdx, evidence: evidence || '' }) }); },

  createShare(jobKey, visibility) { return request(`/v1/jobs/${jobKey}/shares`, { method: 'POST', body: JSON.stringify({ visibility }) }); },
  getShare(slug) { return request(`/v1/shares/${slug}`); },
  setShareVisibility(slug, visibility) { return request(`/v1/shares/${slug}/visibility`, { method: 'POST', body: JSON.stringify({ visibility }) }); },
  rerunShare(slug) { return request(`/v1/shares/${slug}/rerun`, { method: 'POST' }); },

  referralCode() { return request('/v1/account/referral-code').then((r) => r.code); },
  async registerReferral(refCode) {
    const result = await request('/v1/account/referrals', { method: 'POST', body: JSON.stringify({ refCode }) });
    if (result.accessKey) setAccessKey(result.accessKey);
    return result;
  },
  creditBalance() { return request('/v1/account/credits').then((r) => r.balanceUsd); },

  /** Buys a wallet-bound API key and tops up its prepaid balance (min $5), paid for over x402 by the browser's own wallet. */
  topUpKey(owner, amountUsd) { return payX402('/v1/x402/keys', { owner, amountUsd }); },
  /** Runs a quoted job, paid for over x402 by the browser's own wallet instead of the dev-fund stand-in. */
  runWithX402(quoteId, payer) { return payX402('/v1/x402/jobs', { quoteId }, { 'x-jelly-payer': payer }); },

  /**
   * Sign-in (passkey, email link, external wallet). Every path ends in a session id, stored in
   * the same slot as an access key — Authorization: Bearer accepts either, so the rest of this
   * client needs no changes. Signing in replaces whatever key/session was stored before: an
   * anonymous key's jobs stay under that key, not under the newly signed-in identity.
   */
  async registerPasskey(displayName) {
    if (!window.PublicKeyCredential) throw new ApiError('This browser does not support passkeys.', 'no_webauthn', 0);
    const { challenge } = await request('/v1/auth/passkey/register/begin', { method: 'POST' });
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: b64uToBuf(challenge),
        rp: { name: 'JellySwarm' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: displayName || 'jellyswarm-user', displayName: displayName || 'JellySwarm user' },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        timeout: 60000,
      },
    });
    const response = {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        attestationObject: bufToB64u(cred.response.attestationObject),
        ...(cred.response.getTransports ? { transports: cred.response.getTransports() } : {}),
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
    const result = await request('/v1/auth/passkey/register/complete', { method: 'POST', body: JSON.stringify({ challenge, response }) });
    if (result.sessionId) setAccessKey(result.sessionId);
    return result;
  },
  async loginPasskey() {
    if (!window.PublicKeyCredential) throw new ApiError('This browser does not support passkeys.', 'no_webauthn', 0);
    const { challenge } = await request('/v1/auth/passkey/login/begin', { method: 'POST' });
    const cred = await navigator.credentials.get({ publicKey: { challenge: b64uToBuf(challenge), userVerification: 'preferred', timeout: 60000 } });
    const response = {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        authenticatorData: bufToB64u(cred.response.authenticatorData),
        signature: bufToB64u(cred.response.signature),
        ...(cred.response.userHandle ? { userHandle: bufToB64u(cred.response.userHandle) } : {}),
      },
    };
    const result = await request('/v1/auth/passkey/login/complete', { method: 'POST', body: JSON.stringify({ challenge, credentialId: cred.id, response }) });
    if (result.sessionId) setAccessKey(result.sessionId);
    return result;
  },

  /** Signs in with the wallet connected in the dashboard: sign-this-message, not a transaction — moves no funds. */
  async loginWithWallet(chain) {
    const { provider, address } = await connectedWallet();
    const challenge = await request('/v1/auth/siwe/challenge', { method: 'POST', body: JSON.stringify({ address, chain: chain || 'eip155:8453' }) });
    const signature = await provider.request({ method: 'personal_sign', params: [challenge.message, address] });
    const result = await request('/v1/auth/siwe/verify', { method: 'POST', body: JSON.stringify({ address, message: challenge.message, signature, nonce: challenge.nonce }) });
    if (result.sessionId) setAccessKey(result.sessionId);
    return result;
  },

  /** Dev-only: no mailer is wired in, so the service returns the link token directly instead of emailing it. */
  requestEmailLink(email) { return request('/v1/auth/email/request', { method: 'POST', body: JSON.stringify({ email }) }); },
  async verifyEmailLink(token) {
    const result = await request('/v1/auth/email/verify', { method: 'POST', body: JSON.stringify({ token }) });
    if (result.sessionId) setAccessKey(result.sessionId);
    return result;
  },

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
