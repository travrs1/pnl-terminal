// Shared helpers: fetch with timeout, timezone-aware day math, number parsing.

export async function fetchJson(url, opts = {}) {
  const { timeout = 15000, ...rest } = opts;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

export const postJson = (url, body, opts = {}) =>
  fetchJson(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, body: JSON.stringify(body), ...opts });

export const num = (v) => {
  if (v == null || v === '') return 0;
  if (typeof v === 'object') v = v.value ?? v.userNativeCurrency?.value ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Offset (ms) of a timezone from UTC at a given instant.
function tzOffset(ts, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}

export function dayKey(ts, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

export function startOfDay(ts, tz) {
  const [y, m, d] = dayKey(ts, tz).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  return guess - tzOffset(guess, tz);
}

export function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
