// Polls every account on its own interval, keeps the latest values in memory,
// writes ~1/min snapshots, and builds the payload the dashboard renders.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { dayKey, startOfDay } from './util.mjs';
import { dailyPnl, records, roundTrips, spotRoundTrips, combineTrips } from './stats.mjs';
import { majorUsd, tokenUsd } from './history-prices.mjs';
import { GECKO_NET } from './prices.mjs';

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
      // Loans book their own changes (repayments) as transfers — no rebase.
      cfgHash: hashCfg(a), rebase: a.type !== 'loan' && last[a.id] != null && db.getMeta(`cfg:${a.id}`) !== hashCfg(a),
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

  // A position's "today" is measured from the first price seen today. If the server was
  // off at midnight that's whenever it came back, so for positions already held before
  // midnight, use the hourly price at midnight instead: Coinbase candles for majors,
  // GeckoTerminal for on-chain tokens (look-alikes skipped by the sanity band).
  async function seedOpens(acc, positions) {
    const now = Date.now(), t0 = startOfDay(now, tz), day = dayKey(now, tz);
    if (now - t0 < 3600e3 || acc.seeded === day) return;
    acc.seeded = day;
    const prev = JSON.parse(db.getMeta(`pos:${acc.id}`) ?? 'null');
    if (!prev || prev.ts >= t0 || now - prev.ts > 3 * 864e5) return; // was running at midnight, or too stale
    const have = db.posOpen(day, []);
    const want = positions.filter((p) => p.today === undefined && p.price > 0 && (p.kind === 'crypto' || p.kind === 'perp'));
    // Held at shutdown and sold while the server was off: still needs a midnight price
    // for its fills today to count against.
    for (const k of Object.keys(prev.positions)) {
      const [kind, symbol] = k.split(/:(.*)/);
      if (kind === 'perp' && !positions.some((p) => p.key === k)) want.push({ key: k, symbol, kind, price: null });
    }
    for (const p of want) {
      const key = `${acc.id}:${p.key}`;
      if (key in have || !(p.key in prev.positions)) continue;
      // close of the hour ending at midnight
      let px = await majorUsd(p.symbol, t0 - 3600e3).catch(() => null);
      if (!(px > 0) && p.token && GECKO_NET[p.token.chain]) px = await tokenUsd(GECKO_NET[p.token.chain], p.token.address, t0 - 3600e3);
      if (px > 0 && (p.price == null || (px / p.price > 0.5 && px / p.price < 2))) db.posOpen(day, [[key, px]]);
    }
  }

  // After downtime across midnight, the last saved value is from whenever the server
  // stopped, not midnight. Rebuild the midnight value from what's held now: subtract each
  // position's move since midnight (midnight prices, plus today's fills at their prices).
  // Stored once per day; flows during the gap are taken off when it's used.
  function rebuildMidnight(acc, positions, value) {
    const now = Date.now(), t0 = startOfDay(now, tz), day = dayKey(now, tz);
    const metaKey = `mid:${acc.id}:${day}`;
    if (db.getMeta(metaKey)) return;
    const last = db.lastSnapBefore(acc.id, t0), first = db.firstSnapSince(acc.id, t0);
    const GAP = 15 * 60e3;
    if (!last || last.ts > t0 - GAP || t0 - last.ts > 3 * 864e5) return; // running at midnight, or too stale
    if (first && first.ts < t0 + GAP) {
      // Came back right after midnight: the first value is close enough — but it has to be
      // stored, or today would still be measured from the last save before the downtime.
      db.setMeta(metaKey, JSON.stringify({ v: first.value, at: first.ts }));
      statsCache.at = 0;
      console.log(`[${acc.id}] server was off before midnight — midnight value set to ${first.value.toFixed(2)} (was ${last.value.toFixed(2)} at last save)`);
      return;
    }
    if (now - t0 < GAP) return;
    const legs = accountLegs(acc.id, positions, day, t0);
    const moved = legs.reduce((s, l) => s + l.today, 0);
    db.setMeta(metaKey, JSON.stringify({ v: value - moved, at: now }));
    statsCache.at = 0;
    console.log(`[${acc.id}] server was off at midnight — midnight value rebuilt as ${(value - moved).toFixed(2)} (was ${last.value.toFixed(2)} at last save)`);
  }

  function midnightBase(accId, day, t0) {
    const m = JSON.parse(db.getMeta(`mid:${accId}:${day}`) ?? 'null');
    return m ? m.v - db.flowsSince(accId, t0, m.at) : null;
  }

  // One position's PnL since midnight. Units held at midnight move from the midnight price;
  // units bought or sold today count from their fill price; fees come off.
  //   today = q_mid·(px − px_mid) + Σ fill_qty·(px − fill_px) − fees,  q_mid = q_now − Σ fill_qty
  // Without fills for a position this is just q·(px − px_mid), as before.
  function legToday(p, open, fills) {
    const sign = p.side === 'SHORT' ? -1 : 1;
    const qNow = (p.qty ?? 0) * sign, px = p.price;
    let net = 0, fees = 0;
    for (const f of fills) { net += f.side === 'BUY' ? f.size : -f.size; fees += f.fee ?? 0; }
    let qMid = qNow - net;
    // Fills that don't reconcile with the position (transfers, missing history) — ignore them.
    const usable = fills.length && !(p.kind !== 'perp' && qMid < -Math.max(1e-9, Math.abs(qNow) * 0.01));
    if (!usable) { fills = []; fees = 0; qMid = qNow; }
    if (Math.abs(qMid) <= Math.max(1e-9, Math.max(Math.abs(qNow), Math.abs(net)) * 1e-6)) qMid = 0;
    if (qMid && !(open > 0) && px == null) return null; // closed today, never priced at midnight
    const pxMid = open > 0 ? open : px;
    const ref = px ?? pxMid ?? 0; // closed out: nothing left to mark, so any reference cancels
    let today = qMid ? qMid * (ref - pxMid) : 0;
    // Capital at work today, for a %: what was held at midnight plus anything added.
    let run = qMid, base = qMid ? Math.abs(qMid * pxMid) : 0;
    for (const f of fills) {
      const s = f.side === 'BUY' ? f.size : -f.size, fp = f.notional ? f.notional / f.size : f.price;
      today += s * (ref - fp);
      const after = run + s;
      if (Math.abs(after) > Math.abs(run)) base += (Math.sign(after) === Math.sign(run) || !run ? Math.abs(s) : Math.abs(after)) * fp;
      run = after;
    }
    return { today: today - fees, base, fills: fills.length };
  }

  // Splits a perp's fills into round trips: each time the position goes flat or flips, the
  // trip so far is closed and its own leg (so a short closed today still shows after a new
  // long is opened). A flipping fill is split by size, fee included. qStart is the signed
  // position at midnight; returns the closed trips and the fills of the still-open one.
  function splitTrips(fills, qStart) {
    const trips = [];
    let cur = [], run = qStart, side = Math.sign(qStart);
    const part = (f, sz) => ({ ...f, size: sz, notional: f.notional != null ? f.notional * sz / f.size : null, fee: (f.fee ?? 0) * sz / f.size });
    for (const f of fills) {
      const s = f.side === 'BUY' ? f.size : -f.size, eps = Math.max(1e-9, f.size * 1e-6);
      if (!side) side = Math.sign(s);
      const after = run + s;
      if (side && Math.sign(after) === -side && Math.abs(after) > eps) {
        const close = Math.abs(run);
        if (close > eps) cur.push(part(f, close));
        trips.push({ side, fills: cur });
        cur = [part(f, f.size - close)]; side = Math.sign(after);
      } else if (Math.abs(after) <= eps) {
        cur.push(f); trips.push({ side, fills: cur }); cur = []; side = 0;
      } else cur.push(f);
      run = Math.abs(after) <= eps ? 0 : after;
    }
    return { trips, open: cur };
  }

  // Every position this account had today: held now, or closed out by today's fills.
  function accountLegs(accId, positions, day, t0) {
    const opens = db.posOpen(day, positions.map((p) => [`${accId}:${p.key}`, p.price]));
    const fills = db.fillsSince(accId, t0);
    const isPerp = (f) => f.kind === 'perp';
    const legs = [];
    // Perp round trips closed today, one leg each (the first may have been held at midnight).
    const closedTrips = (key, symbol, venue, trips) => {
      trips.forEach((t, i) => {
        const cp = { key, symbol, kind: 'perp', venue, side: t.side < 0 ? 'SHORT' : 'LONG', qty: 0, price: null, closed: true };
        const r = legToday(cp, i === 0 ? opens[`${accId}:${key}`] : null, t.fills);
        if (r) legs.push({ p: cp, today: r.today, base: r.base });
      });
    };
    for (const p of positions) {
      if (p.today !== undefined) { legs.push({ p, today: p.today, base: Math.abs(p.value) - p.today * (p.side === 'SHORT' ? -1 : 1) }); continue; }
      let mine = fills.filter((f) => f.symbol === p.symbol && isPerp(f) === (p.kind === 'perp'));
      if (p.kind === 'perp' && mine.length) {
        const net = mine.reduce((s, f) => s + (f.side === 'BUY' ? f.size : -f.size), 0);
        const { trips, open } = splitTrips(mine, (p.qty ?? 0) * (p.side === 'SHORT' ? -1 : 1) - net);
        closedTrips(p.key, p.symbol, p.venue, trips);
        mine = open;
      }
      const r = legToday(p, opens[`${accId}:${p.key}`], mine);
      legs.push({ p, today: r?.today ?? 0, base: r?.base ?? 0 });
    }
    // Closed today: fills for something no longer held.
    const groups = new Map();
    for (const f of fills) {
      const key = `${isPerp(f) ? 'perp' : 'crypto'}:${f.symbol}`;
      if (positions.some((p) => p.symbol === f.symbol && (p.kind === 'perp') === isPerp(f))) continue;
      (groups.get(key) ?? groups.set(key, []).get(key)).push(f);
    }
    for (const [key, fs] of groups) {
      const [kind, symbol] = key.split(/:(.*)/);
      if (kind === 'perp') {
        const net = fs.reduce((s, f) => s + (f.side === 'BUY' ? f.size : -f.size), 0);
        closedTrips(key, symbol, fs[0].venue, splitTrips(fs, -net).trips);
        continue;
      }
      const p = { key, symbol, kind, venue: fs[0].venue, side: 'LONG', qty: 0, price: null, closed: true };
      const r = legToday(p, opens[`${accId}:${key}`] ?? opens[`${accId}:stock:${symbol}`], fs);
      if (r) legs.push({ p, today: r.today, base: r.base });
    }
    return legs;
  }

  async function refresh(acc) {
    acc.inflight = true;
    acc.lastAttempt = Date.now();
    try {
      const st = acc.type === 'loan' ? loanState(acc) : undefined;
      const res = await acc.conn.fetchAccount(acc.cfg, cfg, st);
      if (!Number.isFinite(res.value)) throw new Error('bad value from connector');
      // A >80% one-tick drop is usually an API hiccup — require 3 confirmations.
      if (acc.value > 1000 && res.value < acc.value * 0.2 && ++acc.suspect < 3) throw new Error('value dropped >80%, confirming…');
      acc.suspect = 0;
      const positions = (res.positions ?? []).map((p) => applyCostBasis(acc.cfg, p));
      await seedOpens(acc, positions);
      Object.assign(acc, { value: res.value, positions, status: 'ok', error: null, updatedAt: Date.now() });
      if (st) settleLoan(acc, st, res.loan);
      if (acc.rebase) rebase(acc, positions, res.value);
      else if (!db.getMeta(`cfg:${acc.id}`)) db.setMeta(`cfg:${acc.id}`, acc.cfgHash);
      const since = Date.parse(cfg.tradesFrom || cfg.historyStart || 0) || 0;
      const trades = (res.trades ?? []).filter((t) => t.ts >= since);
      if (trades.length) db.addTrades(trades.map((t) => ({ ...t, account: acc.id })));
      rebuildMidnight(acc, positions, res.value);
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

  // Loans (connectors/loan.mjs). Until it opens, a loan is armed: it watches the venue the
  // collateral comes from and opens when that venue's coins drop by about the collateral,
  // when the borrowed money lands in `fundsTo`, or when `opened` is set in accounts.json.
  // If the coins left the venue (Coinbase wraps BTC into Morpho), the loan account carries
  // them from then on. Checked for a day after opening in case the venue is slow to update.
  const coinQty = (id, sym) => {
    const a = accounts.get(id);
    if (!a || a.status !== 'ok') return null;
    return a.positions.filter((p) => p.kind === 'crypto' && [sym, `CB${sym}`].includes(p.symbol.toUpperCase())).reduce((s, p) => s + p.qty, 0);
  };

  function loanState(acc) {
    const c = acc.cfg, now = Date.now();
    const st = JSON.parse(db.getMeta(`loan:${acc.id}`) ?? 'null') ?? { armedAt: now };
    const q = Number(c.collateral?.qty) || 0, sym = (c.collateral?.symbol || 'BTC').toUpperCase();
    const held = coinQty(c.collateral?.from, sym);
    const dropped = held != null && st.srcQty != null && st.srcQty - held >= q * 0.8;
    if (!st.opened) {
      const set = c.opened ? Date.parse(c.opened) : null;
      const funded = c.fundsTo && db.flows().some((f) => f.account === c.fundsTo && f.ts >= st.armedAt && f.amount >= Number(c.borrowed) * 0.9);
      if (set || dropped || funded) {
        st.opened = set && set <= now ? set : now;
        console.log(`[${acc.id}] loan opened (${set ? 'set in accounts.json' : dropped ? `${c.collateral.from} ${sym} dropped` : `deposit on ${c.fundsTo}`})`);
      } else if (held != null) st.srcQty = held;
    }
    if (st.opened && !st.moved && dropped && now - st.opened < 864e5) Object.assign(st, { moved: true, dropQty: st.srcQty - held });
    db.setMeta(`loan:${acc.id}`, JSON.stringify(st));
    return { ...st, dayStart: startOfDay(now, tz) };
  }

  // Book the loan's money moves as transfers, once each, at the price the loan was valued
  // at: the loan account gets what came in (collateral) less what went out (the borrowed
  // money), so the open only costs the fee; the collateral leaving its venue isn't a loss;
  // repayments move debt off the books. The borrowed money landing on `fundsTo` is that
  // venue's own deposit. Interest is left as PnL.
  function settleLoan(acc, st, info) {
    const c = acc.cfg, ts = Date.now(), day = dayKey(ts, tz);
    let changed = 0;
    const book = (account, amount, ext, note) => { changed += db.addFlow({ ts, day, account, amount, note, source: 'loan', ext_id: `loan:${acc.id}:${ext}` }).changes; };
    const saved = JSON.parse(db.getMeta(`loan:${acc.id}`));
    if (st.opened && !saved.booked) {
      book(acc.id, (st.moved ? info.qty * info.px : 0) - info.borrowed, 'open', `Borrowed ${info.borrowed} USDC${st.moved ? ` against ${info.qty} ${info.symbol}` : ''}`);
      // Where `fundsTo` stood before the loan: its last snapshot before the opening or the
      // borrowed money landing, whichever came first (deposits after it are taken off its PnL).
      const landed = c.fundsTo ? db.flows().filter((f) => f.account === c.fundsTo && f.ts >= st.armedAt && f.amount >= info.borrowed * 0.9).at(-1)?.ts : null;
      const snap = c.fundsTo ? (db.lastSnapBefore(c.fundsTo, Math.min(st.opened, landed ?? Infinity)) ?? { ts, value: accounts.get(c.fundsTo)?.value ?? 0 }) : null;
      Object.assign(saved, { booked: true, bookedMoved: !!st.moved, fundsStart: snap ? snap.value : null, fundsStartTs: snap ? snap.ts : null });
    }
    if (st.moved && !saved.bookedMoved) {
      book(acc.id, info.qty * info.px, 'moved', `${info.symbol} locked as loan collateral`);
      saved.bookedMoved = true;
    }
    if (st.moved && !saved.bookedOut) {
      book(c.collateral.from, -st.dropQty * info.px, 'out', `${info.symbol} moved to ${acc.name} as collateral`);
      saved.bookedOut = true;
    }
    for (const r of c.repayments ?? []) book(acc.id, Number(r.amount), `repay:${r.date}:${r.amount}`, `Loan repayment (${r.date})`);
    db.setMeta(`loan:${acc.id}`, JSON.stringify(saved));
    if (changed) statsCache.at = 0;
    acc.loan = { ...info, fundsTo: c.fundsTo, fundsStart: saved.fundsStart, fundsStartTs: saved.fundsStartTs };
  }

  // Venues that can report deposits/withdrawals do so every 10 minutes (looking back a
  // day, so restarts don't miss anything; rows are keyed by venue tx id).
  async function syncFlows(acc) {
    acc.flowSync = Date.now();
    try {
      const found = await acc.conn.flows(acc.cfg, cfg, Date.now() - 864e5);
      for (const f of found) db.addFlow({ ...f, day: dayKey(f.ts, tz), account: acc.id });
      for (const f of found) pairWalletFlow(acc, f);
      if (found.length) statsCache.at = 0;
    } catch (e) {
      console.warn(`[${acc.id}] flow sync: ${e.message}`);
    }
  }

  // Wallets can't report their own transfers, so money moved from a tracked wallet to a
  // venue (e.g. Robinhood Wallet → Hyperliquid) would show as a loss on the wallet and a
  // deposit on the venue. When a venue flow lines up with a wallet's value jumping the
  // other way by about the same amount (and no other venue already booked the other side),
  // book the mirror flow on the wallet. Keyed by the venue's tx id, so it's booked once.
  function pairWalletFlow(acc, f) {
    if (!f.ext_id || Math.abs(f.amount) < 50) return;
    const from = f.ts - 3600e3, to = f.ts + 1800e3;
    const tol = (x) => Math.abs(x + f.amount) <= Math.max(25, Math.abs(f.amount) * 0.1);
    const others = db.flows().filter((g) => g.account !== acc.id && g.ts >= from - 3600e3 && g.ts <= to + 3600e3);
    if (others.some((g) => tol(g.amount))) return;
    const snaps = db.snapshotsSince(from).filter((s) => s.ts <= to);
    let best = null;
    for (const w of accounts.values()) {
      if (w.type !== 'wallet' || w.id === acc.id) continue;
      const vals = snaps.filter((s) => s.account === w.id);
      for (let i = 1; i < vals.length; i++) {
        const step = vals[i].value - vals[i - 1].value;
        if (tol(step) && (!best || Math.abs(step + f.amount) < Math.abs(best.step + f.amount))) best = { w, step };
      }
    }
    if (!best) return;
    db.addFlow({
      ts: f.ts, day: dayKey(f.ts, tz), account: best.w.id, amount: -f.amount, source: 'paired', ext_id: `pair:${f.ext_id}`,
      note: f.amount > 0 ? `Sent to ${acc.name} (between your accounts)` : `Received from ${acc.name} (between your accounts)`,
    });
    console.log(`[${best.w.id}] matched ${acc.name} flow ${f.amount.toFixed(2)} — booked as a transfer, not PnL`);
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
    for (const id of accounts.keys()) {
      const mid = midnightBase(id, today, t0);
      if (mid == null) continue;
      base[id] = mid;
      db.setPrevClose(today, id, mid); // the gap's move belongs to the day it happened
    }
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
      // A backfill mid-rewrite leaves the trade table half-updated: keep the last stats.
      const busy = Number(db.getMeta('backfill:running')) > now - 30 * 60_000 && statsCache.trips;
      const lots = busy ? null : {};
      // Older trades only build cost basis; win rate / realized count from historyStart.
      const from = Date.parse(cfg.historyStart || 0) || 0;
      const leverage = Object.fromEntries(cfg.accounts.filter((a) => Number(a.leverage) > 0).map((a) => [a.id, Number(a.leverage)]));
      let trips = statsCache.trips;
      if (!busy) {
        const perp = roundTrips(db.perpFills(), from, leverage);
        trips = combineTrips(perp, spotRoundTrips(db.spotTrades(), cfg.costBasis, lots).filter((t) => t.closed >= from));
        openLots = lots;
      }
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

    const { book, movers } = buildBook(today, t0);
    return {
      now, tz, today, dayStart: t0, demo: !!cfg.demo, unrealized: unreal,
      nav, todayPnl, todayPct: baseTotal ? todayPnl / baseTotal : 0, flowsToday,
      accounts: acctOut,
      book, movers,
      intraday: intraday(todaySnaps, base, t0, flows.filter((f) => f.day === today), live, now),
      days: statsCache.days.map(({ day, pnl, cum, value, est }) => ({ day, pnl, cum, value, est })),
      records: statsCache.rec,
      trades: { ...statsCache.trips, feed: db.recentTrades(120) },
      flows,
      milestones: cfg.milestones,
      loans: [...accounts.values()].filter((a) => a.loan).map((a) => loanView(a, now)),
    };
  }

  // How the money the loan paid for is doing: `fundsTo`'s PnL since the loan opened.
  function loanView(acc, now) {
    const l = acc.loan, f = accounts.get(l.fundsTo);
    const fundsPnl = l.opened && f?.value != null && l.fundsStart != null ? f.value - l.fundsStart - db.flowsSince(l.fundsTo, l.fundsStartTs + 1, now + 1) : null;
    return { id: acc.id, name: acc.name, ...l, fundsName: f?.name, fundsPnl };
  }

  function buildBook(today, t0) {
    const rows = new Map();
    const movers = [];
    for (const acc of accounts.values()) {
      if (acc.value == null) continue;
      let contrib = 0;
      // Not fetched since midnight (e.g. login expired): the broker's day change is from an
      // earlier day, so it isn't today's.
      const positions = acc.updatedAt >= t0 ? acc.positions : acc.positions.map((p) => (p.today === undefined ? p : { ...p, today: 0 }));
      for (const { p, today: t, base } of accountLegs(acc.id, positions, today, t0)) {
        movers.push({ account: acc.id, symbol: p.symbol, kind: p.kind, side: p.side, venue: p.venue || acc.name, today: t, pct: base > 0 ? t / base : null, closed: !!p.closed });
        if (p.closed) continue;
        contrib += p.contrib ?? p.value;
        addRow(rows, p.symbol, { ...p, account: acc.id, today: t });
      }
      const cash = acc.value - contrib;
      // A loan's debt isn't a holding: it stays out of the book (it's in the account's value).
      if (Math.abs(cash) >= 1 && acc.type !== 'loan') addRow(rows, 'Cash', { key: 'cash', symbol: 'Cash', kind: 'cash', venue: acc.name, account: acc.id, value: cash, contrib: cash, today: 0 });
    }
    movers.sort((a, b) => b.today - a.today);
    return { book: [...rows.values()].sort((a, b) => (a.symbol === 'Cash') - (b.symbol === 'Cash') || b.exposure - a.exposure), movers };
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
