// =============================================================================
// Correct news_feed.date to the date the PUBLISHER stamped on the article.
//
// WHY: full-backfill.mjs falls back to a synthetic date whenever Gemini does not
// return one —
//     if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) d = `${q.ce}-${mm[q.m]||'06'}-15`;
// where mm maps a quarter to its middle month. The result is 481 rows (~35% of
// the feed) dated the 15th of Feb/May/Aug/Nov — a date no outlet ever published
// on. Those items sit on the wrong day of the chart and in the wrong day group
// of the news feed.
//
// This reads the real date off the publisher's own page, in priority order:
//   1. JSON-LD  datePublished / dateCreated        (most reliable, schema.org)
//   2. <meta property="article:published_time">    (Open Graph, near-universal)
//   3. <meta itemprop="datePublished">, name=pubdate/publish-date/date
//   4. <time datetime="..."> carrying a pubdate marker
//   5. a /YYYY/MM/DD/ path segment in the URL itself
//
// Thai sites sometimes emit Buddhist-era years, so every candidate goes through
// normalizeDateYear (2568 → 2025). Anything outside a sane window, or more than
// MAX_DRIFT_DAYS from the stored date, is reported but NOT applied — a stray
// date scraped from a "related articles" widget should not silently move a row.
//
// Run:
//   node scripts/fix-news-dates.mjs                  # dry-run, placeholder rows only
//   node scripts/fix-news-dates.mjs --apply          # commit those
//   node scripts/fix-news-dates.mjs --all            # every row with a usable URL
//   node scripts/fix-news-dates.mjs --limit=50       # cap the batch
//   node scripts/fix-news-dates.mjs --max-drift=0    # apply regardless of distance
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { normalizeDateYear, mapLimit } from '../backend/lib/fetchers/news-rss-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env'), quiet: true });

const APPLY = process.argv.includes('--apply');
const ALL   = process.argv.includes('--all');
const argNum = (flag, dflt) => {
  const a = process.argv.find(x => x.startsWith(flag + '='));
  const n = a ? parseInt(a.split('=')[1], 10) : NaN;
  return Number.isFinite(n) ? n : dflt;
};
const LIMIT      = argNum('--limit', null);
const MAX_DRIFT  = argNum('--max-drift', 400);   // days; 0 disables the guard
const CONCURRENCY = 5;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const IPO = '2021-04-28';
const TODAY = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

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

// --- date extraction --------------------------------------------------------

const isoOf = (raw) => {
  if (!raw) return null;
  let s = String(raw).trim();
  // Accept full ISO timestamps, plain dates, and slash-separated forms.
  let m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  const y = m[1], mo = m[2].padStart(2, '0'), d = m[3].padStart(2, '0');
  return normalizeDateYear(`${y}-${mo}-${d}`);
};

const sane = (d) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= '2015-01-01' && d <= TODAY;

// Pull the publisher's stamped date out of a page, best source first.
export function extractPublishedDate(html, url) {
  if (html) {
    // 1. JSON-LD. Scan every block — news pages often carry several graphs.
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      const block = m[1];
      for (const key of ['datePublished', 'dateCreated', 'datepublished']) {
        const km = block.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'i'));
        const d = isoOf(km && km[1]);
        if (sane(d)) return { date: d, via: 'json-ld' };
      }
    }
    // 2/3. Meta tags.
    const METAS = [
      /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
      /<meta[^>]+property=["']og:published_time["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["'](?:pubdate|publish-date|publishdate|date|DC\.date\.issued)["'][^>]+content=["']([^"']+)["']/i,
    ];
    for (const re of METAS) {
      const d = isoOf((html.match(re) || [])[1]);
      if (sane(d)) return { date: d, via: 'meta' };
    }
    // 4. <time datetime> — only when it looks like a publication marker.
    for (const m of html.matchAll(/<time[^>]*datetime=["']([^"']+)["'][^>]*>/gi)) {
      const tag = m[0];
      if (!/pubdate|published|entry-date|post-date/i.test(tag)) continue;
      const d = isoOf(m[1]);
      if (sane(d)) return { date: d, via: 'time-tag' };
    }
  }
  // 5. The URL path itself (/2026/05/15/...).
  const um = String(url || '').match(/\/(20\d{2})\/(\d{1,2})\/(\d{1,2})(?:\/|$)/);
  if (um) {
    const d = isoOf(`${um[1]}-${um[2]}-${um[3]}`);
    if (sane(d)) return { date: d, via: 'url-path' };
  }
  return null;
}

async function fetchHtml(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
      redirect: 'follow', signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { html: null, status: r.status, finalUrl: r.url };
    // Only the head matters and some pages are megabytes.
    const text = await r.text();
    return { html: text.slice(0, 300_000), status: r.status, finalUrl: r.url };
  } catch (e) {
    return { html: null, status: 0, err: e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code || e.name) };
  }
}

