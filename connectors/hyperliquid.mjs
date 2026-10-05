// Hyperliquid — public info API, only needs the wallet address.
import { postJson, num } from '../lib/util.mjs';

const API = 'https://api.hyperliquid.xyz/info';
const info = (body) => postJson(API, body);

export const interval = 10_000;

let spotPx = { at: 0, map: {} };
async function spotPrices() {
  if (Date.now() - spotPx.at < 15_000) return spotPx.map;
  const [meta, ctxs] = await info({ type: 'spotMetaAndAssetCtxs' });
  const map = { USDC: 1 };
  meta.universe.forEach((pair, i) => {
    const [base, quote] = pair.tokens;
    if (quote !== 0) return; // only X/USDC pairs
    const name = meta.tokens.find((t) => t.index === base)?.name;
    if (name && !(name in map)) map[name] = num(ctxs[i]?.markPx || ctxs[i]?.midPx);
  });
  spotPx = { at: Date.now(), map };
  return map;
}

const backfilled = new Set();

export async function fetchAccount(acct) {
  const user = acct.address.toLowerCase();
  const [perp, spot, px] = await Promise.all([
    info({ type: 'clearinghouseState', user }),
    info({ type: 'spotClearinghouseState', user }),
    spotPrices(),
  ]);

  const positions = [];
  for (const { position: p } of perp.assetPositions ?? []) {
    const szi = num(p.szi);
    if (!szi) continue;
    const notional = num(p.positionValue);
    positions.push({
      key: `perp:${p.coin}`, symbol: p.coin, kind: 'perp', venue: 'Hyperliquid', side: szi > 0 ? 'LONG' : 'SHORT',
      qty: Math.abs(szi), avg: num(p.entryPx), price: notional / Math.abs(szi), value: notional,
      upnl: num(p.unrealizedPnl), contrib: num(p.unrealizedPnl), leverage: p.leverage?.value,
    });
  }

  let spotValue = 0;
  for (const b of spot.balances ?? []) {
    const qty = num(b.total);
    if (!qty) continue;
    const price = px[b.coin] ?? 0;
    const value = qty * price;
    spotValue += value;
    if (b.coin === 'USDC') continue; // folded into the cash row
    positions.push({
      key: `crypto:${b.coin}`, symbol: b.coin, kind: 'crypto', venue: 'Hyperliquid', side: 'LONG',
      qty, avg: num(b.entryNtl) / qty || null, price, value, upnl: num(b.entryNtl) ? value - num(b.entryNtl) : null, contrib: value,
    });
  }

  const value = num(perp.marginSummary?.accountValue) + spotValue;

  // Fills: full history once per run, then just the latest batch.
  let trades = [];
  try {
    if (!backfilled.has(user)) {
      let start = 0;
      for (let i = 0; i < 10; i++) {
        const page = await info({ type: 'userFillsByTime', user, startTime: start, aggregateByTime: true });
        if (!page?.length) break;
        trades.push(...page);
        if (page.length < 2000) break;
        start = page.at(-1).time + 1;
      }
      backfilled.add(user);
    } else {
      trades = await info({ type: 'userFills', user, aggregateByTime: true });
    }
  } catch { /* fills are best-effort */ }

  return {
    value,
    positions,
    trades: trades.map((f) => {
      const spotFill = f.coin.startsWith('@') || f.coin.includes('/');
      return {
        ext_id: `hl:${f.tid}`, ts: f.time, venue: 'Hyperliquid', symbol: f.coin, side: f.side === 'B' ? 'BUY' : 'SELL',
        size: num(f.sz), price: num(f.px), notional: num(f.sz) * num(f.px), fee: num(f.fee),
        closed_pnl: num(f.closedPnl), start_pos: num(f.startPosition), dir: f.dir, kind: spotFill ? 'spot' : 'perp',
      };
    }),
  };
}
