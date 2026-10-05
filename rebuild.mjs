// Rebuild estimated daily closes from `historyStart` up to the first live day, so streaks,
// records and the calendar cover the whole run. `npm run rebuild` (safe to re-run).
//
// Each account's holdings at every day's close (local midnight) are reconstructed and
// valued at that moment's prices:
//   Coinbase      every v2 transaction replayed backwards from today's balances (exact)
//   Solana        every tx's balance changes replayed backwards (exact)
//   Robinhood Ch. every transfer of listed tokens replayed backwards (exact)
//   Base          balances read at the day's block from an archive RPC (exact)
//   BNB tokens    no free history: held at today's size from `heldSince` (estimate)
//   Strike        today's BTC + BTC later received on Coinbase (estimate)
// Money moving between your own accounts is internal; money arriving from / leaving to
// anywhere else is logged as a deposit/withdrawal so it isn't counted as PnL.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { secret } from './lib/config.mjs';
import { openDb } from './lib/db.mjs';
import { postJson, dayKey, startOfDay, addDays, sleep, num } from './lib/util.mjs';
import { majorUsd, tokenUsd } from './lib/history-prices.mjs';
import { rpc, balanceOfData } from './lib/evm.mjs';
import { get as coinbaseGet } from './connectors/coinbase.mjs';
import { relayRequests, relayTrades } from './lib/relay.mjs';
import { coinbaseFlow } from './lib/coinbase-flows.mjs';
import { walletSignatures } from './lib/solana.mjs';
import { fetchAccount as strikeAccount } from './connectors/strike.mjs';

const cfg = JSON.parse(readFileSync(new URL('accounts.json', import.meta.url), 'utf8'));
const tz = cfg.timezone;
const db = openDb(new URL('data/pnl.db', import.meta.url).pathname);
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const CACHE = new URL('data/cache/', import.meta.url);
mkdirSync(CACHE, { recursive: true });
const STABLES = new Set(['USD', 'USDC', 'USDT', 'DAI', 'PYUSD', 'USDS', 'USDE']);
const CASH_SYMS = new Set(['USDC', 'USDT', 'USDG', 'DAI', 'ETH', 'WETH', 'SOL', 'WSOL', 'BNB', 'WBNB']);

// Days to rebuild: historyStart .. day before each account's first live row.
// Live tracking starts at the first snapshot; days with a real (non-estimated) row — live
// days, or Hyperliquid's exact history — are never overwritten.
const firstSnap = db.raw.prepare('SELECT MIN(ts) t FROM snapshots').get().t;
const liveStart = dayKey(firstSnap ?? Date.now(), tz);
const exact = new Set(db.raw.prepare('SELECT day, account FROM daily WHERE est = 0').all().map((r) => `${r.account}:${r.day}`));
const DAYS = [];
for (let d = dayKey(Date.parse(cfg.historyStart), tz); d < liveStart; d = addDays(d, 1)) DAYS.push(d);
const dayEnd = (d) => startOfDay(Date.parse(addDays(d, 1) + 'T12:00:00Z'), tz) - 1;
const START = dayEnd(addDays(DAYS[0], -1));
log(`Rebuilding ${DAYS[0]} → ${DAYS.at(-1)} (${DAYS.length} days)`);

// Reads at a past block never change: cache them so reruns skip the slow archive calls.
const ARCHIVE = new URL('archive-rpc.json', CACHE);
const archive = existsSync(ARCHIVE) ? JSON.parse(readFileSync(ARCHIVE, 'utf8')) : {};
async function rpcAt(url, method, params, opts) {
  const key = `${url}|${method}|${JSON.stringify(params)}`;
  if (key in archive) return archive[key];
  const v = await rpc(url, method, params, opts);
  archive[key] = v;
  return v;
}
process.on('exit', () => { try { writeFileSync(ARCHIVE, JSON.stringify(archive)); } catch { /* optional */ } });

