// accounts.json + .env: reading, writing, and the secrets connectors use.
//
// Secrets live in .env (never in accounts.json, never sent back to the browser).
// `secret(name)` reads them; `withSecrets()` lets the setup screen test a key it
// hasn't saved yet without touching what the running accounts use.
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
export const ACCOUNTS_FILE = new URL('accounts.json', ROOT);
export const ENV_FILE = new URL('.env', ROOT);

// Every key the setup screen may write. Anything else in a request is ignored.
export const SECRET_KEYS = [
  'COINBASE_KEY_NAME', 'COINBASE_KEY_SECRET',
  'STRIKE_API_KEY',
  'SCHWAB_APP_KEY', 'SCHWAB_APP_SECRET', 'SCHWAB_CALLBACK_URL',
  'SOLANA_RPC_URL',
];

const override = new AsyncLocalStorage();
export const secret = (name) => (override.getStore()?.[name] ?? process.env[name])?.trim() || undefined;
export const withSecrets = (vals, fn) => override.run({ ...vals }, fn);

export const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function loadConfig() {
  if (!existsSync(ACCOUNTS_FILE)) return { timezone: localTz(), accounts: [] };
  const cfg = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
  cfg.accounts ??= [];
  return cfg;
}

// Write via a temp file so a crash mid-write never leaves half a JSON file.
function writeAtomic(url, text, mode) {
  const tmp = new URL(url.href + '.tmp');
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, url);
}

export function saveConfig(cfg) {
  writeAtomic(ACCOUNTS_FILE, JSON.stringify(cfg, null, 2) + '\n', 0o644);
}

// Which secrets are set (true/false) — the only thing the browser ever learns about them.
export const secretStatus = () => Object.fromEntries(SECRET_KEYS.map((k) => [k, !!process.env[k]?.trim()]));

// Merge `updates` into .env, keeping comments and unrelated lines. A value of null
// removes the key; undefined or '' leaves it alone. Also updates process.env so the
// running server picks the change up without a restart.
export function saveSecrets(updates) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n') : ['# Written by the PnL Terminal setup screen. Stays on this machine.'];
  for (const [k, v] of Object.entries(updates)) {
    if (!SECRET_KEYS.includes(k) || v === undefined || v === '') continue;
    const i = lines.findIndex((l) => l.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1] === k);
    if (v === null) {
      if (i >= 0) lines.splice(i, 1);
      delete process.env[k];
      continue;
    }
    const clean = String(v).trim().replace(/\r/g, '');
    const line = `${k}="${clean.replace(/\n/g, '\\n').replace(/"/g, '')}"`;
    if (i >= 0) lines[i] = line; else lines.push(line);
    process.env[k] = clean;
  }
  writeAtomic(ENV_FILE, lines.join('\n').replace(/\n*$/, '\n'), 0o600);
}
