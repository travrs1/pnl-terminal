// Dashboard client: one SSE stream, everything re-renders from the latest state.
import { initSetup, openSetup, setupTick, api } from './setup.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const usd0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sig3 = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 });
const qtyFmt = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 });

const money = (n, { sign = false, cents = false } = {}) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const r = cents ? Math.round(n * 100) / 100 : Math.round(n);
  const s = (cents ? usd2 : usd0).format(Math.abs(r));
  const pre = r < 0 ? '-' : sign && r > 0 ? '+' : '';
  return `${pre}$${s}`;
};
const short = (n, { sign = false } = {}) => {
  const a = Math.abs(n);
  const pre = n < 0 ? '-' : sign && n > 0 ? '+' : '';
  if (a >= 1e6) return `${pre}$${(a / 1e6).toFixed(2)}m`;
  if (a >= 1e3) return `${pre}$${(a / 1e3).toFixed(1)}k`;
  return `${pre}$${a.toFixed(0)}`;
};
const price = (n) => (n == null || !n ? '' : n >= 1 ? `$${usd2.format(n)}` : `$${sig3.format(n)}`);
const pct = (n, sign = true) => `${sign && n > 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
const cls = (n) => (n >= 0.5 ? 'g' : n <= -0.5 ? 'p' : '');
const timeStr = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
const dayLabel = (day) => new Date(day + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });

let S = null;
let ui = { tab: localStorage.getItem('pnl:tab') || 'today', mode: 'pnl', range: 'ALL', open: new Set() };
let prevToday = null;

// ---------- tabs ----------
function setTab(t) {
  if (!document.getElementById(`tab-${t}`)) t = 'today'; // e.g. a tab remembered from an older version
  ui.tab = t;
  try { localStorage.setItem('pnl:tab', t); } catch {}
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${t}`));
  if (S) render();
  if (t === 'settings') loadSchwab();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
setTab(ui.tab);

// ---------- clock ----------
setInterval(() => {
  const t = timeStr(Date.now());
  $('clock').textContent = t;
  $('clockTop').textContent = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' + t.slice(0, 5);
}, 1000);

// ---------- since you last checked ----------
let lastSeen = null;
try { lastSeen = JSON.parse(localStorage.getItem('pnl:lastSeen')); } catch {}
const saveSeen = () => { if (S) try { localStorage.setItem('pnl:lastSeen', JSON.stringify({ run: S.records.totalPnl, ts: Date.now() })); } catch {} };
document.addEventListener('visibilitychange', () => document.hidden && saveSeen());
window.addEventListener('beforeunload', saveSeen);

// ---------- accounts & keys popup ----------
initSetup({ getState: () => S, onSaved: ({ goto }) => { if (goto) setTab(goto); } });
$('acctBtn').addEventListener('click', () => openSetup());
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-open-setup]')) return;
  e.preventDefault();
  openSetup(S?.needsSetup ? 'add' : undefined);
});
let setupShown = false;

// ---------- stream ----------
function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    S = JSON.parse(e.data);
    render();
    setupTick();
    // First visit with nothing connected: open the popup straight away.
    if (S.needsSetup && !setupShown) { setupShown = true; openSetup(); }
  };
  es.onerror = () => { es.close(); setTimeout(connect, 3000); };
}
connect();

function render() {
  $('demoTag').hidden = !S.demo;
  $('welcome').hidden = !S.needsSetup;
  $('acctBtn').hidden = S.demo;
  renderHero();
  if (ui.tab === 'today') { renderMilestones(); renderPnl(); renderRecords(); renderAccounts(); }
  if (ui.tab === 'positions') { renderStatus(); renderBook(); renderExposure(); renderChart(); renderFeed(); }
  if (ui.tab === 'trades') renderTrades();
  if (ui.tab === 'history') { renderCalendar(); renderDays(); }
  if (ui.tab === 'settings') renderSettings();
}

// ---------- today ----------
function renderHero() {
  const neg = S.todayPnl < 0;
  document.body.classList.toggle('neg', neg);
  $('badge').textContent = neg ? 'NEGATIVE PNL.' : 'POSITIVE PNL.';
  $('badge').classList.toggle('neg', neg);
  $('tzAbbr').textContent = new Date().toLocaleTimeString('en-US', { timeZone: S.tz, timeZoneName: 'short' }).split(' ').pop();
  const big = $('todayPnl');
  big.textContent = money(S.todayPnl, { sign: true });
  big.style.color = neg ? 'var(--pink)' : '';
  if (prevToday != null && Math.abs(S.todayPnl - prevToday) >= 1) {
    big.classList.remove('flash-g', 'flash-p'); void big.offsetWidth;
    big.classList.add(S.todayPnl > prevToday ? 'flash-g' : 'flash-p');
  }
  prevToday = S.todayPnl;
  $('todayPct').textContent = pct(S.todayPct);
  $('todayPct').classList.toggle('neg', neg);
  $('nav').textContent = money(S.nav);
  const r = S.records;
  $('runPnl').innerHTML = `<span class="${cls(r.totalPnl)}">${money(r.totalPnl, { sign: true })} (${pct(r.totalPct)})</span>`;
  $('runSince').textContent = r.since ? `(Since ${new Date(r.since + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})` : '';
  $('runBreakdown').innerHTML = r.since
    ? `<span>Started <b>${money(r.startValue)}</b> on ${dayLabel(r.since)}</span><span>${r.added >= 0 ? 'Added' : 'Withdrew'} <b>${money(Math.abs(r.added))}</b> since</span><span>Put in <b>${money(r.netDeposited)}</b> total</span><span>Worth <b>${money(S.nav)}</b> now</span>`
    : '';
  if (lastSeen) {
    const d = r.totalPnl - lastSeen.run;
    $('sinceChecked').innerHTML = `Since you last checked: <b class="${cls(d)}">${short(d, { sign: true })}</b>`;
  }
  renderSpark();
  document.title = `${money(S.todayPnl, { sign: true })} · PnL Terminal`;
}

