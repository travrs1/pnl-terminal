// Solana history helpers shared by backfill.mjs and rebuild.mjs.
import { rpc } from './evm.mjs';
import { secret } from './config.mjs';

export const solRpc = () => secret('SOLANA_RPC_URL') || 'https://api.mainnet-beta.solana.com';
export const sol = (method, params) => rpc(solRpc(), method, params);
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

// Signatures touching a wallet since `startMs`. Transfers *into* a wallet's token account
// (e.g. USDC landing from a bridge) don't reference the owner address at all, so the
// owner's token accounts are scanned too.
export async function walletSignatures(owner, startMs) {
  const accounts = [owner];
  for (const programId of TOKEN_PROGRAMS) {
    const r = await sol('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }]);
    for (const { pubkey } of r.value) accounts.push(pubkey);
  }
  const seen = new Map();
  for (const a of accounts) {
    let before;
    for (;;) {
      const page = await sol('getSignaturesForAddress', [a, { limit: 1000, ...(before && { before }) }]);
      const fresh = page.filter((s) => s.blockTime * 1000 >= startMs);
      for (const s of fresh) if (!s.err) seen.set(s.signature, s);
      if (page.length < 1000 || fresh.length < page.length) break;
      before = page.at(-1).signature;
    }
  }
  return [...seen.values()].sort((a, b) => b.blockTime - a.blockTime);
}
