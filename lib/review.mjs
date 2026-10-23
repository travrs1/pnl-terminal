// Review tab: grades each perp round trip of a day, grades the day, and lists what went
// well and what didn't, every point backed by numbers from that day's fills.
//
// Rule-based and deterministic. Trips are whole positions (flat → flat), unlike the Trades
// tab, which splits partial closes off as their own trades. v1 covers Hyperliquid perps:
// a venue plugs in by giving `buildReview` a context loader (fee rates, candles, equity…).
import { byOrder } from './stats.mjs';
import { dayKey, startOfDay, addDays } from './util.mjs';
import { getCandles, pickInterval, INTERVAL_MS } from './hl-candles.mjs';
import * as hl from './hl-info.mjs';

// Every threshold in one place, so tuning is a one-line change.
export const RUBRIC = {
  base: 65,
  outcome: { perPct: 5, cap: 15 },                       // points per 1% of account, ±cap
  feeDrag: [[0.10, 5], [0.25, 0], [0.50, -5], [Infinity, -10]],
  liqDist: [[0.03, -20], [0.05, -10], [0.10, 0], [Infinity, 5]],
  mae: [[0.02, 3], [0.05, 0], [0.10, -10], [Infinity, -15]],
  addedToLoser: -10,
  location: { edge: 5, mid: 0, wrong: -5 },
  againstMomentum: -10,
  winnerFloor: 45,
  dayCapBelowLiq: 0.03, dayCap: 79,
  letters: [[90, 'A'], [85, 'A−'], [80, 'B+'], [75, 'B'], [70, 'B−'], [65, 'C+'], [60, 'C'], [55, 'C−'], [50, 'D+'], [45, 'D'], [40, 'D−'], [-Infinity, 'F']],
  // Metric definitions
  locationWindowMin: 60, edge: 0.30, wrong: 0.70,
  momentum: { volX: 3, body: 0.004, afterMin: 30, lookbackH: 24 },
  loserPct: 0.01,
  snapMaxAgeMin: 10,
  // Detectors
  makerGood: 0.90, feeDragGood: 0.10, feeDragBad: 0.15, liqSafe: 0.10, liqClose: 0.05,
  patientMin: 60, patientMae: 0.05, mfeGiveBack: 0.01, n4FeeShare: 0.25, perColumn: 5,
};

const band = (table, x) => table.find(([lim]) => x < lim)[1];
export const letter = (score) => RUBRIC.letters.find(([min]) => score >= min)[1];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---------------------------------------------------------------- trips

// Whole positions from one account's perp fills (ordered by ts, ext_id). A trip runs flat to
// flat per account:symbol; a reversal closes it at zero and the excess opens the next one,
// with the order's fee split by size. Trips are kept on the day (in `tz`) they closed;
// one still open at the end of `day` comes back with `open: true`.
export function reviewTrips(fills, { tz, day }) {
  const live = new Map(), done = [];
  const dayEnd = startOfDay(Date.parse(addDays(day, 1) + 'T12:00:00Z'), tz);
  const leg = (f, kind, size, share, pos, after) => {
    const notional = size * f.price;
    return { ts: f.ts, kind, side: f.side, size, price: f.price, notional, fee: (f.fee ?? 0) * share,
      liquidity: f.makerNotional && f.takerNotional ? 'mixed' : f.makerNotional ? 'maker' : f.takerNotional ? 'taker' : null,
      makerNotional: f.makerNotional * share, takerNotional: f.takerNotional * share,
      closedPnl: kind === 'open' || kind === 'add' ? 0 : f.closed_pnl ?? 0, posBefore: pos, posAfter: after, fills: f.pieces ?? 1 };
  };
  for (const f of byOrder(fills)) {
    if (f.ts >= dayEnd) break;
    const k = `${f.account}:${f.symbol}`;
    const start = f.start_pos ?? 0;
    const after = start + (f.side === 'BUY' ? f.size : -f.size);
    const flat = Math.abs(after) <= Math.max(1e-9, Math.abs(f.size) * 1e-6);
    const startFlat = Math.abs(start) <= Math.max(1e-9, Math.abs(f.size) * 1e-6);
    const flipped = !startFlat && Math.sign(after) !== Math.sign(start) && !flat;
    let t = live.get(k);
    if (startFlat) {
      t = { account: f.account, symbol: f.symbol, side: after > 0 ? 'LONG' : 'SHORT', opened: f.ts, legs: [] };
      t.legs.push(leg(f, 'open', f.size, 1, 0, after));
      live.set(k, t);
      continue;
    }
    if (!t) continue; // opened before the stored history: can't review it
    if (flat || flipped) {
      const share = flipped ? Math.abs(start) / f.size : 1;
      t.legs.push(leg(f, 'close', Math.abs(start), share, start, 0));
      t.closed = f.ts;
      done.push(t);
      live.delete(k);
      if (flipped) {
        const n = { account: f.account, symbol: f.symbol, side: after > 0 ? 'LONG' : 'SHORT', opened: f.ts, legs: [] };
        n.legs.push({ ...leg(f, 'open', Math.abs(after), 1 - share, 0, after), flip: true, fills: 0 });
        live.set(k, n);
      }
      continue;
    }
    t.legs.push(leg(f, Math.abs(after) > Math.abs(start) ? 'add' : 'reduce', f.size, 1, start, after));
  }
  const out = done.filter((t) => dayKey(t.closed, tz) === day).map(summarize);
  for (const t of live.values()) out.push({ ...summarize(t), open: true });
  return out;
}

