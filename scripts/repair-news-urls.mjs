// =============================================================================
// Repair the two classes of unopenable link already sitting in news_feed, and
// retire the rows that can never be dated or opened.
//
// This is the DATA half of the news-link/news-date fix. The CODE half (the URL
// cut in db.sanitizeSourceUrl + parseAIResult, and the event-date row dating in
// gemini-search.mjs) stops new bad rows; it cannot touch what is already
// stored. Measured on 2026-08-17 against 1,551 rows:
//
//   97  vertexaisearch.cloud.google.com/grounding-api-redirect/... URLs.
//       Sampled 22: 7 already hard-404, 1 connection error. Google expires
//       them. ALL 97 came from one gemini-historical run on 2026-08-03, two
//       days before sanitizeSourceUrl() started rejecting them — pure legacy,
//       not an ongoing leak. 44 of them draw a chart pin, and every one of
//       those 44 also sits on a fabricated date: the worst rows in the table.
//   87  URLs with junk glued on ("<url> / <url>", "<url>, <url>",
//       "<url> (อ้างอิงจากข่าว...)"). Unlike the vertex rows these were STILL
//       being written (3 on 08-14, 3 on 08-13, 4 on 08-10) because new URL()
//       accepts them — it percent-encodes the junk and succeeds.
//
// PHASES (each is opt-in; the default run only reports):
//
//   0  --apply-urls       Split titles that swallowed the whole Gemini record
//                         ("HEADLINE:x SUMMARY:y IMPACT_LEVEL:HIGH URL:z" all
//                         in `title`, longest 6,368 chars) back into fields,
//                         recovering the summary and URL buried inside.
//   A  --apply-urls       Re-cut malformed URLs through the same sanitizer the
//                         write path now uses. Pure string work, no network.
//   B  --apply-urls       Try to recover a real article link for each vertex
//                         row via deepenHomepageUrl() (Bing News, headline-
//                         matched). Unrecoverable rows have the dead URL
//                         CLEARED to '' — the UI already renders an empty
//                         source_url as an unclickable headline, which is
//                         honest, where a vertex link is a promise that 404s.
//   C  --hide-undatable   Hide rows with a fabricated date AND no URL left to
//                         read a real date off. Nothing can date these:
//                         re-asking Gemini is what fabricated them in the first
//                         place. `hidden` is reversible and readNewsFeed
//                         already filters on it.
//   D  --hide-undatable   Un-pin (show_pin = FALSE) fabricated-date rows that
//                         DO still have a working link. The row stays readable
//                         in the feed; it just stops putting a marker on a day
//                         of the price chart where the news did not happen.
//                         Rows the user pinned by hand are never touched.
//
// RUN IN THIS ORDER — C/D must come after fix-news-dates, or they retire rows
// it could have repaired:
//
//   node scripts/repair-news-urls.mjs                  # dry-run report
//   node scripts/repair-news-urls.mjs --apply-urls     # phases 0 + A + B
//   node scripts/fix-news-dates.mjs --apply            # date rows that have a URL
//   node scripts/repair-news-urls.mjs --hide-undatable # phases C + D
//
// Every mutating run writes a timestamped JSON backup of the affected rows
// (id + the columns it touches) next to the script before changing anything,
// so any phase can be reverted with a plain UPDATE ... FROM the file.
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import db from '../backend/db.js';
import { deepenHomepageUrl, isHomepageUrl, mapLimit } from '../backend/lib/fetchers/news-rss-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env'), quiet: true });

const APPLY_URLS    = process.argv.includes('--apply-urls');
const HIDE_UNDATABLE = process.argv.includes('--hide-undatable');
// Bing throttles an unbounded fan-out and a throttled response is invisible
// downstream (see mapLimit in news-rss-helpers) — same cap as the fetchers.
const BING_CONCURRENCY = 4;

const TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
// (no IPO floor — see FABRICATED_DATE)

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (() => {
    try {
      const u = new URL(process.env.DATABASE_URL);
      if (u.hostname.endsWith('.railway.internal') || u.hostname === 'localhost') return false;
    } catch {}
    return { rejectUnauthorized: false };
  })(),
  max: 4,
});

