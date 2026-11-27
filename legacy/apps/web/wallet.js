// Wallet connect for the dashboard. No build step: a plain script, like api.js.
// Finds every injected EVM wallet through EIP-6963 (MetaMask, Rabby, Coinbase, Phantom,
// Brave…), falls back to window.ethereum, lets the person pick one, and keeps it on Base.
// It only reads the address and asks the wallet to switch network. It never sends a
// transaction itself: payments and sign-ins still go through the wallet's own approval screen.
(function () {
  const LAST_WALLET_KEY = 'jellyswarm-wallet-v1';
  const BASE = {
    chainId: '0x2105',
    chainName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org'],
  };

  const discovered = new Map(); // rdns -> { info, provider }
  const listeners = new Set();
  const state = { address: null, chainId: null, provider: null, info: null };

  function remember(rdns) { try { rdns ? localStorage.setItem(LAST_WALLET_KEY, rdns) : localStorage.removeItem(LAST_WALLET_KEY); } catch {} }
  function remembered() { try { return localStorage.getItem(LAST_WALLET_KEY); } catch { return null; } }
  function emit() { for (const fn of listeners) { try { fn({ ...state }); } catch {} } }
  function short(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''; }

  window.addEventListener('eip6963:announceProvider', (event) => {
    const { info, provider } = event.detail || {};
    if (info && info.rdns && provider) discovered.set(info.rdns, { info, provider });
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  function wallets() {
    const list = [...discovered.values()];
    // Older wallets that don't announce themselves still inject window.ethereum.
    if (!list.length && window.ethereum) {
      list.push({ info: { rdns: 'injected', name: window.ethereum.isMetaMask ? 'MetaMask' : 'Browser wallet', icon: '' }, provider: window.ethereum });
    }
    return list;
  }

  function onAccounts(accounts) {
    state.address = accounts && accounts[0] ? accounts[0] : null;
    if (!state.address) { detach(); remember(null); }
    emit();
  }
  function onChain(chainId) { state.chainId = chainId; emit(); }

  function attach(entry) {
    detach();
    state.provider = entry.provider;
    state.info = entry.info;
    entry.provider.on?.('accountsChanged', onAccounts);
    entry.provider.on?.('chainChanged', onChain);
  }
  function detach() {
    if (state.provider) {
      state.provider.removeListener?.('accountsChanged', onAccounts);
      state.provider.removeListener?.('chainChanged', onChain);
    }
    state.provider = null; state.info = null; state.address = null; state.chainId = null;
  }

  async function ensureBase(provider) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE.chainId }] });
    } catch (e) {
      if (e && (e.code === 4902 || e?.data?.originalError?.code === 4902)) {
        await provider.request({ method: 'wallet_addEthereumChain', params: [BASE] });
      } else if (e && e.code !== 4001) {
        throw e;
      }
    }
  }

  async function connectWith(entry) {
    attach(entry);
    try {
      const accounts = await entry.provider.request({ method: 'eth_requestAccounts' });
      state.chainId = await entry.provider.request({ method: 'eth_chainId' }).catch(() => null);
      remember(entry.info.rdns);
      onAccounts(accounts);
      if (state.address && state.chainId !== BASE.chainId) {
        await ensureBase(entry.provider).catch(() => {});
        state.chainId = await entry.provider.request({ method: 'eth_chainId' }).catch(() => state.chainId);
        emit();
      }
      return state.address;
    } catch (e) {
      detach(); emit();
      throw e;
    }
  }

  /** Silent reconnect on page load: only if the wallet already trusts this site. Never opens a prompt. */
  async function restore() {
    const rdns = remembered();
    if (!rdns) return;
    // Give EIP-6963 wallets a moment to announce.
    await new Promise((r) => setTimeout(r, 150));
    const entry = wallets().find((w) => w.info.rdns === rdns);
    if (!entry) return;
    try {
      const accounts = await entry.provider.request({ method: 'eth_accounts' });
      if (!accounts || !accounts.length) { remember(null); return; }
      attach(entry);
      state.chainId = await entry.provider.request({ method: 'eth_chainId' }).catch(() => null);
      onAccounts(accounts);
    } catch {}
  }

  function disconnect() {
    // Injected wallets have no standard "disconnect"; revoke where supported, then forget locally.
    state.provider?.request?.({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => {});
    detach(); remember(null); emit();
  }

  // ───────────── picker dialog ─────────────
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    for (const c of children) if (c) node.append(c);
    return node;
  }

  function openPicker() {
    return new Promise((resolve, reject) => {
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      const dialog = el('dialog', { className: 'wallet-dialog' });
      dialog.setAttribute('aria-labelledby', 'wallet-dialog-title');
      const close = el('button', { type: 'button', className: 'drawer-close', textContent: '×' });
      close.setAttribute('aria-label', 'Close');
      const status = el('p', { className: 'wallet-status' });
      status.setAttribute('role', 'status');
      const list = el('div', { className: 'wallet-list' });
      dialog.append(
        el('div', { className: 'wallet-head' }, el('h3', { id: 'wallet-dialog-title', textContent: 'Connect a wallet' }), close),
        el('p', { className: 'wallet-sub', textContent: 'Pick the wallet in this browser. JellySwarm reads your address and asks for Base. Nothing is paid or signed until you approve it in your wallet.' }),
        list, status,
      );

      const found = wallets();
      if (!found.length) {
        list.append(el('div', { className: 'wallet-empty' },
          el('strong', { textContent: 'No wallet found in this browser.' }),
          el('span', { textContent: 'Install a browser wallet such as MetaMask, Rabby or Coinbase Wallet, then reload this page.' })));
      }
      for (const entry of found) {
        const icon = el('span', { className: 'wallet-icon' });
        if (entry.info.icon && /^data:image\//.test(entry.info.icon)) icon.append(el('img', { src: entry.info.icon, alt: '' }));
        else icon.textContent = (entry.info.name || '?').slice(0, 1);
        const btn = el('button', { type: 'button', className: 'wallet-option' }, icon, el('span', { textContent: entry.info.name || 'Wallet' }), el('i', { textContent: '→' }));
        btn.addEventListener('click', async () => {
          list.querySelectorAll('button').forEach((b) => (b.disabled = true));
          btn.classList.add('is-busy');
          status.textContent = `Approve the request in ${entry.info.name || 'your wallet'}…`;
          try {
            const address = await connectWith(entry);
            dialog.close();
            resolve(address);
          } catch (e) {
            status.textContent = e && e.code === 4001 ? 'Request declined in the wallet.' : (e && e.message) || 'The wallet could not connect.';
            list.querySelectorAll('button').forEach((b) => (b.disabled = false));
            btn.classList.remove('is-busy');
          }
        });
        list.append(btn);
      }

      close.addEventListener('click', () => dialog.close());
      dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
      dialog.addEventListener('close', () => { dialog.remove(); if (!state.address) reject(Object.assign(new Error('No wallet connected.'), { code: 'no_wallet' })); });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  // ───────────── nav button ─────────────
  function mountButton(container) {
    if (!container) return;
    const btn = el('button', { type: 'button', className: 'wallet-button' });
    const menu = el('div', { className: 'wallet-menu', hidden: true });
    const copy = el('button', { type: 'button', textContent: 'Copy address' });
    const switchNet = el('button', { type: 'button', textContent: 'Switch to Base' });
    const off = el('button', { type: 'button', textContent: 'Disconnect' });
    menu.append(copy, switchNet, off);
    const wrap = el('div', { className: 'wallet-wrap' }, btn, menu);
    container.append(wrap);

    const paint = () => {
      const wrongChain = state.address && state.chainId && state.chainId !== BASE.chainId;
      btn.classList.toggle('is-connected', !!state.address);
      btn.classList.toggle('is-wrong-chain', !!wrongChain);
      btn.textContent = state.address ? (wrongChain ? `${short(state.address)} · not Base` : short(state.address)) : 'Connect wallet';
      btn.setAttribute('aria-label', state.address ? `Wallet ${state.address}${wrongChain ? ', not on Base' : ''}. Open wallet menu` : 'Connect wallet');
      btn.setAttribute('aria-expanded', String(!menu.hidden));
      switchNet.hidden = !wrongChain;
      if (!state.address) menu.hidden = true;
    };
    btn.addEventListener('click', () => {
      if (!state.address) { openPicker().catch(() => {}); return; }
      menu.hidden = !menu.hidden; paint();
    });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(state.address); copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy address'), 1200); } catch {}
    });
    switchNet.addEventListener('click', () => { if (state.provider) ensureBase(state.provider).catch(() => {}); menu.hidden = true; paint(); });
    off.addEventListener('click', () => { menu.hidden = true; disconnect(); });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target) && !menu.hidden) { menu.hidden = true; paint(); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { menu.hidden = true; paint(); btn.focus(); } });
    listeners.add(paint);
    paint();
  }

  window.JellyWallet = {
    get address() { return state.address; },
    get provider() { return state.provider; },
    get chainId() { return state.chainId; },
    isBase() { return state.chainId === BASE.chainId; },
    short,
    /** Returns the connected provider, opening the picker first if nothing is connected yet. */
    async require() {
      if (!state.address) await openPicker();
      return { provider: state.provider, address: state.address };
    },
    connect: openPicker,
    disconnect,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    mountButton,
  };

  restore();
})();
