// Strike — custodial BTC + USD balances.
import { fetchJson, num } from '../lib/util.mjs';
import { secret } from '../lib/config.mjs';
import { cryptoUsd } from '../lib/prices.mjs';

export const interval = 30_000;

export async function fetchAccount() {
  const key = secret('STRIKE_API_KEY');
  if (!key) throw new Error('Strike API key not set — add it under Accounts & keys');
  const balances = await fetchJson('https://api.strike.me/v1/balances', { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } });
  let value = 0;
  const positions = [];
  for (const b of balances ?? []) {
    const qty = num(b.total ?? b.current);
    if (!qty) continue;
    const price = b.currency === 'USD' ? 1 : await cryptoUsd(b.currency);
    const v = qty * price;
    value += v;
    if (b.currency === 'USD') continue;
    positions.push({ key: `crypto:${b.currency}`, symbol: b.currency, kind: 'crypto', venue: 'Strike', side: 'LONG', qty, avg: null, price, value: v, upnl: null, contrib: v });
  }
  return { value, positions };
}
