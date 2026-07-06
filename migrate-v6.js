'use strict';

// =============================================================================
// Forward migration v6 — User actions on news_feed (hide + note).
//
// Adds 3 columns so the unified feed and Dashboard sidebar can let the user
// (a) hide/dismiss news rows from view, and (b) attach a personal note
// alongside the headline. Single-tenant model — same flag visible to all
// browsers/sessions of the app.
//
// Columns:
//   hidden     BOOLEAN     NOT NULL DEFAULT FALSE   -- soft delete flag
//   hidden_at  TIMESTAMPTZ                          -- audit: when hidden
//   user_note  TEXT                                -- free-text Thai note
//
// Indexes (partial — only rows that match):
//   news_feed_hidden_at_idx ON news_feed (hidden_at DESC) WHERE hidden = TRUE
//     — backs GET /api/news/hidden (newest hide first)
//   news_feed_user_note_idx ON news_feed (id) WHERE user_note IS NOT NULL
//     — small but exact for future "rows with notes" queries
//
// Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS. Safe to
// re-run on a partially-migrated DB. Existing rows get hidden=false and
// hidden_at=NULL automatically via DEFAULT.
// =============================================================================

require('dotenv').config();

const { Pool } = require('pg');

const PG_URL = process.env.DATABASE_URL;

if (!PG_URL) {
  console.error('[migrate-v6] ERROR: DATABASE_URL not set');
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
  console.log(`[migrate-v6] connecting as user="${cfg.user}" db="${cfg.database}" host="${cfg.host}:${cfg.port}"`);
  const pool = new Pool(cfg);

  try {
    // 1. Add 3 user-action columns in a single ALTER. Nullable hidden_at and
    //    user_note because the DEFAULT for hidden (FALSE) implies hidden_at
    //    is meaningless until the user hides the row.
    await pool.query(`
      ALTER TABLE news_feed
        ADD COLUMN IF NOT EXISTS hidden    BOOLEAN     NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS user_note TEXT
    `);
    console.log('[migrate-v6] news_feed.{hidden,hidden_at,user_note} columns ensured');

    // 2. Partial index on hidden rows — supports the "show hidden" view
    //    (newest hide first). Skip if some rows are pre-hidden from prior
    //    data, they'll be included automatically.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS news_feed_hidden_at_idx
        ON news_feed (hidden_at DESC NULLS LAST)
        WHERE hidden = TRUE
    `);
    console.log('[migrate-v6] news_feed_hidden_at_idx ensured');

    // 3. Partial index on rows with notes — supports future "show only my
    //    notes" dashboard widget (not used yet but cheap to add now).
    await pool.query(`
      CREATE INDEX IF NOT EXISTS news_feed_user_note_idx
        ON news_feed (id)
        WHERE user_note IS NOT NULL
    `);
    console.log('[migrate-v6] news_feed_user_note_idx ensured');

    // 4. Verify the new shape + index list.
    const cols = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_name = 'news_feed'
         AND column_name IN ('hidden', 'hidden_at', 'user_note')
       ORDER BY column_name
    `);
    console.log('[migrate-v6] columns:', cols.rows);

    const idx = await pool.query(`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'news_feed'
         AND indexname IN ('news_feed_hidden_at_idx', 'news_feed_user_note_idx')
       ORDER BY indexname
    `);
    console.log('[migrate-v6] user-action indexes:', idx.rows.map(r => r.indexname));

    const counts = await pool.query(`
      SELECT COUNT(*)                                            AS total,
             COUNT(*) FILTER (WHERE hidden = TRUE)               AS hidden,
             COUNT(*) FILTER (WHERE user_note IS NOT NULL)       AS noted
        FROM news_feed
    `);
    console.log('[migrate-v6] counts:', {
      total: Number(counts.rows[0].total),
      hidden: Number(counts.rows[0].hidden),
      noted: Number(counts.rows[0].noted),
    });

    console.log('[migrate-v6] done');
  } catch (e) {
    console.error('[migrate-v6] FAILED:', e.message || e);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();