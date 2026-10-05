// Local-only server: http://localhost:4200
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { openDb } from './lib/db.mjs';
import { createEngine } from './lib/engine.mjs';
import { loadConfig, saveConfig, saveSecrets, secretStatus, withSecrets, localTz, ACCOUNTS_FILE, SECRET_KEYS } from './lib/config.mjs';
import * as hyperliquid from './connectors/hyperliquid.mjs';
import * as coinbase from './connectors/coinbase.mjs';
import * as strike from './connectors/strike.mjs';
import * as wallet from './connectors/wallet.mjs';
import * as schwab from './connectors/schwab.mjs';
import * as manual from './connectors/manual.mjs';
import * as demo from './connectors/demo.mjs';

const DEMO = process.env.DEMO === '1';
const PORT = Number(process.env.PORT) || 4200;
const root = new URL('.', import.meta.url);
const CONNECTORS = { hyperliquid, coinbase, strike, wallet, schwab, manual, demo };
const firstRun = !DEMO && !existsSync(ACCOUNTS_FILE);

// Demo data is regenerated on every start.
if (DEMO) for (const f of ['demo.db', 'demo.db-wal', 'demo.db-shm']) rmSync(new URL('data/' + f, root), { force: true });
const db = openDb(new URL(DEMO ? 'data/demo.db' : 'data/pnl.db', root).pathname);

// The engine is rebuilt whenever the setup screen saves; the stream listens to `hub`,
// which outlives any one engine.
const hub = new EventEmitter();
let cfg, engine;
function boot() {
  engine?.stop();
  cfg = DEMO ? { timezone: localTz(), demo: true, accounts: demo.DEMO_ACCOUNTS } : loadConfig();
  engine = createEngine({ db, cfg, connectors: CONNECTORS });
  engine.on('update', () => hub.emit('update'));
  engine.start();
  hub.emit('update');
}
if (DEMO) demo.seed(db, localTz());
boot();

const state = () => ({ ...engine.state(), needsSetup: !DEMO && !cfg.accounts.length });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Background jobs (backfill / rebuild / CSV import) run as child processes; one at a time.
const JOBS = { backfill: ['backfill.mjs'], rebuild: ['rebuild.mjs'] };
let job = null; // { name, started, ended, code, out }
function runJob(name, args) {
  if (job && !job.ended) throw new Error(`${job.name} is already running`);
  job = { name, started: Date.now(), ended: null, code: null, out: '' };
  const p = spawn(process.execPath, ['--no-warnings', '--env-file-if-exists=.env', ...args], { cwd: root.pathname });
  const add = (b) => { job.out = (job.out + b.toString()).slice(-20_000); };
  p.stdout.on('data', add);
  p.stderr.on('data', add);
  p.on('close', (code) => Object.assign(job, { ended: Date.now(), code }));
  return job;
}
// Wallet trades (Fomo, Robinhood Wallet…) have no live feed, so every 10 minutes a
// catch-up backfill of the last two days runs in the background (skipped if a job is busy).
setInterval(() => {
  if (DEMO || (job && !job.ended) || !cfg.accounts.some((a) => a.type === 'wallet')) return;
  try { runJob('auto-sync (last 2 days)', ['backfill.mjs', '--recent']); } catch { /* busy */ }
}, 600_000).unref();

const readText = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s)); });

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, bad) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } }); });