function renderSpark() {
  const pts = S.intraday;
  const svg = $('spark');
  if (pts.length < 2) { svg.innerHTML = ''; return; }
  const W = 260, H = 90;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = S.dayStart, x1 = Math.max(x0 + 3600e3, xs.at(-1));
  let lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  if (hi - lo < 1) hi = lo + 1;
  const X = (t) => ((t - x0) / (x1 - x0)) * W, Y = (v) => H - ((v - lo) / (hi - lo)) * H;
  const color = ys.at(-1) >= 0 ? 'var(--green)' : 'var(--pink)';
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  svg.innerHTML = `<line x1="0" x2="${W}" y1="${Y(0)}" y2="${Y(0)}" stroke="#333" stroke-dasharray="3 4"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <circle cx="${X(xs.at(-1))}" cy="${Y(ys.at(-1))}" r="3" fill="${color}"/>`;
  const prev = pts.length > 2 ? pts.at(-2)[1] : 0;
  const delta = ys.at(-1) - prev;
  $('sparkLabel').innerHTML = `<span class="${cls(delta)}">${delta >= 0 ? '▲' : '▼'} ${money(Math.abs(delta))}</span> · ${timeStr(xs.at(-1))}`;
}

function renderPnl() {
  const u = S.unrealized, t = S.trades, r = S.records;
  const card = (k, v, s, c = '') => `<div class="card"><div class="k">${k}</div><div class="v lg ${c}">${v}</div><div class="s">${s}</div></div>`;
  $('pnlSince').textContent = r.since ? `Run since ${dayLabel(r.since)}` : '';
  $('pnlCards').innerHTML = [
    card('Unrealized PnL', money(u.total, { sign: true }), u.unknown > 1 ? `open positions · ${short(u.unknown)} with no cost basis` : 'open positions, vs cost basis', cls(u.total)),
    card('Realized PnL', money(t.realized, { sign: true }), `${t.completed} closed trades · spot ${short(t.realizedSpot, { sign: true })} · perps ${short(t.realizedPerp, { sign: true })}`, cls(t.realized)),
    card('Today', money(S.todayPnl, { sign: true }), `${pct(S.todayPct)} on the day`, cls(S.todayPnl)),
    card('Run PnL', money(r.totalPnl, { sign: true }), `${pct(r.totalPct)} · deposits excluded`, cls(r.totalPnl)),
  ].join('');
  const rows = byValue(S.accounts.filter((a) => a.value != null));
  $('pnlBody').innerHTML = rows.map((a) => {
    const un = u.byAccount[a.id];
    return `<tr><td>${esc(a.name)}</td><td class="r">${money(a.value)}</td><td class="r ${cls(a.today)}">${money(a.today, { sign: true })}</td>
      <td class="r ${cls(un)}">${un == null ? '<span class="muted">—</span>' : money(un, { sign: true })}</td></tr>`;
  }).join('') + `<tr class="total"><td>Total</td><td class="r">${money(S.nav)}</td><td class="r ${cls(S.todayPnl)}">${money(S.todayPnl, { sign: true })}</td><td class="r ${cls(u.total)}">${money(u.total, { sign: true })}</td></tr>`;
}

// ---------- milestones ----------
const DEFAULT_MILESTONES = [75_000, 100_000, 150_000, 200_000];
const kFmt = (n) => (n >= 1e6 ? `$${+(n / 1e6).toFixed(2)}M` : `$${+(n / 1e3).toFixed(1)}K`);
let msSeen = null;
try { const v = localStorage.getItem('pnl:msHit'); if (v != null) msSeen = Number(v); } catch {}

// The configured ladder, then past the last one keep going in the same step (200K → 250K → 300K…).
// A milestone counts as hit the first day NAV closed at or above it (or right now, live).
function milestones() {
  const list = [...new Set((Array.isArray(S.milestones) && S.milestones.length ? S.milestones : DEFAULT_MILESTONES).map(Number).filter((n) => n > 0))].sort((a, b) => a - b);
  const step = list.length > 1 ? list.at(-1) - list.at(-2) : list[0];
  const peak = Math.max(S.nav || 0, ...S.days.map((d) => d.value || 0));
  while (list.at(-1) <= peak) list.push(list.at(-1) + step);
  return list.map((target) => ({
    target,
    hit: peak >= target ? (S.days.find((d) => d.value >= target)?.day ?? S.today) : null,
  }));
}

