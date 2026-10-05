// Any account you'd rather type in: holdings priced live, plus optional cash.
import { stockQuote, cryptoUsd } from '../lib/prices.mjs';

export const interval = 30_000;

export async function fetchAccount(acct) {
  const positions = [];
  for (const h of acct.holdings ?? []) {
    const crypto = h.kind === 'crypto';
    const q = crypto ? { price: await cryptoUsd(h.symbol) } : await stockQuote(h.symbol);
    const value = h.qty * q.price;
    positions.push({
      key: `${crypto ? 'crypto' : 'stock'}:${h.symbol}`, symbol: h.symbol, kind: crypto ? 'crypto' : 'stock', venue: acct.name,
      side: 'LONG', qty: h.qty, avg: h.avg ?? null, price: q.price, value, upnl: h.avg ? (q.price - h.avg) * h.qty : null,
      today: q.prevClose ? (q.price - q.prevClose) * h.qty : undefined, contrib: value,
    });
  }
  return { value: positions.reduce((s, p) => s + p.value, 0) + (acct.cash ?? 0), positions };
}