function summarize(t) {
  let avg = 0, pos = 0, inSz = 0, inNtl = 0, outSz = 0, outNtl = 0, peak = 0, peakNtl = 0;
  for (const l of t.legs) {
    const grow = l.kind === 'open' || l.kind === 'add';
    if (grow) {
      avg = (avg * Math.abs(pos) + l.price * l.size) / (Math.abs(pos) + l.size);
      inSz += l.size; inNtl += l.notional;
    } else { outSz += l.size; outNtl += l.notional; }
    pos = l.posAfter;
    l.avgAfter = pos ? avg : null;
    if (Math.abs(pos) > peak) { peak = Math.abs(pos); peakNtl = peak * l.price; }
  }
  const sum = (k) => t.legs.reduce((s, l) => s + l[k], 0);
  const grossPnl = sum('closedPnl'), fees = sum('fee'), notional = sum('notional');
  return { ...t, peakSize: peak, peakNotional: peakNtl, avgEntry: inSz ? inNtl / inSz : null, avgExit: outSz ? outNtl / outSz : null,
    grossPnl, fees, net: grossPnl - fees, notional, makerNotional: sum('makerNotional'), takerNotional: sum('takerNotional'),
    makerShare: notional ? sum('makerNotional') / notional : null, fills: sum('fills') };
}

// ---------------------------------------------------------------- per-trip metrics

// Hyperliquid cross-margin liquidation distance: equity E against a position of notional N
// with maintenance margin rate mmr = 1 / (2 × max leverage).
export const liqDistance = (E, N, mmr) => (N > 0 ? (E - N * mmr) / (N * (1 + mmr)) : null);

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