function renderMilestones() {
  const all = milestones();
  const i = all.findIndex((m) => !m.hit);
  const cur = all[i];
  const hitCount = i;
  const progress = Math.max(0, Math.min(1, S.nav / cur.target));
  $('msTarget').textContent = kFmt(cur.target);
  $('msPct').textContent = `${(progress * 100).toFixed(1)}%`;
  $('msLeft').textContent = `${money(cur.target - S.nav)} to go`;
  $('msFill').style.width = `${(progress * 100).toFixed(2)}%`;
  $('msNote').textContent = hitCount ? `${hitCount} hit · last ${kFmt(all[i - 1].target)} on ${dayLabel(all[i - 1].hit)}` : 'First one up';
  const fresh = Number.isFinite(msSeen) && hitCount > msSeen;
  // Show every hit milestone, the live one, and one locked one ahead.
  $('msLadder').innerHTML = all.slice(0, i + 2).map((m, j) => {
    const state = m.hit ? 'hit' : j === i ? 'live' : 'locked';
    const sub = m.hit ? `✓ ${dayLabel(m.hit)}` : j === i ? `${(progress * 100).toFixed(0)}% there` : 'Locked';
    return `<div class="ms ${state} ${fresh && m.hit && j >= msSeen ? 'new' : ''}"><div class="ms-v mono">${kFmt(m.target)}</div><div class="ms-s">${sub}</div></div>`;
  }).join('');
  if (hitCount !== msSeen) { msSeen = hitCount; try { localStorage.setItem('pnl:msHit', String(hitCount)); } catch {} }
}

function renderRecords() {
  const r = S.records, t = S.trades;
  const firstLive = S.days.find((d) => !d.est)?.day;
  $('recNote').textContent = S.days.some((d) => d.est) ? `From every day this run · before ${dayLabel(firstLive)} rebuilt from history (est.)` : 'From every day this run';
  $('winText').innerHTML = t.completed
    ? `<b>${Math.round(t.winRate * 100)}%</b> · ${t.wins} wins · ${t.losses} losses · ${t.completed} completed trades`
    : 'no completed trades yet';
  $('winFill').style.width = `${(t.winRate * 100).toFixed(1)}%`;
  const opp = r.current.color === 'green' ? 'red' : 'green';
  const card = (k, v, s, c = '') => `<div class="card"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`;
  $('records').innerHTML = [
    card('Current streak', r.current.count ? `${r.current.count} ${r.current.color} day${r.current.count > 1 ? 's' : ''}` : '—',
      r.lastOppositeDay ? `last ${opp} day ${dayLabel(r.lastOppositeDay)}` : `no ${opp} days yet`, r.current.color === 'green' ? 'g' : r.current.color === 'red' ? 'p' : ''),
    card('Best day', r.best ? money(r.best.pnl, { sign: true }) : '—', r.best ? dayLabel(r.best.day) : 'needs a full day', 'g'),
    card('Worst day', r.worst ? money(r.worst.pnl, { sign: true }) : '—', r.worst ? dayLabel(r.worst.day) : 'needs a full day', 'p'),
    card('Longest heater', r.longestGreen, 'green days in a row', 'g'),
    card('Longest cold run', r.longestRed, 'red days in a row', 'p'),
    card('Green days', `${Math.round(r.greenPct * 100)}%`, `${r.greenDays}/${r.tradingDays} · ${short(r.totalPnl, { sign: true })} total`),
  ].join('');
}

function renderAccounts() {
  const list = byValue(S.accounts);
  $('acctCount').textContent = `${list.filter((a) => a.status === 'ok').length}/${list.filter((a) => a.status !== 'setup').length} live`;
  $('accounts').innerHTML = list.map((a) => `
    <div class="acct">
      <div class="name"><span class="dot ${dotCls(a)}"></span>${esc(a.name)}</div>
      <div class="val">${a.value == null ? '—' : money(a.value)}</div>
      <div class="chg ${cls(a.today)}">${a.today == null ? '' : money(a.today, { sign: true }) + ' today'}</div>
      ${a.status === 'error' ? `<div class="err">${esc(a.error)}</div>` : a.status === 'setup' ? `<div class="err muted">Not set up yet · <a href="#" data-open-setup>add keys</a></div>` : ''}
    </div>`).join('');
}
// Richest account first; ones with no value yet (not set up, erroring) go last in setup order.
const byValue = (list) => [...list].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
const dotCls = (a) => (a.status === 'setup' ? 'off' : a.status === 'error' ? (a.value != null ? 'stale' : 'err') : a.status === 'pending' ? 'stale' : '');

