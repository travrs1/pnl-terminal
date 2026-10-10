// Price lookups with a short cache. Free, keyless sources.
import { fetchJson, num } from './util.mjs';

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

const STABLES = new Set(['USD', 'USDC', 'USDT', 'DAI', 'PYUSD', 'USDE', 'FDUSD', 'USDS', 'USDH']);

// Price sources sometimes leave a token out of a response (Jupiter drops thin tokens,
// DexScreener returns nothing). A missing price would value the holding at 0 and show a
// fake loss, then a fake gain when it comes back — so reuse the last good price for a while.
const lastGood = new Map();
const STALE_OK = 30 * 60_000;
function remember(key, price) {
  if (price > 0) { lastGood.set(key, { at: Date.now(), price }); return price; }
  const hit = lastGood.get(key);
  return hit && Date.now() - hit.at < STALE_OK ? hit.price : 0;
}

export async function cryptoUsd(symbol) {
  const s = symbol.toUpperCase();
  if (STABLES.has(s)) return 1;
  const v = await cached(`cb:${s}`, 15000, async () => {
    const r = await fetchJson(`https://api.coinbase.com/v2/prices/${s}-USD/spot`).catch(() => null);
    return remember(`cb:${s}`, num(r?.data?.amount));
  });
  if (!v) throw new Error(`no price for ${s}`); // fail the refresh (keeps the last value) rather than book it at $0
  return v;
}

async function yahoo(symbol) {
  const r = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=true`,
    { headers: { 'user-agent': 'Mozilla/5.0' } });
  const res = r?.chart?.result?.[0];
  const m = res?.meta ?? {};
  const closes = res?.indicators?.quote?.[0]?.close?.filter((x) => x != null) ?? [];
  return { price: closes.at(-1) ?? num(m.regularMarketPrice), prevClose: num(m.chartPreviousClose ?? m.previousClose), name: m.longName || m.shortName || symbol, currency: m.currency || 'USD' };
}

// Stocks via Yahoo's chart endpoint, converted to USD (e.g. 000660.KS is quoted in KRW).
// Returns { price, prevClose, name, localPrice, currency }.
export async function stockQuote(symbol) {
  return cached(`yf:${symbol}`, 15000, async () => {
    const q = await yahoo(symbol);
    let cur = q.currency, div = 1;
    if (cur === 'GBp') { cur = 'GBP'; div = 100; }
    if (cur !== 'USD') {
      const fx = await cached(`fx:${cur}`, 60000, () => yahoo(`${cur}=X`)); // units of cur per 1 USD
      div *= fx.price;
    }
    return { ...q, localPrice: q.price, price: q.price / div, prevClose: q.prevClose / div };
  });
}

// Solana token prices via Jupiter (batch of up to 50 mints).
export async function jupPrices(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 50) {
    const batch = mints.slice(i, i + 50);
    const r = await cached(`jup:${batch.join(',')}`, 15000, () => fetchJson(`https://lite-api.jup.ag/price/v3?ids=${batch.join(',')}`));
    for (const [mint, v] of Object.entries(r ?? {})) out[mint] = num(v?.usdPrice);
  }
  // Jupiter leaves out tokens it can't price reliably; DexScreener usually has them.
  const missing = mints.filter((m) => !out[m]);
  if (missing.length) {
    const dex = await dexPrices('solana', missing).catch(() => ({}));
    for (const m of missing) out[m] = dex[m.toLowerCase()]?.price ?? 0;
  }
  for (const m of mints) out[m] = remember(`sol:${m}`, out[m]);
  return out;
}

// Some tokens ship zero-width or whitespace-only tickers.
export const cleanSymbol = (s) => (s ?? '').replace(/[\u200B-\u200D\u2060\uFEFF\s]/g, '').trim();

const tokenMeta = new Map();
export async function jupTokenMeta(mints) {
  const missing = mints.filter((m) => !tokenMeta.has(m));
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    try {
      const r = await fetchJson(`https://lite-api.jup.ag/tokens/v2/search?query=${batch.join(',')}`);
      for (const t of r ?? []) tokenMeta.set(t.id, { symbol: cleanSymbol(t.symbol) || cleanSymbol(t.name)?.slice(0, 10) || t.id.slice(0, 4) + '…', name: t.name, icon: t.icon });
    } catch { /* names are cosmetic */ }
    for (const m of batch) if (!tokenMeta.has(m)) tokenMeta.set(m, { symbol: m.slice(0, 4) + '…', name: m });
  }
  return Object.fromEntries(mints.map((m) => [m, tokenMeta.get(m)]));
}

// Any EVM token via DexScreener: price from its most liquid pair. chain = dexscreener chain id (bsc, robinhood, base…).
export async function dexPrices(chain, addresses) {
  const out = {};
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    const pairs = await cached(`dex:${chain}:${batch.join(',')}`, 20000, () => fetchJson(`https://api.dexscreener.com/tokens/v1/${chain}/${batch.join(',')}`));
    for (const p of pairs ?? []) {
      const a = p.baseToken?.address?.toLowerCase();
      if (!a || !batch.some((b) => b.toLowerCase() === a)) continue;
      const liq = num(p.liquidity?.usd);
      if (!out[a] || liq > out[a].liq) out[a] = { price: num(p.priceUsd), liq, symbol: p.baseToken.symbol, name: p.baseToken.name };
    }
  }
  // DexScreener sometimes returns empty results for everything; GeckoTerminal covers the gaps.
  const missing = addresses.filter((a) => !out[a.toLowerCase()]?.price);
  if (missing.length) Object.assign(out, await geckoPrices(chain, missing).catch(() => ({})));
  for (const a of addresses) {
    const k = a.toLowerCase();
    const price = remember(`dex:${chain}:${k}`, out[k]?.price);
    if (price) out[k] = { ...out[k], price };
  }
  return out;
}

const GECKO_NET = { eth: 'eth', base: 'base', arbitrum: 'arbitrum', optimism: 'optimism', polygon: 'polygon_pos', bsc: 'bsc', robinhood: 'robinhood', solana: 'solana' };
async function geckoPrices(chain, addresses) {
  const net = GECKO_NET[chain];
  if (!net) return {};
  const out = {};
  for (let i = 0; i < addresses.length; i += 30) {
    // Solana mints are case-sensitive; EVM addresses aren't.
    const batch = addresses.slice(i, i + 30).map((a) => (chain === 'solana' ? a : a.toLowerCase()));
    const r = await cached(`gt:${net}:${batch.join(',')}`, 60000, () => fetchJson(`https://api.geckoterminal.com/api/v2/simple/networks/${net}/token_price/${batch.join(',')}`));
    for (const [a, p] of Object.entries(r?.data?.attributes?.token_prices ?? {})) if (num(p)) out[a.toLowerCase()] = { price: num(p) };
  }
  return out;
}
