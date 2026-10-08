// Polls every account on its own interval, keeps the latest values in memory,
// writes ~1/min snapshots, and builds the payload the dashboard renders.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { dayKey, startOfDay } from './util.mjs';
import { dailyPnl, records, roundTrips, spotRoundTrips, combineTrips } from './stats.mjs';

const SNAP_EVERY = 60_000;

export function createEngine({ db, cfg, connectors }) {
  const tz = cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const bus = new EventEmitter();
  const accounts = new Map();

  // Seed with last known values so a venue that's down at boot still counts.
  const last = Object.fromEntries(db.lastBefore(Date.now() + 1).map((r) => [r.account, r.value]));
  for (const a of cfg.accounts) {
    const conn = connectors[a.type];
    if (!conn) throw new Error(`Unknown account type "${a.type}" for ${a.id}`);
    accounts.set(a.id, {
      cfg: a, conn, id: a.id, name: a.name, type: a.type, status: 'pending', error: null,
      value: last[a.id] ?? null, positions: [], updatedAt: null, lastAttempt: 0, lastSnap: 0, inflight: false, suspect: 0,
      cfgHash: hashCfg(a), rebase: last[a.id] != null && db.getMeta(`cfg:${a.id}`) !== hashCfg(a),
    });
  }

  function posMap(positions, value) {
    const m = Object.fromEntries(positions.map((p) => [p.key, p.contrib ?? p.value]));
    m.__cash = value - Object.values(m).reduce((s, v) => s + v, 0);
    return m;
  }

  function hashCfg(a) {
    const { name, ...rest } = a;
    return createHash('sha1').update(JSON.stringify({ ...rest, costBasis: undefined })).digest('hex');
  }

  // When accounts.json starts (or stops) tracking something — a new chain, token or
  // address — its value would otherwise show up as profit. On the first refresh after
  // a config change, the value of positions that weren't there before is booked as a
  // transfer in (and dropped positions as a transfer out).
  function rebase(acc, positions, value) {
    const prev = JSON.parse(db.getMeta(`pos:${acc.id}`) ?? 'null');
    if (prev) {
      const now = posMap(positions, value);
      let amount = 0;
      for (const [k, v] of Object.entries(now)) if (!(k in prev.positions)) amount += v;
      for (const [k, v] of Object.entries(prev.positions)) if (!(k in now)) amount -= v;
      // Cash included/excluded by the change (e.g. Coinbase `excludeCash`).
      amount += (now.__cash ?? 0) - (prev.positions.__cash ?? 0);
      if (Math.abs(amount) >= 1) {
        const ts = Date.now();
        db.addFlow({ ts, day: dayKey(ts, tz), account: acc.id, amount, note: 'Tracking change in accounts.json', source: 'config' });
        statsCache.at = 0;
        console.log(`[${acc.id}] config changed — booked ${amount.toFixed(2)} as a transfer, not PnL`);
      }
    }
    db.setMeta(`cfg:${acc.id}`, acc.cfgHash);
    acc.rebase = false;
  }

  // Venues only know the price an asset had when it arrived (e.g. BTC bought on Strike,
  // sent to Coinbase). `costBasis` in accounts.json — top-level or per account — overrides it.
  function applyCostBasis(acctCfg, p) {
    if (p.kind === 'perp' || p.kind === 'option') return p;
    let avg = acctCfg.costBasis?.[p.symbol] ?? cfg.costBasis?.[p.symbol];
    // Wallets don't report cost — use the FIFO lots rebuilt from backfilled trades when
    // they account for (nearly) the whole position.
    if (!avg && p.avg == null) {
      const lot = openLots[`${acctCfg.id}:${p.symbol}`];
      if (lot?.avg && lot.knownShare > 0.95 && Math.abs(lot.qty / p.qty - 1) < 0.1) avg = lot.avg;
    }
    if (!avg) return p;
    return { ...p, avg, upnl: (p.price - avg) * p.qty * (p.side === 'SHORT' ? -1 : 1) };
  }

  async function refresh(acc) {
    acc.inflight = true;
    acc.lastAttempt = Date.now();
    try {
      const res = await acc.conn.fetchAccount(acc.cfg, cfg);
      if (!Number.isFinite(res.value)) throw new Error('bad value from connector');
      // A >80% one-tick drop is usually an API hiccup — require 3 confirmations.
      if (acc.value > 1000 && res.value < acc.value * 0.2 && ++acc.suspect < 3) throw new Error('value dropped >80%, confirming…');
      acc.suspect = 0;
      const positions = (res.positions ?? []).map((p) => applyCostBasis(acc.cfg, p));
      Object.assign(acc, { value: res.value, positions, status: 'ok', error: null, updatedAt: Date.now() });
      if (acc.rebase) rebase(acc, positions, res.value);
      else if (!db.getMeta(`cfg:${acc.id}`)) db.setMeta(`cfg:${acc.id}`, acc.cfgHash);
      const since = Date.parse(cfg.tradesFrom || cfg.historyStart || 0) || 0;
      const trades = (res.trades ?? []).filter((t) => t.ts >= since);
      if (trades.length) db.addTrades(trades.map((t) => ({ ...t, account: acc.id })));
      const now = Date.now();
      if (now - acc.lastSnap >= SNAP_EVERY) {
        db.snapshot(now, acc.id, res.value, dayKey(now, tz));
        db.setMeta(`pos:${acc.id}`, JSON.stringify({ ts: now, positions: posMap(positions, res.value) }));
        acc.lastSnap = now;
      }
      bus.emit('update');
    } catch (e) {
      // "No keys yet" isn't a failure — show it as not set up rather than red.
      acc.status = /not set|not connected/i.test(e.message) && acc.value == null ? 'setup' : 'error';
      acc.error = e.message;
      if (!/confirming/.test(e.message) && acc.status !== 'setup') console.warn(`[${acc.id}] ${e.message}`);
      bus.emit('update');
    } finally {
      acc.inflight = false;
    }
  }

  // Venues that can report deposits/withdrawals do so every 10 minutes (looking back a
  // day, so restarts don't miss anything; rows are keyed by venue tx id).
  async function syncFlows(acc) {
    acc.flowSync = Date.now();
    try {
      const found = await acc.conn.flows(acc.cfg, cfg, Date.now() - 864e5);
      for (const f of found) db.addFlow({ ...f, day: dayKey(f.ts, tz), account: acc.id });
      if (found.length) statsCache.at = 0;
    } catch (e) {
      console.warn(`[${acc.id}] flow sync: ${e.message}`);
    }
  }

  function tick() {
    const now = Date.now();
    for (const acc of accounts.values()) {
      if (acc.conn.flows && acc.status === 'ok' && now - (acc.flowSync ?? 0) > 600_000) syncFlows(acc);
    }
    for (const acc of accounts.values()) {
      const every = acc.status === 'error' ? Math.max(acc.conn.interval, 30_000) : acc.conn.interval;
      if (!acc.inflight && now - acc.lastAttempt >= every) refresh(acc);
    }
  }

  let statsCache = { at: 0 };
  let openLots = {};

  function buildState() {
    const now = Date.now();
    const today = dayKey(now, tz);
    const t0 = startOfDay(now, tz);
    const base = Object.fromEntries(db.lastBefore(t0).map((r) => [r.account, r.value]));
    const todaySnaps = db.snapshotsSince(t0);
    const firstToday = {};
    for (const s of todaySnaps) firstToday[s.account] ??= s.value;

    const flows = db.flows();
    const flowsToday = flows.filter((f) => f.day === today).reduce((s, f) => s + f.amount, 0);

    const live = {};
    const acctOut = [];
    let nav = 0, baseTotal = 0, todayPnl = 0;
    for (const acc of accounts.values()) {
      if (acc.value == null) {
        acctOut.push({ id: acc.id, name: acc.name, status: acc.status, error: acc.error, value: null });
        continue;
      }
      const b = base[acc.id] ?? firstToday[acc.id] ?? acc.value;
      live[acc.id] = acc.value;
      nav += acc.value;
      baseTotal += b;
      todayPnl += acc.value - b;
      acctOut.push({ id: acc.id, name: acc.name, type: acc.type, status: acc.status, error: acc.error, value: acc.value, today: acc.value - b, updatedAt: acc.updatedAt });
    }
    todayPnl -= flowsToday;

    // Daily stats are cheap but no need to redo them every push.
    if (now - statsCache.at > 5_000) {
      // Stats cover historyStart onward; older rebuilt days stay in the DB (moving the
      // start back later is just a config change).
      const startDay = cfg.historyStart ? dayKey(Date.parse(cfg.historyStart), tz) : '';
      const days = dailyPnl(db.daily().filter((r) => r.day >= startDay), flows.filter((f) => f.day >= startDay), today, live);
      // Today's PnL comes from intraday snapshots (exact since midnight), not from the
      // difference to yesterday's close, which may be an estimate.
      const last = days.at(-1);
      if (last?.day === today) {
        last.cum += todayPnl - last.pnl;
        last.pnl = todayPnl;
      }
      const lots = {};
      // Older trades only build cost basis; win rate / realized count from historyStart.
      const from = Date.parse(cfg.historyStart || 0) || 0;
      const leverage = Object.fromEntries(cfg.accounts.filter((a) => Number(a.leverage) > 0).map((a) => [a.id, Number(a.leverage)]));
      const perp = roundTrips(db.perpFills(), from, leverage);
      const trips = combineTrips(perp, spotRoundTrips(db.spotTrades(), cfg.costBasis, lots).filter((t) => t.closed >= from));
      openLots = lots;
      statsCache = { at: now, days, rec: records(days, today), trips };
    }

    // Unrealized = open PnL of every position whose cost we know.
    const unreal = { total: 0, unknown: 0, byAccount: {} };
    for (const acc of accounts.values()) {
      if (acc.value == null) continue;
      let u = 0, known = 0;
      for (const p of acc.positions) {
        if (p.upnl == null) { unreal.unknown += Math.abs(p.value); continue; }
        u += p.upnl; known++;
      }
      unreal.byAccount[acc.id] = known ? u : null;
      unreal.total += u;
    }

    return {
      now, tz, today, dayStart: t0, demo: !!cfg.demo, unrealized: unreal,
      nav, todayPnl, todayPct: baseTotal ? todayPnl / baseTotal : 0, flowsToday,
      accounts: acctOut,
      book: buildBook(today),
      intraday: intraday(todaySnaps, base, t0, flows.filter((f) => f.day === today), live, now),
      days: statsCache.days.map(({ day, pnl, cum, value, est }) => ({ day, pnl, cum, value, est })),
      records: statsCache.rec,
      trades: { ...statsCache.trips, feed: db.recentTrades(120) },
      flows,
    };
  }

  function buildBook(today) {
    const rows = new Map();
    const opens = db.posOpen(today, [...accounts.values()].flatMap((a) => a.positions.map((p) => [`${a.id}:${p.key}`, p.price])));
    for (const acc of accounts.values()) {
      if (acc.value == null) continue;
      let contrib = 0;
      for (const p of acc.positions) {
        contrib += p.contrib ?? p.value;
        let todayPnl = p.today;
        if (todayPnl === undefined) {
          const o = opens[`${acc.id}:${p.key}`];
          todayPnl = o ? (p.price - o) * p.qty * (p.side === 'SHORT' ? -1 : 1) : 0;
        }
        addRow(rows, p.symbol, { ...p, account: acc.id, today: todayPnl });
      }
      const cash = acc.value - contrib;
      if (Math.abs(cash) >= 1) addRow(rows, 'Cash', { key: 'cash', symbol: 'Cash', kind: 'cash', venue: acc.name, account: acc.id, value: cash, contrib: cash, today: 0 });
    }
    return [...rows.values()].sort((a, b) => (a.symbol === 'Cash') - (b.symbol === 'Cash') || b.exposure - a.exposure);
  }

  function addRow(rows, symbol, leg) {
    const r = rows.get(symbol) ?? { symbol, legs: [], value: 0, exposure: 0, today: 0, upnl: 0, hasUpnl: false };
    r.legs.push(leg);
    r.value += leg.contrib ?? leg.value;
    r.exposure += Math.abs(leg.value);
    r.today += leg.today ?? 0;
    if (leg.upnl != null) { r.upnl += leg.upnl; r.hasUpnl = true; }
    rows.set(symbol, r);
  }

  // Minute-bucketed total for today, carrying each account's last value forward.
  function intraday(snaps, base, t0, flows, live, now) {
    const cur = { ...base };
    const pts = [];
    let bucket = null;
    const total = () => Object.values(cur).reduce((s, v) => s + v, 0);
    const baseTotal = () => Object.keys(cur).reduce((s, k) => s + (base[k] ?? first[k] ?? 0), 0);
    const first = {};
    for (const s of snaps) first[s.account] ??= s.value;
    const flowAt = (ts) => flows.filter((f) => f.ts <= ts).reduce((s, f) => s + f.amount, 0);
    for (const s of snaps) {
      const b = Math.floor((s.ts - t0) / 60_000);
      if (bucket != null && b !== bucket) pts.push([t0 + bucket * 60_000, total() - baseTotal() - flowAt(t0 + bucket * 60_000)]);
      cur[s.account] = s.value;
      bucket = b;
    }
    if (bucket != null) pts.push([t0 + bucket * 60_000, total() - baseTotal() - flowAt(now)]);
    Object.assign(cur, live);
    pts.push([now, total() - baseTotal() - flowAt(now)]);
    const step = Math.ceil(pts.length / 300);
    return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  }

  let timer = null;
  return {
    tz,
    // Build stats once first so wallet cost basis (FIFO lots) is ready for the first refresh.
    start() { buildState(); tick(); timer = setInterval(tick, 1_000); },
    // Used when the setup screen saves new accounts: the server builds a fresh engine.
    stop() { clearInterval(timer); bus.removeAllListeners(); },
    on: (ev, fn) => bus.on(ev, fn),
    off: (ev, fn) => bus.off(ev, fn),
    state: buildState,
    addFlow(f) {
      const ts = f.date ? Date.parse(f.date + 'T12:00:00') : Date.now();
      db.addFlow({ ts, day: f.date || dayKey(ts, tz), account: f.account || null, amount: Number(f.amount), note: f.note });
      statsCache.at = 0;
    },
    delFlow(id) { db.delFlow(id); statsCache.at = 0; },
  };
}
