'use strict';

// One-time SQLite → Postgres migration.
// Reads from data/asw.db (node:sqlite), writes to the Supabase Postgres URL in
// DATABASE_URL. Safe to re-run: every table uses ON CONFLICT DO NOTHING/UPDATE.
//
// Usage:
//   DATABASE_URL=postgres://... node migrate.js

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');
const { classifySingle } = require('./lib/remark-bucket');

const SQLITE_PATH = path.join(__dirname, 'data', 'asw.db');
const PG_URL = process.env.DATABASE_URL;
const BATCH = 500;

if (!PG_URL) {
  console.error('[migrate] ERROR: DATABASE_URL not set');
  process.exit(1);
}
if (!fs.existsSync(SQLITE_PATH)) {
  console.error('[migrate] ERROR: SQLite DB not found at', SQLITE_PATH);
  process.exit(1);
}

const SCHEMA = `
-- Drop existing tables so we get a clean schema with proper camelCase columns.
-- Re-running migrate.js is idempotent — DROP + CREATE is safe here because
-- every row is reproducible from data/asw.db.
-- news_articles was dropped when we replaced NewsAPI with Gemini grounded
-- search (commit "Migrate from SQLite to Postgres + AI remarks pipeline").
-- Pipeline refactor (migrate-v2): daily.remark is now a SINGLE column +
-- single category. The old 3-column shape (remark_company/sector/macro) is
-- gone for fresh installs.
-- Gemini-search pipeline (migrate-v3): daily also holds a Monday morning
-- brief (morning_brief/morning_watch/morning_remark/morning_weekly_at);
-- news_feed holds pipeline/impact/severity/show_pin per row so the chart
-- can filter event pins precisely.
-- For live-DB upgrades from earlier shapes, run migrate-v2.js then
-- migrate-v3.js — those scripts add the new columns without dropping data.
DROP TABLE IF EXISTS fetch_log CASCADE;
DROP TABLE IF EXISTS peer_prices CASCADE;
DROP TABLE IF EXISTS news_feed CASCADE;
DROP TABLE IF EXISTS daily CASCADE;

CREATE TABLE daily (
  date              TEXT PRIMARY KEY,
  close             DOUBLE PRECISION,
  "change"          DOUBLE PRECISION,
  volume            DOUBLE PRECISION,
  value             DOUBLE PRECISION,
  "setIdx"          DOUBLE PRECISION,
  "propIdx"         DOUBLE PRECISION,
  remark            TEXT,
  category          TEXT,
  -- Monday morning brief (Gemini-search pipeline, migrate-v3)
  morning_brief     TEXT,
  morning_watch     TEXT,
  morning_remark    TEXT,
  morning_weekly_at TEXT,
  fetched_at        TEXT NOT NULL
);
CREATE INDEX daily_date_idx ON daily(date);

CREATE TABLE news_feed (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  date          TEXT NOT NULL,
  category      TEXT NOT NULL,
  source_url    TEXT NOT NULL,
  source_label  TEXT NOT NULL,
  title_hash    TEXT NOT NULL,
  -- Gemini-search pipeline enrichment (migrate-v3)
  pipeline      TEXT,                 -- 'company' | 'sector' | 'macro'
  impact        TEXT,                 -- 'positive' | 'negative' | 'neutral'
  severity      TEXT,                 -- 'high' | 'medium' | 'low'
  show_pin      BOOLEAN,              -- true → also render as event pin on chart
  fetched_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX news_feed_title_hash_idx ON news_feed (title_hash);
CREATE INDEX news_feed_date_idx     ON news_feed (date DESC);
CREATE INDEX news_feed_category_idx ON news_feed (category);
CREATE INDEX news_feed_show_pin_idx ON news_feed (date DESC) WHERE show_pin = TRUE;
CREATE INDEX news_feed_pipeline_idx ON news_feed (pipeline);

CREATE TABLE peer_prices (
  date        TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  name        TEXT,
  close       DOUBLE PRECISION,
  "change"    DOUBLE PRECISION,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (date, ticker)
);
CREATE INDEX peer_prices_date_idx ON peer_prices(date);

CREATE TABLE fetch_log (
  id           SERIAL PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  ok           INTEGER NOT NULL,
  source       TEXT NOT NULL,
  rows_added   INTEGER,
  rows_updated INTEGER,
  error        TEXT
);
`;

// pg-format-style batch INSERT. Builds `$1,$2,...,$N`,($N+1,...) for `rows`.
function batchInsert(table, cols, rows) {
  if (!rows.length) return { sql: '', params: [] };
  const placeholders = [];
  const params = [];
  let p = 1;
  for (const row of rows) {
    const tuple = cols.map((_, i) => `$${p++}`).join(', ');
    placeholders.push(`(${tuple})`);
    for (const c of cols) params.push(row[c]);
  }
  const sql = `INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(', ')}) VALUES ${placeholders.join(', ')} ON CONFLICT DO NOTHING`;
  return { sql, params };
}

async function copyTable(pool, sqlite, table, cols, conflictClause = '') {
  const all = sqlite.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all();
  console.log(`[migrate] ${table}: ${all.length} rows`);
  if (!all.length) return 0;

  let written = 0;
  for (let i = 0; i < all.length; i += BATCH) {
    const slice = all.slice(i, i + BATCH);
    // Use DO UPDATE form for tables with natural keys we want to upsert on.
    const { sql, params } = batchInsert(table, cols, slice);
    const finalSql = conflictClause ? sql.replace('ON CONFLICT DO NOTHING', conflictClause) : sql;
    await pool.query(finalSql, params);
    written += slice.length;
  }
  console.log(`[migrate] ${table}: ${written} rows written`);
  return written;
}

