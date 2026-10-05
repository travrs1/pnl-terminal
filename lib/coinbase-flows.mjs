// Which Coinbase transactions are money entering/leaving your portfolio (so they don't
// count as PnL). Shared by the live tracker and rebuild.
import { num } from './util.mjs';

const CASH = new Set(['USD', 'USDC']);

// `legs`: how many Coinbase wallet transactions share this buy/sell id (1 = paid straight
// from a bank/card, no cash leg inside Coinbase). `tracked`: your own wallet addresses.
// `cryptoTransfers`: 'flows' counts crypto sent to / received from unknown addresses as
// money out/in (the rebuild, which can match both sides by tx hash); 'internal' assumes
// they're your own wallets (live, where the other side can't be matched).
// `excludeCash`: Coinbase USD/USDC isn't part of the portfolio, so money only enters when
// cash turns into crypto (or is sent to one of your wallets) and leaves the other way.
// `otherLeg`: for a convert, the currency on the other side.
export function coinbaseFlow(t, { legs = 1, tracked = new Set(), cryptoTransfers = 'flows', excludeCash = false, otherLeg = null, btcFromStrike = false } = {}) {
  const amt = num(t.amount?.amount);
  const usd = Math.abs(num(t.native_amount?.amount));
  const cur = t.amount?.currency;
  const isCash = CASH.has(cur);
  if (t.status && t.status !== 'completed') return null;
  if (excludeCash) {
    switch (t.type) {
      case 'credit_card_reward': return isCash ? null : { amount: usd, note: 'Card reward' };
      case 'incentives_rewards_payout': return isCash ? null : { amount: usd, note: 'Reward' };
      case 'buy': return isCash ? null : { amount: usd, note: `Bought ${cur}` };
      case 'sell': return isCash ? null : { amount: -usd, note: `Sold ${cur}` };
      case 'trade': // convert: only the crypto leg of a cash↔crypto convert moves money
        if (isCash || !CASH.has(otherLeg)) return null;
        return { amount: amt > 0 ? usd : -usd, note: amt > 0 ? `Bought ${cur} with ${otherLeg}` : `Sold ${cur} for ${otherLeg}` };
      case 'send':
      case 'receive': {
        const to = t.to?.address?.toLowerCase();
        if (isCash) {
          // Card cash sent to one of your wallets joins the portfolio.
          return amt < 0 && to && tracked.has(to) ? { amount: usd, note: `${cur} from Coinbase cash` } : null;
        }
        break; // crypto transfers: same as below
      }
      default: return null; // deposits, card payments, interest… all inside excluded cash
    }
  } else {
    switch (t.type) {
      case 'fiat_deposit': return { amount: usd, note: 'Bank deposit' };
      case 'fiat_withdrawal': return { amount: -usd, note: 'Bank withdrawal' };
      case 'credit_card_reward': return { amount: usd, note: 'Card reward' };
      case 'incentives_rewards_payout': return { amount: usd, note: 'Reward' };
      case 'credit_card_balance_payment': return { amount: -usd, note: 'Card payment' };
      case 'buy': return legs === 1 ? { amount: usd, note: `Bought ${cur} with bank/card` } : null;
      case 'sell': return legs === 1 ? { amount: -usd, note: `Sold ${cur} to bank` } : null;
      case 'send':
      case 'receive': break;
      default: return null;
    }
  }
  // Crypto sent/received. Coinbase reports both directions as "send"; incoming is positive.
  if (cryptoTransfers === 'internal') return null;
  if (amt < 0) {
    const to = t.to?.address?.toLowerCase();
    return to && tracked.has(to) ? null : { amount: -usd, note: `Sent ${cur} off-platform` };
  }
  if (cur === 'BTC' && btcFromStrike) return null; // BTC bought on Strike and sent here is internal
  return { amount: usd, note: `Received ${cur}` };
}