// When Strike's own history begins: everything with a CSV, else its `historyFrom`.
const strikeAcct = cfg.accounts.find((a) => a.type === 'strike');
const strikeFrom = !strikeAcct ? Infinity
  : db.raw.prepare("SELECT COUNT(*) n FROM trades WHERE account = ? AND symbol = 'BTC'").get(strikeAcct.id).n ? -Infinity
  : startOfDay(Date.parse((strikeAcct.historyFrom ?? cfg.historyStart).slice(0, 10) + 'T12:00:00Z'), tz);

const tracked = new Set(cfg.accounts.flatMap((a) => [...(a.evm ?? []), ...(a.solana ?? []), ...(a.bitcoin ?? []), a.address].filter(Boolean).map((x) => x.toLowerCase())));
const values = {}; // account -> day -> value
const flows = [];  // { ts, account, amount, note, ext_id }
const setVal = (acct, day, v) => ((values[acct] ??= {})[day] = (values[acct]?.[day] ?? 0) + v);

// Price at a day's close: Coinbase for majors, GeckoTerminal for tokens, else the last
// price we actually traded it at.
const observed = new Map(); // priceKey -> [[ts, px]]
const observe = (key, ts, px) => { if (px > 0) (observed.get(key) ?? observed.set(key, []).get(key)).push([ts, px]); };
async function priceAt(key, ts) {
  const [src, a, b] = key.split(':');
  let px = null;
  if (src === 'stable') return 1;
  if (src === 'cb') px = await majorUsd(a, ts);
  if (src === 'gt') px = await tokenUsd(a, b, ts);
  if (px) return px;
  const obs = observed.get(key) ?? [];
  let best = null;
  for (const [t, p] of obs) if (t <= ts || best == null) best = p;
  return best ?? 0;
}

// Hash → which of your accounts saw it (to recognize internal transfers).
const seenTx = new Map();

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
  const bal = {}, events = [], legsById = new Map();
  for (const a of accounts) {
    const cur = a.currency.code ?? a.currency;
    bal[cur] = (bal[cur] ?? 0) + num(a.balance.amount);
    let query = '?limit=100&order=desc';
    for (;;) {
      const r = await coinbaseGet(`/v2/accounts/${a.id}/transactions`, query);
      const page = r.data ?? [];
      for (const t of page) {
        const ts = Date.parse(t.created_at);
        if (ts <= START) continue;
        const ev = { ts, cur, amt: num(t.amount.amount), usd: num(t.native_amount?.amount), t };
        events.push(ev);
        const gid = t.buy?.id ?? t.sell?.id ?? t.trade?.id;
        if (gid) (legsById.get(gid) ?? legsById.set(gid, []).get(gid)).push(ev);
      }
      if (!page.length || page.every((t) => Date.parse(t.created_at) <= START) || !r.pagination?.next_uri) break;
      query = r.pagination.next_uri.slice(r.pagination.next_uri.indexOf('?'));
    }
  }
  // Money in/out (bank deposits, USDC bought with bank, card payments, rewards, crypto to
  // unknown addresses). Crypto transfers are held back until the wallets are scanned, so a
  // transfer that shows up on one of your wallets (same tx hash) can be cancelled.
  for (const e of events) {
    const { t } = e;
    if (t.network?.hash) seenTx.set(t.network.hash.toLowerCase(), { account: acct.id, e });
    const gid = t.buy?.id ?? t.sell?.id;
    const tid = t.trade?.id;
    const otherLeg = tid ? legsById.get(tid)?.find((x) => x !== e)?.cur : null;
    let f = coinbaseFlow(t, { legs: gid ? legsById.get(gid)?.length ?? 1 : 1, tracked, excludeCash: acct.excludeCash, otherLeg, btcFromStrike: !!strikeAcct });
    // BTC arriving from Strike is internal — but only once Strike itself is in the history.
    if (!f && e.cur === 'BTC' && ['send', 'receive'].includes(t.type) && e.amt > 0 && e.ts < strikeFrom) f = { amount: Math.abs(e.usd), note: 'BTC from Strike (before Strike history)' };
    if (!f) continue;
    const flow = { ts: e.ts, account: acct.id, ...f, ext_id: `cb2:${t.id}` };
    if (['send', 'receive'].includes(t.type)) e.pendingFlow = flow;
    else flows.push(flow);
  }
  for (const d of DAYS) {
    const end = dayEnd(d);
    let v = 0;
    for (const [cur, b] of Object.entries(bal)) {
      if (acct.excludeCash && (cur === 'USD' || cur === 'USDC')) continue;
      const after = events.filter((e) => e.cur === cur && e.ts > end).reduce((s, e) => s + e.amt, 0);
      const qty = b - after;
      if (Math.abs(qty) < 1e-9) continue;
      v += qty * (cur === 'USD' || STABLES.has(cur) ? 1 : await priceAt(`cb:${cur}`, end));
    }
    setVal(acct.id, d, v);
  }
  coinbaseEvents = events;
  log(`Coinbase: ${events.length} transactions replayed`);
}
let coinbaseEvents = [];

