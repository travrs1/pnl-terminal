// Relay (relay.link) cross-chain swaps. Fomo and Robinhood Wallet buy tokens on other
// chains through Relay: USDC leaves Solana/Base and the token lands on Robinhood Chain,
// BNB, Base…, so neither chain alone shows the trade. Relay's request log has both legs
// with USD values, so it doubles as an exact trade ledger for those wallets.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { sleep } from './util.mjs';

const FILE = new URL('../data/cache/relay.json', import.meta.url);
export const CHAINS = { 792703809: 'solana', 8453: 'base', 56: 'bsc', 4663: 'robinhood', 1: 'eth', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon', 5042: 'chain-5042' };
export const CHAIN_LABEL = { solana: 'Solana', base: 'Base', bsc: 'BNB Chain', robinhood: 'Robinhood Chain', eth: 'Ethereum', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon' };
// What counts as money rather than a position on either side of a swap.
const CASHLIKE = new Set(['USDC', 'USDT', 'USDG', 'DAI', 'ETH', 'WETH', 'SOL', 'WSOL', 'BNB', 'WBNB']);

async function get(url) {
  for (let i = 0; i < 12; i++) {
    const res = await fetch(url);
    if (res.status === 429) { await sleep(45_000); continue; } // public API is rate-limited
    if (!res.ok) throw new Error(`relay ${res.status}`);
    return res.json();
  }
  throw new Error('relay: rate limited');
}

// All requests involving any of `addresses`, cached on disk and topped up incrementally.
export async function relayRequests(addresses, { refresh = true } = {}) {
  const cache = new Map((existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []).map((r) => [r.id, r]));
  if (refresh) {
    for (const a of addresses) {
      let cont = '';
      for (let page = 0; page < 40; page++) {
        const r = await get(`https://api.relay.link/requests/v2?user=${a}&limit=50${cont ? '&continuation=' + cont : ''}`);
        const reqs = r.requests ?? [];
        const known = reqs.filter((q) => cache.has(q.id) && cache.get(q.id).status === q.status).length;
        for (const q of reqs) cache.set(q.id, q);
        if (!r.continuation || !reqs.length || known === reqs.length) break;
        cont = r.continuation;
        await sleep(8000);
      }
      await sleep(4000);
    }
    mkdirSync(new URL('.', FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify([...cache.values()]));
  }
  return [...cache.values()].filter((q) => q.status === 'success').sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

// Normalize to buy/sell rows. `accountOf(address)` maps a wallet address to an account id.
export function relayTrades(requests, accountOf) {
  const out = [];
  for (const q of requests) {
    const m = q.data?.metadata;
    if (!m?.currencyIn || !m?.currencyOut) continue;
    const i = m.currencyIn, o = m.currencyOut;
    const ci = CHAINS[i.currency.chainId] ?? String(i.currency.chainId), co = CHAINS[o.currency.chainId] ?? String(o.currency.chainId);
    const ts = (q.data.outTxs?.[0]?.timestamp ?? q.data.inTxs?.[0]?.timestamp) * 1000 || Date.parse(q.createdAt);
    const inCash = CASHLIKE.has(i.currency.symbol.toUpperCase()), outCash = CASHLIKE.has(o.currency.symbol.toUpperCase());
    const base = { ts, inHashes: (q.data.inTxs ?? []).map((t) => t.hash), outHashes: (q.data.outTxs ?? []).map((t) => t.hash), relayId: q.id };
    const leg = (side, cur, chain, account, notional, other) => ({
      ...base, ext_id: `relay:${q.id}:${side}`, account, side, symbol: cur.currency.symbol, chain, token: cur.currency.address,
      size: Number(cur.amountFormatted), notional, price: notional / Number(cur.amountFormatted), kind: 'spot', dir: 'Swap',
      note: `via Relay · ${other}`, venue: null,
    });
    const buyer = accountOf(q.recipient) ?? accountOf(q.user);
    const seller = accountOf(q.user) ?? accountOf(q.recipient);
    if (inCash && !outCash) out.push(leg('BUY', o, co, buyer, Number(i.amountUsd), `${Number(i.amountFormatted).toPrecision(4)} ${i.currency.symbol} on ${ci}`));
    else if (!inCash && outCash) out.push(leg('SELL', i, ci, seller, Number(o.amountUsd), `→ ${o.currency.symbol} on ${co}`));
    else if (!inCash && !outCash) {
      out.push(leg('SELL', i, ci, seller, Number(i.amountUsd), `→ ${o.currency.symbol}`));
      out.push(leg('BUY', o, co, buyer, Number(o.amountUsd), `← ${i.currency.symbol}`));
    } else out.push({ ...base, ext_id: `relay:${q.id}:bridge`, bridge: true, account: buyer, usd: Number(i.amountUsd) });
  }
  return out.filter((t) => t.account);
}
