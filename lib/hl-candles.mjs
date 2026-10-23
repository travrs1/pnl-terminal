// Hyperliquid candles for the Review tab, cached in SQLite.
//
// The info API only serves the most recent ~5,000 candles per interval (1m ≈ 3.5 days,
// 5m ≈ 17 days, 15m ≈ 52 days), so a day is reviewed on the finest interval that is
// still served or already cached. Only closed candles are cached; the rest is re-fetched.
import { postJson, num } from './util.mjs';

const API = 'https://api.hyperliquid.xyz/info';
export const INTERVAL_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000 };
const SERVED = 5000; // candles the API keeps per interval

// The finest interval that covers [startTs, endTs): still served by the API, or cached.
export function pickInterval(db, coin, startTs, endTs, now = Date.now()) {
  for (const [iv, ms] of Object.entries(INTERVAL_MS)) {
    if (startTs >= now - SERVED * ms * 0.95) return iv;
    const want = Math.floor((Math.min(endTs, now) - startTs) / ms);
    if (want > 0 && db.candles(coin, iv, startTs, endTs).length >= want * 0.98) return iv;
  }
  return '15m';
}

// Candles overlapping [startTs, endTs), oldest first: { t, o, h, l, c, v }.
export async function getCandles(db, coin, interval, startTs, endTs) {
  const ms = INTERVAL_MS[interval];
  const now = Date.now();
  const from = Math.floor(startTs / ms) * ms;
  const cached = db.candles(coin, interval, from, endTs);
  const have = new Set(cached.map((k) => k.t));
  // First slot that should be closed but isn't cached; past it, everything is fetched.
  let missing = null;
  for (let t = from; t < endTs && t + ms <= now; t += ms) if (!have.has(t)) { missing = t; break; }
  const lastClosed = Math.floor(now / ms) * ms - ms;
  if (missing == null && (endTs <= lastClosed + ms)) return cached;
  const start = missing ?? Math.max(from, lastClosed + ms);
  const fresh = [];
  for (let a = start; a < endTs; a += SERVED * ms) {
    const rows = await postJson(API, { type: 'candleSnapshot', req: { coin, interval, startTime: a, endTime: Math.min(endTs, a + SERVED * ms) - 1 } });
    for (const k of rows ?? []) fresh.push({ t: k.t, o: num(k.o), h: num(k.h), l: num(k.l), c: num(k.c), v: num(k.v) });
  }
  db.addCandles(coin, interval, fresh.filter((k) => k.t + ms <= now));
  const byT = new Map(cached.map((k) => [k.t, k]));
  for (const k of fresh) if (k.t >= from && k.t < endTs) byT.set(k.t, k);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}
