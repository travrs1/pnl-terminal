// Historical USD prices for backfilling: Coinbase hourly candles for majors,
// GeckoTerminal hourly OHLCV for on-chain tokens.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fetchJson, sleep } from './util.mjs';

const HOUR = 3600_000;
const hourly = new Map(); // `${src}:${id}` -> Map(hourStart -> close)

async function coinbaseHours(symbol, ts) {
  const key = `cb:${symbol}`;
  if (!hourly.has(key)) hourly.set(key, new Map());
  const m = hourly.get(key);
  const h = Math.floor(ts / HOUR) * HOUR;
  if (!m.has(h)) {
    // Fetch the 300-hour window containing ts.
    // Aligned 300-hour windows; finished ones never change, so they're cached on disk.
    const start = Math.floor(h / (300 * HOUR)) * 300 * HOUR, end = start + 299 * HOUR;
    const url = `https://api.exchange.coinbase.com/products/${symbol}-USD/candles?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(Math.min(end, Date.now())).toISOString()}`;
    const c = diskCache();
    const done = end < Date.now() - 2 * HOUR;
    const rows = done && c[url] ? c[url].v : await fetchJson(url, { headers: { 'user-agent': 'pnl-terminal' } });
    if (done && !c[url]) saveDisk(url, rows);
    for (const [t, , , , close] of rows ?? []) m.set(t * 1000, close);
    if (!m.has(h)) m.set(h, nearest(m, h));
  }
  return m.get(h);
}

function nearest(m, h) {
  let best = null, bd = Infinity;
  for (const [t, v] of m) if (Math.abs(t - h) < bd) { bd = Math.abs(t - h); best = v; }
  return best;
}

const STABLE = new Set(['USD', 'USDC', 'USDT', 'DAI', 'PYUSD', 'USDS', 'USDE']);

export async function majorUsd(symbol, ts) {
  const s = symbol.toUpperCase().replace(/^W(ETH|SOL|BNB|BTC)$/, '$1');
  if (STABLE.has(s)) return 1;
  try { return await coinbaseHours(s, ts); } catch { return null; }
}

// GeckoTerminal: network = solana | bsc | robinhood | base | eth …
const poolOf = new Map();
let lastGecko = 0;
// Past OHLCV windows never change, so responses are cached on disk; reruns are fast.
const DISK = new URL('../data/cache/gecko.json', import.meta.url);
let disk = null;
function diskCache() {
  if (!disk) { try { disk = JSON.parse(readFileSync(DISK, 'utf8')); } catch { disk = {}; } }
  return disk;
}
async function gecko(url) {
  const c = diskCache();
  const before = Number(new URL(url).searchParams.get('before_timestamp'));
  const cacheable = before && before * 1000 < Date.now() - 2 * HOUR;
  const poolLookup = url.includes('/pools?page=');
  // Finished windows forever, pool lists for a week, the current hour's window for an hour.
  const ttl = cacheable ? Infinity : poolLookup ? 7 * 864e5 : HOUR;
  if (c[url] && Date.now() - c[url].at < ttl) return c[url].v;
  const v = await geckoFetch(url);
  saveDisk(url, v);
  return v;
}
let saveTimer = null;
function saveDisk(url, v) {
  diskCache()[url] = { at: Date.now(), v };
  // Batch writes — the file is a few MB.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { mkdirSync(new URL('.', DISK), { recursive: true }); writeFileSync(DISK, JSON.stringify(disk)); } catch { /* cache is optional */ }
  }, 500);
}
async function geckoFetch(url) {
  const wait = 2100 - (Date.now() - lastGecko); // free tier: 30 req/min
  if (wait > 0) await sleep(wait);
  lastGecko = Date.now();
  for (let i = 0; i < 6; i++) {
    try { return await fetchJson(url, { headers: { accept: 'application/json' } }); }
    catch (e) { if (!/429|fetch failed|aborted/.test(e.message) || i === 5) throw e; await sleep(15_000); }
  }
  throw new Error('geckoterminal rate limited');
}

export async function tokenUsd(network, address, ts) {
  const key = `gt:${network}:${address}`;
  try {
    // A token trades in several pools; today's biggest may not have existed yet, so use
    // the most liquid pool that was already live at `ts`.
    if (!poolOf.has(key)) {
      const r = await gecko(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}/pools?page=1`);
      const a = address.toLowerCase();
      poolOf.set(key, (r?.data ?? []).slice(0, 8).map((p) => ({
        id: p.attributes.address,
        base: p.relationships?.base_token?.data?.id?.toLowerCase().endsWith(a),
        created: Date.parse(p.attributes.pool_created_at) || 0,
        ranges: [], m: new Map(),
      })));
    }
    const h = Math.floor(ts / HOUR) * HOUR;
    const pool = poolOf.get(key).find((p) => p.created <= h - HOUR);
    if (!pool) return null;
    const m = pool.m;
    // Thin tokens have gaps in their hourly candles, so remember which windows were
    // fetched and carry the last close forward instead of refetching per hour.
    if (!pool.ranges.some(([a, b]) => h >= a && h <= b)) {
      // Aligned windows so past ones are stable (and disk-cacheable).
      let before = Math.min((Math.floor(h / (900 * HOUR)) + 1) * 900 * HOUR, Math.floor(Date.now() / HOUR) * HOUR);
      if (h < before - 990 * HOUR) before = h + 900 * HOUR; // capped at "now" and too far back
      const r = await gecko(`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool.id}/ohlcv/hour?before_timestamp=${Math.floor(before / 1000)}&limit=1000&currency=usd&token=${pool.base ? 'base' : 'quote'}`);
      for (const [t, , , , close] of r?.data?.attributes?.ohlcv_list ?? []) m.set(t * 1000, close);
      pool.ranges.push([before - 1000 * HOUR, before]);
    }
    if (m.has(h)) return m.get(h);
    let best = null, bt = -Infinity;
    for (const [t, v] of m) if (t <= h && t > bt) { bt = t; best = v; }
    return best ?? nearest(m, h);
  } catch {
    return null;
  }
}
