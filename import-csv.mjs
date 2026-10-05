// Import a venue's CSV export into the trades/flows tables.
//   npm run import -- strike ~/Downloads/strike-transactions.csv           (dry run: prints what it understood)
//   npm run import -- strike ~/Downloads/strike-transactions.csv --write   (saves it)
// Column names are matched loosely so different export layouts work: one row per
// transaction with BTC and/or USD amounts (either as "Amount BTC"/"Amount USD" columns or
// as "Amount 1/Currency 1, Amount 2/Currency 2" pairs).
import { readFileSync } from 'node:fs';
import { openDb } from './lib/db.mjs';
import { dayKey, num } from './lib/util.mjs';
import { majorUsd } from './lib/history-prices.mjs';

const [account, file, flag] = process.argv.slice(2);
if (!account || !file) {
  console.log('usage: npm run import -- <account id from accounts.json> <file.csv> [--write]');
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(new URL('accounts.json', import.meta.url), 'utf8'));
const acct = cfg.accounts.find((a) => a.id === account);
if (!acct) { console.log(`No account "${account}" in accounts.json`); process.exit(1); }
const write = flag === '--write';

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const [header, ...lines] = parseCsv(readFileSync(file.replace(/^~/, process.env.HOME), 'utf8').replace(/^﻿/, ''));
const H = header.map((h) => h.trim().toLowerCase());
const col = (...res) => H.findIndex((h) => res.every((re) => re.test(h)));
const C = {
  id: col(/id|reference/),
  time: [col(/time|date/, /utc/), col(/completed/), col(/time|date/)].find((i) => i >= 0),
  type: col(/type/),
  status: col(/status/),
  btc: col(/amount/, /btc/), usd: col(/amount/, /usd/),
  feeBtc: col(/fee/, /btc/), feeUsd: col(/fee/, /usd/),
  price: col(/btc/, /price|rate/) >= 0 ? col(/btc/, /price|rate/) : col(/price|rate/),
  a1: col(/amount 1/), c1: col(/currency 1/), a2: col(/amount 2/), c2: col(/currency 2/),
};
console.log('Columns understood:', Object.fromEntries(Object.entries(C).filter(([, i]) => i >= 0).map(([k, i]) => [k, header[i]])));
if (C.time < 0) { console.log('Could not find a date/time column.'); process.exit(1); }

const trades = [], flows = [], skipped = {};
for (const [n, r] of lines.entries()) {
  const get = (i) => (i >= 0 ? r[i]?.trim() : '');
  if (C.status >= 0 && /fail|cancel|pending|reject/i.test(get(C.status))) continue;
  const raw = get(C.time);
  const utc = /utc/.test(H[C.time]) && !/(z|[+-]\d\d:?\d\d|utc|gmt)$/i.test(raw);
  let ts = utc ? Date.parse(/^\d{4}-\d\d-\d\d/.test(raw) ? raw.replace(' ', 'T') + 'Z' : raw + ' UTC') : Date.parse(raw);
  if (!Number.isFinite(ts)) ts = Date.parse(raw.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ts)) { skipped['bad date'] = (skipped['bad date'] ?? 0) + 1; continue; }
  let btc = num(get(C.btc)), usd = num(get(C.usd));
  if (C.a1 >= 0) {
    for (const [a, c] of [[C.a1, C.c1], [C.a2, C.c2]]) {
      const cur = get(c).toUpperCase();
      if (cur === 'BTC') btc += num(get(a));
      if (cur === 'USD') usd += num(get(a));
    }
  }
  const type = get(C.type);
  const id = `csv:${account}:${get(C.id) || `${ts}:${n}`}`;
  const base = { ext_id: id, ts, account, venue: acct.name, symbol: 'BTC' };
  if (btc && usd && Math.sign(btc) !== Math.sign(usd)) {
    const size = Math.abs(btc);
    trades.push({ ...base, side: btc > 0 ? 'BUY' : 'SELL', size, price: Math.abs(usd) / size, notional: Math.abs(usd), fee: num(get(C.feeUsd)), kind: 'spot', dir: type || (btc > 0 ? 'Buy' : 'Sell') });
  } else if (btc) {
    const px = num(get(C.price)) || (await majorUsd('BTC', ts)) || 0;
    trades.push({ ...base, side: btc > 0 ? 'RECEIVE' : 'SEND', size: Math.abs(btc), price: px, notional: Math.abs(btc) * px, kind: 'transfer', dir: type || (btc > 0 ? 'Received' : 'Sent') });
  } else if (usd) {
    // Plain USD in/out of the account (bank deposits, withdrawals, card spend).
    flows.push({ ts, day: dayKey(ts, cfg.timezone), account, amount: usd, note: type || (usd > 0 ? 'Deposit' : 'Withdrawal'), source: `csv:${account}`, ext_id: id });
  } else skipped[type || 'empty'] = (skipped[type || 'empty'] ?? 0) + 1;
}

const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const buys = trades.filter((t) => t.side === 'BUY');
console.log(`\n${trades.length} BTC rows (${buys.length} buys, ${trades.filter((t) => t.side === 'SELL').length} sells, ${trades.filter((t) => t.kind === 'transfer').length} transfers), ${flows.length} USD deposits/withdrawals`);
if (buys.length) console.log(`Buys: ${sum(buys, (t) => t.size).toFixed(8)} BTC for $${sum(buys, (t) => t.notional).toFixed(2)} → avg $${(sum(buys, (t) => t.notional) / sum(buys, (t) => t.size)).toFixed(2)}`);
if (Object.keys(skipped).length) console.log('Skipped:', skipped);
for (const t of trades.slice(0, 5)) console.log(' ', new Date(t.ts).toISOString().slice(0, 16), t.side, t.size, '$' + t.notional?.toFixed(2), t.dir);

if (!write) { console.log('\nDry run — add --write to save.'); process.exit(0); }
const db = openDb(new URL('data/pnl.db', import.meta.url).pathname);
db.addTrades(trades);
for (const f of flows) db.addFlow(f);
console.log('Saved.');