// ctx: { acct, equityAt(ts), mmr, candles, ivMs, candles15, end }
export function tripMetrics(t, ctx) {
  const acct = ctx.acct;
  const m = { acct, netPct: acct ? t.net / acct : null, feeDrag: t.grossPnl > 0 ? t.fees / t.grossPnl : null, heldMin: ((t.closed ?? ctx.end) - t.opened) / 60000 };

  // Liquidation distance after every open/add (and just before each add, for the bullets).
  m.liqDist = null; m.liqUnknown = false;
  for (const l of t.legs) {
    if (l.kind !== 'open' && l.kind !== 'add') continue;
    const E = ctx.mmr ? ctx.equityAt(l.ts) : null;
    if (E == null) { l.liqDist = null; m.liqUnknown = true; continue; }
    l.liqDist = liqDistance(E, Math.abs(l.posAfter) * l.price, ctx.mmr);
    if (l.kind === 'add') l.liqBefore = liqDistance(E, Math.abs(l.posBefore) * l.price, ctx.mmr);
    if (m.liqDist == null || l.liqDist < m.liqDist) m.liqDist = l.liqDist;
  }
  if (m.liqUnknown) m.liqDist = null; // one unknown leg could have been the closest: don't guess

  // Unrealized at each add (at the add's own price), for adding to a loser.
  m.addedToLoser = false;
  for (const [i, l] of t.legs.entries()) {
    if (l.kind !== 'add') continue;
    const prevAvg = t.legs[i - 1].avgAfter;
    l.upnlBefore = l.posBefore * (l.price - prevAvg);
    if (acct && l.upnlBefore < -RUBRIC.loserPct * acct) { m.addedToLoser = true; l.loser = true; }
  }

  // MAE / MFE: each candle is checked against every position held during it.
  const bars = ctx.candles ?? [];
  if (bars.length) {
    let mae = 0, mfe = 0, j = 0, state = null;
    const end = t.closed ?? Infinity;
    for (const b of bars) {
      if (b.t + ctx.ivMs <= t.opened || b.t > end) continue;
      const states = state ? [state] : [];
      while (j < t.legs.length && t.legs[j].ts < b.t + ctx.ivMs) {
        const l = t.legs[j++];
        state = l.posAfter ? { pos: l.posAfter, avg: l.avgAfter } : null;
        if (state) states.push(state);
      }
      for (const s of states) {
        const worst = s.pos > 0 ? b.l : b.h, best = s.pos > 0 ? b.h : b.l;
        mae = Math.min(mae, s.pos * (worst - s.avg));
        mfe = Math.max(mfe, s.pos * (best - s.avg));
      }
    }
    Object.assign(m, { mae, mfe, maePct: acct ? -mae / acct : null, mfePct: acct ? mfe / acct : null });
  } else Object.assign(m, { mae: null, mfe: null, maePct: null, mfePct: null });

  // Where in the last hour's range the first entry landed.
  m.location = null;
  const first = t.legs[0];
  const win = bars.filter((b) => b.t >= first.ts - RUBRIC.locationWindowMin * 60000 && b.t + ctx.ivMs <= first.ts);
  if (win.length >= (RUBRIC.locationWindowMin * 60000 / ctx.ivMs) * 0.5) {
    const lo = Math.min(...win.map((b) => b.l)), hi = Math.max(...win.map((b) => b.h));
    if (hi > lo) {
      const p = (first.price - lo) / (hi - lo);
      const q = t.side === 'LONG' ? p : 1 - p; // 0 = the good end of the range
      m.locationP = p;
      m.location = q <= RUBRIC.edge ? 'edge' : q > RUBRIC.wrong ? 'wrong' : 'mid';
    }
  }

  // Opening or adding right after a high-volume 15m candle that closed against the leg.
  m.againstMomentum = false;
  const c15 = ctx.candles15 ?? [];
  const mo = RUBRIC.momentum, q15 = INTERVAL_MS['15m'];
  for (const l of t.legs) {
    if (l.kind !== 'open' && l.kind !== 'add') continue;
    const short = l.side === 'SELL';
    for (const b of c15) {
      // During the candle or up to 30 minutes after it closed.
      if (l.ts < b.t || l.ts > b.t + q15 + mo.afterMin * 60000) continue;
      const prior = c15.filter((x) => x.t < b.t && x.t >= b.t - mo.lookbackH * 3_600_000).map((x) => x.v);
      const med = median(prior);
      const against = short ? b.c > b.o : b.c < b.o;
      if (med && prior.length >= 24 && b.v >= mo.volX * med && Math.abs(b.c - b.o) / b.o >= mo.body && against) {
        m.againstMomentum = true;
        const x = { leg: l, candle: b, volX: b.v / med };
        if (!m.momentum || x.volX > m.momentum.volX) m.momentum = x;
      }
    }
  }
  return m;
}

