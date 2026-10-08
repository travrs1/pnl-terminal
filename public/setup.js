// "Accounts & keys" popup: add accounts, paste API keys / wallet addresses, test each
// connection, save. Keys go to .env on this machine; the server only ever tells the
// browser whether a key is set, never what it is.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const money = (n) => (n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);
export const api = (path, opts = {}) => fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-pnl': '1', ...(opts.headers || {}) } });

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BTC_RE = /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/;

const EVM_CHAINS = [
  ['eth', 'Ethereum'], ['base', 'Base'], ['arbitrum', 'Arbitrum'], ['optimism', 'Optimism'], ['polygon', 'Polygon'],
  ['bsc', 'BNB Chain'], ['robinhood', 'Robinhood Chain'],
];
const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text} ↗</a>`;

// Everything the popup knows about each account type.
const TYPES = {
  coinbase: {
    label: 'Coinbase', icon: 'CB', blurb: 'Spot, perps and futures, through a view-only API key.', one: true,
    secrets: [
      { k: 'COINBASE_KEY_NAME', label: 'API key name or ID', ph: 'organizations/…/apiKeys/…  or  a key ID' },
      { k: 'COINBASE_KEY_SECRET', label: 'Private key', ph: '-----BEGIN EC PRIVATE KEY-----…  or the base64 secret', area: true },
    ],
    keyFile: true,
    fields: [{ k: 'excludeCash', t: 'check', label: 'Leave Coinbase USD / USDC out of the portfolio', help: 'Turn this on if that cash is spending money (e.g. for the Coinbase Card) rather than trading money.' }],
    steps: [
      `Open ${link('https://portal.cdp.coinbase.com/projects/api-keys', 'Coinbase Developer Platform → API keys')} and sign in with your normal Coinbase login.`,
      'Click <b>Create API key</b>. Under permissions tick <b>View</b> only. Leave Trade and Transfer off.',
      'Download the key file (<code>cdp_api_key.json</code>) and drop it below, or paste the two values in.',
    ],
  },
  strike: {
    label: 'Strike', icon: 'ST', blurb: 'Bitcoin and USD balances.', one: true,
    secrets: [{ k: 'STRIKE_API_KEY', label: 'API key', ph: 'Paste your Strike API key' }],
    steps: [
      `Open the ${link('https://dashboard.strike.me', 'Strike dashboard')} and go to <b>API keys</b>.`,
      'Create a key and give it <b>only</b> the scope that reads balances.',
      'Paste it below. Strike\'s API has no trade history; you can import a CSV export later in Settings.',
    ],
  },
  hyperliquid: {
    label: 'Hyperliquid', icon: 'HL', blurb: 'Perps and spot. Only needs your wallet address.',
    fields: [
      { k: 'address', label: 'Wallet address', ph: '0x…', req: true, check: (v) => EVM_RE.test(v) || 'Enter a 0x… address (42 characters)' },
      { k: 'leverage', t: 'num', label: 'Leverage you trade at', ph: '1', help: 'Closed-trade % is measured on margin (notional ÷ leverage). Leave blank for 1x.', check: (v) => Number(v) >= 1 || 'Leverage must be 1 or more' },
    ],
    steps: [
      'Copy the address of the wallet you trade with on Hyperliquid (the <code>0x…</code> address in MetaMask, Rabby, etc.).',
      'Paste it below. No key needed, because Hyperliquid account data is public.',
    ],
  },
  wallet: {
    label: 'Crypto wallet', icon: 'W', blurb: 'Self-custody wallets on Ethereum and other EVM chains, Solana, or Bitcoin. Addresses only.',
    fields: [
      { k: 'evm', t: 'lines', label: 'EVM addresses (one per line)', ph: '0x…', check: (v) => v.every((x) => EVM_RE.test(x)) || 'Each line must be a 0x… address' },
      { k: 'chains', t: 'chains', label: 'Chains to check for those addresses' },
      { k: 'solana', t: 'lines', label: 'Solana addresses (one per line)', ph: 'e.g. 7xKX…', check: (v) => v.every((x) => SOL_RE.test(x)) || 'One of these doesn\'t look like a Solana address' },
      { k: 'bitcoin', t: 'lines', label: 'Bitcoin addresses (one per line)', ph: 'bc1…', check: (v) => v.every((x) => BTC_RE.test(x)) || 'One of these doesn\'t look like a Bitcoin address' },
      { k: 'tokens', t: 'tokens', label: 'Extra tokens (BNB Chain and Robinhood Chain only)', help: 'These two chains have no free way to discover tokens, so list the contracts you hold there. Other chains are found automatically.' },
    ],
    secrets: [{ k: 'SOLANA_RPC_URL', label: 'Solana RPC URL (optional, shared by all wallets)', ph: 'https://mainnet.helius-rpc.com/?api-key=…', optional: true }],
    secretsLast: true,
    steps: [
      'Paste the <b>public</b> address of each wallet. Never paste a seed phrase or private key. Nothing here needs one.',
      `Solana works without setup, but the public endpoint is rate-limited. A free ${link('https://dashboard.helius.dev', 'Helius')} key makes it faster and more reliable.`,
    ],
    need: (a) => (a.evm?.length || a.solana?.length || a.bitcoin?.length) ? '' : 'Add at least one address',
  },
  schwab: {
    label: 'Charles Schwab', icon: 'CS', blurb: 'Stocks and options via the Schwab Trader API, or type your holdings in.', one: true,
    secrets: [
      { k: 'SCHWAB_APP_KEY', label: 'App key', ph: 'From your app on developer.schwab.com', optional: true },
      { k: 'SCHWAB_APP_SECRET', label: 'App secret', ph: '', optional: true },
      { k: 'SCHWAB_CALLBACK_URL', label: 'Callback URL', ph: 'https://127.0.0.1', optional: true },
    ],
    fields: [
      { k: 'holdings', t: 'holdings', label: 'Manual holdings (used until the API is connected)' },
      { k: 'cash', t: 'num', label: 'Cash (USD)', ph: '0' },
    ],
    steps: [
      `Register at ${link('https://developer.schwab.com', 'developer.schwab.com')} and request <b>Trader API – Individual</b> access.`,
      'Create an app with the product <b>Accounts and Trading Production</b> and the callback URL <code>https://127.0.0.1</code>. Approval can take a few days, until the app shows "Ready For Use".',
      'Paste the app key and secret, save, then finish the Schwab login under <b>Settings → Schwab API</b>. Until then, type your holdings below.',
    ],
    need: (a) => (['saved', 'new'].includes(secretState('SCHWAB_APP_KEY')) || a.holdings?.length || a.cash) ? '' : 'Add the app key, or some manual holdings to use until the API is approved',
  },
  manual: {
    label: 'Manual holdings', icon: '✎', blurb: 'Any broker without an API. Type what you hold and it\'s priced live.',
    fields: [
      { k: 'holdings', t: 'holdings', label: 'Holdings' },
      { k: 'cash', t: 'num', label: 'Cash (USD)', ph: '0' },
    ],
    steps: ['Add each position: ticker, quantity and (optionally) your average cost so open PnL can be shown. Stocks and ETFs use Yahoo quotes; crypto uses Coinbase prices.'],
    need: (a) => (a.holdings?.length || a.cash) ? '' : 'Add at least one holding or some cash',
  },
};

let D = null;          // server response: { config, secrets, localTz, demo, firstRun }
let draft = null;      // editable copy of accounts.json
let sec = {};          // unsaved secret edits (null = remove)
let sel = { view: 'welcome' };
let tests = {};        // per-account test results, keyed by draft index
let dirty = false;
let touched = new WeakSet(); // accounts the user has typed into (errors show only after that)
let lastView = '';
let getState = () => null;
let onSaved = () => {};

export function initSetup(opts) {
  ({ getState, onSaved } = opts);
  $('setup').addEventListener('click', onClick);
  $('setup').addEventListener('input', onInput);
  $('setup').addEventListener('change', onInput);
  $('setup').addEventListener('cancel', (e) => { e.preventDefault(); close(); });
}

export async function openSetup(view) {
  D = await fetch('/api/setup').then((r) => r.json());
  draft = structuredClone(D.config);
  draft.accounts ??= [];
  sec = {}; tests = {}; dirty = false;
  sel = view === 'add' ? { view: 'pick' } : draft.accounts.length ? { view: 'acct', i: 0 } : { view: 'welcome' };
  render();
  if (!$('setup').open) $('setup').showModal();
}

function close() {
  if (dirty && !confirm('Close without saving your changes?')) return;
  $('setup').close();
}

// ---------- rendering ----------
function render() {
  $('setupList').innerHTML = renderList();
  $('setupPane').innerHTML = renderPane();
  const view = `${sel.view}:${sel.i ?? ''}`;
  if (view !== lastView) { $('setupPane').scrollTop = 0; lastView = view; }
  $('setupFoot').innerHTML = renderFoot();
}

function liveStatus(a) {
  const s = getState()?.accounts?.find((x) => x.id === a.id);
  if (!s) return { cls: 'off', text: 'not saved yet' };
  if (s.status === 'ok') return { cls: '', text: money(s.value) };
  if (s.status === 'setup') return { cls: 'off', text: 'needs keys' };
  if (s.status === 'error') return { cls: 'err', text: 'error' };
  return { cls: 'stale', text: 'connecting…' };
}

function renderList() {
  const items = draft.accounts.map((a, i) => {
    const st = liveStatus(a);
    const bad = problems(a, i).length;
    return `<button class="s-item ${sel.view === 'acct' && sel.i === i ? 'on' : ''}" data-act="select" data-i="${i}">
      <span class="s-icon">${esc(TYPES[a.type]?.icon ?? '?')}</span>
      <span class="s-item-main"><b>${esc(a.name || TYPES[a.type]?.label)}</b><span class="muted">${bad ? '<span class="p">needs info</span>' : `<span class="dot ${st.cls}"></span>${esc(st.text)}`}</span></span>
    </button>`;
  }).join('');
  return `<div class="s-list-head">Your accounts</div>
    ${items || '<div class="s-empty">None yet</div>'}
    <button class="s-add ${sel.view === 'pick' ? 'on' : ''}" data-act="pick">+ Add account</button>
    <div class="s-list-head" style="margin-top:22px">Preferences</div>
    <button class="s-item ${sel.view === 'general' ? 'on' : ''}" data-act="general"><span class="s-icon">⚙</span><span class="s-item-main"><b>General</b><span class="muted">time zone, history start</span></span></button>`;
}

function renderPane() {
  if (sel.view === 'welcome') return renderWelcome();
  if (sel.view === 'pick') return renderPicker();
  if (sel.view === 'general') return renderGeneral();
  if (sel.view === 'done') return renderDone();
  return renderAccount(sel.i);
}

function renderWelcome() {
  return `<div class="s-welcome">
    <h2>Track your PnL across every account</h2>
    <p>Connect exchanges, brokers and wallets with <b>read-only</b> keys or plain wallet addresses. This takes a couple of minutes per account.</p>
    <ul class="s-points">
      <li><b>Everything stays on this computer.</b> Keys are saved to a <code>.env</code> file next to the app and only ever sent to the venue they belong to.</li>
      <li><b>Read-only is enough.</b> Never give a key trade or withdraw permission, and never paste a seed phrase.</li>
      <li>You can add, edit or remove accounts anytime from <b>Accounts &amp; keys</b> at the top of the page.</li>
    </ul>
    <button class="btn" data-act="pick">Add your first account →</button>
    <p class="fine">Just looking? Stop the server and run <code>npm run demo</code> to explore with fake data.</p>
  </div>`;
}

function renderPicker() {
  const used = new Set(draft.accounts.map((a) => a.type));
  return `<h2>Add an account</h2><p class="muted">Pick where the money is. You can add several wallets and Hyperliquid addresses.</p>
    <div class="s-types">${Object.entries(TYPES).map(([t, d]) => {
      const off = d.one && used.has(t);
      return `<button class="s-type" data-act="add" data-type="${t}" ${off ? 'disabled' : ''}>
        <span class="s-icon lg">${esc(d.icon)}</span><b>${esc(d.label)}</b><span>${off ? 'Already added' : esc(d.blurb)}</span></button>`;
    }).join('')}</div>`;
}

function renderGeneral() {
  const tzs = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [draft.timezone || D.localTz];
  const tz = draft.timezone || D.localTz;
  const basis = Object.entries(draft.costBasis ?? {});
  return `<h2>General</h2>
    <div class="s-form">
      <label class="s-field"><span>Time zone <em>your trading day rolls over at midnight here</em></span>
        <select data-g="timezone">${tzs.map((z) => `<option ${z === tz ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
      <label class="s-field"><span>History starts <em>streaks, win rate and the calendar count from this day</em></span>
        <input type="date" data-g="historyStart" value="${esc((draft.historyStart || `${new Date().getFullYear()}-01-01`).slice(0, 10))}"></label>
      <div class="s-field"><span>Cost basis overrides <em>optional: average price for an asset when a venue doesn't know it (e.g. BTC bought elsewhere and sent in)</em></span>
        <div class="s-rows">${basis.map(([sym, p], i) => `<div class="s-row">
            <input placeholder="BTC" value="${esc(sym)}" data-basis="${i}" data-c="sym">
            <input type="number" step="any" placeholder="avg price" value="${esc(p)}" data-basis="${i}" data-c="price">
            <button class="x" data-act="delbasis" data-i="${i}" title="Remove">✕</button></div>`).join('')}
          <button class="btn ghost sm" data-act="addbasis">+ Add override</button></div></div>
    </div>`;
}

function renderDone() {
  return `<div class="s-welcome">
    <h2>Saved ✓ — live tracking has started</h2>
    <p>Your accounts are connecting now. Balances show up within a minute and PnL starts accruing from today.</p>
    <p><b>Want your past trades too?</b> The backfill pulls trade history from Coinbase, your wallets and Hyperliquid. That fills in win rate and realized PnL, and lets you rebuild earlier days. It runs in the background and can take a few minutes.</p>
    <div class="job-btns"><button class="btn" data-act="backfill">Import past trades</button><button class="btn ghost" data-act="close">Go to dashboard</button></div>
  </div>`;
}

function renderAccount(i) {
  const a = draft.accounts[i];
  const T = TYPES[a.type];
  const errs = problems(a, i);
  const t = tests[i];
  return `<div class="row-between"><h2>${esc(T.label)}</h2><button class="s-remove" data-act="remove" data-i="${i}">Remove account</button></div>
    <ol class="s-steps">${T.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
    <div class="s-form">
      <label class="s-field"><span>Display name</span><input data-f="name" value="${esc(a.name)}" placeholder="${esc(T.label)}"></label>
      ${T.keyFile ? `<label class="s-drop"><input type="file" accept=".json,application/json" data-act-file="keyfile"><b>Drop or choose cdp_api_key.json</b><span>fills both fields below</span></label>` : ''}
      ${T.secretsLast ? '' : (T.secrets ?? []).map(renderSecret).join('')}
      ${(T.fields ?? []).map((f) => renderField(a, f)).join('')}
      ${T.secretsLast ? (T.secrets ?? []).map(renderSecret).join('') : ''}
    </div>
    ${errs.length && touched.has(a) ? `<div class="s-errs">${errs.map((e) => `<div>• ${esc(e)}</div>`).join('')}</div>` : ''}
    <div class="s-test">
      <button class="btn ghost" data-act="test" data-i="${i}" ${t?.running ? 'disabled' : ''}>${t?.running ? 'Testing…' : 'Test connection'}</button>
      ${t && !t.running ? (t.ok
        ? `<span class="g">✓ Connected: ${money(t.value)} across ${t.positions} position${t.positions === 1 ? '' : 's'}${t.top?.length ? ` (${esc(t.top.join(', '))})` : ''}</span>`
        : `<span class="p">✕ ${esc(t.error)}</span>`) : ''}
    </div>`;
}

function secretState(k) {
  if (sec[k] === null) return 'removed';
  if (sec[k]) return 'new';
  return D.secrets[k] ? 'saved' : 'empty';
}

function renderSecret(s) {
  const st = secretState(s.k);
  const ph = st === 'saved' ? '•••••••• saved. Paste a new value to replace it' : s.ph;
  const val = st === 'new' ? sec[s.k] : '';
  const input = s.area
    ? `<textarea data-s="${s.k}" rows="3" placeholder="${esc(ph)}" spellcheck="false" autocomplete="off">${esc(val)}</textarea>`
    : `<input data-s="${s.k}" type="password" placeholder="${esc(ph)}" value="${esc(val)}" autocomplete="off" spellcheck="false">`;
  return `<label class="s-field"><span>${esc(s.label)} ${st === 'saved' ? '<em class="g">● saved</em>' : st === 'new' ? '<em class="y">● unsaved</em>' : s.optional ? '<em>optional</em>' : ''}</span>${input}</label>`;
}

function renderField(a, f) {
  const v = a[f.k];
  const head = `<span>${esc(f.label)}${f.help ? ` <em>${esc(f.help)}</em>` : ''}</span>`;
  switch (f.t) {
    case 'check':
      return `<label class="s-check"><input type="checkbox" data-f="${f.k}" data-t="check" ${v ? 'checked' : ''}><span><b>${esc(f.label)}</b>${f.help ? `<em>${esc(f.help)}</em>` : ''}</span></label>`;
    case 'lines':
      return `<label class="s-field">${head}<textarea data-f="${f.k}" data-t="lines" rows="2" placeholder="${esc(f.ph)}" spellcheck="false">${esc((v ?? []).join('\n'))}</textarea></label>`;
    case 'num':
      return `<label class="s-field">${head}<input type="number" step="any" data-f="${f.k}" data-t="num" value="${esc(v ?? '')}" placeholder="${esc(f.ph ?? '')}"></label>`;
    case 'chains': {
      const on = new Set(v ?? ['eth', 'base']);
      return `<div class="s-field">${head}<div class="s-chips">${EVM_CHAINS.map(([c, n]) => `<label class="s-chip"><input type="checkbox" data-chain="${c}" ${on.has(c) ? 'checked' : ''}>${n}</label>`).join('')}</div></div>`;
    }
    case 'tokens':
      return `<details class="s-field" ${v?.length ? 'open' : ''}><summary>${esc(f.label)}</summary><em class="s-help">${esc(f.help)}</em>
        <div class="s-rows">${(v ?? []).map((t, i) => `<div class="s-row">
            <select data-row="tokens" data-i="${i}" data-c="chain">${[['bsc', 'BNB Chain'], ['robinhood', 'Robinhood Chain']].map(([c, n]) => `<option value="${c}" ${t.chain === c ? 'selected' : ''}>${n}</option>`).join('')}</select>
            <input placeholder="Symbol" value="${esc(t.symbol)}" data-row="tokens" data-i="${i}" data-c="symbol">
            <input placeholder="0x… token contract" value="${esc(t.address)}" data-row="tokens" data-i="${i}" data-c="address" class="wide">
            <button class="x" data-act="delrow" data-row="tokens" data-i="${i}" title="Remove">✕</button></div>`).join('')}
          <button class="btn ghost sm" data-act="addrow" data-row="tokens">+ Add token</button></div></details>`;
    case 'holdings':
      return `<div class="s-field">${head}<div class="s-rows">
          ${(v ?? []).length ? '<div class="s-row s-row-head"><span>Ticker</span><span>Quantity</span><span>Avg cost</span><span>Type</span><span></span></div>' : ''}
          ${(v ?? []).map((h, i) => `<div class="s-row">
            <input placeholder="AAPL" value="${esc(h.symbol)}" data-row="holdings" data-i="${i}" data-c="symbol">
            <input type="number" step="any" placeholder="10" value="${esc(h.qty ?? '')}" data-row="holdings" data-i="${i}" data-c="qty">
            <input type="number" step="any" placeholder="optional" value="${esc(h.avg ?? '')}" data-row="holdings" data-i="${i}" data-c="avg">
            <select data-row="holdings" data-i="${i}" data-c="kind"><option value="stock">Stock / ETF</option><option value="crypto" ${h.kind === 'crypto' ? 'selected' : ''}>Crypto</option></select>
            <button class="x" data-act="delrow" data-row="holdings" data-i="${i}" title="Remove">✕</button></div>`).join('')}
          <button class="btn ghost sm" data-act="addrow" data-row="holdings">+ Add holding</button></div></div>`;
    default:
      return `<label class="s-field">${head}<input data-f="${f.k}" value="${esc(v ?? '')}" placeholder="${esc(f.ph ?? '')}" spellcheck="false" autocomplete="off"></label>`;
  }
}

function renderFoot() {
  const n = draft.accounts.reduce((s, a, i) => s + problems(a, i).length, 0);
  return `<span class="muted small">${dirty ? (n ? `<span class="p">${n} thing${n > 1 ? 's' : ''} to fix before saving</span>` : 'Unsaved changes') : 'Keys are stored in .env on this computer only.'}</span>
    <div><button class="btn ghost" data-act="close">${dirty ? 'Cancel' : 'Close'}</button>
    <button class="btn" data-act="save" ${!dirty || n ? 'disabled' : ''}>Save &amp; start tracking</button></div>`;
}

// What's missing or malformed for an account (empty list = ready to save).
function problems(a, i) {
  const T = TYPES[a.type];
  if (!T) return [];
  const out = [];
  for (const s of T.secrets ?? []) if (!s.optional && ['empty', 'removed'].includes(secretState(s.k))) out.push(`${s.label} is required`);
  for (const f of T.fields ?? []) {
    const v = a[f.k];
    const empty = v == null || v === '' || (Array.isArray(v) && !v.length);
    if (f.req && empty) out.push(`${f.label} is required`);
    else if (!empty && f.check) { const r = f.check(v); if (r !== true) out.push(r); }
  }
  if (T.need) { const r = T.need(a); if (r) out.push(r); }
  for (const t of a.tokens ?? []) if (!EVM_RE.test(t.address ?? '')) { out.push('A token contract address isn\'t a valid 0x… address'); break; }
  for (const h of a.holdings ?? []) if (!h.symbol || !(Number(h.qty) > 0 || Number(h.qty) < 0)) { out.push('Each holding needs a ticker and a quantity'); break; }
  return out;
}

// ---------- events ----------
const cur = () => (sel.view === 'acct' ? draft.accounts[sel.i] : null);
function touch(full = false) {
  dirty = true;
  if (sel.view === 'acct') delete tests[sel.i];
  if (full) render();
  else { $('setupList').innerHTML = renderList(); $('setupFoot').innerHTML = renderFoot(); refreshErrs(); }
}
// Re-render just the error box so typing doesn't lose focus.
function refreshErrs() {
  const a = cur();
  if (!a) return;
  touched.add(a);
  const errs = problems(a, sel.i);
  let box = $('setupPane').querySelector('.s-errs');
  if (!errs.length) { box?.remove(); return; }
  if (!box) { box = document.createElement('div'); box.className = 's-errs'; $('setupPane').querySelector('.s-test').before(box); }
  box.innerHTML = errs.map((e) => `<div>• ${esc(e)}</div>`).join('');
  const t = $('setupPane').querySelector('.s-test span');
  t?.remove();
}

function onInput(e) {
  const el = e.target;
  const a = cur();
  if (el.dataset.actFile === 'keyfile' && e.type === 'change') return readKeyFile(el.files[0]);
  if (el.dataset.s) {
    sec[el.dataset.s] = el.value.trim() ? el.value : undefined;
    // Pasting the whole cdp_api_key.json into either field works too.
    if (el.dataset.s.startsWith('COINBASE') && el.value.trim().startsWith('{')) { try { fillCoinbase(JSON.parse(el.value)); return; } catch {} }
    return touch();
  }
  if (el.dataset.g) {
    draft[el.dataset.g] = el.dataset.g === 'historyStart' ? `${el.value}T00:00:00` : el.value;
    if (el.dataset.g === 'historyStart') draft.tradesFrom = draft.historyStart;
    return touch();
  }
  if (el.dataset.basis != null) {
    const rows = Object.entries(draft.costBasis ?? {});
    const i = Number(el.dataset.basis);
    if (el.dataset.c === 'sym') rows[i][0] = el.value.trim().toUpperCase();
    else rows[i][1] = el.value === '' ? '' : Number(el.value);
    draft.costBasis = Object.fromEntries(rows);
    return touch();
  }
  if (!a) return;
  if (el.dataset.f) {
    const t = el.dataset.t;
    a[el.dataset.f] = t === 'check' ? el.checked : t === 'lines' ? el.value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)
      : t === 'num' ? (el.value === '' ? null : Number(el.value)) : el.value.trim();
    return touch();
  }
  if (el.dataset.chain) {
    const on = new Set(a.chains ?? ['eth', 'base']);
    el.checked ? on.add(el.dataset.chain) : on.delete(el.dataset.chain);
    a.chains = EVM_CHAINS.map(([c]) => c).filter((c) => on.has(c));
    return touch();
  }
  if (el.dataset.row) {
    const row = a[el.dataset.row][Number(el.dataset.i)];
    const c = el.dataset.c;
    row[c] = ['qty', 'avg'].includes(c) ? (el.value === '' ? undefined : Number(el.value)) : c === 'symbol' ? el.value.trim().toUpperCase() : el.value.trim();
    return touch();
  }
}

