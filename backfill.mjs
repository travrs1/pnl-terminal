// One-off history import: `npm run backfill` (safe to re-run — rows are keyed by tx id).
//   Coinbase   v2 transactions (app buys/sells/converts, fiat in/out, card rewards)
//   Solana     every tx of each wallet address, decoded into buys/sells/transfers
//   EVM (RPC)  transfers of the tokens listed per wallet in accounts.json (Robinhood Chain)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { secret } from './lib/config.mjs';
import { openDb } from './lib/db.mjs';
import { postJson, dayKey, sleep, num, addDays, startOfDay } from './lib/util.mjs';
import { jupTokenMeta } from './lib/prices.mjs';
import { majorUsd, tokenUsd } from './lib/history-prices.mjs';
import { get as coinbaseGet } from './connectors/coinbase.mjs';
import { relayRequests, relayTrades, CHAIN_LABEL } from './lib/relay.mjs';
import { walletSignatures } from './lib/solana.mjs';

const cfg = JSON.parse(readFileSync(new URL('accounts.json', import.meta.url), 'utf8'));
// Trades go back further than the PnL history so positions opened earlier still get a cost basis.
const START = Date.parse(process.env.BACKFILL_FROM || cfg.tradesFrom || cfg.historyStart || `${new Date().getFullYear()}-01-01T00:00:00`);
const HISTORY_START = Date.parse(cfg.historyStart || cfg.tradesFrom);
const tz = cfg.timezone;
const db = openDb(new URL('data/pnl.db', import.meta.url).pathname);
const STABLES = new Set(['USD', 'USDC', 'USDT', 'DAI', 'PYUSD', 'USDS', 'USDE']);
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const summary = {};
const bump = (k, n = 1) => (summary[k] = (summary[k] ?? 0) + n);

// ---------------------------------------------------------------- Coinbase
async function coinbase(acct) {
  const accounts = [];
  let q = '?limit=100';
  for (;;) {
    const r = await coinbaseGet('/v2/accounts', q);
    accounts.push(...r.data);
    if (!r.pagination?.next_uri) break;
    q = r.pagination.next_uri.slice(r.pagination.next_uri.indexOf('?'));
  }
  const trades = [];
  for (const a of accounts) {
    const path = `/v2/accounts/${a.id}/transactions`;
    let query = '?limit=100&order=desc';
    for (;;) {
      const r = await coinbaseGet(path, query);
      const page = r.data ?? [];
      const older = page.length > 0 && page.every((t) => Date.parse(t.created_at) < START);
      for (const t of page) {
        const ts = Date.parse(t.created_at);
        if (ts < START) continue;
        if (t.status && t.status !== 'completed') continue;
        handleCoinbaseTx(acct, t, ts, trades);
      }
      if (older || !r.pagination?.next_uri) break;
      query = r.pagination.next_uri.slice(r.pagination.next_uri.indexOf('?'));
    }
  }
  db.addTrades(trades);
  log(`Coinbase: ${trades.length} trades/transfers`);
}

function handleCoinbaseTx(acct, t, ts, trades) {
  const cur = t.amount.currency;
  const amt = num(t.amount.amount);
  const usd = num(t.native_amount?.amount);
  const base = { ext_id: `cb2:${t.id}`, ts, account: acct.id, venue: 'Coinbase', symbol: cur };
  // Deposits/withdrawals are decided by lib/coinbase-flows.mjs (live tracker + rebuild).
  const flow = () => {};
  switch (t.type) {
    case 'buy':
    case 'sell':
    case 'trade': {
      if (STABLES.has(cur)) return; // the cash leg of a buy/convert
      const side = amt >= 0 ? 'BUY' : 'SELL';
      const size = Math.abs(amt), notional = Math.abs(usd);
      trades.push({ ...base, side, size, price: notional / size, notional, kind: 'spot', dir: t.type === 'trade' ? 'Convert' : side === 'BUY' ? 'Buy' : 'Sell' });
      return bump('Coinbase trades');
    }
    case 'fiat_deposit': return flow('Bank deposit');
    case 'fiat_withdrawal': return flow('Bank withdrawal');
    case 'credit_card_reward':
    case 'incentives_rewards_payout': return flow(t.type === 'credit_card_reward' ? 'Card reward' : 'Reward');
    case 'credit_card_balance_payment': return flow('Card payment');
    case 'send':
    case 'receive': {
      if (STABLES.has(cur) && Math.abs(usd) < 1) return;
      const size = Math.abs(amt);
      trades.push({ ...base, side: amt >= 0 ? 'RECEIVE' : 'SEND', size, price: size ? Math.abs(usd) / size : 0, notional: Math.abs(usd), kind: 'transfer',
        dir: amt >= 0 ? 'Received' : 'Sent', note: t.details?.subtitle ?? null });
      return bump('Coinbase transfers');
    }
    default: // interest, staking, advanced_trade_fill (covered by the live fills feed)…
  }
}