// Points per component, total and letter. Unknown metrics score 0.
export function gradeTrip(t, m) {
  const R = RUBRIC;
  const pts = {
    outcome: m.netPct == null ? 0 : clamp(m.netPct * 100 * R.outcome.perPct, -R.outcome.cap, R.outcome.cap),
    feeDrag: m.feeDrag == null ? 0 : band(R.feeDrag, m.feeDrag),
    liqDist: m.liqDist == null ? 0 : band(R.liqDist, m.liqDist),
    mae: m.maePct == null ? 0 : band(R.mae, m.maePct),
    addedToLoser: m.addedToLoser ? R.addedToLoser : 0,
    location: m.location ? R.location[m.location] : 0,
    againstMomentum: m.againstMomentum ? R.againstMomentum : 0,
  };
  let score = clamp(R.base + Object.values(pts).reduce((s, x) => s + x, 0), 0, 100);
  if (t.net > 0 && score < R.winnerFloor) { pts.floor = R.winnerFloor - score; score = R.winnerFloor; }
  return { score, letter: letter(score), points: pts };
}

// ---------------------------------------------------------------- the day

const usd = (n) => `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
const usdS = (n) => `${n > 0 ? '+' : ''}${usd(n)}`;
const pctS = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const kUsd = (n) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}K` : usd(n));
const sz = (n) => (+n.toFixed(n >= 1 ? 2 : 4)).toString();
const dur = (min) => (min < 60 ? `${Math.round(min)}m` : `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`);
const refs = (ts) => ts.map((t) => `#${t.n}`).join(', ').replace(/, (#\d+)$/, ' and $1');
const hhmm = (ts, tz) => new Date(ts).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: false });