function fillCoinbase(j) {
  const name = j.name ?? j.id;
  const key = j.privateKey ?? j.private_key;
  if (!name || !key) throw new Error('not a key file');
  sec.COINBASE_KEY_NAME = name;
  sec.COINBASE_KEY_SECRET = key;
  touch(true);
}
async function readKeyFile(file) {
  if (!file) return;
  try { fillCoinbase(JSON.parse(await file.text())); } catch { alert('That file doesn\'t look like a Coinbase API key file (cdp_api_key.json).'); }
}

async function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) { if (e.target === $('setup')) close(); return; }
  const act = b.dataset.act;
  const i = Number(b.dataset.i);
  const a = cur();
  if (act === 'close') return close();
  if (act === 'pick') { sel = { view: 'pick' }; return render(); }
  if (act === 'general') { sel = { view: 'general' }; return render(); }
  if (act === 'select') { sel = { view: 'acct', i }; return render(); }
  if (act === 'add') {
    const type = b.dataset.type;
    const acct = { type, name: TYPES[type].label };
    if (type === 'wallet') {
      const n = draft.accounts.filter((x) => x.type === 'wallet').length;
      Object.assign(acct, { name: n ? `Wallet ${n + 1}` : 'Wallet', chains: ['eth', 'base'] });
    }
    if (type === 'hyperliquid' && draft.accounts.some((x) => x.type === 'hyperliquid')) acct.name = `Hyperliquid ${draft.accounts.filter((x) => x.type === 'hyperliquid').length + 1}`;
    draft.accounts.push(acct);
    sel = { view: 'acct', i: draft.accounts.length - 1 };
    return touch(true);
  }
  if (act === 'remove') {
    const gone = draft.accounts[i];
    if (!confirm(`Remove ${gone.name}? Its past history stays in the database; it just stops being tracked.`)) return;
    draft.accounts.splice(i, 1);
    // One-per-install venues: their keys go too. (The shared Solana RPC stays.)
    if (TYPES[gone.type].one) for (const s of TYPES[gone.type].secrets ?? []) sec[s.k] = D.secrets[s.k] ? null : undefined;
    tests = {};
    sel = draft.accounts.length ? { view: 'acct', i: Math.max(0, i - 1) } : { view: 'pick' };
    return touch(true);
  }
  if (act === 'addrow') {
    const k = b.dataset.row;
    a[k] = [...(a[k] ?? []), k === 'tokens' ? { chain: 'bsc', symbol: '', address: '' } : { symbol: '', qty: undefined, kind: 'stock' }];
    return touch(true);
  }
  if (act === 'delrow') { a[b.dataset.row].splice(i, 1); return touch(true); }
  if (act === 'addbasis') { draft.costBasis = { ...(draft.costBasis ?? {}), '': '' }; return touch(true); }
  if (act === 'delbasis') { const rows = Object.entries(draft.costBasis ?? {}); rows.splice(i, 1); draft.costBasis = Object.fromEntries(rows); return touch(true); }
  if (act === 'test') return runTest(i);
  if (act === 'save') return save();
  if (act === 'backfill') {
    const r = await api('/api/jobs/backfill', { method: 'POST' });
    if (!r.ok) return alert((await r.json()).error);
    $('setup').close();
    onSaved({ goto: 'settings' });
  }
}

