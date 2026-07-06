'use strict';

// =============================================================================
// Forward migration v5 — Add `summary` (short body text) to news_feed.
//
// The unified-feed UI shows the `title` for each item but users complained
// that headlines like "ครม." give no context. This migration adds a
// nullable TEXT column so the Gemini-search prompt can be extended to also
// emit a 1-2 sentence summary that we store alongside each headline.
//
//   summary TEXT          -- 1-2 sentence Thai summary, NULL for old rows
//
// No backfill is possible for existing rows (their summaries don't exist),
// so old rows keep summary = NULL and the frontend falls back to the title.
// New rows from gemini-company / gemini-sector / gemini-macro will populate
// it as soon as the prompt is updated and the next cron fires.
//
// Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run.
// =============================================================================

require('dotenv').config();

const { Pool } = require('pg');

const PG_URL = process.env.DATABASE_URL;

if (!PG_URL) {
  console.error('[migrate-v5] ERROR: DATABASE_URL not set');
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
  console.log(`[migrate-v5] connecting as user="${cfg.user}" db="${cfg.database}" host="${cfg.host}:${cfg.port}"`);
  const pool = new Pool(cfg);

  try {
    // 1. Add the nullable summary column. Nullable on purpose so the ALTER is
    //    cheap on a populated table (no rewrite of existing tuples).
    await pool.query(`
      ALTER TABLE news_feed
        ADD COLUMN IF NOT EXISTS summary TEXT
    `);
    console.log('[migrate-v5] news_feed.summary column ensured');

    // 2. Verify: count rows + how many already have a summary (should be 0
    //    on a fresh run, > 0 after the next gemini-* cron fires).
    const counts = await pool.query(`
      SELECT
        COUNT(*)                                       AS total,
        COUNT(*) FILTER (WHERE summary IS NOT NULL)    AS with_summary,
        COUNT(*) FILTER (WHERE summary IS NULL)        AS without_summary
      FROM news_feed
    `);
    const r = counts.rows[0];
    console.log('[migrate-v5] counts:', {
      total: Number(r.total),
      with_summary: Number(r.with_summary),
      without_summary: Number(r.without_summary),
    });
    console.log('[migrate-v5] NOTE: trigger POST /api/news/refresh to populate summary on next run');

    console.log('[migrate-v5] done');
  } catch (e) {
    console.error('[migrate-v5] FAILED:', e.message || e);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