// Parse DATABASE_URL into explicit pg config. Bypasses pg's URL parser,
// which mangles userinfo containing brackets even when URL-encoded.
function parsePgUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    ssl: { rejectUnauthorized: false },
    max: 4,
  };
}

async function main() {
  const sqlite = new DatabaseSync(SQLITE_PATH);
  const cfg = parsePgUrl(PG_URL);
  console.log(`[migrate] connecting as user="${cfg.user}" db="${cfg.database}" host="${cfg.host}:${cfg.port}"`);
  const pool = new Pool(cfg);

  console.log('[migrate] connected to Postgres');

  // 1. Schema
  await pool.query(SCHEMA);
  console.log('[migrate] schema ensured');

  // 2. daily — read legacy rows from SQLite, collapse the single `remark`
  // text into one remark column + one category column via classifySingle().
  // Then upsert into Postgres by date. Pipeline refactor: 1 row → 1 remark
  // (was 3 columns in the v1 schema).
  const dailyRows = sqlite.prepare(
    `SELECT date, close, change, volume, value, setIdx, propIdx, remark, fetched_at FROM daily`
  ).all();
  console.log(`[migrate] daily: ${dailyRows.length} rows`);
  const DAILY_COLS = ['date','close','change','volume','value','setIdx','propIdx','remark','category','morning_brief','morning_watch','morning_remark','morning_weekly_at','fetched_at'];
  let dailyWritten = 0;
  for (let i = 0; i < dailyRows.length; i += BATCH) {
    const slice = dailyRows.slice(i, i + BATCH);
    const split = slice.map(r => {
      const b = classifySingle(r.remark || '');
      return {
        date: r.date,
        close: r.close,
        change: r.change,
        volume: r.volume,
        value: r.value,
        setIdx: r.setIdx,
        propIdx: r.propIdx,
        remark: b.text,
        category: b.category,
        // morning-brief columns — SQLite source has none, leave null. The
        // Monday morning-brief fetcher (gemini-search.mjs) will populate them
        // on the next Monday cron run.
        morning_brief: null,
        morning_watch: null,
        morning_remark: null,
        morning_weekly_at: null,
        fetched_at: r.fetched_at,
      };
    });
    const placeholders = [];
    const params = [];
    let p = 1;
    for (const row of split) {
      const tup = DAILY_COLS.map(_ => `$${p++}`).join(', ');
      placeholders.push(`(${tup})`);
      for (const c of DAILY_COLS) params.push(row[c]);
    }
    await pool.query(`
      INSERT INTO daily (date, close, "change", volume, value, "setIdx", "propIdx",
                         remark, category,
                         morning_brief, morning_watch, morning_remark, morning_weekly_at,
                         fetched_at)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (date) DO UPDATE SET
        close             = EXCLUDED.close,
        "change"          = EXCLUDED."change",
        volume            = EXCLUDED.volume,
        value             = EXCLUDED.value,
        "setIdx"          = EXCLUDED."setIdx",
        "propIdx"         = EXCLUDED."propIdx",
        remark            = EXCLUDED.remark,
        category          = EXCLUDED.category,
        morning_brief     = EXCLUDED.morning_brief,
        morning_watch     = EXCLUDED.morning_watch,
        morning_remark    = EXCLUDED.morning_remark,
        morning_weekly_at = EXCLUDED.morning_weekly_at,
        fetched_at        = EXCLUDED.fetched_at
    `, params);
    dailyWritten += slice.length;
  }
  console.log(`[migrate] daily: ${dailyWritten} rows written`);

  // 3. peer_prices — upsert by (date, ticker)
  await copyTable(pool, sqlite, 'peer_prices',
    ['date', 'ticker', 'name', 'close', 'change', 'fetched_at'],
    `ON CONFLICT (date, ticker) DO UPDATE SET
       name = EXCLUDED.name,
       close = EXCLUDED.close,
       "change" = EXCLUDED."change",
       fetched_at = EXCLUDED.fetched_at`);

  // 4. fetch_log — preserve IDs, skip dupes
  await copyTable(pool, sqlite, 'fetch_log',
    ['id', 'started_at', 'finished_at', 'ok', 'source', 'rows_added', 'rows_updated', 'error']);

  // 5. Reset SERIAL sequences past MAX(id) so future INSERTs don't collide.
  await pool.query(`SELECT setval(pg_get_serial_sequence('fetch_log','id'),
                       COALESCE((SELECT MAX(id) FROM fetch_log), 1))`);

  // 6. Verify counts
  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM daily)       AS daily,
      (SELECT COUNT(*) FROM peer_prices) AS peer_prices,
      (SELECT COUNT(*) FROM fetch_log)   AS fetch_log,
      (SELECT COUNT(*) FROM news_feed)   AS news_feed
  `);
  console.log('[migrate] final counts:', counts.rows[0]);

  console.log('[migrate] done');
  await pool.end();
  sqlite.close();
}

main().catch(e => {
  console.error('[migrate] FAILED:', e.message || e);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});