async function runTest(i) {
  const a = draft.accounts[i];
  touched.add(a);
  tests[i] = { running: true };
  render();
  const { accounts: _, ...settings } = draft;
  try {
    const r = await api('/api/setup/test', { method: 'POST', body: JSON.stringify({ account: cleanAccount(a), secrets: sec, settings }) });
    tests[i] = await r.json();
  } catch (err) {
    tests[i] = { ok: false, error: err.message };
  }
  if (sel.view === 'acct' && sel.i === i) render();
}

const cleanAccount = (a) => ({
  ...a,
  holdings: a.holdings?.filter((h) => h.symbol).map(({ symbol, qty, avg, kind }) => ({ symbol, qty: Number(qty), ...(avg ? { avg: Number(avg) } : {}), ...(kind === 'crypto' ? { kind } : {}) })),
  tokens: a.tokens?.filter((t) => t.address),
});

async function save() {
  const config = { ...draft, accounts: draft.accounts.map(cleanAccount) };
  config.costBasis = Object.fromEntries(Object.entries(draft.costBasis ?? {}).filter(([k, v]) => k && Number(v) > 0));
  if (!Object.keys(config.costBasis).length) delete config.costBasis;
  const btn = $('setupFoot').querySelector('[data-act=save]');
  btn.disabled = true; btn.textContent = 'Saving…';
  const r = await api('/api/setup', { method: 'POST', body: JSON.stringify({ config, secrets: sec }) });
  const body = await r.json();
  if (!r.ok) { alert(body.error); return render(); }
  D = { ...D, config: body.config, secrets: body.secrets };
  draft = structuredClone(body.config);
  sec = {}; dirty = false;
  sel = { view: 'done' };
  render();
  onSaved({});
}

// Keep the live dots in the account list current while the popup is open.
export function setupTick() {
  if ($('setup').open && D) $('setupList').innerHTML = renderList();
}
