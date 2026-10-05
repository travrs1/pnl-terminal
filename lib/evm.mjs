// Minimal JSON-RPC helper for EVM chains with backoff on public-endpoint rate limits.
import { postJson, sleep } from './util.mjs';

export async function rpc(url, method, params, { tries = 12, gap = 0 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await postJson(url, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 30_000 });
      if (r.error) throw new Error(r.error.message);
      if (gap) await sleep(gap);
      return r.result;
    } catch (e) {
      // Rate limits and network blips (wifi drop, DNS) are retried with backoff.
      const transient = /429|rate limit|Too Many|timeout|aborted|fetch failed|ECONN|ENET|EHOST|ETIMEDOUT|socket/i.test(`${e.message} ${e.cause?.code ?? ''}`);
      if (!transient || i === tries - 1) throw e;
      await sleep(1000 * 2 ** Math.min(i, 5)); // up to 32s between tries
    }
  }
}

export const balanceOfData = (owner) => '0x70a08231' + owner.toLowerCase().replace(/^0x/, '').padStart(64, '0');
