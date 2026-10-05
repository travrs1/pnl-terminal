// Daily PnL + streaks/records, computed from the `daily` table.
//
// Per account, a day's PnL is close − previous close. The first day an account
// appears its open counts as the previous close, so adding an account (or its
// opening balance) never shows up as profit. External deposits/withdrawals in
// `flows` are subtracted from the day they happened.

export function dailyPnl(dailyRows, flows, todayKey, liveValues) {
  const byDay = new Map();
  for (const r of dailyRows) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
  }
  // Live values override today's stored close.
  if (liveValues) {
    const rows = byDay.get(todayKey) ?? [];
    for (const [account, value] of Object.entries(liveValues)) {
      const row = rows.find((r) => r.account === account);
      if (row) row.close = value;
      else rows.push({ day: todayKey, account, open: value, close: value });
    }
    if (rows.length) byDay.set(todayKey, rows);
  }
  const flowByDay = {};
  for (const f of flows) (flowByDay[f.day] ??= []).push(f);

  const lastClose = {};
  const out = [];
  let cum = 0;
  for (const day of [...byDay.keys()].sort()) {
    let pnl = 0, deposits = 0, est = false;
    for (const r of byDay.get(day)) {
      if (r.est) est = true;
      const prev = lastClose[r.account];
      if (prev == null) deposits += r.open;
      pnl += r.close - (prev ?? r.open);
      lastClose[r.account] = r.close;
    }
    // Only count flows for accounts that are being tracked by that day — a Coinbase
    // deposit can't affect a day whose history only covers Hyperliquid.
    const flow = (flowByDay[day] ?? []).filter((f) => !f.account || f.account in lastClose).reduce((s, f) => s + f.amount, 0);
    pnl -= flow;
    deposits += flow;
    cum += pnl;
    const value = Object.values(lastClose).reduce((s, v) => s + v, 0);
    out.push({ day, pnl, cum, value, deposits, est });
  }
  return out;
}

export function records(days, todayKey) {
  const done = days.filter((d) => d.day !== todayKey && Math.abs(d.pnl) > 0.005);
  const green = done.filter((d) => d.pnl > 0);
  let best = null, worst = null;
  for (const d of done) {
    if (!best || d.pnl > best.pnl) best = d;
    if (!worst || d.pnl < worst.pnl) worst = d;
  }
  let longestGreen = 0, longestRed = 0, run = 0, sign = 0;
  for (const d of done) {
    const s = Math.sign(d.pnl);
    run = s === sign ? run + 1 : 1;
    sign = s;
    if (s > 0) longestGreen = Math.max(longestGreen, run);
    else longestRed = Math.max(longestRed, run);
  }
  const current = done.length ? { count: run, color: sign > 0 ? 'green' : 'red' } : { count: 0, color: 'none' };
  // Days since the last day of the opposite color
  const lastOpp = [...done].reverse().find((d) => Math.sign(d.pnl) !== sign);
  let peak = -Infinity, peakDay = null, maxDd = 0;
  for (const d of days) {
    if (d.cum > peak) { peak = d.cum; peakDay = d.day; }
    maxDd = Math.min(maxDd, d.cum - peak);
  }
  const net = days.reduce((s, d) => s + d.deposits, 0);
  const startValue = days[0] ? days[0].deposits : 0; // what everything was worth when the run began
  const total = days.at(-1)?.cum ?? 0;
  return {
    tradingDays: done.length, greenDays: green.length, redDays: done.length - green.length,
    greenPct: done.length ? green.length / done.length : 0,
    best, worst, longestGreen, longestRed, current, lastOppositeDay: lastOpp?.day ?? null,
    totalPnl: total, netDeposited: net, startValue, added: net - startValue, nowValue: days.at(-1)?.value ?? 0, totalPct: net > 0 ? total / net : 0,
    peakPnl: peak === -Infinity ? 0 : peak, peakDay, maxDrawdown: maxDd,
    avgGreen: green.length ? green.reduce((s, d) => s + d.pnl, 0) / green.length : 0,
    avgRed: done.length - green.length ? done.filter((d) => d.pnl < 0).reduce((s, d) => s + d.pnl, 0) / (done.length - green.length) : 0,
    since: days[0]?.day ?? null,
  };
}

