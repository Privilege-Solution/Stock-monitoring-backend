'use strict';

// =============================================================================
// Forward migration v11 — link-validation metadata on news_feed.
//
// Background
// ----------
// news_feed has exactly one field describing link health, `url_verified`, and
// it is a lie by construction: it is derived from `/^https?:\/\//.test(url)`,
// so it means "this string starts with http", not "this link was checked".
// Nothing ever fetched a URL, so the table cannot distinguish:
//
//   - a working article link
//   - a link that 404s
//   - a link the publisher blocks bots from (403 — the page is FINE for a
//     reader; 8 of 60 sampled links are this, and calling them dead would
//     throw away good journalism)
//   - a homepage that loads but never shows the story
//   - a link belonging to a DIFFERENT story (106 URLs are shared across 374
//     rows with unrelated headlines)
//
// This adds the columns needed to record an actual verdict, so the UI can stop
// offering links it has reason to doubt and the operator can see WHY.
//
// Columns
// -------
//   source_url_status            unchecked | valid | dead | blocked |
//                                rate_limited | homepage | mismatch |
//                                timeout | unsafe | unknown
//   source_url_checked_at        TIMESTAMPTZ of the last check (NULL = never)
//   source_url_http_status       the numeric HTTP code we saw, for the operator
//   source_url_final             URL after redirects, when it differs
//   source_url_validation_reason human-readable why, e.g. "HTTP 410"
//
// Safety
// ------
//   - ADD COLUMN IF NOT EXISTS throughout: safe to run repeatedly.
//   - Every column is nullable except the status, which defaults to
//     'unchecked'. Existing rows therefore stay readable and are honestly
//     labelled as "we have not looked at this yet" rather than assumed good.
//   - NO row is deleted and NO source_url is modified. A bad link is a fact to
//     record, not a reason to destroy the news item attached to it.
//   - The old `url_verified` column is LEFT IN PLACE and still written, so a
//     rollback to the previous deploy keeps working. It is now a mirror of
//     (source_url_status = 'valid'); prefer the status column in new code.
//
// Run (staging first — do NOT point this at production casually):
//     node backend/migrate-v11.js            # dry-run, prints the plan
//     node backend/migrate-v11.js --apply    # execute
// =============================================================================

// Load backend/.env explicitly rather than cwd/.env — this file lives in
// backend/ but is normally invoked from the repo root, where bare config()
// finds nothing and the script dies on "DATABASE_URL not set".
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

// Each statement runs on its own. Sending them as one string makes Postgres
// treat the batch as a single implicit transaction, so one failure rolls back
// all of them — the same trap ensureSchema() documents in db.js.
const STATEMENTS = [
  `ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS source_url_status TEXT NOT NULL DEFAULT 'unchecked'`,
  `ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS source_url_checked_at TIMESTAMPTZ`,
  `ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS source_url_http_status INTEGER`,
  `ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS source_url_final TEXT`,
  `ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS source_url_validation_reason TEXT`,
  // The audit script filters on status and orders by staleness; the feed reads
  // only non-hidden rows. Partial index keeps it small.
  `CREATE INDEX IF NOT EXISTS news_feed_url_status_idx
     ON news_feed (source_url_status) WHERE hidden = FALSE`,
  `CREATE INDEX IF NOT EXISTS news_feed_url_checked_idx
     ON news_feed (source_url_checked_at NULLS FIRST) WHERE hidden = FALSE`,
];

(async () => {
  const client = await pool.connect();
  try {
    const { rows: [before] } = await client.query(`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE source_url IS NULL OR source_url = '') AS no_url
        FROM news_feed`);
    console.log(`[migrate-v11] news_feed rows: ${before.total} (${before.no_url} with no url)`);

    const { rows: existing } = await client.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'news_feed' AND column_name LIKE 'source_url_%'`);
    const have = new Set(existing.map(r => r.column_name));
    console.log(`[migrate-v11] validation columns already present: ${have.size ? [...have].join(', ') : '(none)'}`);

    if (!APPLY) {
      console.log('\n[migrate-v11] DRY-RUN. Statements that would run:\n');
      for (const s of STATEMENTS) console.log('  ' + s.replace(/\s+/g, ' ').trim());
      console.log('\n[migrate-v11] pass --apply to execute. No rows are read or written by these.');
      return;
    }

    const failures = [];
    for (const sql of STATEMENTS) {
      try {
        await client.query(sql);
        console.log(`  ok  ${sql.replace(/\s+/g, ' ').trim().slice(0, 88)}`);
      } catch (e) {
        failures.push({ sql, message: e.message });
        console.error(`  ERR ${sql.replace(/\s+/g, ' ').trim().slice(0, 66)} → ${e.message}`);
      }
    }

    const { rows: [after] } = await client.query(`
      SELECT count(*) FILTER (WHERE source_url_status = 'unchecked') AS unchecked,
             count(*) AS total FROM news_feed`);
    console.log(`\n[migrate-v11] done. ${after.unchecked}/${after.total} rows are 'unchecked' (expected on first run).`);
    console.log('[migrate-v11] next: node scripts/audit-news-urls.mjs   # read-only report');

    if (failures.length) {
      console.error(`\n[migrate-v11] ${failures.length} statement(s) failed — see above.`);
      process.exitCode = 1;
    }
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('[migrate-v11] fatal:', e.message);
  process.exit(1);
});
