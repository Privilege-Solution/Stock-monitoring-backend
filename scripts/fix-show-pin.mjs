// =============================================================================
// Repair show_pin on rows that are severity='high' but were written with an
// explicit show_pin=false.
//
// db.writeNewsItems() derives the flag as:
//     show_pin != null ? show_pin : severity === 'high'
// so passing an explicit `false` suppresses the derivation. Four historical
// backfill scripts did exactly that (gemini-all-category / gemini-historical /
// gemini-asw / gemini-keyword) while still assigning severity='high'. The
// result: 105 high-severity rows WITH working article links that never drew a
// pin, which is why the dashboard chart looked empty across 2021-2025 and
// crowded only in the last few months.
//
// Those scripts no longer pass show_pin at all; this fixes the rows they
// already wrote. Nothing else is touched — severity, category and URLs are
// left exactly as they are.
//
// Run:
//   node scripts/fix-show-pin.mjs            # dry-run, shows the impact
//   node scripts/fix-show-pin.mjs --apply    # commit
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env'), quiet: true });

const APPLY = process.argv.includes('--apply');
const IPO = '2021-04-28';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (() => {
    try {
      const u = new URL(process.env.DATABASE_URL);
      if (u.hostname.endsWith('.railway.internal') || u.hostname === 'localhost') return false;
    } catch {}
    return { rejectUnauthorized: false };
  })(),
  max: 3,
});

const TARGET = `hidden = FALSE AND severity = 'high' AND show_pin = FALSE`;

const { rows: before } = await pool.query(
  `SELECT LEFT(date,4) yr, COUNT(*)::int n,
          COUNT(*) FILTER (WHERE source_url ~ '^https?://'
                             AND source_url !~ 'vertexaisearch'
                             AND source_url !~ '^https?://[^/]+/?$')::int linked
     FROM news_feed WHERE ${TARGET} AND date >= $1
    GROUP BY 1 ORDER BY 1`, [IPO]);

const total = before.reduce((a, r) => a + r.n, 0);
const linked = before.reduce((a, r) => a + r.linked, 0);

console.log(`[fix-show-pin] mode: ${APPLY ? 'APPLY (will UPDATE)' : 'DRY-RUN (pass --apply to commit)'}`);
console.log(`[fix-show-pin] rows with severity='high' but show_pin=false: ${total} (${linked} with a working article link)\n`);
console.log('  year   rows   of which linked');
for (const r of before) console.log(`  ${r.yr}   ${String(r.n).padStart(4)}   ${String(r.linked).padStart(6)}`);

// What the chart will actually draw afterwards: a pin needs a usable link too
// (buildMarkAnnotations drops any day whose news has none).
const { rows: after } = await pool.query(
  `SELECT LEFT(date,4) yr,
          COUNT(DISTINCT date) FILTER (WHERE (show_pin OR chart_marked))::int now_days,
          COUNT(DISTINCT date) FILTER (WHERE (show_pin OR chart_marked OR severity='high'))::int after_days
     FROM news_feed
    WHERE hidden = FALSE AND date >= $1
      AND source_url ~ '^https?://' AND source_url !~ 'vertexaisearch'
      AND source_url !~ '^https?://[^/]+/?$'
    GROUP BY 1 ORDER BY 1`, [IPO]);
console.log('\n  pinned DAYS on the chart (what you actually see):');
console.log('  year   now   after');
for (const r of after) console.log(`  ${r.yr}  ${String(r.now_days).padStart(4)}  ${String(r.after_days).padStart(6)}`);

if (!APPLY) {
  console.log('\n[fix-show-pin] dry-run — nothing written. Re-run with --apply to commit.');
} else {
  const r = await pool.query(`UPDATE news_feed SET show_pin = TRUE WHERE ${TARGET}`);
  console.log(`\n[fix-show-pin] UPDATED ${r.rowCount} row(s).`);
}

await pool.end();