// The fabricated-date signature — matched on the GENERATOR's fingerprint, not
// on "looks implausible". Two generators produced these:
//   full-backfill.mjs      `${year}-${quarterMiddleMonth}-15`  → day 15 of 02/05/08/11
//   gemini-*-backfill.mjs  `${year}-06-01`                     → the mid-year fallback
// Plus a future date, which is always a model error.
//
// NOT `date < IPO`. fix-news-dates.mjs uses that bound and it is safe THERE
// (that script re-reads the publisher's page and would simply re-confirm a
// correct date), but here a false positive HIDES a row. All 13 pre-IPO rows in
// the table are real: ASW's IPO priced on 2021-04-12 and listed on 2021-04-28,
// so two weeks of legitimate run-up coverage sits before the listing date. An
// IPO-date floor would have retired 6 of them as fabrications. The floor below
// is a garbage-year check only.
const FABRICATED_DATE = `(
     (RIGHT(date,2) = '15' AND SUBSTRING(date,6,2) IN ('02','05','06','08','11'))
  OR RIGHT(date,5) = '06-01'
  OR date > '${TODAY}'
  OR date < '2000-01-01'
)`;

// A title carrying another field's marker means the whole Gemini record
// collapsed into it — see the FIELD_MARKER note in gemini-search.mjs. Also
// recovers the SUMMARY and URL that were swallowed along with it.
const IS_BLOB_TITLE = `title ~ '(SUMMARY|IMPACT_LEVEL|SOURCE|URL|CATEGORY|EVENT_DATE|PUBLISH_DATE|CONFIDENCE)[[:space:]]*:'`;
const FIELD_MARKER  = /\s*\[?\b(?:CATEGORY|HEADLINE|SUMMARY|IMPACT_LEVEL|SOURCE|URL|DATE|EVENT_DATE|PUBLISH_DATE|CONFIDENCE)\s*:/;

const IS_VERTEX    = `source_url ~ 'vertexaisearch|grounding-api-redirect'`;
// Junk glued onto the URL: whitespace anywhere, or a comma/semicolon that runs
// straight into a second scheme.
const IS_MALFORMED = `(source_url ~ '[[:space:]]' OR source_url ~ '[,;][[:space:]]*https?://')`;

const stamp = new Date(Date.now() + 7 * 3600 * 1000).toISOString().replace(/[:.]/g, '-').slice(0, 19);
function backup(name, rows) {
  if (!rows.length) return null;
  const file = join(__dirname, `backup-${name}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(rows, null, 2));
  console.log(`    backup → ${file}  (${rows.length} rows)`);
  return file;
}

// --- report ------------------------------------------------------------------

async function report() {
  const { rows: [c] } = await pool.query(`
    SELECT
      count(*)                                              AS total,
      count(*) FILTER (WHERE ${IS_BLOB_TITLE})              AS blob_title,
      count(*) FILTER (WHERE ${IS_VERTEX})                  AS vertex,
      count(*) FILTER (WHERE ${IS_MALFORMED})               AS malformed,
      count(*) FILTER (WHERE ${FABRICATED_DATE})            AS fake_date,
      count(*) FILTER (WHERE ${FABRICATED_DATE} AND ${IS_VERTEX}) AS fake_date_and_vertex,
      count(*) FILTER (WHERE ${FABRICATED_DATE}
                         AND (source_url IS NULL OR source_url = '')) AS fake_date_no_url,
      count(*) FILTER (WHERE (show_pin OR chart_marked) AND ${IS_VERTEX}) AS vertex_pins
    FROM news_feed WHERE hidden = FALSE`);

  console.log('news_feed (visible rows only)');
  console.log(`  total                              ${c.total}`);
  console.log('  — content —');
  console.log(`  titles holding a whole record      ${c.blob_title}`);
  console.log('  — links —');
  console.log(`  vertex grounding redirects         ${c.vertex}   (expire → 404)`);
  console.log(`  ...of which draw a chart pin       ${c.vertex_pins}`);
  console.log(`  malformed (junk glued on)          ${c.malformed}`);
  console.log('  — dates —');
  console.log(`  fabricated date                    ${c.fake_date}`);
  console.log(`  ...also a vertex link              ${c.fake_date_and_vertex}`);
  console.log(`  ...with no URL to re-date from     ${c.fake_date_no_url}`);
  console.log('');
}

// --- phase 0: split blob titles back into their fields ------------------------

// Pull one field's value out of a run-together record, stopping at the next
// marker. Mirrors get() in gemini-search.mjs.
function fieldOf(text, key) {
  const m = String(text).match(new RegExp(`${key}\\s*:\\s*(.+)`, 's'));
  if (!m) return null;
  const v = m[1].split(FIELD_MARKER)[0].trim().replace(/^\[|\]$/g, '').trim();
  return v || null;
}

async function phase0() {
  const { rows } = await pool.query(
    `SELECT id, title, summary, source_url FROM news_feed
      WHERE hidden = FALSE AND ${IS_BLOB_TITLE} ORDER BY length(title) DESC`);
  console.log(`[0] titles holding a whole record: ${rows.length} row(s)`);
  if (!rows.length) return;

  const fixes = [];
  for (const r of rows) {
    // Everything before the first marker is the real headline. Strip the
    // bracket the prompt's placeholder syntax leaves behind.
    const headline = String(r.title).split(FIELD_MARKER)[0].trim().replace(/^\[|\]$/g, '').trim();
    if (!headline || headline === r.title) continue;
    // The SUMMARY and URL were swallowed by the same collapse — recover them
    // rather than leave the row with a truncated title and nothing else.
    const summary = r.summary || fieldOf(r.title, 'SUMMARY');
    const rescuedUrl = db.sanitizeSourceUrl(fieldOf(r.title, 'URL') || '');
    fixes.push({
      id: r.id,
      old: { title: r.title, summary: r.summary, source_url: r.source_url },
      title: headline,
      summary,
      // Only fill an EMPTY url — never overwrite a link the row already has.
      source_url: (!r.source_url && rescuedUrl) ? rescuedUrl : r.source_url,
    });
  }
  for (const f of fixes.slice(0, 5)) {
    console.log(`    ${f.id}  ${f.old.title.length} chars → ${f.title.length}`);
    console.log(`         "${f.title.slice(0, 62)}"`);
  }
  if (fixes.length > 5) console.log(`    ... and ${fixes.length - 5} more`);

  if (!APPLY_URLS) { console.log('    DRY-RUN — pass --apply-urls to write\n'); return; }
  backup('blob-titles', fixes.map(f => ({ id: f.id, ...f.old })));
  let rescued = 0;
  for (const f of fixes) {
    if (f.source_url && !f.old.source_url) rescued++;
    await pool.query(
      `UPDATE news_feed SET title = $1, summary = $2, source_url = $3 WHERE id = $4`,
      [f.title, f.summary, f.source_url || '', f.id]);
  }
  console.log(`    ✓ split ${fixes.length} title(s); recovered ${rescued} URL(s) from the blob\n`);
}

// --- phase A: re-cut malformed URLs ------------------------------------------

async function phaseA() {
  const { rows } = await pool.query(
    `SELECT id, title, source_url FROM news_feed
      WHERE hidden = FALSE AND ${IS_MALFORMED} ORDER BY id`);
  console.log(`[A] malformed URLs: ${rows.length} row(s)`);
  if (!rows.length) return;

  const fixes = [];
  for (const r of rows) {
    // The same function the write path now calls — one definition of the cut.
    const cleaned = db.sanitizeSourceUrl(r.source_url);
    if (cleaned !== r.source_url) fixes.push({ ...r, cleaned });
  }
  for (const f of fixes.slice(0, 8)) {
    console.log(`    ${f.id}  ${String(f.source_url).slice(0, 58)}`);
    console.log(`         → ${f.cleaned ? String(f.cleaned).slice(0, 58) : '(cleared)'}`);
  }
  if (fixes.length > 8) console.log(`    ... and ${fixes.length - 8} more`);

  if (!APPLY_URLS) { console.log('    DRY-RUN — pass --apply-urls to write\n'); return; }
  backup('malformed-urls', fixes.map(f => ({ id: f.id, source_url: f.source_url })));
  for (const f of fixes) {
    await pool.query(
      `UPDATE news_feed SET source_url = $1, url_verified = $2 WHERE id = $3`,
      [f.cleaned, /^https?:\/\//i.test(f.cleaned), f.id]);
  }
  console.log(`    ✓ updated ${fixes.length} row(s)\n`);
}

// --- phase B: recover or clear vertex URLs ------------------------------------

async function phaseB() {
  const { rows } = await pool.query(
    `SELECT id, title, source_label, source_url, show_pin, chart_marked
       FROM news_feed WHERE hidden = FALSE AND ${IS_VERTEX} ORDER BY id`);
  console.log(`[B] vertex grounding redirects: ${rows.length} row(s)`);
  if (!rows.length) return;

  if (!APPLY_URLS) {
    console.log(`    would search Bing for a real article link for each, and`);
    console.log(`    clear the URL on any that cannot be resolved`);
    console.log('    DRY-RUN — pass --apply-urls to write\n');
    return;
  }

  backup('vertex-urls', rows.map(r => ({ id: r.id, source_url: r.source_url })));

  let recovered = 0, cleared = 0;
  await mapLimit(rows, BING_CONCURRENCY, async (r) => {
    // deepenHomepageUrl only returns a hit whose headline tokens (and company
    // aliases) match this story — never a same-domain consolation prize.
    let deep = null;
    try { deep = await deepenHomepageUrl(r.title, r.source_label); } catch {}
    if (deep && !isHomepageUrl(deep)) {
      await pool.query(
        `UPDATE news_feed SET source_url = $1, url_verified = TRUE WHERE id = $2`,
        [deep, r.id]);
      recovered++;
      console.log(`    ✓ ${r.id}  ${String(r.title).slice(0, 44)}`);
      console.log(`         → ${deep.slice(0, 70)}`);
    } else {
      await pool.query(
        `UPDATE news_feed SET source_url = '', url_verified = FALSE WHERE id = $1`,
        [r.id]);
      cleared++;
    }
  });
  console.log(`    ✓ recovered ${recovered}, cleared ${cleared}\n`);
}

// --- phase C: retire the undatable -------------------------------------------

async function phaseC() {
  const { rows } = await pool.query(
    `SELECT id, date, title, pipeline FROM news_feed
      WHERE hidden = FALSE AND ${FABRICATED_DATE}
        AND (source_url IS NULL OR source_url = '')
      ORDER BY date, id`);
  console.log(`[C] fabricated date + no URL to re-date from: ${rows.length} row(s)`);
  if (!rows.length) return;
  for (const r of rows.slice(0, 6)) {
    console.log(`    ${r.id}  ${r.date}  [${r.pipeline}]  ${String(r.title).slice(0, 50)}`);
  }
  if (rows.length > 6) console.log(`    ... and ${rows.length - 6} more`);

  if (!HIDE_UNDATABLE) {
    console.log('    DRY-RUN — pass --hide-undatable to hide these');
    console.log('    (run fix-news-dates.mjs --apply FIRST, or this hides rows it could have fixed)\n');
    return;
  }
  backup('hidden-undatable', rows.map(r => ({ id: r.id, date: r.date, hidden: false })));
  const ids = rows.map(r => r.id);
  await pool.query(
    `UPDATE news_feed SET hidden = TRUE, hidden_at = now() WHERE id = ANY($1::int[])`, [ids]);
  console.log(`    ✓ hid ${ids.length} row(s) — reversible: UPDATE news_feed SET hidden=FALSE WHERE id = ANY(...)\n`);
}

// --- phase D: un-pin the fabricated dates that still have a link --------------

// A fabricated-date row that DOES have a working link is worth keeping in the
// feed — the reader can open it and see the real story. What it must not do is
// put a marker on the price chart, because the chart's whole claim is "this
// news happened on this day" and for these rows that is false.
//
// So: clear show_pin, keep the row. Rows the USER pinned (chart_marked) are
// never touched — that is their call, not this script's.
async function phaseD() {
  const { rows } = await pool.query(
    `SELECT id, date, title FROM news_feed
      WHERE hidden = FALSE AND ${FABRICATED_DATE}
        AND source_url IS NOT NULL AND source_url <> ''
        AND show_pin = TRUE AND chart_marked = FALSE
      ORDER BY date, id`);
  console.log(`[D] chart pins on a fabricated date (link intact): ${rows.length} row(s)`);
  if (!rows.length) return;
  for (const r of rows.slice(0, 5)) {
    console.log(`    ${r.id}  ${r.date}  ${String(r.title).slice(0, 52)}`);
  }
  if (rows.length > 5) console.log(`    ... and ${rows.length - 5} more`);

  if (!HIDE_UNDATABLE) {
    console.log('    DRY-RUN — pass --hide-undatable to un-pin these (row stays in the feed)\n');
    return;
  }
  backup('unpinned-fake-date', rows.map(r => ({ id: r.id, date: r.date, show_pin: true })));
  const ids = rows.map(r => r.id);
  await pool.query(`UPDATE news_feed SET show_pin = FALSE WHERE id = ANY($1::int[])`, [ids]);
  console.log(`    ✓ un-pinned ${ids.length} row(s) — still readable in the feed\n`);
}

// --- main ---------------------------------------------------------------------

console.log(`[repair-news-urls] ${TODAY} — mode: ${
  APPLY_URLS ? 'APPLY URLS (A+B)' : HIDE_UNDATABLE ? 'HIDE UNDATABLE (C)' : 'DRY-RUN (report only)'}\n`);

await report();
await phase0();
await phaseA();
await phaseB();
await phaseC();
await phaseD();

if (APPLY_URLS) {
  console.log('NEXT:  node scripts/fix-news-dates.mjs --apply');
  console.log('       then: node scripts/repair-news-urls.mjs --hide-undatable');
}
await pool.end();
