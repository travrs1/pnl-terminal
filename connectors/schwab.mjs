// Charles Schwab Trader API (OAuth). Until it's connected, falls back to the
// manual `holdings` list in accounts.json priced off live quotes.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fetchJson, num } from '../lib/util.mjs';
import { secret as readSecret } from '../lib/config.mjs';
import { stockQuote, cryptoUsd } from '../lib/prices.mjs';

export const interval = 20_000;
const TOKEN_FILE = new URL('../data/schwab-tokens.json', import.meta.url);
const OAUTH = 'https://api.schwabapi.com/v1/oauth';

const env = () => {
  const key = readSecret('SCHWAB_APP_KEY');
  const secret = readSecret('SCHWAB_APP_SECRET');
  const callback = readSecret('SCHWAB_CALLBACK_URL') || 'https://127.0.0.1';
  return { key, secret, callback };
};

const loadTokens = () => (existsSync(TOKEN_FILE) ? JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) : null);
const saveTokens = (t) => writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });

export function status() {
  const { key } = env();
  const t = loadTokens();
  if (!key) return { configured: false, connected: false };
  if (!t) return { configured: true, connected: false };
  const refreshLeftMs = t.refresh_issued_at + 7 * 864e5 - Date.now();
  return { configured: true, connected: refreshLeftMs > 0, refreshExpiresInHours: Math.max(0, Math.round(refreshLeftMs / 36e5)) };
}

export function authUrl() {
  const { key, callback } = env();
  if (!key) throw new Error('Schwab app key not set — add it under Accounts & keys');
  return `${OAUTH}/authorize?client_id=${encodeURIComponent(key)}&redirect_uri=${encodeURIComponent(callback)}`;
}

async function tokenRequest(params) {
  const { key, secret } = env();
  return fetchJson(`${OAUTH}/token`, {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

// Accepts the full redirected URL (https://127.0.0.1/?code=...&session=...) or the bare code.
export async function exchangeCode(input) {
  let code = input.trim();
  if (code.includes('code=')) code = new URL(code).searchParams.get('code');
  const r = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: env().callback });
  const now = Date.now();
  saveTokens({ ...r, access_expires_at: now + r.expires_in * 1000 - 60_000, refresh_issued_at: now });
}

async function accessToken() {
  let t = loadTokens();
  if (!t) return null;
  if (Date.now() > t.refresh_issued_at + 7 * 864e5) throw new Error('Schwab login expired (7-day limit) — reconnect in Settings');
  if (Date.now() > t.access_expires_at) {
    const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    t = { ...t, ...r, access_expires_at: Date.now() + r.expires_in * 1000 - 60_000 };
    saveTokens(t);
  }
  return t.access_token;
}

async function fromApi(token, acct) {
  const accounts = await fetchJson('https://api.schwabapi.com/trader/v1/accounts?fields=positions', { headers: { authorization: `Bearer ${token}` } });
  let value = 0;
  const positions = [];
  for (const { securitiesAccount: sa } of accounts ?? []) {
    if (acct.accountNumbers && !acct.accountNumbers.includes(sa.accountNumber)) continue;
    value += num(sa.currentBalances?.liquidationValue);
    for (const p of sa.positions ?? []) {
      const ins = p.instrument ?? {};
      if (ins.assetType === 'CASH_EQUIVALENT' && /MONEY MARKET|SWEEP/i.test(ins.description ?? '')) continue;
      const long = num(p.longQuantity), short = num(p.shortQuantity);
      const qty = long || short;
      if (!qty) continue;
      const isOpt = ins.assetType === 'OPTION';
      const mv = num(p.marketValue);
      positions.push({
        key: `${isOpt ? 'option' : 'stock'}:${ins.symbol}`, symbol: isOpt ? ins.underlyingSymbol || ins.symbol : ins.symbol,
        name: isOpt ? ins.description : ins.description || ins.symbol, kind: isOpt ? 'option' : 'stock', venue: 'Schwab',
        side: short ? 'SHORT' : 'LONG', qty, avg: num(p.averagePrice), price: Math.abs(mv) / qty / (isOpt ? 100 : 1), value: mv,
        upnl: p.longOpenProfitLoss != null || p.shortOpenProfitLoss != null ? num(p.longOpenProfitLoss) + num(p.shortOpenProfitLoss) : null,
        today: num(p.currentDayProfitLoss), contrib: mv,
      });
    }
  }
  return { value, positions };
}

async function fromHoldings(acct) {
  const positions = [];
  for (const h of acct.holdings ?? []) {
    const crypto = h.kind === 'crypto';
    const q = crypto ? { price: await cryptoUsd(h.symbol), prevClose: null } : await stockQuote(h.symbol);
    const value = h.qty * q.price;
    positions.push({
      key: `${crypto ? 'crypto' : 'stock'}:${h.symbol}`, symbol: h.symbol, name: q.name, kind: crypto ? 'crypto' : 'stock',
      venue: `${acct.name} · manual`, side: h.qty < 0 ? 'SHORT' : 'LONG', qty: Math.abs(h.qty), avg: h.avg ?? null, price: q.price,
      value, upnl: h.avg ? (q.price - h.avg) * h.qty : null, today: q.prevClose ? (q.price - q.prevClose) * h.qty : undefined, contrib: value,
    });
  }
  return { value: positions.reduce((s, p) => s + p.value, 0) + num(acct.cash), positions };
}

export async function fetchAccount(acct) {
  const token = env().key ? await accessToken() : null;
  if (token) return fromApi(token, acct);
  if (acct.holdings?.length || acct.cash) return fromHoldings(acct);
  throw new Error('Schwab not connected — log in under Settings, or add manual holdings');
}
