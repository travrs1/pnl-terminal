// A loan against crypto, e.g. Coinbase's BTC-backed USDC loans (Morpho on Base). The account
// is what the loan adds to net worth: the locked collateral (when it left the venue it came
// from) minus what's owed. Borrowed money is never profit; the fee and interest are a cost.
// The debt is just the account's value (not a position or a trade), so it never shows in
// the book or among the day's movers. The engine works out when the loan opened and where the collateral sits (`loanState` in
// lib/engine.mjs) and passes that in as `st`.
import { cryptoUsd } from '../lib/prices.mjs';

export const interval = 15_000;

const YEAR = 365 * 864e5;

// Owed at `ts`: borrowed + fee, compounding continuously at `rate` (Morpho accrues every
// block), plus later borrows (`draws`, each with its own fee), less repayments.
// `owed: { amount, date }` resyncs to the figure Coinbase shows.
export function debtAt(acct, openedTs, ts) {
  const rate = Number(acct.rate) || 0;
  let at = openedTs, bal = Number(acct.borrowed) + (Number(acct.fee) || 0);
  if (acct.owed?.amount && Date.parse(acct.owed.date) <= ts) {
    at = Math.max(openedTs, Date.parse(acct.owed.date));
    bal = Number(acct.owed.amount);
  }
  const grow = (to) => { if (to > at) { bal *= Math.exp(rate * (to - at) / YEAR); at = to; } };
  const moves = [
    ...(acct.draws ?? []).map((d) => ({ date: d.date, amount: Number(d.amount) + (Number(d.fee) || 0) })),
    ...(acct.repayments ?? []).map((r) => ({ date: r.date, amount: -Number(r.amount) })),
  ].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  for (const m of moves) {
    const t = Date.parse(m.date);
    if (t <= at || t > ts) continue;
    grow(t);
    bal += m.amount;
  }
  grow(ts);
  return Math.max(0, bal);
}

// Everything borrowed and every fee, the first borrow plus any `draws` since.
export const totals = (acct) => (acct.draws ?? []).reduce(
  (t, d) => ({ borrowed: t.borrowed + Number(d.amount), fee: t.fee + (Number(d.fee) || 0) }),
  { borrowed: Number(acct.borrowed), fee: Number(acct.fee) || 0 },
);

export async function fetchAccount(acct, cfg, st = {}) {
  const c = acct.collateral ?? {};
  const px = await cryptoUsd(c.symbol || 'BTC');
  const info = {
    status: st.opened ? 'open' : 'armed', symbol: c.symbol || 'BTC', qty: Number(c.qty), px,
    ...totals(acct), draws: (acct.draws ?? []).length, rate: Number(acct.rate) || 0, lltv: Number(acct.lltv) || null,
  };
  // Not borrowed yet: worth nothing, just watching for the loan to open.
  if (!st.opened) return { value: 0, positions: [], loan: info };

  const now = Date.now();
  const debt = debtAt(acct, st.opened, now);
  const dayStart = Math.max(st.opened, st.dayStart ?? now);
  // Today's growth in the debt, less anything borrowed today (that's principal and fee).
  const drawnToday = (acct.draws ?? []).filter((d) => Date.parse(d.date) > dayStart).reduce((s, d) => s + Number(d.amount) + (Number(d.fee) || 0), 0);
  const interestToday = debt - debtAt(acct, st.opened, dayStart) - drawnToday;
  const collUsd = info.qty * px;
  const positions = [];
  if (st.moved) {
    positions.push({
      key: `crypto:${info.symbol}`, symbol: info.symbol, kind: 'crypto', venue: `${acct.name} (collateral)`, side: 'LONG',
      qty: info.qty, avg: null, price: px, value: collUsd, upnl: null, contrib: collUsd,
    });
  }
  const repaid = (acct.repayments ?? []).reduce((s, r) => s + Number(r.amount), 0);
  Object.assign(info, {
    opened: st.opened, moved: !!st.moved, debt, collUsd, interestToday, repaid,
    interest: debt + repaid - info.borrowed - info.fee,
    ltv: collUsd ? debt / collUsd : null,
    liqPrice: info.lltv && info.qty ? debt / (info.qty * info.lltv) : null,
  });
  return { value: (st.moved ? collUsd : 0) - debt, positions, loan: info };
}
