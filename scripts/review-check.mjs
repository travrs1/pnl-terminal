// Prints the Review tab for one day as plain text, to sanity-check grades against fills.
//   node --no-warnings scripts/review-check.mjs --day 2026-10-20 [--account hyperliquid]
import { readFileSync } from 'node:fs';
import { openDb } from '../lib/db.mjs';
import { buildReview } from '../lib/review.mjs';
import { dayKey } from '../lib/util.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const cfg = JSON.parse(readFileSync(new URL('../accounts.json', import.meta.url), 'utf8'));
const db = openDb(new URL('../data/pnl.db', import.meta.url).pathname);
const day = arg('--day') ?? dayKey(Date.now(), cfg.timezone);
const account = cfg.accounts.find((a) => (arg('--account') ? a.id === arg('--account') : a.type === 'hyperliquid'));
if (!account) { console.error('No Hyperliquid account in accounts.json'); process.exit(1); }

const r = await buildReview({ db, cfg, account, day });
const c = r.cards;
const $ = (n, d = 2) => (n == null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(d)}`);
const pc = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const time = (ts) => new Date(ts).toLocaleTimeString('en-GB', { timeZone: cfg.timezone, hour: '2-digit', minute: '2-digit' });

console.log(`\nReview ${day} · ${account.name} · candles ${r.candleInterval ?? '—'}${r.rates ? ` · taker ${pc(r.rates.taker, 4)} maker ${pc(r.rates.maker, 4)}${r.rates.fallback ? ' (from fills)' : ''}` : ''}\n`);
console.log(`Day grade ${c.grade ? `${c.grade.letter} (${c.grade.score}${c.grade.capped ? ', capped' : ''})` : '—'}`);
console.log(`Gross ${$(c.gross)} · fees ${$(c.fees)} (maker ${$(c.makerFees)} / taker ${$(c.takerFees)}) · funding ${$(r.funding)} · net ${$(c.net)}`);
console.log(`Fee drag ${pc(c.feeDrag)} · maker ${pc(c.makerShare)} (saved ~${$(c.saved)}) · turnover ${c.turnover == null ? '—' : c.turnover.toFixed(1) + '×'} on ${$(c.dayStartValue, 0)}`);
console.log(`${c.trips} trips · ${c.orders} orders · ${c.fills} fills${c.takerFills != null ? ` (${c.takerFills} taker)` : ''}\n`);

for (const t of r.trips) {
  const m = t.m ?? {};
  console.log(`#${t.n} ${t.symbol} ${t.side.padEnd(5)} ${time(t.opened)} → ${t.open ? 'OPEN ' : time(t.closed)}  peak ${t.peakSize.toFixed(5)}  ${t.avgEntry?.toFixed(0)} → ${t.avgExit?.toFixed(0) ?? '—'}  gross ${$(t.grossPnl)} fees ${$(t.fees)} net ${$(t.net)}  ${t.grade ? `${t.grade.letter} (${t.grade.score.toFixed(1)})` : ''}`);
  console.log(`   acct ${$(m.acct, 0)} · liq ${pc(m.liqDist)} · MAE ${$(m.mae, 0)} (${pc(m.maePct)}) · MFE ${$(m.mfe, 0)} · location ${m.location ?? '—'}${m.locationP != null ? ` (p=${m.locationP.toFixed(2)})` : ''} · loser-add ${m.addedToLoser} · momentum ${m.againstMomentum}${m.momentum ? ` (${time(m.momentum.t)} ${m.momentum.volX.toFixed(1)}×)` : ''} · held ${m.heldMin?.toFixed(0)}m · legs ${t.legs.length}`);
  if (t.grade) console.log(`   points ${Object.entries(t.grade.points).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v.toFixed(1)}`).join(' · ')}`);
}
console.log('\nGood');
for (const b of r.good) console.log(`  ${b.id} ${b.text}  [${b.impact.toFixed(0)}]`);
for (const b of r.goodMore) console.log(`  (more) ${b.id} ${b.text}  [${b.impact.toFixed(0)}]`);
console.log('Needs work');
for (const b of r.needsWork) console.log(`  ${b.id} ${b.text}  [${b.impact.toFixed(0)}]`);
for (const b of r.needsWorkMore) console.log(`  (more) ${b.id} ${b.text}  [${b.impact.toFixed(0)}]`);
console.log(`\nBottom line: ${r.bottomLine ?? '—'}\n`);
