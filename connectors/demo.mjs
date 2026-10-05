// Fake accounts + 4 months of fake history so the UI can be seen before any keys exist.
import { addDays, dayKey, startOfDay } from '../lib/util.mjs';

export const interval = 3_000;

export const DEMO_ACCOUNTS = [
  { id: 'strike', name: 'Strike', type: 'demo', base: 85_000, vol: 0.025, mix: [['BTC', 'crypto', 1]] },
  { id: 'coinbase', name: 'Coinbase', type: 'demo', base: 210_000, vol: 0.035, mix: [['ZEC', 'crypto', 0.45], ['ETH', 'crypto', 0.25], ['SOL', 'crypto', 0.2], ['ZEC', 'perp', 0.1]] },
  { id: 'rh-wallet', name: 'Robinhood Wallet', type: 'demo', base: 42_000, vol: 0.05, mix: [['ETH', 'crypto', 0.6], ['AERO', 'crypto', 0.4]] },
  { id: 'fomo', name: 'Fomo', type: 'demo', base: 18_000, vol: 0.09, mix: [['BONK', 'crypto', 0.5], ['FARTCOIN', 'crypto', 0.3], ['PNUT', 'crypto', 0.2]] },
  { id: 'hyperliquid', name: 'Hyperliquid', type: 'demo', base: 95_000, vol: 0.06, mix: [['HYPE', 'perp', 0.6], ['BTC', 'perp', 0.4]] },
  { id: 'schwab', name: 'Schwab', type: 'demo', base: 160_000, vol: 0.018, mix: [['MU', 'stock', 0.35], ['NVDA', 'stock', 0.3], ['SNDK', 'stock', 0.2], ['SPY', 'stock', 0.15]] },
];

const PX = { BTC: 118_000, ZEC: 1_320, ETH: 2_690, SOL: 205, AERO: 1.42, BONK: 0.0000241, FARTCOIN: 1.12, PNUT: 0.31, HYPE: 48.2, MU: 1_066, NVDA: 192, SNDK: 1_715, SPY: 668 };

function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const live = new Map(); // account id -> { value, open, mult }

export function seed(db, tz) {
  const today = dayKey(Date.now(), tz);
  const days = 120;
  for (const a of DEMO_ACCOUNTS) {
    let v = a.base * 0.55;
    for (let i = days; i >= 1; i--) {
      const day = addDays(today, -i);
      const open = v;
      v = Math.max(1000, v * (1 + 0.004 + a.vol * gauss()));
      if (i === 70 && a.id === 'hyperliquid') v *= 1.35; // a heater
      db.raw.prepare('INSERT OR REPLACE INTO daily (day, account, open, close, close_ts) VALUES (?, ?, ?, ?, ?)').run(day, a.id, open, v, startOfDay(Date.now(), tz) - i * 864e5 + 863e5);
    }
    // Intraday points for today
    const t0 = startOfDay(Date.now(), tz);
    const prevClose = v;
    for (let t = t0; t < Date.now(); t += 300_000) {
      v = v * (1 + (a.vol / 18) * gauss() + 0.0004);
      db.snapshot(t, a.id, v, today);
    }
    live.set(a.id, { value: v, prevClose, mult: v / a.base });
  }
  // Deposits so the flow logic has something to chew on
  db.addFlow({ ts: Date.now() - 60 * 864e5, day: addDays(today, -60), account: 'coinbase', amount: 25_000, note: 'Bank deposit (demo)' });

  // Fake perp round trips on Hyperliquid + a few spot buys
  const trades = [];
  let t = Date.now() - days * 864e5;
  for (let i = 0; i < 70; i++) {
    t += Math.random() * 1.6 * 864e5;
    const coin = ['HYPE', 'BTC', 'ETH', 'SOL'][i % 4];
    const px = PX[coin] * (0.85 + Math.random() * 0.3);
    const sz = +(20_000 / px).toFixed(3);
    const pnl = (Math.random() - 0.47) * 3_000;
    trades.push({ ext_id: `demo:o${i}`, ts: t, account: 'hyperliquid', venue: 'Hyperliquid', symbol: coin, side: 'BUY', size: sz, price: px, notional: sz * px, fee: 6, closed_pnl: 0, start_pos: 0, dir: 'Open Long', kind: 'perp' });
    trades.push({ ext_id: `demo:c${i}`, ts: t + 3 * 36e5, account: 'hyperliquid', venue: 'Hyperliquid', symbol: coin, side: 'SELL', size: sz, price: px + pnl / sz, notional: sz * px, fee: 6, closed_pnl: pnl, start_pos: sz, dir: 'Close Long', kind: 'perp' });
  }
  for (let i = 0; i < 12; i++) {
    const coin = ['ZEC', 'ETH', 'SOL'][i % 3];
    trades.push({ ext_id: `demo:s${i}`, ts: Date.now() - i * 0.7 * 864e5 - 5e6, account: 'coinbase', venue: 'Coinbase', symbol: coin, side: i % 4 ? 'BUY' : 'SELL', size: 5_000 / PX[coin], price: PX[coin], notional: 5_000, fee: 3, kind: 'spot' });
  }
  db.addTrades(trades);
}

export async function fetchAccount(acct) {
  const a = DEMO_ACCOUNTS.find((x) => x.id === acct.id);
  let s = live.get(a.id);
  if (!s) { s = { value: a.base, prevClose: a.base, mult: 1 }; live.set(a.id, s); }
  s.value *= 1 + (a.vol / 90) * gauss() + 0.00003;
  const scale = s.value / a.base;
  const positions = a.mix.map(([sym, kind, w]) => {
    const price = PX[sym] * (1 + (s.value / s.prevClose - 1) * 1.2);
    const notional = a.base * w * (kind === 'perp' ? 3 : 1) * scale;
    const avg = PX[sym] * (0.8 + ((sym.charCodeAt(0) * 7) % 40) / 100);
    const qty = notional / price;
    const upnl = (price - avg) * qty;
    return { key: `${kind}:${sym}`, symbol: sym, kind, venue: a.name, side: 'LONG', qty, avg, price, value: notional, upnl, contrib: kind === 'perp' ? upnl : notional };
  });
  return { value: s.value, positions };
}
