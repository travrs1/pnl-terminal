// SQLite storage (node:sqlite, no deps).
//  snapshots: account value roughly once a minute (intraday + 1W charts)
//  daily:     open/close value per account per day (all stats are built from this)
//  flows:     external deposits (+) / withdrawals (-) so they don't count as PnL
//  trades:    fills from venues that expose them (activity feed + win rate)
//  pos_open:  first price seen for a position each day (per-position "today")
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

export function openDb(file) {
  mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS snapshots (ts INTEGER NOT NULL, account TEXT NOT NULL, value REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS snapshots_ts ON snapshots (ts);
    CREATE TABLE IF NOT EXISTS daily (
      day TEXT NOT NULL, account TEXT NOT NULL, open REAL NOT NULL, close REAL NOT NULL, close_ts INTEGER NOT NULL,
      PRIMARY KEY (day, account));
    CREATE TABLE IF NOT EXISTS flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, account TEXT,
      amount REAL NOT NULL, note TEXT, source TEXT DEFAULT 'manual', ext_id TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS trades (
      ext_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, account TEXT NOT NULL, venue TEXT, symbol TEXT, side TEXT,
      size REAL, price REAL, notional REAL, fee REAL, closed_pnl REAL, start_pos REAL, dir TEXT, kind TEXT);
    CREATE INDEX IF NOT EXISTS trades_ts ON trades (ts);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS pos_open (day TEXT NOT NULL, key TEXT NOT NULL, price REAL NOT NULL, PRIMARY KEY (day, key));
  `);

  try { db.exec('ALTER TABLE trades ADD COLUMN note TEXT'); } catch { /* already there */ }
  try { db.exec('ALTER TABLE daily ADD COLUMN est INTEGER DEFAULT 0'); } catch { /* already there */ }

  const q = {
    insSnap: db.prepare('INSERT INTO snapshots (ts, account, value) VALUES (?, ?, ?)'),
    upDaily: db.prepare(`INSERT INTO daily (day, account, open, close, close_ts) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (day, account) DO UPDATE SET close = excluded.close, close_ts = excluded.close_ts`),
    insTrade: db.prepare(`INSERT OR REPLACE INTO trades (ext_id, ts, account, venue, symbol, side, size, price, notional, fee, closed_pnl, start_pos, dir, kind, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insPosOpen: db.prepare('INSERT OR IGNORE INTO pos_open (day, key, price) VALUES (?, ?, ?)'),
    getPosOpen: db.prepare('SELECT key, price FROM pos_open WHERE day = ?'),
  };

  return {
    raw: db,
    snapshot(ts, account, value, day) {
      q.insSnap.run(ts, account, value);
      q.upDaily.run(day, account, value, value, ts);
    },
    daily: () => db.prepare('SELECT day, account, open, close, est FROM daily ORDER BY day').all(),
    lastBefore: (ts) => db.prepare(`SELECT s.account, s.value FROM snapshots s
      JOIN (SELECT account, MAX(ts) AS mts FROM snapshots WHERE ts < ? GROUP BY account) m
      ON s.account = m.account AND s.ts = m.mts`).all(ts),
    snapshotsSince: (ts) => db.prepare('SELECT ts, account, value FROM snapshots WHERE ts >= ? ORDER BY ts').all(ts),
    flows: () => db.prepare('SELECT * FROM flows ORDER BY ts DESC').all(),
    addFlow: (f) => db.prepare('INSERT OR IGNORE INTO flows (ts, day, account, amount, note, source, ext_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(f.ts, f.day, f.account ?? null, f.amount, f.note ?? '', f.source ?? 'manual', f.ext_id ?? null),
    delFlow: (id) => db.prepare('DELETE FROM flows WHERE id = ?').run(id),
    addTrades(trades) {
      for (const t of trades) {
        q.insTrade.run(t.ext_id, t.ts, t.account, t.venue ?? null, t.symbol ?? null, t.side ?? null, t.size ?? null, t.price ?? null,
          t.notional ?? null, t.fee ?? null, t.closed_pnl ?? null, t.start_pos ?? null, t.dir ?? null, t.kind ?? null, t.note ?? null);
      }
    },
    recentTrades: (limit = 150) => db.prepare("SELECT * FROM trades WHERE NOT (kind = 'transfer' AND COALESCE(notional, 0) < 1) ORDER BY ts DESC LIMIT ?").all(limit),
    perpFills: () => db.prepare("SELECT * FROM trades WHERE kind = 'perp' ORDER BY ts, ext_id").all(),
    spotTrades: () => db.prepare("SELECT * FROM trades WHERE kind IN ('spot', 'transfer') ORDER BY ts, ext_id").all(),
    posOpen(day, entries) {
      for (const [key, price] of entries) if (price > 0) q.insPosOpen.run(day, key, price);
      return Object.fromEntries(q.getPosOpen.all(day).map((r) => [r.key, r.price]));
    },
    getMeta: (k) => db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null,
    setMeta: (k, v) => db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, v),
    isEmpty: () => db.prepare('SELECT COUNT(*) AS n FROM daily').get().n === 0,
  };
}