// ---------- positions ----------
function renderStatus() {
  $('statusStrip').innerHTML = byValue(S.accounts).map((a) => `
    <div><div class="k"><span class="dot ${dotCls(a)}"></span>${esc(a.name)}</div>
    <div class="v">${a.value == null ? '—' : money(a.value)}</div>
    <div class="t">${a.status === 'setup' ? 'not set up' : a.status === 'error' ? (a.value != null ? 'stale · retrying' : 'error · retrying') : a.updatedAt ? 'updated ' + timeStr(a.updatedAt) : 'connecting…'}</div></div>`).join('');
  $('bookSince').textContent = `Live since 00:00 · ${new Date(S.dayStart).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

const kindLabel = { crypto: 'Crypto', perp: 'Perps', stock: 'Stock', option: 'Option', cash: 'Cash' };

// Qty-weighted avg cost and price across legs, when they're the same kind and side
// (e.g. one stock held in several accounts). Mixed legs like spot + perp aren't averaged.
function blended(legs) {
  if (legs.length < 2 || legs.some((l) => l.kind !== legs[0].kind || l.side !== legs[0].side || !l.qty || l.avg == null || l.price == null)) return null;
  const qty = legs.reduce((s, l) => s + l.qty, 0);
  return { avg: legs.reduce((s, l) => s + l.avg * l.qty, 0) / qty, price: legs.reduce((s, l) => s + l.price * l.qty, 0) / qty };
}

function renderBook() {
  let html = '';
  let total = 0, totalToday = 0, totalUpnl = 0;
  S.book.forEach((r, i) => {
    total += r.value; totalToday += r.today; totalUpnl += r.upnl;
    const one = r.legs.length === 1 ? r.legs[0] : null;
    const kinds = [...new Set(r.legs.map((l) => kindLabel[l.kind] ?? l.kind))];
    const side = r.legs.some((l) => l.side === 'SHORT') ? (r.legs.every((l) => l.side === 'SHORT') ? 'SHORT' : 'MIXED') : 'LONG';
    const sub = one ? `${kindLabel[one.kind] ?? one.kind} · <span class="venue">${esc(one.venue)}</span>`
      : `${r.legs.length} positions${r.legs.every((l) => l.kind === r.legs[0].kind && l.qty) ? ` · ${qtyFmt.format(r.legs.reduce((s, l) => s + l.qty, 0))}` : ''}`;
    const isCash = r.symbol === 'Cash';
    const avg = blended(r.legs);
    html += `<tr class="main" data-sym="${esc(r.symbol)}">
      <td><span class="idx">${String(i + 1).padStart(2, '0')}</span><span class="tk">${esc(r.symbol)}</span>
        <div class="tags" style="margin-left:34px">${isCash ? '' : `<span class="tag ${side === 'SHORT' ? 'short' : 'long'}">${side}</span>`}${isCash ? sub : sub}</div></td>
      <td class="r muted">${one ? price(one.avg) : avg ? price(avg.avg) : ''}</td>
      <td class="r">${one ? price(one.price) : avg ? price(avg.price) : ''}</td>
      <td class="r">${money(r.exposure)}</td>
      <td class="r ${cls(r.today)}">${isCash ? '' : money(r.today, { sign: true })}</td>
      <td class="r ${cls(r.upnl)}">${r.hasUpnl ? money(r.upnl, { sign: true }) : ''}</td></tr>`;
    if (!one && ui.open.has(r.symbol)) {
      for (const l of r.legs) {
        html += `<tr class="leg"><td><div class="legname">${kindLabel[l.kind] ?? l.kind}
            <div class="tags">${l.kind === 'cash' ? '' : `<span class="tag ${l.side === 'SHORT' ? 'short' : 'long'}">${l.side}</span>`}<span class="venue">${esc(l.venue)}</span>${l.qty ? `<span>${qtyFmt.format(l.qty)}</span>` : ''}</div></div></td>
          <td class="r">${price(l.avg)}</td><td class="r">${price(l.price)}</td><td class="r">${money(Math.abs(l.value))}</td>
          <td class="r ${cls(l.today)}">${l.kind === 'cash' ? '' : money(l.today, { sign: true })}</td>
          <td class="r ${cls(l.upnl)}">${l.upnl != null ? money(l.upnl, { sign: true }) : ''}</td></tr>`;
      }
    }
  });
  html += `<tr class="total"><td>NAV</td><td></td><td></td><td class="r">${money(S.nav)}</td>
    <td class="r ${cls(S.todayPnl)}">${money(S.todayPnl, { sign: true })}</td><td class="r ${cls(totalUpnl)}">${money(totalUpnl, { sign: true })}</td></tr>`;
  $('bookBody').innerHTML = S.book.length ? html : `<tr><td colspan="6" class="empty">No positions yet — waiting on connectors.</td></tr>`;
}
$('bookBody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr.main');
  if (!tr) return;
  const s = tr.dataset.sym;
  ui.open.has(s) ? ui.open.delete(s) : ui.open.add(s);
  renderBook();
});

function renderExposure() {
  const rows = S.book.filter((r) => r.symbol !== 'Cash').slice(0, 10);
  const cash = S.book.find((r) => r.symbol === 'Cash');
  if (cash) rows.push(cash);
  rows.sort((a, b) => b.exposure - a.exposure);
  $('exposure').innerHTML = rows.map((r) => {
    const share = S.nav ? r.exposure / S.nav : 0;
    return `<div class="exp-row"><div class="row-between"><span>${esc(r.symbol)}</span><span class="mono">${short(r.exposure)} · ${Math.round(share * 100)}%</span></div>
      <div class="exp-bar"><div style="width:${Math.min(100, share * 100)}%"></div></div></div>`;
  }).join('') || '<div class="empty">Nothing yet.</div>';
}

// ---------- performance chart ----------
document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => { ui.mode = b.dataset.mode; segOn('modeSeg', b); renderChart(); }));
document.querySelectorAll('#rangeSeg button').forEach((b) => b.addEventListener('click', () => { ui.range = b.dataset.range; segOn('rangeSeg', b); renderChart(); }));
const segOn = (id, btn) => document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b === btn));

function chartSeries() {
  if (ui.range === '1D') {
    const base = S.nav - S.todayPnl;
    return S.intraday.map(([t, v]) => ({ t, v: ui.mode === 'pnl' ? v : base + v, label: timeStr(t).slice(0, 5) }));
  }
  const n = { '1W': 8, '1M': 31, ALL: Infinity }[ui.range];
  return S.days.slice(-n).map((d) => ({ t: Date.parse(d.day + 'T12:00:00'), v: ui.mode === 'pnl' ? d.cum : d.value, label: dayLabel(d.day), pnl: d.pnl }));
}

function renderChart() {
  const svg = $('chart');
  const pts = chartSeries();
  const W = svg.clientWidth || 600, H = 320, L = 64, B = 26, T = 10;
  if (pts.length < 2) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">Not enough history yet — the chart fills in as days go by.</text>`; $('chartHead').textContent = ''; return; }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const ys = pts.map((p) => p.v);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (ui.mode === 'pnl') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const X = (i) => L + (i / (pts.length - 1)) * (W - L - 8);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${X(pts.length - 1)},${H - B}L${X(0)},${H - B}Z`;
  const peak = Math.max(...ys);
  const peakI = ys.indexOf(peak);
  let grid = '';
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    grid += `<text x="${L - 10}" y="${Y(v) + 4}" text-anchor="end">${short(v)}</text>`;
  }
  const xt = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (pts.length - 1)));
  for (const i of new Set(xt)) grid += `<text x="${X(i)}" y="${H - 6}" text-anchor="middle">${pts[i].label}</text>`;
  const last = pts.at(-1);
  svg.innerHTML = `<defs><linearGradient id="ga" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#3db6ff" stop-opacity=".28"/><stop offset="1" stop-color="#3db6ff" stop-opacity="0"/></linearGradient></defs>
    ${grid}
    ${ui.mode === 'pnl' ? `<line x1="${L}" x2="${W}" y1="${Y(0)}" y2="${Y(0)}" stroke="#2a2a30"/>` : ''}
    <line x1="${L}" x2="${W}" y1="${Y(peak)}" y2="${Y(peak)}" stroke="#555" stroke-dasharray="5 5"/>
    <text x="${L + 6}" y="${Y(peak) + 16}">Peak ${ui.mode === 'pnl' ? 'PnL' : 'value'} ${short(peak)}</text>
    <path d="${area}" fill="url(#ga)"/>
    <path d="${line}" fill="none" stroke="#3db6ff" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="${X(pts.length - 1)}" cy="${Y(last.v)}" r="5" fill="#3db6ff"/>
    <circle cx="${X(peakI)}" cy="${Y(peak)}" r="0"/>
    <line id="hoverLine" y1="${T}" y2="${H - B}" stroke="#666" stroke-dasharray="2 3" visibility="hidden"/>
    <rect x="${L}" y="0" width="${W - L}" height="${H}" fill="transparent" id="hoverRect"/>`;
  $('chartHead').innerHTML = `<span class="${ui.mode === 'pnl' ? cls(last.v) : ''}">${money(last.v, { sign: ui.mode === 'pnl' })}</span>`;
  const tip = $('chartTip');
  const rect = svg.querySelector('#hoverRect');
  rect.onmousemove = (e) => {
    const bx = svg.getBoundingClientRect();
    const x = ((e.clientX - bx.left) / bx.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((x - L) / (W - L - 8)) * (pts.length - 1))));
    const p = pts[i];
    const hl = svg.querySelector('#hoverLine');
    hl.setAttribute('x1', X(i)); hl.setAttribute('x2', X(i)); hl.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.style.left = `${(X(i) / W) * bx.width}px`;
    tip.style.top = `${(Y(p.v) / H) * bx.height}px`;
    tip.innerHTML = `${p.label}<br><b>${money(p.v, { sign: ui.mode === 'pnl' })}</b>${p.pnl != null ? `<br><span class="${cls(p.pnl)}">${money(p.pnl, { sign: true })} day</span>` : ''}`;
  };
  rect.onmouseleave = () => { tip.hidden = true; svg.querySelector('#hoverLine')?.setAttribute('visibility', 'hidden'); };
}
window.addEventListener('resize', () => S && ui.tab === 'positions' && renderChart());

// ---------- trades feed ----------
function renderFeed() {
  const feed = S.trades.feed;
  if (!feed.length) { $('feed').innerHTML = '<div class="empty">Trades from every connected venue show up here.</div>'; return; }
  const todayKey = new Date().toDateString();
  let html = '', lastDay = '';
  for (const t of feed) {
    const d = new Date(t.ts);
    const dk = d.toDateString();
    if (dk !== lastDay) {
      lastDay = dk;
      const lbl = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
      html += `<div class="day">${dk === todayKey ? 'TODAY · ' : ''}${lbl}</div>`;
    }
    const buy = t.side === 'BUY' || t.side === 'RECEIVE';
    const xfer = t.kind === 'transfer';
    const notional = t.notional != null ? ` · ${short(t.notional)}${t.kind === 'perp' ? ' notional' : ''}` : '';
    const desc = `${t.dir ? esc(t.dir) + ' · ' : ''}${qtyFmt.format(t.size)}${t.price ? ' @ ' + price(t.price) : ''}${notional}${t.note ? ' · ' + esc(t.note) : ''}`;
    const tag = xfer ? (buy ? 'IN' : 'OUT') : buy ? 'BUY' : 'SELL';
    html += `<div class="tr"><span class="side ${xfer ? 'xfer' : buy ? 'buy' : 'sell'}">${tag}</span><span class="sym">${esc(t.symbol)}</span>
      <span class="desc">${desc} · <span class="muted">${esc(t.venue)} ${timeStr(t.ts).slice(0, 5)}</span></span>
      ${t.closed_pnl ? `<span class="pnl ${cls(t.closed_pnl)}">${money(t.closed_pnl, { sign: true })}</span>` : ''}</div>`;
  }
  $('feed').innerHTML = html;
}

// ---------- history ----------
function renderCalendar() {
  const days = S.days;
  if (!days.length) { $('calendar').innerHTML = '<div class="empty">History starts building from your first day running this.</div>'; return; }
  const byDay = Object.fromEntries(days.map((d) => [d.day, d]));
  const mags = days.map((d) => Math.abs(d.pnl)).sort((a, b) => a - b);
  const scale = mags[Math.floor(mags.length * 0.9)] || 1;
  const months = [];
  const start = new Date(days[0].day + 'T12:00:00'); start.setDate(1);
  const end = new Date(S.today + 'T12:00:00');
  for (const m = new Date(start); m <= end; m.setMonth(m.getMonth() + 1)) months.push(new Date(m));
  const firstLive = S.days.find((d) => !d.est)?.day;
  $('calLegend').textContent = `color intensity scaled to ${short(scale)}${S.days.some((d) => d.est) ? ` · dashed = rebuilt estimate (before ${dayLabel(firstLive)})` : ''}`;
  $('calendar').innerHTML = months.reverse().map((m) => {
    const y = m.getFullYear(), mo = m.getMonth();
    const first = (new Date(y, mo, 1).getDay() + 6) % 7; // Monday-first
    const n = new Date(y, mo + 1, 0).getDate();
    let total = 0;
    let cells = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<div class="dow">${d}</div>`).join('') + '<div></div>'.repeat(first);
    for (let d = 1; d <= n; d++) {
      const key = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const rec = byDay[key];
      let style = '', tip = '';
      if (rec) {
        total += rec.pnl;
        const a = Math.min(1, Math.abs(rec.pnl) / scale) * 0.85 + 0.12;
        style = `background:${rec.pnl >= 0 ? `rgba(93,252,93,${a})` : `rgba(255,61,139,${a})`};color:${a > 0.5 ? '#000' : 'var(--muted)'}`;
        tip = `data-tip="${dayLabel(key)} · ${money(rec.pnl, { sign: true })}${rec.est ? ' · estimated' : ''}"`;
      }
      cells += `<div class="cell ${key === S.today ? 'today' : ''} ${rec?.est ? 'est' : ''}" style="${style}" ${tip}>${d}</div>`;
    }
    return `<div class="month"><h4>${m.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}<span class="mono ${cls(total)}">${short(total, { sign: true })}</span></h4><div class="month-grid">${cells}</div></div>`;
  }).join('');
}

