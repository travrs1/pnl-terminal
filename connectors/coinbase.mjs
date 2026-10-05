// Coinbase Advanced Trade API (spot + US perps/futures) via a read-only CDP key.
import crypto from 'node:crypto';
import { fetchJson, num } from '../lib/util.mjs';
import { secret as readSecret } from '../lib/config.mjs';

export const interval = 20_000;
const HOST = 'api.coinbase.com';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signingKey() {
  const name = readSecret('COINBASE_KEY_NAME');
  let secret = readSecret('COINBASE_KEY_SECRET');
  if (!name || !secret) throw new Error('Coinbase API key not set — add it under Accounts & keys');
  secret = secret.replace(/\\n/g, '\n');
  if (secret.includes('BEGIN')) return { name, alg: 'ES256', key: crypto.createPrivateKey(secret) };
  // Ed25519 key: base64 of seed(32) + public(32)
  const raw = Buffer.from(secret, 'base64');
  const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', d: b64url(raw.subarray(0, 32)), x: b64url(raw.subarray(32, 64)) } });
  return { name, alg: 'EdDSA', key };
}

function jwt(method, path) {
  const { name, alg, key } = signingKey();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg, kid: name, typ: 'JWT', nonce: crypto.randomBytes(16).toString('hex') };
  const payload = { sub: name, iss: 'cdp', nbf: now, exp: now + 120, uri: `${method} ${HOST}${path}` };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = alg === 'ES256'
    ? crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' })
    : crypto.sign(null, Buffer.from(data), key);
  return `${data}.${b64url(sig)}`;
}

export const get = (path, query = '') =>
  fetchJson(`https://${HOST}${path}${query}`, { headers: { authorization: `Bearer ${jwt('GET', path)}` } });

// USD/USDC sitting on Coinbase can be left out of the portfolio (`excludeCash` in
// accounts.json) — e.g. when it's money set aside for the Coinbase card.
export const CASH = new Set(['USD', 'USDC']);

export async function fetchAccount(acct = {}) {
  const { portfolios = [] } = await get('/api/v3/brokerage/portfolios');
  let value = 0;
  const positions = [];

  for (const pf of portfolios) {
    if (pf.deleted) continue;
    const { breakdown: b } = await get(`/api/v3/brokerage/portfolios/${pf.uuid}`);
    value += num(b.portfolio_balances?.total_balance);
    const tag = portfolios.length > 1 ? ` · ${pf.name}` : '';

    for (const s of b.spot_positions ?? []) {
      const v = num(s.total_balance_fiat);
      if (acct.excludeCash && (s.is_cash || CASH.has(s.asset))) { value -= v; continue; }
      if (s.is_cash || v < 0.01) continue;
      const qty = num(s.total_balance_crypto);
      positions.push({
        key: `crypto:${s.asset}`, symbol: s.asset, kind: 'crypto', venue: 'Coinbase' + tag, side: 'LONG',
        qty, avg: num(s.average_entry_price) || null, price: qty ? v / qty : 0, value: v,
        upnl: s.unrealized_pnl != null ? num(s.unrealized_pnl) : null, contrib: v,
      });
    }
    for (const p of b.perp_positions ?? []) {
      const size = num(p.net_size);
      if (!size) continue;
      const sym = (p.symbol || p.product_id || '').split('-')[0];
      const upnl = num(p.unrealized_pnl);
      positions.push({
        key: `perp:${sym}`, symbol: sym, kind: 'perp', venue: 'Coinbase' + tag, side: size > 0 ? 'LONG' : 'SHORT',
        qty: Math.abs(size), avg: num(p.vwap), price: num(p.mark_price), value: Math.abs(num(p.position_notional)), upnl, contrib: upnl,
      });
    }
    for (const f of b.futures_positions ?? []) {
      const contracts = num(f.amount);
      if (!contracts) continue;
      const sym = (f.product_id || '').split('-')[0];
      const qty = contracts * num(f.contract_size || 1);
      const upnl = num(f.unrealized_pnl);
      positions.push({
        key: `perp:${sym}`, symbol: sym, kind: 'perp', venue: 'Coinbase' + tag, side: /short/i.test(f.side) ? 'SHORT' : 'LONG',
        qty, avg: num(f.avg_entry_price), price: num(f.current_price), value: qty * num(f.current_price), upnl, contrib: upnl,
      });
    }
  }

  let trades = [];
  try {
    const r = await get('/api/v3/brokerage/orders/historical/fills', '?limit=100');
    trades = (r.fills ?? []).map((f) => {
      const size = num(f.size);
      const price = num(f.price);
      const sym = (f.product_id || '').split('-')[0];
      return {
        ext_id: `cb:${f.entry_id || f.trade_id}`, ts: Date.parse(f.trade_time), venue: 'Coinbase', symbol: sym,
        side: f.side, size: f.size_in_quote ? size / price : size, price,
        notional: f.size_in_quote ? size : size * price, fee: num(f.commission), kind: /PERP|\d{2}[A-Z]{3}\d{2}/.test(f.product_id) ? 'cb-perp' : 'spot',
      };
    });
  } catch { /* fills are best-effort */ }

  return { value, positions, trades };
}

// Money in/out since `sinceTs` (bank deposits, USDC bought with bank, card payments, rewards)
// so the live tracker doesn't count them as PnL. Called by the engine every few minutes.
export async function flows(acct, cfg, sinceTs) {
  const { coinbaseFlow } = await import('../lib/coinbase-flows.mjs');
  const { data: accounts } = await get('/v2/accounts', '?limit=100');
  const txs = [];
  for (const a of accounts) {
    const r = await get(`/v2/accounts/${a.id}/transactions`, '?limit=25&order=desc');
    txs.push(...(r.data ?? []).filter((t) => Date.parse(t.created_at) >= sinceTs));
  }
  const legs = new Map();
  for (const t of txs) {
    const gid = t.buy?.id ?? t.sell?.id;
    if (gid) legs.set(gid, (legs.get(gid) ?? 0) + 1);
  }
  const out = [];
  for (const t of txs) {
    const gid = t.buy?.id ?? t.sell?.id;
    const f = coinbaseFlow(t, { legs: gid ? legs.get(gid) : 1, cryptoTransfers: 'internal', excludeCash: acct.excludeCash, tracked: trackedAddrs(cfg), otherLeg: otherLeg(t, txs) });
    if (f) out.push({ ts: Date.parse(t.created_at), ...f, ext_id: `cb2:${t.id}`, source: 'coinbase' });
  }
  return out;
}

const trackedAddrs = (cfg) => new Set(cfg.accounts.flatMap((a) => [...(a.evm ?? []), ...(a.solana ?? [])]).map((x) => x.toLowerCase()));
// Currency on the other side of a convert ("trade" legs share trade.id).
export const otherLeg = (t, txs) => t.trade?.id ? txs.find((x) => x !== t && x.trade?.id === t.trade.id)?.amount?.currency : null;
