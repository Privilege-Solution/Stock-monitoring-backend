// =============================================================================
// One-off: pin the HIGH-impact rows the old show_pin rule left unpinned.
//
// Until 9a31a3e the Gemini parser set show_pin only for the `company` pipeline
// and HIGH `macro` rows, and passed an explicit FALSE everywhere else — which
// writeNewsItems() respects. So every live TITLE row (title-company,
// title-drivers) and ASW's HIGH competitor/policy rows (sector) were stored
// unpinned, and TITLE's chart has had no pins since its backfill ended.
//
// Scope is exactly the rows the NEW rule would have pinned and that only
// Gemini can produce: impact_level HIGH in sector / title-drivers /
// title-company. RSS rows can't match — rss-property is always medium,
// rss-extended's HIGH rows use the company/macro pipelines, and TITLE's RSS
// copies are capped at medium. (Lower-impact title-company rows also pin under
// the new rule, but RSS writes that pipeline name too, so they are left alone.)
//
// display_priority gets the +10 a pinned row carries (priorityForItem), so the
// feed orders them exactly as if they had been written pinned.
//
// Run:
//   node scripts/repin-high-news.mjs            # dry run: counts + sample
//   node scripts/repin-high-news.mjs --apply    # backup ids → UPDATE (one transaction)
// Undo: the backup file lists every id; set show_pin = FALSE and
//       display_priority = display_priority - 10 for exactly those ids.
// =============================================================================

import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env'), quiet: true });
const { default: db } = await import('../backend/db.js');

const APPLY = process.argv.includes('--apply');
const WHERE = `hidden = FALSE AND show_pin = FALSE AND chart_marked = FALSE
               AND impact_level = 'HIGH'
               AND pipeline IN ('sector', 'title-drivers', 'title-company')`;

const pool = db.openDb();
try {
  const { rows } = await pool.query(
    `SELECT id, stock, date, pipeline, category, display_priority, title
       FROM news_feed WHERE ${WHERE} ORDER BY stock, date`);

  const tally = {};
  for (const r of rows) { const k = `${r.stock} ${r.pipeline}`; tally[k] = (tally[k] || 0) + 1; }
  console.log(`[repin] ${rows.length} rows match`);
  for (const [k, n] of Object.entries(tally)) console.log(`   ${String(n).padStart(4)}  ${k}`);
  const first = rows[0]?.date, last = rows.at(-1)?.date;
  if (rows.length) console.log(`   dates ${String(first).slice(0, 10)} … ${String(last).slice(0, 10)}`);
  for (const r of rows.slice(0, 8)) console.log(`   ${String(r.date).slice(0, 10)} ${r.stock} [${r.category}] ${String(r.title).slice(0, 64)}`);

  if (!APPLY) {
    console.log('\n[repin] dry run — nothing written. Re-run with --apply.');
  } else if (rows.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backup = join(__dirname, `backup-repin-${stamp}.json`);
    writeFileSync(backup, JSON.stringify(rows.map(r => ({ id: r.id, stock: r.stock, display_priority: r.display_priority })), null, 2));
    console.log(`[repin] backup of ${rows.length} ids → ${backup}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ids = rows.map(r => r.id);
      // Re-check the predicate inside the UPDATE so a row changed since the
      // SELECT (e.g. marked by a user) is not touched.
      const res = await client.query(
        `UPDATE news_feed SET show_pin = TRUE, display_priority = display_priority + 10
          WHERE id = ANY($1::bigint[]) AND ${WHERE}`, [ids]);
      await client.query('COMMIT');
      console.log(`[repin] updated ${res.rowCount} rows`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
} finally {
  await db.closeDb();
}
