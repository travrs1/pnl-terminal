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

const modes = new Map();
async function abstraction(user) {
  const hit = modes.get(user);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.v;
  const v = await info({ type: 'userAbstraction', user }).catch(() => null);
  if (v) modes.set(user, { at: Date.now(), v }); // don't remember a failed lookup
  return v ?? hit?.v ?? null;
}

export async function fetchAccount(acct) {
  const user = acct.address.toLowerCase();
  const [perp, spot, px, mode] = await Promise.all([
    info({ type: 'clearinghouseState', user }),
    info({ type: 'spotClearinghouseState', user }),
    spotPrices(),
    abstraction(user),
  ]);
  // Unified / portfolio-margin accounts keep collateral in spot: perp margin shows up as a
  // spot "hold" and again inside the perp account value. If the mode lookup fails, the
  // spot hold matching the perp margin used gives it away.
  const usdc = (spot.balances ?? []).find((b) => b.coin === 'USDC');
  const marginUsed = num(perp.marginSummary?.totalMarginUsed);
  const unified = mode === 'unifiedAccount' || mode === 'portfolioMargin'
    || (!mode && marginUsed > 0 && Math.abs(num(usdc?.hold) - marginUsed) <= marginUsed * 0.02);

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

  // Unified: the spot balance is marked to market — margin, open PnL, fees and funding are
  // all already in it (it's what Hyperliquid itself reports as account value). Classic
  // accounts keep perp collateral separately, so its account value is added on top of spot.
  const value = unified ? spotValue : num(perp.marginSummary?.accountValue) + spotValue;

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

// Deposits/withdrawals from Hyperliquid's own ledger, so moving money in and out of perps
// is never counted as PnL. Internal moves (spot↔perp, sub-accounts) aren't flows.
export async function flows(acct, cfg, sinceTs) {
  const user = acct.address.toLowerCase();
  const updates = await info({ type: 'userNonFundingLedgerUpdates', user, startTime: Math.floor(sinceTs) });
  const out = [];
  for (const u of updates ?? []) {
    const d = u.delta ?? {};
    let amount = 0, note = '';
    if (d.type === 'deposit') { amount = num(d.usdc); note = 'Deposit to Hyperliquid'; }
    else if (d.type === 'withdraw') { amount = -num(d.usdc) - num(d.fee); note = 'Withdrawal from Hyperliquid'; }
    else if (d.type === 'send' || d.type === 'spotTransfer') {
      const usd = num(d.usdcValue ?? d.amount);
      if (d.destination?.toLowerCase() === user && d.user?.toLowerCase() !== user) { amount = usd; note = `${d.token ?? 'USDC'} received on Hyperliquid`; }
      else if (d.user?.toLowerCase() === user && d.destination?.toLowerCase() !== user) { amount = -usd; note = `${d.token ?? 'USDC'} sent from Hyperliquid`; }
    }
    if (amount) out.push({ ts: u.time, amount, note, ext_id: `hl-ledger:${u.hash}`, source: 'hyperliquid' });
  }
  return out;
}
