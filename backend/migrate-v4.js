'use strict';

// =============================================================================
// Forward migration v4 — News & Factors unified feed priority.
//
// Adds one derived column to news_feed so the unified-feed renderer can sort
// severity-first in O(limit) without recomputing per row:
//
//   display_priority SMALLINT NOT NULL DEFAULT 0
//
// Formula (matches the JS version in index.html#priorityForItem):
//   sev  = 'high'           → 100
//        | 'medium'         → 50
//        | 'low' OR NULL    → 25        (NULL severity treated as low)
//   imp  = 'positive'       → 25
//        | 'negative'       → 15
//        | 'neutral' OR NULL→ 5
//   pin  = show_pin=TRUE    → 10  else 0
//   total = sev + imp + pin             // 0..150, fits SMALLINT (-32k..+32k)
//
// Plus a composite DESC index for the unified-feed hot path:
//
//   news_feed_priority_date_idx ON news_feed (display_priority DESC, date DESC)
//
// All DDL is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS; the backfill UPDATE
// only touches rows where display_priority = 0 (set during this run), so
// re-running on an already-backfilled DB is a no-op.
//
// Usage:
//   DATABASE_URL=postgres://... node migrate-v4.js
// =============================================================================

// Load .env (gitignored) BEFORE any module reads DATABASE_URL at import time.
require('dotenv').config();

const { Pool } = require('pg');

const PG_URL = process.env.DATABASE_URL;

if (!PG_URL) {
  console.error('[migrate-v4] ERROR: DATABASE_URL not set');
  process.exit(1);
}

function parsePgUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    ssl: { rejectUnauthorized: false },
    max: 2,
  };
}

async function main() {
  const cfg = parsePgUrl(PG_URL);
  console.log(`[migrate-v4] connecting as user="${cfg.user}" db="${cfg.database}" host="${cfg.host}:${cfg.port}"`);
  const pool = new Pool(cfg);

  try {
    // 1. Add the derived column.
    await pool.query(`
      ALTER TABLE news_feed
        ADD COLUMN IF NOT EXISTS display_priority SMALLINT NOT NULL DEFAULT 0
    `);
    console.log('[migrate-v4] news_feed.display_priority column ensured');

    // 2. Idempotent backfill — only updates rows where the column is still 0
    //    (i.e. just created by the ALTER above, or already backfilled in a
    //    prior run). Compute via CASE per column rather than calling a stored
    //    function so the SQL stays self-contained.
    const updateRes = await pool.query(`
      UPDATE news_feed
      SET display_priority =
            (CASE severity WHEN 'high' THEN 100 WHEN 'medium' THEN 50 ELSE 25 END)
          + (CASE impact   WHEN 'positive' THEN 25 WHEN 'negative' THEN 15 ELSE 5 END)
          + (CASE WHEN show_pin = TRUE THEN 10 ELSE 0 END)
      WHERE display_priority = 0
    `);
    console.log(`[migrate-v4] backfilled ${updateRes.rowCount} rows`);

    // 3. Composite index for the unified-feed hot path.
    //    ORDER BY display_priority DESC, date DESC, id DESC
    //    The id tiebreak keeps order stable when 2 rows share priority+date.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS news_feed_priority_date_idx
        ON news_feed (display_priority DESC, date DESC, id DESC)
    `);
    console.log('[migrate-v4] news_feed_priority_date_idx ensured');

    // 4. Verify.
    const counts = await pool.query(`
      SELECT
        COUNT(*)                                                          AS total,
        COUNT(*)        FILTER (WHERE display_priority = 0)               AS zero_p,
        COUNT(*)        FILTER (WHERE severity = 'high')                  AS high,
        COUNT(*)        FILTER (WHERE display_priority >= 75)             AS p75,
        MAX(display_priority)                                             AS max_p,
        MIN(date)                                                         AS date_min,
        MAX(date)                                                         AS date_max
      FROM news_feed
    `);
    const r = counts.rows[0];
    console.log('[migrate-v4] counts:', r);
    if (Number(r.zero_p) > 0) {
      console.warn(`[migrate-v4] WARNING: ${r.zero_p} rows still have display_priority=0 — re-run or check UPDATE`);
    }
    if (Number(r.max_p) < 25 && Number(r.total) > 0) {
      console.warn(`[migrate-v4] WARNING: max_p=${r.max_p} seems low — formula may be off`);
    }

    const nfIdx = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'news_feed' AND indexname LIKE 'news_feed_priority%'
    `);
    console.log('[migrate-v4] priority indexes:', nfIdx.rows.map(r => r.indexname));

    console.log('[migrate-v4] done');
  } catch (e) {
    console.error('[migrate-v4] FAILED:', e.message || e);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
