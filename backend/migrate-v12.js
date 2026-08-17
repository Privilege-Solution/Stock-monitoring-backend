'use strict';

// =============================================================================
// Forward migration v12 — title verification + retry accounting.
//
// v11 recorded WHETHER a link resolved. It could not record whether the page
// that resolved is the right story: ~350 rows return HTTP 200 from the correct
// publisher on an article-shaped path while carrying a completely different
// article. Separately, v11 had nowhere to record that a link has failed
// transiently N times, so every audit re-decided from scratch and a publisher
// having a bad afternoon looked identical to a genuinely broken link.
//
// Columns
// -------
//   source_url_check_attempts  how many times we have checked this link.
//                              Lets the operator tell "failed once, probably a
//                              blip" from "failed on five separate audits".
//                              Never resets on success — it counts checks, not
//                              failures, so a rising number on a `valid` row
//                              is just a well-travelled link.
//   source_url_title           the title the page actually served. This is the
//                              evidence behind a title_mismatch verdict; without
//                              it, "the page is a different story" is an
//                              assertion the operator cannot check.
//   source_url_match_score     0..1 similarity between the stored headline and
//                              that title. Stored so the threshold can be
//                              re-tuned later against real data instead of
//                              re-fetching 1,000 pages to find out what a
//                              different cut-off would have done.
//
// Safety
// ------
//   - ADD COLUMN IF NOT EXISTS throughout: safe to run repeatedly.
//   - Purely additive. No row is deleted, no existing column is rewritten, and
//     no source_url is touched.
//   - source_url_status keeps its v11 default of 'unchecked'. Rows already
//     carrying a v11 status stay exactly as they are; the new title statuses
//     only appear after an audit run.
//   - v11 statuses remain valid values. `dead` rows are NOT rewritten to
//     `soft_404` — the distinction only exists going forward, and rewriting
//     history would invent a precision the old run did not have.
//
// Run (staging first):
//     node backend/migrate-v12.js            # dry-run, prints the plan
//     node backend/migrate-v12.js --apply    # execute
// =============================================================================

require('dotenv').config({ path: require('node:path').join(__dirname, '.env'), quiet: true });

const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const PG_URL = process.env.DATABASE_URL;

if (!PG_URL) {
  console.error('DATABASE_URL not set in environment');
  process.exit(1);
}

const pool = new Pool({
  connectionString: PG_URL,
  ssl: (() => {
    try {
      const u = new URL(PG_URL);
      if (u.hostname.endsWith('.railway.internal') || u.hostname === 'localhost') return false;
    } catch { /* fall through to SSL-on */ }
    return { rejectUnauthorized: false };
  })(),
});

// One statement per query: a single combined string is one implicit
// transaction, so one failure rolls back all of them (see the note in db.js
// ensureSchema).
const STATEMENTS = [
  `ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS source_url_check_attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS source_url_title TEXT`,
  `ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS source_url_match_score REAL`,
  // The audit re-checks the least-recently-verified rows first and the
  // remediation script selects by status; both want these together.
  `CREATE INDEX IF NOT EXISTS news_feed_url_recheck_idx
     ON news_feed (source_url_status, source_url_checked_at NULLS FIRST) WHERE hidden = FALSE`,
];

(async () => {
  const client = await pool.connect();
  try {
    const { rows: existing } = await client.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'news_feed' AND column_name LIKE 'source_url_%'
       ORDER BY column_name`);
    const have = new Set(existing.map(r => r.column_name));

    if (!have.has('source_url_status')) {
      console.error('[migrate-v12] news_feed has no source_url_status — run migrate-v11 first:');
      console.error('              node backend/migrate-v11.js --apply');
      process.exitCode = 1;
      return;
    }

    console.log(`[migrate-v12] existing validation columns: ${[...have].join(', ')}`);
    const missing = ['source_url_check_attempts', 'source_url_title', 'source_url_match_score']
      .filter(c => !have.has(c));
    console.log(`[migrate-v12] to add: ${missing.length ? missing.join(', ') : '(none — already applied)'}`);

    const { rows: [c] } = await client.query(`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE source_url_status <> 'unchecked') AS checked
        FROM news_feed`);
    console.log(`[migrate-v12] news_feed: ${c.total} rows, ${c.checked} already carry a v11 status`);

    if (!APPLY) {
      console.log('\n[migrate-v12] DRY-RUN. Statements that would run:\n');
      for (const s of STATEMENTS) console.log('  ' + s.replace(/\s+/g, ' ').trim());
      console.log('\n[migrate-v12] pass --apply to execute. Additive only — no row or url is modified.');
      return;
    }

    const failures = [];
    for (const sql of STATEMENTS) {
      try {
        await client.query(sql);
        console.log(`  ok  ${sql.replace(/\s+/g, ' ').trim().slice(0, 88)}`);
      } catch (e) {
        failures.push(e.message);
        console.error(`  ERR ${sql.replace(/\s+/g, ' ').trim().slice(0, 66)} → ${e.message}`);
      }
    }

    console.log('\n[migrate-v12] done.');
    console.log('[migrate-v12] next: node scripts/audit-news-urls.mjs --limit=100   # read-only');

    if (failures.length) {
      console.error(`[migrate-v12] ${failures.length} statement(s) failed — see above.`);
      process.exitCode = 1;
    }
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('[migrate-v12] fatal:', e.message);
  process.exit(1);
});
