'use strict';

// =============================================================================
// Forward migration v7 — User-remark popover on the Daily Price Table.
//
// Adds 1 nullable column on `daily` so the user can attach a personal note to
// any row of the price table via a click-on-cell popover (separate from the
// Gemini-generated `remark` text — both columns coexist on the same row).
//
// Columns:
//   user_note  TEXT     -- free-text personal remark, NULL means no note yet
//
// Index (partial — small):
//   daily_user_note_idx ON daily (date DESC) WHERE user_note IS NOT NULL
//
// Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS. Safe to
// re-run on a partially-migrated DB.
// =============================================================================

require('dotenv').config();

const { Pool } = require('pg');

const PG_URL = process.env.DATABASE_URL;

if (!PG_URL) {
  console.error('[migrate-v7] ERROR: DATABASE_URL not set');
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
  console.log(`[migrate-v7] connecting as user="${cfg.user}" db="${cfg.database}" host="${cfg.host}:${cfg.port}"`);
  const pool = new Pool(cfg);

  try {
    // 1. Add the nullable user_note column. Cheap ALTER (no table rewrite) on
    //    Postgres because no DEFAULT is set — existing rows stay NULL.
    await pool.query(`
      ALTER TABLE daily
        ADD COLUMN IF NOT EXISTS user_note TEXT
    `);
    console.log('[migrate-v7] daily.user_note column ensured');

    // 2. Partial index — only rows with notes. Tiny, exact, backs future
    //    "show only my notes" widget.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS daily_user_note_idx
        ON daily (date DESC)
        WHERE user_note IS NOT NULL
    `);
    console.log('[migrate-v7] daily_user_note_idx ensured');

    // 3. Verify the new shape + index list.
    const cols = await pool.query(`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_name = 'daily'
         AND column_name = 'user_note'
    `);
    console.log('[migrate-v7] columns:', cols.rows);

    const idx = await pool.query(`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'daily'
         AND indexname = 'daily_user_note_idx'
    `);
    console.log('[migrate-v7] user-remark indexes:', idx.rows.map(r => r.indexname));

    const counts = await pool.query(`
      SELECT COUNT(*)                                        AS total,
             COUNT(*) FILTER (WHERE user_note IS NOT NULL)   AS noted
        FROM daily
    `);
    console.log('[migrate-v7] counts:', {
      total: Number(counts.rows[0].total),
      noted: Number(counts.rows[0].noted),
    });

    console.log('[migrate-v7] done');
  } catch (e) {
    console.error('[migrate-v7] FAILED:', e.message || e);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();