// Hyperliquid account context for the Review tab: fee rates, max leverage, funding,
// recent orders (for stops) and the raw fill count. All best-effort: a failed call
// returns null and the review marks that metric unknown.
import { postJson, num } from './util.mjs';

const API = 'https://api.hyperliquid.xyz/info';
const info = (body) => postJson(API, body);
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const v = await fn().catch(() => null);
  if (v != null) cache.set(key, { at: Date.now(), v }); // don't remember a failed lookup
  return v ?? hit?.v ?? null;
}

// Effective rates after the referral and staking discounts: { taker, maker }.
export const feeRates = (user) => cached(`fees:${user}`, 3_600_000, async () => {
  const f = await info({ type: 'userFees', user });
  const k = (1 - num(f.activeReferralDiscount)) * (1 - num(f.activeStakingDiscount?.discount));
  return { taker: num(f.userCrossRate) * k, maker: num(f.userAddRate) * k };
});

// Max leverage per perp coin, e.g. { BTC: 40 }.
export const maxLeverage = () => cached('meta', 3_600_000, async () => {
  const m = await info({ type: 'meta' });
  return Object.fromEntries(m.universe.map((u) => [u.name, num(u.maxLeverage)]));
});

// Funding over [startTs, endTs): + received, − paid.
export const funding = (user, startTs, endTs) => cached(`funding:${user}:${startTs}:${endTs}`, 60_000, async () => {
  const rows = await info({ type: 'userFunding', user, startTime: startTs, endTime: endTs - 1 });
  return rows.reduce((s, r) => s + num(r.delta?.usdc), 0);
});

// The most recent orders (up to 2,000), trigger orders included, plus how far back they reach
// (fewer than 2,000 means the whole history).
export const historicalOrders = (user) => cached(`orders:${user}`, 60_000, async () => {
  const rows = await info({ type: 'historicalOrders', user });
  const orders = rows.map((r) => ({ ...r.order, status: r.status, statusTs: r.statusTimestamp }));
  return { orders, since: orders.length >= 2000 ? Math.min(...orders.map((o) => o.timestamp)) : 0 };
});

// Raw (unaggregated) perp fills over [startTs, endTs): the stored ones are merged by time.
export const fillCount = (user, startTs, endTs) => cached(`fills:${user}:${startTs}:${endTs}`, 60_000, async () => {
  let total = 0, taker = 0, start = startTs;
  for (let i = 0; i < 10; i++) {
    const page = await info({ type: 'userFillsByTime', user, startTime: start, endTime: endTs - 1 });
    for (const f of page) {
      if (f.coin.startsWith('@') || f.coin.includes('/')) continue;
      total++;
      if (f.crossed) taker++;
    }
    if (page.length < 2000) break;
    start = page.at(-1).time + 1;
  }
  return { total, taker };
});
