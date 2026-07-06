'use strict';

// =============================================================================
// Forward migration v2 — pipeline refactor.
//   1. Adds remark + category columns to `daily` (keeps the 3 legacy columns
//      around for one release so rollback is trivial).
//   2. Backfills the new columns from the 3 legacy columns using a macro-
//      first priority (matches the front-end colour-pin weight).
//   3. Creates the new `news_feed` table with a unique index on title_hash
//      so the Pipeline B writer dedupes naturally.
//
// Idempotent — every DDL uses IF NOT EXISTS and the UPDATE skips rows that
// already have a remark set. Safe to re-run.
//
// Usage:
//   DATABASE_URL=postgres://... node migrate-v2.js
// =============================================================================

const { Pool } = require('pg');

const PG_URL = process.env.DATABASE_URL;

if (!PG_URL) {
  console.error('[migrate-v2] ERROR: DATABASE_URL not set');
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
  console.log(`[migrate-v2] connecting as user="${cfg.user}" db="${cfg.database}" host="${cfg.host}:${cfg.port}"`);
  const pool = new Pool(cfg);

  try {
    // 1. Add the new 2 columns (idempotent).
    await pool.query(`ALTER TABLE daily ADD COLUMN IF NOT EXISTS remark   TEXT`);
    await pool.query(`ALTER TABLE daily ADD COLUMN IF NOT EXISTS category TEXT`);
    console.log('[migrate-v2] daily.remark + daily.category columns ensured');

    // 2. Backfill — first-non-empty priority: macro → sector → company.
    // WHERE remark IS NULL makes this a no-op on the second run.
    const r = await pool.query(`
      UPDATE daily SET
        remark   = COALESCE(remark_macro, remark_sector, remark_company),
        category = CASE
          WHEN remark_macro  IS NOT NULL THEN 'macro'
          WHEN remark_sector IS NOT NULL THEN 'sector'
          WHEN remark_company IS NOT NULL THEN 'company'
          ELSE NULL
        END
      WHERE remark IS NULL
    `);
    console.log(`[migrate-v2] backfilled ${r.rowCount} rows into remark+category`);

    // 3. News feed table.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS news_feed (
        id            SERIAL PRIMARY KEY,
        title         TEXT NOT NULL,
        date          TEXT NOT NULL,
        category      TEXT NOT NULL,
        source_url    TEXT NOT NULL,
        source_label  TEXT NOT NULL,
        title_hash    TEXT NOT NULL,
        fetched_at    TEXT NOT NULL
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS news_feed_title_hash_idx ON news_feed (title_hash)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS news_feed_date_idx     ON news_feed (date DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS news_feed_category_idx ON news_feed (category)`);
    console.log('[migrate-v2] news_feed table + 3 indexes ensured');

    // 4. Verify.
    const counts = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM daily)        AS total_rows,
        (SELECT COUNT(remark) FROM daily)   AS rows_with_remark,
        (SELECT COUNT(category) FROM daily) AS rows_with_category,
        (SELECT COUNT(*) FROM news_feed)    AS news_rows
    `);
    console.log('[migrate-v2] counts:', counts.rows[0]);

    const catBreakdown = await pool.query(`
      SELECT COALESCE(category, '(null)') AS category, COUNT(*) AS n
      FROM daily
      GROUP BY 1 ORDER BY 2 DESC
    `);
    console.log('[migrate-v2] daily category breakdown:', catBreakdown.rows);

    console.log('[migrate-v2] done');
  } catch (e) {
    console.error('[migrate-v2] FAILED:', e.message || e);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