function renderDays() {
  $('daysBody').innerHTML = [...S.days].reverse().map((d) => `<tr><td>${dayLabel(d.day)}${d.day === S.today ? ' <span class="chip">LIVE</span>' : d.est ? ' <span class="chip est">EST</span>' : ''}</td>
    <td class="r ${cls(d.pnl)}">${money(d.pnl, { sign: true })}</td><td class="r ${cls(d.cum)}">${money(d.cum, { sign: true })}</td><td class="r">${money(d.value)}</td></tr>`).join('');
}

// ---------- settings ----------
let lastAcctCount = -1;
function renderSettings() {
  const csvSel = $('csvAccount');
  if (csvSel.options.length !== S.accounts.length) csvSel.innerHTML = S.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  if (!jobTimer) { jobTimer = 1; pollJob(); }
  const sel = document.querySelector('#flowForm select');
  if (sel.options.length !== S.accounts.length + 1) {
    sel.innerHTML = '<option value="">Portfolio (external)</option>' + S.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    document.querySelector('#flowForm [name=date]').value = S.today;
  }
  const names = Object.fromEntries(S.accounts.map((a) => [a.id, a.name]));
  $('flowsBody').innerHTML = S.flows.map((f) => `<tr><td>${dayLabel(f.day)}</td><td>${esc(names[f.account] ?? 'Portfolio')}</td>
    <td class="r ${cls(f.amount)}">${money(f.amount, { sign: true, cents: true })}</td><td>${esc(f.note)}</td>
    <td><button class="x" data-del="${f.id}" title="Remove">✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No deposits or withdrawals logged.</td></tr>';
  if (S.accounts.length !== lastAcctCount) { lastAcctCount = S.accounts.length; loadSchwab(); }
  $('connList').innerHTML = !S.accounts.length ? '<p class="fine">No accounts yet. Use <b>Manage accounts</b> above.</p>' : S.accounts.map((a) => `<div class="conn"><span class="dot ${dotCls(a)}"></span><div><b>${esc(a.name)}</b> <span class="muted mono small">${esc(a.type ?? '')}</span>
    <div class="msg">${a.status === 'ok' ? `OK · ${money(a.value)} · updated ${timeStr(a.updatedAt)}` : esc(a.error ?? 'connecting…')}</div></div></div>`).join('');
}

$('flowForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const r = await api('/api/flows', { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) return alert((await r.json()).error);
  e.target.amount.value = ''; e.target.note.value = '';
});
$('flowsBody').addEventListener('click', async (e) => {
  const id = e.target.dataset?.del;
  if (id && confirm('Remove this entry?')) await api(`/api/flows/${id}`, { method: 'DELETE' });
});

async function loadSchwab() {
  const box = $('schwabBox');
  const st = await fetch('/api/schwab/status').then((r) => r.json()).catch(() => null);
  if (!st) return;
  if (!st.hasAccount) { box.innerHTML = ''; return; }
  if (!st.configured) { box.innerHTML = '<h3>Schwab API</h3><p class="fine">Not set up. Once your Schwab developer app is approved, paste its app key and secret under <b>Accounts &amp; keys</b>. Until then the Schwab account uses your manual holdings.</p>'; return; }
  box.innerHTML = `<h3>Schwab API</h3>
    <p class="fine">${st.connected ? `Connected. Login expires in ~${st.refreshExpiresInHours}h (Schwab forces a re-login every 7 days).` : 'Not connected.'}</p>
    <ol class="fine"><li>Click “Log in to Schwab”, sign in, approve.</li><li>You'll land on a page that won't load (127.0.0.1) — that's expected. Copy the whole URL from the address bar.</li><li>Paste it below.</li></ol>
    <button class="btn ghost" id="schwabLogin">Log in to Schwab</button>
    <input id="schwabCode" placeholder="https://127.0.0.1/?code=...&session=...">
    <button class="btn" id="schwabSubmit">Connect</button> <span id="schwabMsg" class="small"></span>`;
  $('schwabLogin').onclick = async () => window.open((await fetch('/api/schwab/authurl').then((r) => r.json())).url, '_blank');
  $('schwabSubmit').onclick = async () => {
    // A code is single-use; a second click would replace "Connected" with invalid_grant.
    if ($('schwabSubmit').disabled) return;
    $('schwabSubmit').disabled = true;
    const r = await api('/api/schwab/code', { method: 'POST', body: JSON.stringify({ code: $('schwabCode').value }) });
    $('schwabMsg').textContent = r.ok ? 'Connected ✓' : `Failed: ${(await r.json()).error}`;
    if (r.ok) loadSchwab(); else $('schwabSubmit').disabled = false;
  };
  // The auth code expires in ~30s, so connect as soon as a callback URL is pasted.
  $('schwabCode').onpaste = () => setTimeout(() => { if ($('schwabCode').value.includes('code=')) $('schwabSubmit').click(); });
}

// ---------- jobs + CSV import ----------
let jobTimer = null;
async function pollJob() {
  const { job } = await fetch('/api/jobs').then((r) => r.json());
  const out = $('jobOut');
  if (!job) return;
  out.hidden = false;
  out.textContent = `${job.name} — ${job.ended ? (job.code === 0 ? 'done' : 'failed (' + job.code + ')') : 'running…'}\n\n${job.out}`;
  out.scrollTop = out.scrollHeight;
  clearTimeout(jobTimer);
  if (!job.ended) jobTimer = setTimeout(pollJob, 2000);
}
document.querySelectorAll('[data-job]').forEach((b) => b.addEventListener('click', async () => {
  const r = await api(`/api/jobs/${b.dataset.job}`, { method: 'POST' });
  if (!r.ok) return alert((await r.json()).error);
  pollJob();
}));
async function csvSend(write) {
  const f = $('csvFile').files[0];
  if (!f) return alert('Choose a CSV file first');
  const r = await api(`/api/import/${$('csvAccount').value}${write ? '?write=1' : ''}`, { method: 'POST', body: await f.text(), headers: { 'content-type': 'text/csv' } });
  if (!r.ok) return alert((await r.json()).error);
  pollJob();
}
$('csvPreview').addEventListener('click', () => csvSend(false));
$('csvImport').addEventListener('click', () => { if (confirm('Import these rows into your history?')) csvSend(true); });

// ---------- closed trades ----------
ui.tradeAcct = 'all'; ui.tradeResult = 'all'; ui.tradeSort = { key: 'closed', asc: false };
const held = (ms) => { const h = ms / 36e5; return h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`; };
$('tradeResult').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; ui.tradeResult = b.dataset.r; segOn('tradeResult', b); renderTrades(); });
$('tradeAcct').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; ui.tradeAcct = b.dataset.a; renderTrades(); });
document.querySelectorAll('.closed-trades th[data-sort]').forEach((th) => th.addEventListener('click', () => {
  const k = th.dataset.sort;
  ui.tradeSort = ui.tradeSort.key === k ? { key: k, asc: !ui.tradeSort.asc } : { key: k, asc: ['symbol', 'venue'].includes(k) };
  renderTrades();
}));

