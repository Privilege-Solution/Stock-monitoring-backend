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
DROP TABLE IF EXISTS news_articles CASCADE;
DROP TABLE IF EXISTS fetch_log CASCADE;
DROP TABLE IF EXISTS peer_prices CASCADE;
DROP TABLE IF EXISTS daily CASCADE;

CREATE TABLE daily (
  date        TEXT PRIMARY KEY,
  close       DOUBLE PRECISION,
  "change"    DOUBLE PRECISION,
  volume      DOUBLE PRECISION,
  value       DOUBLE PRECISION,
  "setIdx"    DOUBLE PRECISION,
  "propIdx"   DOUBLE PRECISION,
  remark      TEXT,
  fetched_at  TEXT NOT NULL
);
CREATE INDEX daily_date_idx ON daily(date);

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

CREATE TABLE news_articles (
  id           SERIAL PRIMARY KEY,
  published_at TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  url          TEXT,
  source_name  TEXT,
  query_tag    TEXT,
  fetched_at   TEXT NOT NULL,
  UNIQUE(url, published_at)
);
CREATE INDEX news_articles_pub_idx ON news_articles(published_at);
CREATE INDEX news_articles_tag_idx ON news_articles(query_tag);
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

  // 2. daily — upsert by date
  await copyTable(pool, sqlite, 'daily',
    ['date', 'close', 'change', 'volume', 'value', 'setIdx', 'propIdx', 'remark', 'fetched_at'],
    `ON CONFLICT (date) DO UPDATE SET
       close = EXCLUDED.close,
       "change" = EXCLUDED."change",
       volume = EXCLUDED.volume,
       value = EXCLUDED.value,
       "setIdx" = EXCLUDED."setIdx",
       "propIdx" = EXCLUDED."propIdx",
       remark = EXCLUDED.remark,
       fetched_at = EXCLUDED.fetched_at`);

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

  // 5. news_articles — dedupe by (url, published_at)
  await copyTable(pool, sqlite, 'news_articles',
    ['id', 'published_at', 'title', 'description', 'url', 'source_name', 'query_tag', 'fetched_at']);

  // 6. Reset SERIAL sequences past MAX(id) so future INSERTs don't collide.
  await pool.query(`SELECT setval(pg_get_serial_sequence('fetch_log','id'),
                       COALESCE((SELECT MAX(id) FROM fetch_log), 1))`);
  await pool.query(`SELECT setval(pg_get_serial_sequence('news_articles','id'),
                       COALESCE((SELECT MAX(id) FROM news_articles), 1))`);

  // 7. Verify counts
  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM daily)         AS daily,
      (SELECT COUNT(*) FROM peer_prices)   AS peer_prices,
      (SELECT COUNT(*) FROM fetch_log)     AS fetch_log,
      (SELECT COUNT(*) FROM news_articles) AS news_articles
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