// --- main -------------------------------------------------------------------

const USABLE_URL = `source_url ~ '^https?://'
                    AND source_url !~ 'vertexaisearch|grounding-api-redirect'
                    AND source_url !~ '^https?://[^/]+/?$'`;
// Placeholder heuristic: the quarter-midpoint dates full-backfill.mjs invents,
// plus anything outside the plausible range.
const SUSPECT = `(
     (RIGHT(date,2) = '15' AND SUBSTRING(date,6,2) IN ('02','05','06','08','11'))
  OR date > '${TODAY}'
  OR date < '${IPO}'
)`;

const where = [`hidden = FALSE`, USABLE_URL];
if (!ALL) where.push(SUSPECT);

const { rows } = await pool.query(
  `SELECT id, title, date, source_url, source_label, pipeline
     FROM news_feed WHERE ${where.join(' AND ')}
    ORDER BY date ASC, id ASC ${LIMIT ? `LIMIT ${LIMIT}` : ''}`
);

console.log(`[fix-dates] scope   : ${ALL ? 'every row with a usable URL' : 'placeholder / out-of-range dates only'}${LIMIT ? ` (limit ${LIMIT})` : ''}`);
console.log(`[fix-dates] targets : ${rows.length} rows`);
console.log(`[fix-dates] mode    : ${APPLY ? 'APPLY (will UPDATE)' : 'DRY-RUN (pass --apply to commit)'}`);
console.log(`[fix-dates] guard   : skip changes further than ${MAX_DRIFT || '∞'} days from the stored date\n`);

let corrected = 0, same = 0, notFound = 0, tooFar = 0, written = 0;
const drifted = [];

await mapLimit(rows, CONCURRENCY, async (row, i) => {
  const { html, status, err } = await fetchHtml(row.source_url);
  const found = extractPublishedDate(html, row.source_url);
  const tag = `[${String(i + 1).padStart(4)}/${rows.length}]`;

  if (!found) {
    notFound++;
    if (notFound <= 6) console.log(`${tag} ?  no date on page (${status || err})  ${row.date}  ${row.title.slice(0, 44)}`);
    return;
  }
  if (found.date === row.date) { same++; return; }

  const driftDays = Math.abs(new Date(found.date) - new Date(row.date)) / 864e5;
  if (MAX_DRIFT && driftDays > MAX_DRIFT) {
    tooFar++;
    drifted.push({ row, found, driftDays: Math.round(driftDays) });
    return;
  }

  corrected++;
  console.log(`${tag} ✓  ${row.date} → ${found.date}  (${found.via}, ${Math.round(driftDays)}d)  ${row.title.slice(0, 42)}`);
  if (APPLY) {
    await pool.query(`UPDATE news_feed SET date = $1 WHERE id = $2`, [found.date, row.id]);
    written++;
  }
});

console.log(`\n[fix-dates] already correct : ${same}`);
console.log(`[fix-dates] corrected       : ${corrected}${APPLY ? ` (${written} UPDATEd)` : ' (dry-run)'}`);
console.log(`[fix-dates] no date found   : ${notFound}`);
console.log(`[fix-dates] skipped, drift > ${MAX_DRIFT}d : ${tooFar}`);
if (drifted.length) {
  console.log(`\n  these need a human — page date is far from the stored date:`);
  for (const d of drifted.slice(0, 10)) {
    console.log(`   ${d.row.date} → ${d.found.date} (${d.driftDays}d, ${d.found.via})  ${d.row.title.slice(0, 50)}`);
  }
  console.log(`   re-run with --max-drift=0 to apply these too.`);
}
if (!APPLY) console.log(`\n[fix-dates] dry-run — nothing written.`);
await pool.end();