function renderTrades() {
  const names = Object.fromEntries(S.accounts.map((a) => [a.id, a.name]));
  const all = S.trades.closed ?? [];
  const accts = [...new Set(all.map((t) => t.account))];
  $('tradeAcct').innerHTML = [['all', 'All accounts'], ...accts.map((a) => [a, names[a] ?? a])]
    .map(([id, n]) => `<button data-a="${esc(id)}" class="${ui.tradeAcct === id ? 'on' : ''}">${esc(n)} <span class="muted">${id === 'all' ? all.length : all.filter((t) => t.account === id).length}</span></button>`).join('');
  let rows = all.filter((t) => (ui.tradeAcct === 'all' || t.account === ui.tradeAcct)
    && (ui.tradeResult === 'all' || (ui.tradeResult === 'win' ? t.pnl > 0 : t.pnl <= 0)));

  const sum = (xs) => xs.reduce((s, t) => s + t.pnl, 0);
  const w = rows.filter((t) => t.pnl > 0), l = rows.filter((t) => t.pnl <= 0);
  const best = rows.reduce((b, t) => (!b || t.pnl > b.pnl ? t : b), null), worst = rows.reduce((b, t) => (!b || t.pnl < b.pnl ? t : b), null);
  const card = (k, v, sub, c = '') => `<div class="card"><div class="k">${k}</div><div class="v lg ${c}">${v}</div><div class="s">${sub}</div></div>`;
  $('tradeCards').innerHTML = [
    card('Realized PnL', money(sum(rows), { sign: true }), `won ${money(sum(w))} · lost ${money(-sum(l))}`, cls(sum(rows))),
    card('Win rate', rows.length ? `${Math.round((w.length / rows.length) * 100)}%` : '—', `${w.length} wins · ${l.length} losses`),
    card('Avg win / loss', `<span class="g">${short(w.length ? sum(w) / w.length : 0, { sign: true })}</span> <span class="muted">/</span> <span class="p">${short(l.length ? sum(l) / l.length : 0)}</span>`,
      sum(l) ? `profit factor ${(sum(w) / -sum(l)).toFixed(2)}` : ''),
    card('Best / worst', `<span class="g">${best ? short(best.pnl, { sign: true }) : '—'}</span> <span class="muted">/</span> <span class="p">${worst && worst.pnl < 0 ? short(worst.pnl) : '—'}</span>`,
      `${best ? esc(best.symbol) : ''}${worst && worst.pnl < 0 ? ' · ' + esc(worst.symbol) : ''}`),
  ].join('');
  $('tradesNote').textContent = `Since ${dayLabel(S.records.since ?? S.today)} · ${all.length} round trips`;

  const { key, asc } = ui.tradeSort;
  const val = (t) => (key === 'held' ? t.closed - t.opened : key === 'venue' ? t.venue ?? '' : t[key] ?? -Infinity);
  rows = [...rows].sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * (asc ? 1 : -1); });
  document.querySelectorAll('.closed-trades th[data-sort]').forEach((th) => { th.classList.toggle('sorted', th.dataset.sort === key); th.classList.toggle('asc', th.dataset.sort === key && asc); });

  $('tradesBody').innerHTML = rows.map((t) => `<tr>
      <td>${new Date(t.closed).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</td>
      <td><span class="tk" style="font-size:16px">${esc(t.symbol)}</span>${t.kind === 'perp' ? ' <span class="tag long">PERP</span>' : ''}${t.est ? '<span class="est-tag">est.</span>' : ''}</td>
      <td class="venue-cell">${esc(t.venue || names[t.account] || t.account)}</td>
      <td class="r muted">${held(t.closed - t.opened)}</td>
      <td class="r">${money(t.cost)}</td>
      <td class="r">${money(t.proceeds)}</td>
      <td class="r ${cls(t.pnl)}">${money(t.pnl, { sign: true })}</td>
      <td class="r ${cls(t.pnl)}">${t.pct != null ? pct(t.pct) : ''}</td></tr>`).join('')
    || '<tr><td colspan="8" class="empty">No closed trades match.</td></tr>';
}