// Only this machine's browser may talk to the server. The Host check stops DNS-rebinding
// pages from reading your portfolio; the custom header on writes can't be sent by another
// website without a CORS preflight, which this server never answers.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
function allowed(req) {
  if (!LOCAL_HOST.test(req.headers.host ?? '')) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (origin && !LOCAL_HOST.test(origin.replace(/^https?:\/\//, ''))) return false;
  return req.headers['x-pnl'] === '1';
}

// ---------- setup screen ----------
const ACCOUNT_TYPES = ['coinbase', 'strike', 'hyperliquid', 'wallet', 'schwab', 'manual'];
const ONE_PER_INSTALL = ['coinbase', 'strike', 'schwab']; // their keys live in .env, one set each

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account'; }

// Accepts the setup screen's draft and returns a clean accounts.json. Keeps fields the
// screen doesn't know about (e.g. `historyFrom`) on accounts that already existed.
function normalize(draft) {
  const prev = new Map(cfg.accounts.map((a) => [a.id, a]));
  const ids = new Set();
  const accounts = (draft.accounts ?? []).map((a) => {
    if (!ACCOUNT_TYPES.includes(a.type)) throw new Error(`Unknown account type "${a.type}"`);
    let id = a.id && prev.has(a.id) ? a.id : slug(a.name || a.type);
    for (let n = 2; ids.has(id); n++) id = `${slug(a.name || a.type)}-${n}`;
    ids.add(id);
    const out = { ...(prev.get(a.id) ?? {}), ...a, id, name: (a.name || a.type).trim() };
    for (const k of Object.keys(out)) if (out[k] === null || (Array.isArray(out[k]) && !out[k].length && k !== 'accounts')) delete out[k];
    return out;
  });
  for (const t of ONE_PER_INSTALL) if (accounts.filter((a) => a.type === t).length > 1) throw new Error(`Only one ${t} account is supported`);
  const { accounts: _, ...settings } = draft;
  const next = { ...cfg, ...settings, accounts };
  delete next.demo;
  next.timezone ||= localTz();
  next.historyStart ||= `${new Date().getFullYear()}-01-01T00:00:00`;
  next.tradesFrom ||= next.historyStart;
  return next;
}

const pickSecrets = (s = {}) => Object.fromEntries(Object.entries(s).filter(([k]) => SECRET_KEYS.includes(k)));

async function testAccount(account, secrets, settings) {
  const conn = CONNECTORS[account.type];
  if (!conn || account.type === 'demo') throw new Error('Unknown account type');
  const unsaved = Object.fromEntries(Object.entries(pickSecrets(secrets)).filter(([, v]) => v));
  const draftCfg = { ...cfg, ...settings, accounts: [account] };
  const run = withSecrets(unsaved, () => conn.fetchAccount({ id: 'test', name: 'Test', ...account }, draftCfg));
  const res = await Promise.race([run, new Promise((_, bad) => setTimeout(() => bad(new Error('Timed out after 45s — the venue may be slow, try again')), 45_000))]);
  const top = [...(res.positions ?? [])].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 5).map((p) => p.symbol);
  return { value: res.value, positions: res.positions?.length ?? 0, top };
}

function friendlyError(msg) {
  if (/^40[13]\b/.test(msg)) return `The venue rejected this key (${msg.slice(0, 3)}). Check it was copied in full and has read permission.`;
  if (/^429\b/.test(msg)) return 'Rate-limited by the venue. Wait a minute and try again.';
  if (/Invalid key|DECODER|asn1|PEM|bad base64|Invalid private key/i.test(msg)) return 'That private key couldn\'t be read. Paste the whole key, including the BEGIN/END lines if it has them.';
  return msg;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (!allowed(req)) return json(res, 403, { error: 'forbidden' });

    if (url.pathname === '/api/state') return json(res, 200, state());

    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      let pending = false;
      const push = () => {
        if (pending) return;
        pending = true;
        setTimeout(() => { pending = false; if (!res.writableEnded) res.write(`data: ${JSON.stringify(state())}\n\n`); }, 500);
      };
      push();
      hub.on('update', push);
      const ping = setInterval(push, 15_000);
      req.on('close', () => { hub.off('update', push); clearInterval(ping); });
      return;
    }

    // Setup screen: current config + which keys exist (never their values).
    if (url.pathname === '/api/setup' && req.method === 'GET') {
      const { demo: _, ...c } = cfg;
      return json(res, 200, { config: DEMO ? { timezone: c.timezone, accounts: [] } : c, secrets: secretStatus(), localTz: localTz(), demo: DEMO, firstRun });
    }
    if (url.pathname === '/api/setup' && req.method === 'POST') {
      if (DEMO) return json(res, 400, { error: 'Setup is off in demo mode — run `npm start` to use your own accounts' });
      const b = await readBody(req);
      const next = normalize(b.config ?? {});
      saveSecrets(pickSecrets(b.secrets));
      saveConfig(next);
      boot();
      return json(res, 200, { ok: true, config: next, secrets: secretStatus() });
    }
    if (url.pathname === '/api/setup/test' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        return json(res, 200, { ok: true, ...(await testAccount(b.account ?? {}, b.secrets, b.settings)) });
      } catch (e) {
        return json(res, 200, { ok: false, error: friendlyError(e.message) });
      }
    }

    if (url.pathname === '/api/flows' && req.method === 'POST') {
      const b = await readBody(req);
      if (!Number.isFinite(Number(b.amount)) || !Number(b.amount)) return json(res, 400, { error: 'amount required' });
      engine.addFlow(b);
      return json(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/flows/') && req.method === 'DELETE') {
      engine.delFlow(Number(url.pathname.split('/').pop()));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/jobs' && req.method === 'GET') return json(res, 200, { job, demo: DEMO });
    if (url.pathname.startsWith('/api/jobs/') && req.method === 'POST') {
      if (DEMO) return json(res, 400, { error: 'not available in demo mode' });
      if (!cfg.accounts.length) return json(res, 400, { error: 'add an account first' });
      const name = url.pathname.split('/').pop();
      if (!JOBS[name]) return json(res, 404, { error: 'unknown job' });
      return json(res, 200, { job: runJob(name, JOBS[name]) });
    }
    if (url.pathname.startsWith('/api/import/') && req.method === 'POST') {
      if (DEMO) return json(res, 400, { error: 'not available in demo mode' });
      const account = url.pathname.split('/').pop();
      if (!cfg.accounts.some((a) => a.id === account)) return json(res, 400, { error: 'unknown account' });
      const dir = new URL('data/imports/', root);
      mkdirSync(dir, { recursive: true });
      const file = new URL(`${account}-${Date.now()}.csv`, dir).pathname;
      writeFileSync(file, await readText(req));
      const write = url.searchParams.get('write') === '1';
      return json(res, 200, { job: runJob(`import ${account}`, ['import-csv.mjs', account, file, ...(write ? ['--write'] : [])]) });
    }

    if (url.pathname === '/api/schwab/status') return json(res, 200, { ...schwab.status(), hasAccount: cfg.accounts.some((a) => a.type === 'schwab') });
    if (url.pathname === '/api/schwab/authurl') return json(res, 200, { url: schwab.authUrl() });
    if (url.pathname === '/api/schwab/code' && req.method === 'POST') {
      await schwab.exchangeCode((await readBody(req)).code);
      return json(res, 200, { ok: true });
    }

    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (path.includes('..')) return json(res, 400, { error: 'bad path' });
    const file = new URL('public' + path, root);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    console.error(e);
    json(res, 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  const link = `http://localhost:${PORT}`;
  console.log(`\n  PnL terminal ${DEMO ? '(DEMO DATA) ' : ''}→ ${link}\n`);
  if (firstRun) {
    console.log('  First run: opening the setup screen in your browser to connect your accounts.\n');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    if (!process.env.NO_OPEN) spawn(opener, [link], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