// ---------------------------------------------------------------- Solana
const SOL = 'So11111111111111111111111111111111111111112';
const QUOTE_SOL = new Map([
  [SOL, 'SOL'],
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC'],
  ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2noCxV7aaBHUuo', 'USDT'],
]);

const solRpc = secret('SOLANA_RPC_URL') || 'https://api.mainnet-beta.solana.com';
async function sol(method, params) {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await postJson(solRpc, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 30_000 });
      if (r.error) throw new Error(r.error.message);
      return r.result;
    } catch (e) {
      if (!/429|Too many|rate/i.test(e.message) || i === 7) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

async function solana(acct, addr) {
  const sigs = await walletSignatures(addr, START);
  log(`Solana ${addr.slice(0, 6)}… (${acct.name}): ${sigs.length} txs since start`);
  // Shares the per-tx cache with rebuild.mjs (raw balance changes per signature).
  const cacheFile = new URL(`data/cache/sol-${addr}.json`, import.meta.url);
  const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
  const decoded = [];
  for (const [i, s] of sigs.entries()) {
    if (i && i % 50 === 0) log(`  …${i}/${sigs.length}`);
    if (!cache[s.signature]) {
      const tx = await sol('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]);
      if (!tx) continue;
      cache[s.signature] = { ts: tx.blockTime * 1000, legs: solanaLegs(tx, addr, { raw: true }) };
      await sleep(solRpc.includes('mainnet-beta') ? 350 : 60);
    }
    const { ts, legs: raw } = cache[s.signature];
    const legs = raw.length > 1 ? raw.filter((l) => !(l.mint === SOL && Math.abs(l.d) < 0.01)) : raw;
    if (legs.length) decoded.push({ sig: s.signature, ts, legs });
  }
  mkdirSync(new URL('data/cache/', import.meta.url), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(cache));
  const mints = [...new Set(decoded.flatMap((d) => d.legs.map((l) => l.mint)))];
  const meta = await jupTokenMeta(mints.filter((m) => !QUOTE_SOL.has(m)));
  const sym = (m) => QUOTE_SOL.get(m) ?? meta[m]?.symbol ?? m.slice(0, 4);
  const trades = [];
  for (const d of decoded) {
    trades.push(...await classify(d.legs, {
      ts: d.ts, id: `sol:${d.sig}`, account: acct.id, venue: `${acct.name} · Solana`,
      isQuote: (m) => QUOTE_SOL.has(m), symbol: sym,
      quoteUsd: (m) => majorUsd(QUOTE_SOL.get(m), d.ts),
      tokenUsd: (m) => tokenUsd('solana', m, d.ts),
    }));
  }
  db.addTrades(trades);
  bump(`${acct.name} trades`, trades.filter((t) => t.kind === 'spot').length);
  log(`  → ${trades.length} rows`);
}

function solanaLegs(tx, addr, { raw = false } = {}) {
  const meta = tx.meta;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey ?? k);
  const delta = {};
  const add = (mint, v) => { delta[mint] = (delta[mint] ?? 0) + v; };
  const idx = keys.indexOf(addr);
  if (idx >= 0) {
    let lamports = meta.postBalances[idx] - meta.preBalances[idx];
    if (idx === 0) lamports += meta.fee; // ignore network fees we paid
    add(SOL, lamports / 1e9);
  }
  const pre = Object.fromEntries((meta.preTokenBalances ?? []).filter((b) => b.owner === addr).map((b) => [b.accountIndex, b]));
  for (const b of meta.postTokenBalances ?? []) {
    if (b.owner !== addr) continue;
    add(b.mint, num(b.uiTokenAmount.uiAmountString) - num(pre[b.accountIndex]?.uiTokenAmount.uiAmountString));
    delete pre[b.accountIndex];
  }
  for (const b of Object.values(pre)) add(b.mint, -num(b.uiTokenAmount.uiAmountString));
  let legs = Object.entries(delta).map(([mint, d]) => ({ mint, d })).filter((l) => Math.abs(l.d) > 1e-12);
  // Token-account rent (~0.002 SOL) and tips aren't trades.
  if (!raw && legs.length > 1) legs = legs.filter((l) => !(l.mint === SOL && Math.abs(l.d) < 0.01));
  return legs;
}

// Turn per-tx balance changes into buy/sell/transfer rows.
async function classify(legs, c) {
  const quotes = legs.filter((l) => c.isQuote(l.mint));
  const tokens = legs.filter((l) => !c.isQuote(l.mint));
  const row = (l, side, notional, extra = {}) => ({
    ext_id: `${c.id}:${l.mint}`, ts: c.ts, account: c.account, venue: c.venue, symbol: c.symbol(l.mint),
    side, size: Math.abs(l.d), price: notional != null ? notional / Math.abs(l.d) : null, notional, kind: 'spot', ...extra,
  });
  const out = [];
  if (tokens.length === 1 && quotes.length >= 1) {
    const t = tokens[0];
    const q = quotes.find((x) => Math.sign(x.d) !== Math.sign(t.d)) ?? quotes[0];
    const notional = Math.abs(q.d) * ((await c.quoteUsd(q.mint)) ?? 0);
    out.push(row(t, t.d > 0 ? 'BUY' : 'SELL', notional || null, { dir: 'Swap', note: `${Math.abs(q.d).toPrecision(4)} ${c.symbol(q.mint)}` }));
  } else if (tokens.length === 2 && tokens[0].d * tokens[1].d < 0) {
    const [sold, bought] = tokens[0].d < 0 ? tokens : [tokens[1], tokens[0]];
    const px = (await c.tokenUsd(sold.mint)) ?? null;
    const notional = px != null ? Math.abs(sold.d) * px : null;
    out.push(row(sold, 'SELL', notional, { dir: 'Swap', note: `→ ${c.symbol(bought.mint)}` }));
    out.push(row(bought, 'BUY', notional, { dir: 'Swap', note: `← ${c.symbol(sold.mint)}` }));
  } else if (tokens.length === 0 && quotes.length === 1) {
    // Pure SOL/USDC movement in or out — deposits, withdrawals, transfers between wallets.
    const q = quotes[0];
    const usd = Math.abs(q.d) * ((await c.quoteUsd(q.mint)) ?? 0);
    if (usd >= 1) out.push(row(q, q.d > 0 ? 'RECEIVE' : 'SEND', usd, { kind: 'transfer', dir: q.d > 0 ? 'Received' : 'Sent' }));
  } else {
    for (const t of tokens) {
      const px = await c.tokenUsd(t.mint);
      out.push(row(t, t.d > 0 ? 'RECEIVE' : 'SEND', px != null ? Math.abs(t.d) * px : null, { kind: 'transfer', dir: t.d > 0 ? 'Received' : 'Sent' }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- EVM via RPC (Robinhood Chain)
const EVM_RPC = { robinhood: { url: 'https://rpc.mainnet.chain.robinhood.com', gecko: 'robinhood', native: 'ETH', maxRange: 9_999_999 } };
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad32 = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

async function evmRpc(url, method, params) {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await postJson(url, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 30_000 });
      if (r.error) throw new Error(r.error.message);
      return r.result;
    } catch (e) {
      if (!/429|Too Many|rate/i.test(e.message) || i === 7) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

async function blockAtTime(url, ts) {
  let lo = 0, hi = parseInt(await evmRpc(url, 'eth_blockNumber', []), 16);
  const time = async (n) => parseInt((await evmRpc(url, 'eth_getBlockByNumber', ['0x' + n.toString(16), false])).timestamp, 16) * 1000;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await time(mid)) < ts) lo = mid; else hi = mid;
    await sleep(150);
  }
  return lo;
}

const tokenInfo = new Map();
async function erc20Info(url, address) {
  if (!tokenInfo.has(address)) {
    const dec = await evmRpc(url, 'eth_call', [{ to: address, data: '0x313ce567' }, 'latest']).catch(() => '0x12');
    const symHex = await evmRpc(url, 'eth_call', [{ to: address, data: '0x95d89b41' }, 'latest']).catch(() => '0x');
    let symbol = address.slice(0, 6);
    try {
      const b = Buffer.from(symHex.slice(2), 'hex');
      symbol = b.length >= 96 ? b.subarray(64, 64 + Number(b.readBigUInt64BE(56))).toString('utf8') : b.toString('utf8').replace(/\0/g, '') || symbol;
    } catch { /* keep address prefix */ }
    tokenInfo.set(address, { decimals: parseInt(dec, 16) || 18, symbol });
  }
  return tokenInfo.get(address);
}

async function evmChain(acct, addr, chain) {
  const { url, gecko, native, maxRange } = EVM_RPC[chain];
  // Listed tokens plus every token this account bought here through Relay — those are
  // usually sold locally on the chain (swapped into PONS/ETH/USDG), which Relay never sees.
  const tokens = (acct.tokens ?? []).filter((t) => t.chain === chain);
  for (const r of relayRows) {
    if (r.bridge || r.account !== acct.id || r.chain !== chain || !r.token) continue;
    if (!tokens.some((t) => t.address.toLowerCase() === r.token.toLowerCase())) tokens.push({ chain, symbol: r.symbol, address: r.token });
  }
  if (!tokens.length) return;
  const from = await blockAtTime(url, START);
  const head = parseInt(await evmRpc(url, 'eth_blockNumber', []), 16);
  const hashes = new Set();
  for (const t of tokens) {
    for (let a = from; a <= head; a += maxRange + 1) {
      const b = Math.min(head, a + maxRange);
      for (const pos of [1, 2]) {
        const topics = [TRANSFER, null, null];
        topics[pos] = pad32(addr);
        const logs = await evmRpc(url, 'eth_getLogs', [{ address: t.address, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16), topics }]);
        for (const l of logs) hashes.add(l.transactionHash);
        await sleep(300);
      }
    }
  }
  log(`${chain} ${addr.slice(0, 6)}… (${acct.name}): ${hashes.size} txs touching ${tokens.map((t) => t.symbol).join('/')}`);
  const me = addr.toLowerCase();
  const trades = [];
  for (const hash of hashes) {
    const [tx, rc] = [await evmRpc(url, 'eth_getTransactionByHash', [hash]), await evmRpc(url, 'eth_getTransactionReceipt', [hash])];
    const blk = await evmRpc(url, 'eth_getBlockByNumber', [rc.blockNumber, false]);
    const ts = parseInt(blk.timestamp, 16) * 1000;
    const delta = {};
    for (const l of rc.logs) {
      if (l.topics[0] !== TRANSFER || l.topics.length < 3) continue;
      const fromA = '0x' + l.topics[1].slice(26), toA = '0x' + l.topics[2].slice(26);
      if (fromA !== me && toA !== me) continue;
      const { decimals } = await erc20Info(url, l.address);
      const v = Number(BigInt(l.data)) / 10 ** decimals;
      delta[l.address] = (delta[l.address] ?? 0) + (toA === me ? v : 0) - (fromA === me ? v : 0);
    }
    if (tx.from.toLowerCase() === me && BigInt(tx.value) > 0n) delta[native] = (delta[native] ?? 0) - Number(BigInt(tx.value)) / 1e18;
    const legs = Object.entries(delta).map(([mint, d]) => ({ mint, d })).filter((l) => Math.abs(l.d) > 1e-12);
    const symOf = async (m) => (m === native ? native : (await erc20Info(url, m)).symbol);
    const syms = Object.fromEntries(await Promise.all(legs.map(async (l) => [l.mint, await symOf(l.mint)])));
    const isQuote = (m) => ['ETH', 'WETH', 'USDC', 'USDT', 'USDG', 'BNB', 'WBNB'].includes(syms[m]);
    let rows = await classify(legs, {
      ts, id: `${chain}:${hash}`, account: acct.id, venue: `${acct.name} · ${chain === 'robinhood' ? 'Robinhood Chain' : chain}`,
      isQuote, symbol: (m) => syms[m], quoteUsd: (m) => majorUsd(syms[m], ts), tokenUsd: (m) => tokenUsd(gecko, m, ts),
    });
    // Sold for native ETH: the ETH comes back as an internal transfer that has no log —
    // if we signed a tx to a contract that only sent our tokens out, call it a sell.
    const toContract = tx.to && (await evmRpc(url, 'eth_getCode', [tx.to, 'latest'])) !== '0x';
    if (toContract && tx.from.toLowerCase() === me) {
      rows = rows.map((r) => (r.kind === 'transfer' && r.side === 'SEND' ? { ...r, kind: 'spot', side: 'SELL', dir: 'Swap', note: `for ${native} (est. price)` } : r));
    }
    trades.push(...rows);
    await sleep(250);
  }
  db.addTrades(trades);
  bump(`${acct.name} trades`, trades.filter((t) => t.kind === 'spot').length);
  log(`  → ${trades.length} rows`);
}

// ---------------------------------------------------------------- Hyperliquid daily history
// Hyperliquid keeps account value + PnL series itself (deposit-adjusted), so past days
// can be rebuilt exactly: close = account value, and any value change not explained by
// PnL is a deposit/withdrawal. Uses the ~daily 30-day series, the sparser all-time one before.
async function hyperliquidDaily(acct) {
  const r = await postJson('https://api.hyperliquid.xyz/info', { type: 'portfolio', user: acct.address.toLowerCase() });
  const series = Object.fromEntries(r);
  const merge = (k) => {
    const m = new Map();
    for (const name of ['allTime', 'month', 'week']) for (const [t, v] of series[name]?.[k] ?? []) m.set(t, num(v));
    return [...m].sort((a, b) => a[0] - b[0]);
  };
  const values = merge('accountValueHistory'), pnls = merge('pnlHistory');
  const at = (arr, ts) => { let v = null; for (const [t, x] of arr) { if (t > ts) break; v = x; } return v; };
  const today = dayKey(Date.now(), tz);
  const live = new Set(db.raw.prepare('SELECT day FROM daily WHERE account = ?').all(acct.id).map((r) => r.day));
  let prev = null, n = 0;
  for (let d = dayKey(HISTORY_START, tz); d < today; d = addDays(d, 1)) {
    const end = startOfDay(Date.parse(addDays(d, 1) + 'T12:00:00Z'), tz) - 1;
    const value = at(values, end), pnl = at(pnls, end);
    if (value == null || pnl == null) continue;
    if (!live.has(d) && (value > 0 || prev)) {
      const open = prev?.value ?? value;
      db.raw.prepare('INSERT OR REPLACE INTO daily (day, account, open, close, close_ts) VALUES (?, ?, ?, ?, ?)').run(d, acct.id, open, value, end);
      const flow = prev ? (value - prev.value) - (pnl - prev.pnl) : 0;
      if (Math.abs(flow) >= 1) db.addFlow({ ts: end, day: d, account: acct.id, amount: flow, note: 'Hyperliquid deposit/withdrawal', source: 'hyperliquid', ext_id: `hl-day:${d}` });
      n++;
    }
    prev = { value, pnl };
  }
  log(`Hyperliquid: rebuilt ${n} days of history`);
}

// ---------------------------------------------------------------- reclassify
// Self-custody wallets buy and sell through cross-chain routers: the token lands from a
// relayer and the payment leaves on another chain, so the wallet only sees a transfer.
// Any non-cash token moving in/out of a wallet is a buy/sell at market — unless the same
// amount of that token moved the other way in another of your accounts (internal move).
export function reclassify() {
  const walletIds = new Set(cfg.accounts.filter((a) => a.type === 'wallet').map((a) => a.id));
  const rows = db.raw.prepare("SELECT * FROM trades WHERE kind = 'transfer' ORDER BY ts").all();
  const internal = new Set();
  for (const a of rows) {
    if (internal.has(a.ext_id)) continue;
    const b = rows.find((x) => x !== a && !internal.has(x.ext_id) && x.symbol === a.symbol && x.account !== a.account && x.side !== a.side
      && Math.abs(x.ts - a.ts) < 2 * 3600e3 && Math.abs(x.size - a.size) <= Math.max(a.size, x.size) * 0.03);
    if (b) { internal.add(a.ext_id); internal.add(b.ext_id); }
  }
  const upd = db.raw.prepare("UPDATE trades SET kind = 'spot', side = ?, dir = 'Swap', note = ? WHERE ext_id = ?");
  const mark = db.raw.prepare("UPDATE trades SET note = 'between your accounts' WHERE ext_id = ?");
  let n = 0;
  for (const r of rows) {
    if (internal.has(r.ext_id)) { mark.run(r.ext_id); continue; }
    if (!walletIds.has(r.account) || STABLES.has(r.symbol) || ['SOL', 'ETH', 'BNB'].includes(r.symbol)) continue;
    if (!(r.notional >= 5)) continue; // dust drops / rewards, not trades
    upd.run(r.side === 'RECEIVE' ? 'BUY' : 'SELL', 'cross-chain · est. price', r.ext_id);
    n++;
  }
  db.raw.prepare('DELETE FROM trades WHERE ts < ? AND ext_id NOT LIKE ?').run(START, 'hl:%');
  log(`Reclassified ${n} wallet transfers as swaps; ${internal.size / 2} internal moves matched`);
}

// Same rule as the live wallet connector: a "BTC" memecoin isn't BTC.
const MAJORS = ['BTC', 'ETH', 'SOL', 'BNB', 'ZEC', 'NEAR', 'HYPE', 'XRP', 'DOGE'];
async function disambiguate() {
  const rows = db.raw.prepare(`SELECT ext_id, ts, symbol, price, venue FROM trades WHERE venue LIKE '%·%' AND symbol IN (${MAJORS.map(() => '?').join(',')})`).all(...MAJORS);
  const upd = db.raw.prepare('UPDATE trades SET symbol = ? WHERE ext_id = ?');
  let n = 0;
  for (const r of rows) {
    const ref = await majorUsd(r.symbol, r.ts);
    if (!ref || !r.price || Math.abs(r.price / ref - 1) <= 0.2) continue;
    const chain = /Solana/.test(r.venue) ? 'sol' : /Robinhood/.test(r.venue) ? 'robinhood' : 'evm';
    upd.run(`${r.symbol}·${chain}`, r.ext_id);
    n++;
  }
  log(`Renamed ${n} look-alike tickers`);
}

// ---------------------------------------------------------------- Relay (cross-chain swaps)
let relayRows = [];
async function loadRelay() {
  const byAddr = new Map();
  for (const a of cfg.accounts) for (const x of [...(a.evm ?? []), ...(a.solana ?? [])]) byAddr.set(x.toLowerCase(), a);
  const reqs = await relayRequests([...byAddr.keys()]);
  relayRows = relayTrades(reqs, (addr) => byAddr.get(addr?.toLowerCase())?.id);
  return reqs;
}

async function relay(reqs) {
  const rows = relayRows;
  // Relay has both legs with USD values, so its rows replace what each chain saw on its
  // own (a lone USDC transfer out on Solana, a token "received" on Robinhood Chain…).
  // Only the legs Relay itself records (the token, and the cash that paid for it) — one tx
  // can also hold a local swap (e.g. PONS → USDG on Robinhood Chain, then USDG → Relay).
  const del = db.raw.prepare(`DELETE FROM trades WHERE ext_id LIKE ? AND ext_id NOT LIKE 'relay:%'
    AND (symbol = ? OR symbol IN ('USDC', 'USDT', 'USDG', 'ETH', 'WETH', 'SOL'))`);
  const trades = [];
  for (const r of rows) {
    for (const h of [...r.inHashes, ...r.outHashes]) del.run(`%:${h}%`, r.symbol ?? '');
    if (r.bridge) continue;
    const acct = cfg.accounts.find((a) => a.id === r.account);
    trades.push({ ...r, venue: `${acct.name} · ${CHAIN_LABEL[r.chain] ?? r.chain}` });
  }
  db.addTrades(trades);
  bump('Relay cross-chain trades', trades.length);
  log(`Relay: ${reqs.length} cross-chain requests → ${trades.length} buys/sells`);
}

// ---------------------------------------------------------------- run
if (process.argv[2] === 'reclassify') { reclassify(); await disambiguate(); process.exit(0); }
log(`Backfilling from ${new Date(START).toDateString()}`);
let relayReqs = [];
try { relayReqs = await loadRelay(); } catch (e) { log(`Relay: FAILED — ${e.message}`); }
for (const acct of cfg.accounts) {
  try {
    if (acct.type === 'coinbase') await coinbase(acct);
    if (acct.type === 'wallet') {
      for (const a of acct.solana ?? []) await solana(acct, a);
      for (const a of acct.evm ?? []) for (const chain of acct.chains ?? []) if (EVM_RPC[chain]) await evmChain(acct, a, chain);
    }
    if (acct.type === 'hyperliquid') await hyperliquidDaily(acct);
    if (acct.type === 'strike') log('Strike: history needs extra API scopes or a CSV export — skipped for now');
  } catch (e) {
    log(`${acct.name}: FAILED — ${e.message}`);
  }
}
try { await relay(relayReqs); } catch (e) { log(`Relay: FAILED — ${e.message}`); }
reclassify();
await disambiguate();
log('Done.', summary);