// ---------------------------------------------------------------- Solana
const SOL = 'So11111111111111111111111111111111111111112';
const QUOTES = { [SOL]: 'SOL', EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC', Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2noCxV7aaBHUuo: 'USDT' };
const solRpc = secret('SOLANA_RPC_URL') || 'https://api.mainnet-beta.solana.com';
const sol = (m, p) => rpc(solRpc, m, p);

async function solanaLegs(addr) {
  const file = new URL(`sol-${addr}.json`, CACHE);
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const sigs = await walletSignatures(addr, START + 1);
  const todo = sigs.filter((s) => !cache[s.signature]);
  log(`Solana ${addr.slice(0, 6)}…: ${sigs.length} txs (${todo.length} to fetch)`);
  for (const [i, s] of todo.entries()) {
    const tx = await sol('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]);
    if (tx) cache[s.signature] = { ts: tx.blockTime * 1000, legs: legsOf(tx, addr) };
    if (i % 25 === 24) writeFileSync(file, JSON.stringify(cache));
    await sleep(solRpc.includes('mainnet-beta') ? 300 : 50);
  }
  writeFileSync(file, JSON.stringify(cache));
  return sigs.map((s) => ({ sig: s.signature, ...cache[s.signature] })).filter((x) => x.legs);
}

function legsOf(tx, addr) {
  const m = tx.meta, keys = tx.transaction.message.accountKeys.map((k) => k.pubkey ?? k);
  const delta = {};
  const idx = keys.indexOf(addr);
  if (idx >= 0) delta[SOL] = (m.postBalances[idx] - m.preBalances[idx] + (idx === 0 ? m.fee : 0)) / 1e9;
  const pre = Object.fromEntries((m.preTokenBalances ?? []).filter((b) => b.owner === addr).map((b) => [b.accountIndex, b]));
  for (const b of m.postTokenBalances ?? []) {
    if (b.owner !== addr) continue;
    delta[b.mint] = (delta[b.mint] ?? 0) + num(b.uiTokenAmount.uiAmountString) - num(pre[b.accountIndex]?.uiTokenAmount.uiAmountString);
    delete pre[b.accountIndex];
  }
  for (const b of Object.values(pre)) delta[b.mint] = (delta[b.mint] ?? 0) - num(b.uiTokenAmount.uiAmountString);
  return Object.entries(delta).filter(([, d]) => Math.abs(d) > 1e-12).map(([mint, d]) => ({ mint, d }));
}

async function solanaNow(addr) {
  const out = { [SOL]: num((await sol('getBalance', [addr])).value) / 1e9 };
  for (const programId of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
    const r = await sol('getTokenAccountsByOwner', [addr, { programId }, { encoding: 'jsonParsed' }]);
    for (const { account } of r.value) {
      const i = account.data.parsed.info;
      out[i.mint] = (out[i.mint] ?? 0) + num(i.tokenAmount.uiAmountString);
    }
  }
  return out;
}

const keyOfMint = (mint) => (QUOTES[mint] ? (QUOTES[mint] === 'SOL' ? 'cb:SOL' : 'stable') : `gt:solana:${mint}`);

async function solana(acct, addr) {
  const txs = await solanaLegs(addr);
  const now = await solanaNow(addr);
  // Observed prices from swaps against SOL/USDC, and flows from unmatched SOL/USDC transfers.
  for (const tx of txs) {
    const quotes = tx.legs.filter((l) => QUOTES[l.mint] && !(l.mint === SOL && Math.abs(l.d) < 0.01));
    const tokens = tx.legs.filter((l) => !QUOTES[l.mint]);
    if (tokens.length === 1 && quotes.length) {
      const q = quotes[0];
      const qpx = QUOTES[q.mint] === 'SOL' ? await majorUsd('SOL', tx.ts) : 1;
      observe(keyOfMint(tokens[0].mint), tx.ts, (Math.abs(q.d) * qpx) / Math.abs(tokens[0].d));
    }
    if (!tokens.length && quotes.length === 1) {
      const q = quotes[0];
      const usd = Math.abs(q.d) * (QUOTES[q.mint] === 'SOL' ? await majorUsd('SOL', tx.ts) : 1);
      if (usd < 1) continue;
      const cb = seenTx.get(tx.sig.toLowerCase());
      if (cb) {
        cb.e.pendingFlow = null; // Coinbase ↔ this wallet: internal…
        // …unless Coinbase cash is excluded: USDC going back to Coinbase leaves the portfolio.
        const cbAcct = cfg.accounts.find((a) => a.id === cb.account);
        if (cbAcct?.excludeCash && QUOTES[q.mint] === 'USDC' && q.d < 0) flows.push({ ts: tx.ts, account: acct.id, amount: -usd, note: 'USDC to Coinbase cash', ext_id: `rb:sol:${tx.sig}` });
        continue;
      }
      if (relayHashes.has(tx.sig)) continue; // cross-chain swap leg (Relay): stays in the account
      // Apps like Fomo buy tokens on other chains by sending USDC into a cross-chain router:
      // that's a purchase inside the account, not money leaving your portfolio.
      if (acct.crossChainSpends && q.d < 0) continue;
      flows.push({ ts: tx.ts, account: acct.id, amount: q.d > 0 ? usd : -usd, note: q.d > 0 ? `${QUOTES[q.mint]} in` : `${QUOTES[q.mint]} out`, ext_id: `rb:sol:${tx.sig}` });
    }
  }
  for (const d of DAYS) {
    const end = dayEnd(d);
    let v = 0;
    const mints = new Set([...Object.keys(now), ...txs.flatMap((t) => t.legs.map((l) => l.mint))]);
    for (const mint of mints) {
      const after = txs.filter((t) => t.ts > end).reduce((s, t) => s + (t.legs.find((l) => l.mint === mint)?.d ?? 0), 0);
      const qty = (now[mint] ?? 0) - after;
      if (qty <= 1e-9) continue;
      const px = await priceAt(keyOfMint(mint), end);
      v += qty * px;
    }
    setVal(acct.id, d, v);
  }
  log(`  ${acct.name} Solana valued`);
}

// ---------------------------------------------------------------- EVM
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad32 = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

async function robinhoodTokens(acct, addr) {
  const url = 'https://rpc.mainnet.chain.robinhood.com';
  const head = parseInt(await rpc(url, 'eth_blockNumber', []), 16);
  // Listed tokens plus anything this account ever bought here through Relay.
  const list = new Map((acct.tokens ?? []).filter((x) => x.chain === 'robinhood').map((t) => [t.address.toLowerCase(), t]));
  for (const r of relayRows) {
    if (r.bridge || r.account !== acct.id || r.chain !== 'robinhood' || CASH_SYMS.has(r.symbol.toUpperCase())) continue;
    if (!list.has(r.token.toLowerCase())) list.set(r.token.toLowerCase(), { chain: 'robinhood', symbol: r.symbol, address: r.token });
  }
  for (const t of list.values()) {
    for (const r of relayRows) if (!r.bridge && r.chain === 'robinhood' && r.token?.toLowerCase() === t.address.toLowerCase()) observe(`gt:robinhood:${t.address}`, r.ts, r.price);
    for (const r of db.raw.prepare('SELECT ts, notional, size FROM trades WHERE account = ? AND symbol = ? AND notional > 0').all(acct.id, t.symbol)) {
      observe(`gt:robinhood:${t.address}`, r.ts, r.notional / r.size);
    }
    const moves = [];
    const dec = parseInt(await rpc(url, 'eth_call', [{ to: t.address, data: '0x313ce567' }, 'latest']).catch(() => '0x12'), 16) || 18;
    for (let to = head; to > 0; to -= 10_000_000) {
      for (const pos of [1, 2]) {
        const topics = [TRANSFER, null, null];
        topics[pos] = pad32(addr);
        const logs = await rpc(url, 'eth_getLogs', [{ address: t.address, fromBlock: '0x' + Math.max(0, to - 9_999_999).toString(16), toBlock: '0x' + to.toString(16), topics }], { gap: 300 });
        for (const l of logs) moves.push({ block: parseInt(l.blockNumber, 16), d: (pos === 2 ? 1 : -1) * Number(BigInt(l.data)) / 10 ** dec });
      }
    }
    const nowQty = Number(BigInt(await rpc(url, 'eth_call', [{ to: t.address, data: balanceOfData(addr) }, 'latest']))) / 10 ** dec;
    if (!moves.length) continue;
    // Block → time for the handful of moves.
    for (const m of moves) m.ts = parseInt((await rpc(url, 'eth_getBlockByNumber', ['0x' + m.block.toString(16), false], { gap: 150 })).timestamp, 16) * 1000;
    for (const d of DAYS) {
      const end = dayEnd(d);
      const qty = nowQty - moves.filter((m) => m.ts > end).reduce((s, m) => s + m.d, 0);
      if (qty > 1e-9) setVal(acct.id, d, qty * await priceAt(`gt:robinhood:${t.address}`, end));
    }
    log(`  ${acct.name} ${t.symbol}: ${moves.length} transfers replayed`);
  }
}

const BASE_TOKENS = [{ symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }];
async function baseArchive(acct, addr) {
  const url = 'https://mainnet.base.org';
  // Base makes a block every 2s exactly, so a day's closing block follows from any
  // reference block — fixed tags per day keep the archive cache reusable.
  const head = parseInt(await rpc(url, 'eth_blockNumber', []), 16);
  const refTs = parseInt((await rpc(url, 'eth_getBlockByNumber', ['0x' + head.toString(16), false])).timestamp, 16) * 1000;
  for (const d of DAYS) {
    const end = dayEnd(d);
    const tag = '0x' + (head - Math.ceil((refTs - end) / 2000)).toString(16);
    const eth = Number(BigInt(await rpcAt(url, 'eth_getBalance', [addr, tag], { gap: 250 }))) / 1e18;
    let v = eth * await priceAt('cb:ETH', end);
    for (const t of BASE_TOKENS) v += Number(BigInt(await rpcAt(url, 'eth_call', [{ to: t.address, data: balanceOfData(addr) }, tag], { gap: 250 }))) / 10 ** t.decimals;
    setVal(acct.id, d, v);
  }
  log(`  ${acct.name} Base balances read`);
}

async function bscTokens(acct, addr) {
  const url = 'https://bsc-dataseed1.bnbchain.org';
  for (const t of (acct.tokens ?? []).filter((x) => x.chain === 'bsc')) {
    const qty = Number(BigInt(await rpc(url, 'eth_call', [{ to: t.address, data: balanceOfData(addr) }, 'latest']))) / 1e18;
    if (relayCovered.has(`${acct.id}:bsc:${t.address.toLowerCase()}`)) continue; // replayed from Relay instead
    const since = t.heldSince ?? DAYS[0];
    for (const d of DAYS) if (d >= since) setVal(acct.id, d, qty * await priceAt(`gt:bsc:${t.address}`, dayEnd(d)));
    log(`  ${acct.name} ${t.symbol}: ${qty.toFixed(2)} held since ${since} (estimate)`);
  }
}

// ---------------------------------------------------------------- Relay positions
// Tokens bought/sold cross-chain through Relay (Robinhood Chain memecoins, RHEA on BNB,
// VCAT on Base…) are replayed from Relay's ledger and valued at each day's close.
const GECKO_NET = { robinhood: 'robinhood', bsc: 'bsc', base: 'base', eth: 'eth', arbitrum: 'arbitrum', solana: 'solana' };
const relayHashes = new Set();
const relayCovered = new Set();
let relayRows = [];
async function loadRelay() {
  const byAddr = new Map();
  for (const a of cfg.accounts) for (const x of [...(a.evm ?? []), ...(a.solana ?? [])]) byAddr.set(x.toLowerCase(), a.id);
  const reqs = await relayRequests([...byAddr.keys()], { refresh: false });
  relayRows = relayTrades(reqs, (addr) => byAddr.get(addr?.toLowerCase()));
  for (const r of relayRows) for (const h of [...r.inHashes, ...r.outHashes]) relayHashes.add(h);
  // Positions whose chain is already replayed exactly (Solana txs, Robinhood Chain logs
  // for listed tokens) are left to those; everything else comes from Relay.
  for (const r of relayRows) {
    // Solana and Robinhood Chain are replayed exactly from their own history.
    if (r.bridge || r.chain === 'solana' || r.chain === 'robinhood') continue;
    relayCovered.add(`${r.account}:${r.chain}:${r.token.toLowerCase()}`);
  }
  log(`Relay: ${reqs.length} requests, ${relayCovered.size} cross-chain positions to replay`);
}

async function relayPositions() {
  for (const key of relayCovered) {
    const [account, chain, token] = key.split(':');
    const rows = relayRows.filter((r) => !r.bridge && r.account === account && r.chain === chain && r.token.toLowerCase() === token);
    const pk = GECKO_NET[chain] ? `gt:${GECKO_NET[chain]}:${token}` : `relay:${chain}:${token}`;
    for (const r of rows) observe(pk, r.ts, r.price);
    // Anchor to today's on-chain balance where we can read it (sells made locally on that
    // chain never touch Relay); otherwise sum Relay buys/sells forward.
    const url = { bsc: 'https://bsc-dataseed1.bnbchain.org', base: 'https://mainnet.base.org' }[chain];
    const owner = cfg.accounts.find((a) => a.id === account)?.evm?.[0];
    let nowQty = null;
    if (url && owner) {
      try {
        const dec = parseInt(await rpc(url, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']), 16) || 18;
        nowQty = Number(BigInt(await rpc(url, 'eth_call', [{ to: token, data: balanceOfData(owner) }, 'latest']))) / 10 ** dec;
      } catch { /* fall back to forward sum */ }
    }
    const delta = (r) => (r.side === 'BUY' ? r.size : -r.size);
    for (const d of DAYS) {
      const end = dayEnd(d);
      const qty = nowQty != null
        ? Math.max(0, nowQty - rows.filter((r) => r.ts > end).reduce((s, r) => s + delta(r), 0))
        : rows.filter((r) => r.ts <= end).reduce((s, r) => s + delta(r), 0);
      if (qty > 1e-9) setVal(account, d, qty * await priceAt(pk, end));
    }
    log(`  ${account} ${rows[0]?.symbol} on ${chain}: ${rows.length} Relay trades replayed${nowQty != null ? ` (now ${nowQty.toPrecision(4)})` : ''}`);
  }
}

// ---------------------------------------------------------------- Strike
async function strike(acct) {
  const { positions } = await strikeAccount(acct);
  const btcNow = positions.find((p) => p.symbol === 'BTC')?.qty ?? 0;
  // With an imported CSV, replay Strike's own BTC movements; buys paid from the bank
  // are money coming in. Without one, only BTC later received on Coinbase is known, so
  // Strike's history starts at `historyFrom` (its balance then counts as a deposit).
  const own = db.raw.prepare("SELECT ts, side, size, notional, ext_id FROM trades WHERE account = ? AND symbol = 'BTC'").all(acct.id);
  const moves = own.length
    ? own.map((t) => ({ ts: t.ts, d: ['BUY', 'RECEIVE'].includes(t.side) ? t.size : -t.size, t }))
    : coinbaseEvents.filter((e) => e.cur === 'BTC' && ['send', 'receive'].includes(e.t.type) && e.amt > 0).map((e) => ({ ts: e.ts, d: e.amt }));
  if (own.length) {
    for (const m of moves) {
      if (m.t.side === 'BUY') flows.push({ ts: m.ts, account: acct.id, amount: m.t.notional, note: 'Strike BTC buy (bank)', ext_id: `rb:${m.t.ext_id}` });
      if (m.t.side === 'SELL') flows.push({ ts: m.ts, account: acct.id, amount: -m.t.notional, note: 'Strike BTC sell (to bank)', ext_id: `rb:${m.t.ext_id}` });
    }
  }
  const from = own.length ? DAYS[0] : (acct.historyFrom ?? DAYS[0]);
  for (const d of DAYS) {
    if (d < from) continue;
    const end = dayEnd(d);
    // Without a CSV, Coinbase receives are Strike sends (Strike had that BTC before).
    const after = moves.filter((m) => m.ts > end).reduce((s, m) => s + m.d, 0);
    const qty = own.length ? btcNow - after : btcNow + after;
    if (qty > 1e-9) setVal(acct.id, d, qty * await priceAt('cb:BTC', end));
  }
  log(`Strike: ${btcNow.toFixed(4)} BTC now, ${own.length ? own.length + ' CSV rows' : moves.length + ' transfers to Coinbase'} replayed from ${from}${own.length ? '' : ' (estimate)'}`);
}

// ---------------------------------------------------------------- run
await loadRelay();
for (const acct of cfg.accounts.filter((a) => a.type === 'coinbase')) await coinbase(acct);
for (const acct of cfg.accounts.filter((a) => a.type === 'wallet')) {
  log(acct.name);
  for (const a of acct.solana ?? []) await solana(acct, a);
  for (const a of acct.evm ?? []) {
    if (acct.chains?.includes('robinhood')) await robinhoodTokens(acct, a);
    if (acct.chains?.includes('base')) await baseArchive(acct, a);
    if (acct.chains?.includes('bsc')) await bscTokens(acct, a);
  }
}
await relayPositions();
for (const acct of cfg.accounts.filter((a) => a.type === 'strike')) await strike(acct);
for (const e of coinbaseEvents) if (e.pendingFlow) flows.push(e.pendingFlow);

// Write: replace previous estimates, never touch live days.
db.raw.exec("DELETE FROM daily WHERE est = 1; DELETE FROM flows WHERE source IN ('rebuild', 'coinbase');");
const ins = db.raw.prepare('INSERT OR IGNORE INTO daily (day, account, open, close, close_ts, est) VALUES (?, ?, ?, ?, ?, 1)');
let rows = 0;
for (const [acct, byDay] of Object.entries(values)) {
  let prev = null;
  for (const d of DAYS) {
    if (exact.has(`${acct}:${d}`)) { prev = null; continue; }
    const v = byDay[d];
    if (v == null) continue;
    ins.run(d, acct, prev ?? v, v, dayEnd(d));
    prev = v;
    rows++;
  }
}
for (const f of flows) {
  if (f.ts > dayEnd(DAYS.at(-1)) && !f.ext_id.startsWith('cb2:')) continue; // live days handle their own flows
  db.addFlow({ ts: f.ts, day: dayKey(f.ts, tz), account: f.account, amount: f.amount, note: f.note, source: f.ext_id.startsWith('cb2:') ? 'coinbase' : 'rebuild', ext_id: f.ext_id });
}
log(`Wrote ${rows} estimated account-days and ${flows.length} transfers in/out`);
const totals = DAYS.map((d) => [d, Object.values(values).reduce((s, v) => s + (v[d] ?? 0), 0)]);
for (const [d, v] of totals.filter((_, i) => i % 7 === 0 || i === totals.length - 1)) log(`  ${d}  $${v.toFixed(0)}`);
