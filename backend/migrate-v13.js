'use strict';

// =============================================================================
// Forward migration v13 — the `stock` dimension (multi-stock: ASW + TITLE).
//
// Adds `stock TEXT NOT NULL DEFAULT 'ASW'` to daily / news_feed /
// news_daily_summary and moves the uniqueness keys to include it:
//   daily               PK (date)        → (stock, date)
//   news_feed           UNIQUE (title_hash) → (stock, title_hash)
//   news_daily_summary  PK (date)        → (stock, date)
// Every pre-existing row backfills to 'ASW' via the column DEFAULT.
//
// The heavy lifting is db.ensureStockMigration(), which server boot also runs
// — this script exists for the repo's migrate-vN convention (apply/verify
// against staging first, without booting the whole app) and for --down.
//
// Crash-safe ordering (see ensureStockMigration): the NEW unique index is
// created BEFORE the old constraint/index is dropped, so every intermediate
// state keeps at least one uniqueness guarantee and a re-run converges.
//
// Run (staging first):
//     node backend/migrate-v13.js            # dry-run, prints the plan
//     node backend/migrate-v13.js --apply    # execute (idempotent)
//     node backend/migrate-v13.js --down     # ROLLBACK — see below
//
// --down exists because a plain CODE revert against a migrated DB breaks
// hard: the old writeRows does `ON CONFLICT (date)`, which errors with "no
// unique or exclusion constraint matching" once the PK is (stock, date) —
// killing ALL daily writes, not just TITLE's. Rollback procedure is therefore:
//   1. node backend/migrate-v13.js --down    (deletes stock<>'ASW' rows,
//      restores the original single-column keys; the stock columns stay —
//      old code ignores them)
//   2. revert the deploy
// =============================================================================

require('dotenv').config({ path: require('node:path').join(__dirname, '.env'), quiet: true });

const db = require('./db');

const DOWN_STATEMENTS = [
  // TITLE (and any future stock) rows go away — ASW rows are untouched.
  `DELETE FROM daily WHERE stock <> 'ASW'`,
  `DELETE FROM news_feed WHERE stock <> 'ASW'`,
  `DELETE FROM news_daily_summary WHERE stock <> 'ASW'`,
  // Restore the original single-column uniqueness FIRST (safe: post-DELETE,
  // ASW-only data cannot violate them), then drop the composite keys.
  `CREATE UNIQUE INDEX IF NOT EXISTS news_feed_title_hash_idx ON news_feed (title_hash)`,
  `DROP INDEX IF EXISTS news_feed_stock_title_hash_idx`,
  `ALTER TABLE daily DROP CONSTRAINT IF EXISTS daily_pkey`,
  `ALTER TABLE daily ADD PRIMARY KEY (date)`,
  `ALTER TABLE news_daily_summary DROP CONSTRAINT IF EXISTS news_daily_summary_pkey`,
  `ALTER TABLE news_daily_summary ADD PRIMARY KEY (date)`,
];

(async () => {
  const apply = process.argv.includes('--apply');
  const down = process.argv.includes('--down');

  if (down) {
    console.log('[migrate-v13] ROLLBACK — deleting non-ASW rows and restoring single-column keys.');
    const pool = db.openDb();
    const failures = [];
    for (const sql of DOWN_STATEMENTS) {
      try {
        const r = await pool.query(sql);
        console.log(`  ok  ${sql.replace(/\s+/g, ' ').slice(0, 88)}${r.rowCount != null ? `  (${r.rowCount} rows)` : ''}`);
      } catch (e) {
        failures.push(e.message);
        console.error(`  ERR ${sql.replace(/\s+/g, ' ').slice(0, 66)} → ${e.message}`);
      }
    }
    if (failures.length) {
      console.error(`[migrate-v13] ${failures.length} statement(s) failed — DB may be part-rolled-back; re-run --down.`);
      process.exitCode = 1;
    } else {
      console.log('[migrate-v13] rollback done. Now revert the code deploy.');
    }
    await db.closeDb();
    return;
  }

  if (!apply) {
    console.log('[migrate-v13] DRY RUN. Would run db.ensureStockMigration():');
    console.log('  1. ALTER TABLE {daily,news_feed,news_daily_summary} ADD COLUMN IF NOT EXISTS stock DEFAULT \'ASW\'');
    console.log('  2. CREATE UNIQUE INDEX news_feed_stock_title_hash_idx (stock, title_hash); DROP old title_hash index');
    console.log('  3. daily / news_daily_summary: PK (date) → (stock, date) via create-index-then-promote');
    console.log('\n[migrate-v13] pass --apply to execute (idempotent), or --down to roll back.');
    return;
  }

  db.openDb();
  await db.ensureStockMigration();
  console.log('[migrate-v13] done. Existing rows carry stock=\'ASW\'; TITLE rows appear after the next fetch.');
  await db.closeDb();
})().catch((e) => {
  console.error('[migrate-v13] fatal:', e.message);
  process.exit(1);
});