// Round trips from perp fills: a trade completes when the position returns to flat.
export function roundTrips(fills, from = 0) {
  const open = new Map();
  const done = [];
  for (const f of fills) {
    const k = `${f.account}:${f.symbol}`;
    const signed = f.side === 'BUY' ? f.size : -f.size;
    const after = (f.start_pos ?? 0) + signed;
    const cur = open.get(k) ?? { pnl: 0, start: f.ts, cost: 0, fills: 0 };
    cur.pnl += (f.closed_pnl ?? 0) - (f.fee ?? 0);
    cur.fills++;
    if (Math.abs(after) > Math.abs(f.start_pos ?? 0)) cur.cost += Math.abs(f.notional ?? f.size * f.price); // adding to the position
    const flat = Math.abs(after) <= Math.max(1e-9, Math.abs(f.size) * 1e-6);
    const flipped = (f.start_pos ?? 0) !== 0 && Math.sign(after) !== Math.sign(f.start_pos) && !flat;
    if (flat || flipped) {
      done.push({ account: f.account, symbol: f.symbol, venue: f.venue, pnl: cur.pnl, cost: cur.cost, proceeds: cur.cost + cur.pnl,
        pct: cur.cost ? cur.pnl / cur.cost : null, opened: cur.start, closed: f.ts, fills: cur.fills, kind: 'perp' });
      open.set(k, { pnl: 0, start: f.ts, cost: 0, fills: 0 });
    } else open.set(k, cur);
  }
  const kept = done.filter((t) => t.closed >= from);
  const wins = kept.filter((t) => t.pnl > 0).length;
  return { completed: kept.length, wins, losses: kept.length - wins, winRate: kept.length ? wins / kept.length : 0, all: kept, realized: kept.reduce((s, t) => s + t.pnl, 0) };
}

// Spot round trips across every venue, FIFO cost basis. A position "completes" when it's
// sold back down to <2% of its peak size. Tokens transferred in are costed at their
// market value when they arrived; transfers out just remove lots without realizing.
const CASH = new Set(['USD', 'USDC', 'USDT', 'DAI', 'PYUSD', 'USDS', 'USDE']);

export function spotRoundTrips(trades, costBasis = {}, openOut = null) {
  const book = new Map();
  const done = [];
  const fresh = (ts) => ({ lots: [], peak: 0, cost: 0, proceeds: 0, sells: 0, buys: 0, opened: ts, venues: new Set(), est: false });
  for (const t of trades) {
    if (CASH.has(t.symbol) || !(t.size > 0)) continue;
    const k = `${t.account}:${t.symbol}`;
    let b = book.get(k);
    const held = () => b.lots.reduce((s, l) => s + l.qty, 0);
    if (t.side === 'BUY' || t.side === 'RECEIVE') {
      if (!b || held() <= b.peak * 0.02) { b = fresh(t.ts); book.set(k, b); }
      const unit = costBasis[t.symbol] ?? (t.notional != null ? t.notional / t.size : null);
      b.lots.push({ qty: t.size, unit });
      b.peak = Math.max(b.peak, held());
      if (t.side === 'BUY') b.buys++;
      if (t.venue) b.venues.add(t.venue);
      if (/est\./.test(t.note ?? '')) b.est = true;
      continue;
    }
    if (!b) continue; // selling something bought before the history window
    let left = t.size, cost = 0, unknown = false;
    while (left > 1e-12 && b.lots.length) {
      const l = b.lots[0];
      const take = Math.min(l.qty, left);
      if (l.unit == null) unknown = true; else cost += take * l.unit;
      l.qty -= take; left -= take;
      if (l.qty <= 1e-12) b.lots.shift();
    }
    if (t.side === 'SELL') {
      if (t.venue) b.venues.add(t.venue);
      if (/est\./.test(t.note ?? '')) b.est = true;
      if (t.notional == null || unknown) b.unknown = true;
      b.cost += cost; b.proceeds += t.notional ?? 0; b.sells++;
    }
    if (held() <= b.peak * 0.02) {
      // Dust round trips (airdrops, rebates, <$5 in and out) aren't trades.
      if (b.sells && !b.unknown && (b.cost >= 5 || b.proceeds >= 5)) {
        done.push({ account: t.account, symbol: t.symbol, venue: [...b.venues].join(' + '), pnl: b.proceeds - b.cost, cost: b.cost, proceeds: b.proceeds,
          pct: b.cost ? (b.proceeds - b.cost) / b.cost : null, opened: b.opened, closed: t.ts, fills: b.buys + b.sells, kind: 'spot', est: b.est });
      }
      book.delete(k);
    }
  }
  if (openOut) {
    for (const [k, b] of book) {
      let qty = 0, cost = 0, known = 0;
      for (const l of b.lots) { qty += l.qty; if (l.unit != null) { cost += l.qty * l.unit; known += l.qty; } }
      if (qty > 0) openOut[k] = { qty, avg: known ? cost / known : null, knownShare: known / qty };
    }
  }
  return done;
}

export function combineTrips(perp, spot) {
  const all = [...perp.all, ...spot].sort((a, b) => b.closed - a.closed);
  const wins = perp.wins + spot.filter((t) => t.pnl > 0).length;
  const completed = perp.completed + spot.length;
  const w = all.filter((t) => t.pnl > 0), l = all.filter((t) => t.pnl <= 0);
  const sum = (xs) => xs.reduce((s, t) => s + t.pnl, 0);
  return { completed, wins, losses: completed - wins, winRate: completed ? wins / completed : 0, closed: all,
    avgWin: w.length ? sum(w) / w.length : 0, avgLoss: l.length ? sum(l) / l.length : 0,
    grossWin: sum(w), grossLoss: sum(l), profitFactor: sum(l) ? sum(w) / -sum(l) : null,
    realizedSpot: spot.reduce((s, t) => s + t.pnl, 0), realizedPerp: perp.realized,
    realized: spot.reduce((s, t) => s + t.pnl, 0) + perp.realized };
}