// Pure: trips with metrics and grades in, cards + bullets + bottom line out.
// Net is the day's closed trips (+ funding); fees, maker share and turnover are the orders
// placed that day, open trips included. dctx: { tz, dayStart, dayEnd, rates, funding,
// dayStartValue, fillCount, noStop(trip) }
export function dayReview(trips, dctx) {
  const closed = trips.filter((t) => !t.open);
  const graded = closed.filter((t) => t.grade);
  const legs = trips.flatMap((t) => t.legs).filter((l) => l.ts >= dctx.dayStart && l.ts < dctx.dayEnd);
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
  const gross = sum(closed, (t) => t.grossPnl), fees = sum(legs, (l) => l.fee);
  const posGross = sum(closed, (t) => Math.max(t.grossPnl, 0));
  const notional = sum(legs, (l) => l.notional), maker = sum(legs, (l) => l.makerNotional), taker = sum(legs, (l) => l.takerNotional);
  const feeLeg = (liq) => sum(legs, (l) => (l.makerNotional + l.takerNotional ? l.fee * (liq === 'maker' ? l.makerNotional : l.takerNotional) / (l.makerNotional + l.takerNotional) : 0));
  const spread = dctx.rates ? dctx.rates.taker - dctx.rates.maker : null;
  const known = maker + taker;

  let dayScore = graded.length ? sum(graded, (t) => t.grade.score) / graded.length : null;
  const capped = dayScore != null && graded.some((t) => t.m.liqDist != null && t.m.liqDist < RUBRIC.dayCapBelowLiq) && dayScore > RUBRIC.dayCap;
  if (capped) dayScore = RUBRIC.dayCap;

  const cards = {
    grade: dayScore == null ? null : { score: Math.round(dayScore), letter: letter(dayScore), capped },
    net: closed.length ? sum(closed, (t) => t.net) + (dctx.funding ?? 0) : null, gross, funding: dctx.funding,
    fees, makerFees: feeLeg('maker'), takerFees: feeLeg('taker'),
    feeDrag: posGross > 0 ? fees / posGross : null,
    makerShare: known ? maker / known : null, makerKnown: notional ? known / notional : 0,
    saved: spread != null ? maker * spread : null,
    turnover: dctx.dayStartValue ? notional / dctx.dayStartValue : null, notional, dayStartValue: dctx.dayStartValue,
    trips: closed.length, orders: legs.filter((l) => !l.flip).length, fills: dctx.fillCount?.total ?? sum(legs, (l) => l.fills),
    takerFills: dctx.fillCount?.taker ?? null,
  };

  const good = [], bad = [];
  const add = (list, id, text, impact) => list.push({ id, text, impact });
  const wins = closed.filter((t) => t.net > 0);

  // Good
  if (cards.makerShare != null && cards.makerShare >= RUBRIC.makerGood && cards.makerKnown > 0.9)
    add(good, 'G1', `${pctS(cards.makerShare)} maker fills${cards.saved != null ? `: ~${usd(cards.saved)} saved vs taker` : ` on ${kUsd(maker)} traded`}`, cards.saved ?? 0);
  const edges = graded.filter((t) => t.m.location === 'edge' && t.net > 0);
  if (edges.length >= 2) {
    const sides = new Set(edges.map((t) => t.side));
    const how = sides.size > 1 ? 'bought near support / sold near resistance' : sides.has('LONG') ? 'bought near support' : 'sold near resistance';
    add(good, 'G2', `${refs(edges)} ${how} (${usdS(sum(edges, (t) => t.net))} net)`, sum(edges, (t) => t.net));
  }
  const gaveBack = graded.filter((t) => t.m.mfePct != null && t.m.mfePct >= RUBRIC.mfeGiveBack && t.net <= 0);
  if (wins.length >= 2 && !gaveBack.length)
    add(good, 'G3', `Took profits: no winner turned into a loss (${wins.length} winners, ${usdS(sum(wins, (t) => t.net))})`, sum(wins, (t) => t.net));
  const patient = graded.filter((t) => t.net > 0 && t.m.heldMin >= RUBRIC.patientMin && t.m.maePct != null && t.m.maePct < RUBRIC.patientMae);
  if (patient.length)
    add(good, 'G4', `Patient hold${patient.length > 1 ? 's' : ''} on ${patient.map((t) => `#${t.n} (${dur(t.m.heldMin)}, ${usdS(t.net)})`).join(patient.length > 2 ? ', ' : ' and ')}`, sum(patient, (t) => t.net));
  if (cards.feeDrag != null && cards.feeDrag < RUBRIC.feeDragGood)
    add(good, 'G5', `Fees only ${pctS(cards.feeDrag)} of gross PnL (${usd(fees)} on ${usdS(posGross)})`, posGross * (RUBRIC.feeDragGood - cards.feeDrag));
  const liqs = graded.map((t) => t.m.liqDist);
  if (graded.length && liqs.every((d) => d != null && d >= RUBRIC.liqSafe))
    add(good, 'G6', `Never closer than ${pctS(Math.min(...liqs))} to liquidation`, 0);

  // Needs work
  const stop = (t) => (dctx.noStop?.(t) ? ' with no stop' : '');
  for (const t of graded.filter((t) => t.m.againstMomentum)) {
    const { leg, candle, volX } = t.m.momentum;
    const verb = leg.kind === 'add' ? `added to the ${t.side.toLowerCase()}` : leg.side === 'SELL' ? 'shorted' : 'bought';
    add(bad, 'N1', `#${t.n} ${verb} into a high-volume move (${hhmm(candle.t, dctx.tz)} candle ${Math.round(volX)}× median volume)${stop(t)}${t.m.mae != null ? `, max drawdown ${usd(t.m.mae)}` : ''}`, Math.abs(t.m.mae ?? 0));
  }
  const n2 = new Set();
  for (const t of graded.filter((t) => t.m.addedToLoser)) {
    n2.add(t);
    const l = t.legs.filter((x) => x.loser).sort((a, b) => a.upnlBefore - b.upnlBefore)[0];
    const liq = l.liqBefore != null && l.liqDist != null ? `: liquidation distance ${pctS(l.liqBefore, 1)} → ${pctS(l.liqDist, 1)}` : '';
    add(bad, 'N2', `#${t.n} added ${sz(l.size)} ${t.symbol} while down ${usd(-l.upnlBefore)} (${pctS(-l.upnlBefore / t.m.acct, 1)} of account)${stop(t)}${liq}`, Math.abs(t.m.mae ?? l.upnlBefore));
  }
  for (const t of graded.filter((t) => t.m.liqDist != null && t.m.liqDist < RUBRIC.liqClose && !n2.has(t)))
    add(bad, 'N3', `#${t.n} got within ${pctS(t.m.liqDist, 1)} of liquidation${stop(t)}`, t.peakNotional * t.m.liqDist);
  for (const t of graded.filter((t) => (t.m.location === 'mid' || t.m.location === 'wrong') && t.grossPnl > 0 && t.fees / t.grossPnl > RUBRIC.n4FeeShare))
    add(bad, 'N4', `#${t.n} entered ${t.m.location === 'mid' ? 'mid-range' : `near the ${t.side === 'LONG' ? 'top' : 'bottom'} of the range`}; fees took ${pctS(t.fees / t.grossPnl)} of its profit`, t.fees);
  if (cards.feeDrag != null && cards.feeDrag >= RUBRIC.feeDragBad)
    add(bad, 'N5', `Fees were ${pctS(cards.feeDrag)} of gross PnL${cards.turnover != null ? ` (${Math.round(cards.turnover)}× turnover on ${kUsd(cards.dayStartValue)})` : ` (${usd(fees)})`}`, fees);
  if (taker > 0) {
    const n = cards.takerFills ?? legs.filter((l) => l.takerNotional > 0).length;
    const extra = spread != null ? taker * spread : null;
    add(bad, 'N6', `${n} taker fill${n === 1 ? '' : 's'}${extra != null ? ` cost ~${usd(extra)} more than limit orders would have` : ` on ${kUsd(taker)} notional`}`, extra ?? 0);
  }
  for (const t of gaveBack) add(bad, 'N7', `#${t.n} was up ${usd(t.m.mfe)} and closed ${usdS(t.net)}`, t.m.mfe - t.net);

  // Biggest dollar impact first; past the cap they're kept as `more` (the tab can show them).
  const rank = (xs) => xs.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const needsWork = rank(bad).slice(0, RUBRIC.perColumn);

  // Bottom line
  let bottomLine = null;
  if (graded.length) {
    const best = [...graded].sort((a, b) => b.grade.score - a.grade.score)[0];
    const risky = [...graded].sort((a, b) => (a.m.liqDist ?? Infinity) - (b.m.liqDist ?? Infinity) || (a.m.mae ?? 0) - (b.m.mae ?? 0))[0];
    if (bad.some((b) => ['N1', 'N2', 'N3'].includes(b.id))) {
      bottomLine = best !== risky
        ? `#${best.n} was your setup working; #${risky.n} is the kind of trade that can erase several of those.`
        : `#${risky.n} is the kind of trade that can erase several good ones.`;
    } else if (dayScore >= 75) {
      bottomLine = `Clean day: ${closed.length} trade${closed.length === 1 ? '' : 's'}${cards.makerShare != null ? `, ${pctS(cards.makerShare)} maker` : ''}${cards.feeDrag != null ? `, fees ${pctS(cards.feeDrag)} of gross` : ''}.`;
    } else if (needsWork.length) {
      bottomLine = `Biggest lever: ${needsWork[0].text.split(/[:(]/)[0].trim()}.`;
    } else bottomLine = `${closed.length} trade${closed.length === 1 ? '' : 's'}, day grade ${letter(dayScore)}.`;
  }
  return { cards, good: rank(good).slice(0, RUBRIC.perColumn), needsWork, goodMore: good.slice(RUBRIC.perColumn), needsWorkMore: bad.slice(RUBRIC.perColumn), bottomLine };
}

// ---------------------------------------------------------------- loading (Hyperliquid)

// Everything the review needs for one Hyperliquid account and day; network calls are
// best-effort and a failed one leaves its metric unknown.
export async function buildReview({ db, cfg, account, day }) {
  const tz = cfg.timezone;
  const user = account.address?.toLowerCase();
  const dayStart = startOfDay(Date.parse(day + 'T12:00:00Z'), tz);
  const dayEnd = startOfDay(Date.parse(addDays(day, 1) + 'T12:00:00Z'), tz);
  const fills = db.perpFills().filter((f) => f.account === account.id);
  const trips = reviewTrips(fills, { tz, day });
  trips.sort((a, b) => (a.open ? 1 : 0) - (b.open ? 1 : 0) || a.opened - b.opened).forEach((t, i) => (t.n = i + 1));

  const [rates0, levs, fundingUsd, orders, fillCount] = user ? await Promise.all([
    hl.feeRates(user), hl.maxLeverage(), hl.funding(user, dayStart, dayEnd), hl.historicalOrders(user), hl.fillCount(user, dayStart, dayEnd),
  ]) : [];
  // Fallback rates: the median fee/notional of the day's own maker and taker fills.
  let rates = rates0;
  if (!rates) {
    const dayFills = fills.filter((f) => f.ts >= dayStart && f.ts < dayEnd && f.notional > 0);
    const rate = (liq) => median(dayFills.filter((f) => f.liquidity === liq).map((f) => f.fee / f.notional));
    const maker = rate('maker'), taker = rate('taker');
    rates = maker != null && taker != null ? { taker, maker, fallback: true } : null;
  }

  const snapMax = RUBRIC.snapMaxAgeMin * 60000;
  const equityAt = (ts) => { const s = db.lastSnapBefore(account.id, ts + 1); return s && ts - s.ts <= snapMax ? s.value : null; };
  const valueAt = (ts) => (db.lastSnapBefore(account.id, ts + 1) ?? db.firstSnapSince(account.id, ts))?.value ?? null;

  let candleInterval = null;
  for (const t of trips) {
    const end = t.closed ?? Math.min(Date.now(), dayEnd);
    const from = t.opened - RUBRIC.locationWindowMin * 60000;
    const iv = pickInterval(db, t.symbol, from, end);
    candleInterval = !candleInterval || INTERVAL_MS[iv] > INTERVAL_MS[candleInterval] ? iv : candleInterval;
    const [candles, candles15] = await Promise.all([
      getCandles(db, t.symbol, iv, from, end).catch(() => null),
      getCandles(db, t.symbol, '15m', t.opened - (RUBRIC.momentum.lookbackH + 1) * 3_600_000, end).catch(() => null),
    ]);
    const mmr = levs?.[t.symbol] ? 1 / (2 * levs[t.symbol]) : null;
    t.m = tripMetrics(t, { acct: valueAt(t.opened), equityAt, mmr, candles, ivMs: INTERVAL_MS[iv], candles15, end });
    t.m.candles = !!candles?.length;
    if (!t.open) t.grade = gradeTrip(t, t.m);
  }

  // A stop is a reduce-only trigger order for the coin, on the closing side, placed while the trip was open.
  const noStop = (t) => {
    if (!orders || t.opened < orders.since) return false;
    const side = t.side === 'LONG' ? 'A' : 'B';
    return !orders.orders.some((o) => o.coin === t.symbol && o.isTrigger && o.reduceOnly && /stop/i.test(o.orderType ?? '') && o.side === side
      && o.timestamp >= t.opened - 60_000 && o.timestamp <= t.closed);
  };
  const day0 = valueAt(dayStart);
  const out = dayReview(trips, { tz, dayStart, dayEnd, rates, funding: fundingUsd, dayStartValue: day0, fillCount, noStop });
  return {
    day, account: account.id, candleInterval, ...out, funding: fundingUsd, rates,
    trips: trips.map(({ m, ...t }) => ({ ...t, m: m && { ...m, momentum: m.momentum && { t: m.momentum.candle.t, volX: m.momentum.volX, legTs: m.momentum.leg.ts } } })),
  };
}

// Days (in `tz`) with perp fills for an account, oldest first.
export const tradingDays = (db, accountId, tz) => [...new Set(db.perpFills().filter((f) => f.account === accountId).map((f) => dayKey(f.ts, tz)))];
