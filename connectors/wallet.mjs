// Self-custody wallets (Robinhood Wallet, Fomo, MetaMask spot…): EVM chains, Solana, Bitcoin.
// Keyless: Blockscout for EVM, Solana RPC + Jupiter prices, mempool.space for BTC.
import { fetchJson, postJson, num } from '../lib/util.mjs';
import { secret } from '../lib/config.mjs';
import { rpc as rpcCall } from '../lib/evm.mjs';
import { readFileSync } from 'node:fs';
import { cryptoUsd, jupPrices, jupTokenMeta, dexPrices } from '../lib/prices.mjs';

export const interval = 60_000;

const BLOCKSCOUT = {
  eth: 'eth.blockscout.com', base: 'base.blockscout.com', arbitrum: 'arbitrum.blockscout.com',
  optimism: 'optimism.blockscout.com', polygon: 'polygon.blockscout.com',
};
const NATIVE = { eth: 'ETH', base: 'ETH', arbitrum: 'ETH', optimism: 'ETH', polygon: 'POL' };
const CHAIN_LABEL = { eth: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', robinhood: 'Robinhood Chain', bsc: 'BNB Chain' };

// Chains without a usable free explorer API: read native balance + the tokens listed
// under `tokens` in accounts.json straight from RPC, priced via DexScreener.
const RPC = {
  robinhood: { urls: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'], native: 'ETH' },
  bsc: { urls: ['https://bsc-dataseed1.bnbchain.org', 'https://bsc-dataseed2.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc.rpc.blxrbdn.com'], native: 'BNB' },
};

async function rpcChain(addr, chain, tokens, dust) {
  const { urls, native } = RPC[chain];
  const list = tokens.filter((t) => t.chain === chain);
  const owner = addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const calls = [
    { jsonrpc: '2.0', id: 0, method: 'eth_getBalance', params: [addr, 'latest'] },
    ...list.map((t, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'eth_call', params: [{ to: t.address, data: '0x70a08231' + owner }, 'latest'] })),
  ];
  // Public endpoints come and go: try each, with a short backoff on rate limits.
  let res, lastErr;
  for (const url of urls) {
    for (let i = 0; i < 2 && !res; i++) {
      try { res = await postJson(url, calls); } catch (e) {
        lastErr = e;
        if (!/429|Too Many/i.test(e.message)) break;
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    if (res) break;
  }
  if (!res) throw lastErr;
  const byId = Object.fromEntries(res.map((r) => {
    if (r.error) throw new Error(`${chain} rpc: ${r.error.message}`);
    return [r.id, BigInt(r.result || '0x0')];
  }));
  const out = [{ symbol: native, name: native, qty: Number(byId[0]) / 1e18, price: await cryptoUsd(native), chain }];
  const held = list.map((t, i) => ({ ...t, raw: byId[i + 1] })).filter((t) => t.raw > 0n);
  const px = held.length ? await dexPrices(chain, held.map((t) => t.address)) : {};
  for (const t of held) {
    const p = px[t.address.toLowerCase()];
    out.push({ symbol: t.symbol || p?.symbol || t.address.slice(0, 6), name: p?.name ?? t.symbol, qty: Number(t.raw) / 10 ** (t.decimals ?? 18), price: p?.price ?? 0, chain });
  }
  return out.filter((x) => x.qty * x.price >= dust);
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

async function evm(addr, chain, dust) {
  const host = BLOCKSCOUT[chain];
  if (!host) throw new Error(`unknown chain ${chain}`);
  const out = [];
  const [a, tokens] = await Promise.all([
    fetchJson(`https://${host}/api/v2/addresses/${addr}`, { timeout: 30000 }).catch(() => null),
    fetchJson(`https://${host}/api/v2/addresses/${addr}/token-balances`, { timeout: 30000 }),
  ]);
  if (a?.coin_balance) {
    const qty = num(a.coin_balance) / 1e18;
    const price = num(a.exchange_rate) || await cryptoUsd(NATIVE[chain]);
    out.push({ symbol: NATIVE[chain], name: NATIVE[chain], qty, price, chain });
  }
  for (const t of tokens ?? []) {
    const tk = t.token ?? {};
    if (tk.type !== 'ERC-20' || !tk.exchange_rate || tk.reputation === 'scam') continue;
    const qty = num(t.value) / 10 ** num(tk.decimals || 18);
    out.push({ symbol: tk.symbol, name: tk.name, qty, price: num(tk.exchange_rate), chain });
  }
  return out.filter((x) => x.qty * x.price >= dust);
}

async function solana(addr, dust) {
  const rpc = secret('SOLANA_RPC_URL') || 'https://api.mainnet-beta.solana.com';
  const call = (method, params) => rpcCall(rpc, method, params, { tries: 3 });
  const [bal, ...tokenSets] = await Promise.all([
    call('getBalance', [addr]),
    ...TOKEN_PROGRAMS.map((programId) => call('getTokenAccountsByOwner', [addr, { programId }, { encoding: 'jsonParsed' }])),
  ]);
  const amounts = { [SOL_MINT]: num(bal.value) / 1e9 };
  for (const set of tokenSets) {
    for (const { account } of set.value ?? []) {
      const info = account.data?.parsed?.info;
      const amt = num(info?.tokenAmount?.uiAmountString);
      if (amt > 0) amounts[info.mint] = (amounts[info.mint] ?? 0) + amt;
    }
  }
  const mints = Object.keys(amounts);
  const [prices, meta] = await Promise.all([jupPrices(mints), jupTokenMeta(mints.filter((m) => m !== SOL_MINT))]);
  return mints
    .map((m) => ({ symbol: m === SOL_MINT ? 'SOL' : meta[m]?.symbol ?? m.slice(0, 4), name: meta[m]?.name ?? 'Solana', mint: m, qty: amounts[m], price: prices[m] ?? 0, chain: 'solana' }))
    .filter((x) => x.qty * x.price >= dust);
}

async function bitcoin(addr) {
  const a = await fetchJson(`https://mempool.space/api/address/${addr}`);
  const sats = num(a.chain_stats.funded_txo_sum) - num(a.chain_stats.spent_txo_sum) + num(a.mempool_stats.funded_txo_sum) - num(a.mempool_stats.spent_txo_sum);
  return [{ symbol: 'BTC', name: 'Bitcoin', qty: sats / 1e8, price: await cryptoUsd('BTC'), chain: 'bitcoin' }];
}

// Memecoins love borrowing tickers ("BTC" on Solana trading at $0.004). Anything named
// like a major but priced nowhere near it gets a chain suffix so it never merges with the real one.
const MAJORS = ['BTC', 'ETH', 'SOL', 'BNB', 'ZEC', 'NEAR', 'HYPE', 'XRP', 'DOGE'];
export async function disambiguate(holdings) {
  for (const h of holdings) {
    if (!MAJORS.includes(h.symbol?.toUpperCase())) continue;
    const ref = await cryptoUsd(h.symbol).catch(() => 0);
    if (ref && Math.abs(h.price / ref - 1) > 0.2) h.symbol = `${h.symbol}·${h.chain === 'solana' ? 'sol' : h.chain}`;
  }
  return holdings;
}

// Tokens this wallet ever bought cross-chain via Relay (from the backfill's cache), so
// new Robinhood Chain / BNB buys are tracked without listing them in accounts.json.
const RELAY_FILE = new URL('../data/cache/relay.json', import.meta.url);
const RELAY_CHAIN = { 4663: 'robinhood', 56: 'bsc' };
const CASHLIKE = new Set(['USDC', 'USDT', 'USDG', 'DAI', 'ETH', 'WETH', 'BNB', 'WBNB']);
let relayCache = { at: 0, rows: [] };
function relayTokens(acct) {
  if (Date.now() - relayCache.at > 600_000) {
    try { relayCache = { at: Date.now(), rows: JSON.parse(readFileSync(RELAY_FILE, 'utf8')) }; } catch { relayCache = { at: Date.now(), rows: [] }; }
  }
  const mine = new Set((acct.evm ?? []).map((a) => a.toLowerCase()));
  const out = new Map();
  for (const q of relayCache.rows) {
    const o = q.data?.metadata?.currencyOut?.currency;
    const chain = RELAY_CHAIN[o?.chainId];
    if (!chain || !mine.has(q.recipient?.toLowerCase()) || CASHLIKE.has(o.symbol?.toUpperCase())) continue;
    out.set(`${chain}:${o.address.toLowerCase()}`, { chain, symbol: o.symbol, address: o.address, decimals: o.decimals });
  }
  return [...out.values()];
}

export async function fetchAccount(acct, cfg) {
  const dust = cfg.dustUsd ?? 1;
  const jobs = [];
  const listed = acct.tokens ?? [];
  const tokens = [...listed, ...relayTokens(acct).filter((t) => !listed.some((l) => l.chain === t.chain && l.address.toLowerCase() === t.address.toLowerCase()))];
  for (const addr of acct.evm ?? []) {
    for (const chain of acct.chains ?? ['eth', 'base']) jobs.push(RPC[chain] ? rpcChain(addr, chain, tokens, dust) : evm(addr, chain, dust));
  }
  for (const addr of acct.solana ?? []) jobs.push(solana(addr, dust));
  for (const addr of acct.bitcoin ?? []) jobs.push(bitcoin(addr));

  // One chain hiccuping shouldn't zero the whole wallet — fail the account so the last good value is kept.
  const results = await Promise.all(jobs);
  const merged = new Map();
  const holdings = await disambiguate(results.flat());
  for (const h of holdings) {
    const k = `crypto:${h.symbol}`;
    const label = h.chain === 'solana' ? 'Solana' : h.chain === 'bitcoin' ? 'Bitcoin' : CHAIN_LABEL[h.chain];
    const cur = merged.get(k);
    if (cur) { cur.qty += h.qty; cur.value += h.qty * h.price; if (!cur.chains.includes(label)) cur.chains.push(label); }
    else merged.set(k, { key: k, symbol: h.symbol, name: h.name, kind: 'crypto', side: 'LONG', qty: h.qty, price: h.price, value: h.qty * h.price, chains: [label], mint: h.mint });
  }
  const positions = [...merged.values()].map((p) => ({
    ...p, venue: `${acct.name} · ${p.chains.join('/')}`, avg: null, upnl: null, contrib: p.value,
  }));
  const isCash = (p) => ['USDC', 'USDT', 'DAI', 'PYUSD', 'USDE', 'USDS'].includes(p.symbol.toUpperCase());
  return {
    value: positions.reduce((s, p) => s + p.value, 0),
    positions: positions.filter((p) => !isCash(p)),
  };
}
