'use strict';

// =============================================================================
// Forward migration v3 — Gemini-search pipeline.
//
//   1. Adds 4 columns to news_feed:
//        pipeline   TEXT    -- 'company' | 'sector' | 'macro'
//        impact     TEXT    -- 'positive' | 'negative' | 'neutral'
//        severity   TEXT    -- 'high' | 'medium' | 'low'
//        show_pin   BOOLEAN -- true = also render as event pin on chart
//   2. Adds 4 columns to daily for the Monday weekly brief:
//        morning_brief     TEXT  -- LAST_WEEK bullets
//        morning_watch     TEXT  -- THIS_WEEK_WATCH bullets
//        morning_remark    TEXT  -- TONE (bullish/bearish/neutral)
//        morning_weekly_at TEXT  -- ISO timestamp of last refresh
//   3. Adds 2 partial indexes for chart-pin lookups:
//        news_feed_show_pin_idx ON news_feed (date DESC) WHERE show_pin = TRUE
//        news_feed_pipeline_idx ON news_feed (pipeline)
//
// Idempotent — every DDL uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
// Safe to re-run; no destructive backfill.
//
// Usage:
//   DATABASE_URL=postgres://... node migrate-v3.js
// =============================================================================

const { Pool } = require('pg');

const PG_URL = process.env.DATABASE_URL;

if (!PG_URL) {
  console.error('[migrate-v3] ERROR: DATABASE_URL not set');
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
  console.log(`[migrate-v3] connecting as user="${cfg.user}" db="${cfg.database}" host="${cfg.host}:${cfg.port}"`);
  const pool = new Pool(cfg);

  try {
    // 1. news_feed — 4 new columns (idempotent).
    await pool.query(`ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS pipeline TEXT`);
    await pool.query(`ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS impact   TEXT`);
    await pool.query(`ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS severity TEXT`);
    await pool.query(`ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS show_pin BOOLEAN`);
    console.log('[migrate-v3] news_feed.{pipeline,impact,severity,show_pin} columns ensured');

    // 2. daily — 4 morning-brief columns (idempotent).
    await pool.query(`ALTER TABLE daily ADD COLUMN IF NOT EXISTS morning_brief     TEXT`);
    await pool.query(`ALTER TABLE daily ADD COLUMN IF NOT EXISTS morning_watch     TEXT`);
    await pool.query(`ALTER TABLE daily ADD COLUMN IF NOT EXISTS morning_remark    TEXT`);
    await pool.query(`ALTER TABLE daily ADD COLUMN IF NOT EXISTS morning_weekly_at TEXT`);
    console.log('[migrate-v3] daily.{morning_brief,morning_watch,morning_remark,morning_weekly_at} columns ensured');

    // 3. Indexes for the chart-pin filter and pipeline filter. Partial index on
    //    show_pin=TRUE keeps it tiny (only rows that surface as chart pins).
    await pool.query(`
      CREATE INDEX IF NOT EXISTS news_feed_show_pin_idx
      ON news_feed (date DESC)
      WHERE show_pin = TRUE
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS news_feed_pipeline_idx
      ON news_feed (pipeline)
    `);
    console.log('[migrate-v3] news_feed.{show_pin_partial,pipeline} indexes ensured');

    // 4. Verify.
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM news_feed)                              AS news_rows,
        (SELECT COUNT(*) FROM news_feed WHERE show_pin = TRUE)        AS news_pin_rows,
        (SELECT COUNT(DISTINCT pipeline) FROM news_feed)              AS news_pipelines,
        (SELECT COUNT(*) FROM daily WHERE morning_brief IS NOT NULL)  AS brief_rows
    `);
    console.log('[migrate-v3] counts:', counts.rows[0]);

    const nfCols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'news_feed' ORDER BY ordinal_position
    `);
    const dailyCols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'daily' ORDER BY ordinal_position
    `);
    console.log('[migrate-v3] news_feed columns:', nfCols.rows.map(r => r.column_name));
    console.log('[migrate-v3] daily columns:', dailyCols.rows.map(r => r.column_name));

    console.log('[migrate-v3] done');
  } catch (e) {
    console.error('[migrate-v3] FAILED:', e.message || e);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
