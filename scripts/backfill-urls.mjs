// =============================================================================
// One-shot backfill: rewrite stale news.google.com URLs in news_feed to the
// real publisher article URL, by searching Bing News RSS for each row's
// headline. Old rows from before the Bing switch still carry Google News
// redirects that 404 over time — this migrates them in place so the dashboard
// sidebar links work again without waiting for the rows to age out.
//
// Run:
//   node scripts/backfill-urls.mjs            # dry-run, prints what would change
//   node scripts/backfill-urls.mjs --apply    # actually UPDATE the DB
//
// Matching: normalize each headline (lowercase, strip punctuation/whitespace,
// drop a trailing "- SourceName" suffix). Then search Bing News RSS with the
// raw headline and look for an item whose normalized title is a fuzzy match
// (substring either way, or shares ≥60% of the longer title's words). The
// first good match wins and its decoded publisher URL is written to the row.
// =============================================================================

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { bingNewsRssUrl, extractPublisherUrl } from '../backend/lib/fetchers/news-rss-helpers.mjs';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', 'backend', '.env') });

const APPLY = process.argv.includes('--apply');
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const CONCURRENCY = 4;

const sslConfig = (() => {
  const u = new URL(process.env.DATABASE_URL);
  if (u.hostname.includes('.railway.internal') || u.hostname === 'localhost') return false;
  return { rejectUnauthorized: false };
})();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
  max: 4,
});

// Normalize a headline for fuzzy comparison. Strips Google News' " - Source"
// suffix, lowercases, collapses whitespace, removes most punctuation. Keeps
// Thai characters intact (Thai has no whitespace between words so we can't
// tokenize, but substring matching still works).
function normalizeTitle(s) {
  return String(s || '')
    .replace(/\s*-\s*[^-]+$/, '')        // trailing " - Source"
    .toLowerCase()
    .replace(/[()[\]{}""'`.!,?;:]/g, '') // strip common punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// A loose title match — substring either direction, or the shorter title
// contains all the significant (3+ char) words of the other.
function titlesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const wa = a.split(' ').filter(w => w.length >= 3);
  const wb = b.split(' ').filter(w => w.length >= 3);
  if (!wa.length || !wb.length) return false;
  const shorter = wa.length < wb.length ? wa : wb;
  const longer = wa.length < wb.length ? wb : wa;
  const longSet = new Set(longer);
  const hits = shorter.filter(w => longSet.has(w)).length;
  return hits / shorter.length >= 0.6;
}

async function bingSearchHeadline(headline) {
  const url = bingNewsRssUrl(headline);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return [];
  const xml = await res.text();
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.map(itemXml => {
    const title = (itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (itemXml.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || '';
    return { title: normalizeTitle(title), url: extractPublisherUrl(link) };
  }).filter(it => it.title && it.url);
}

// Find the best publisher URL for a headline. Returns null if nothing matches
// confidently — we'd rather leave a stale URL than overwrite it with a wrong
// one (the row stays 404 but at least it's not pointing to an unrelated site).
async function resolveUrlForHeadline(headline) {
  const normHeadline = normalizeTitle(headline);
  const results = await bingSearchHeadline(headline);
  for (const r of results) {
    if (titlesMatch(normHeadline, r.title)) return r.url;
  }
  return null;
}

async function poolMap(items, worker, concurrency) {
  const queue = items.slice();
  const results = new Array(items.length);
  let nextIdx = 0;
  async function run() {
    while (queue.length) {
      const item = queue.shift();
      const myIdx = nextIdx++;
      try {
        results[myIdx] = await worker(item);
      } catch (e) {
        results[myIdx] = { error: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => run()));
  return results;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  // Select rows whose URL is still a Google News redirect. Group by normalized
  // headline so identical stories (often duplicated across queries) share one
  // Bing round-trip.
  const { rows } = await pool.query(
    `SELECT id, title, source_url
     FROM news_feed
     WHERE source_url LIKE '%news.google.com%'
     ORDER BY date DESC, id DESC`
  );
  console.log(`[backfill] ${rows.length} rows with stale Google News URLs`);
  console.log(`[backfill] mode: ${APPLY ? 'APPLY (will UPDATE DB)' : 'DRY-RUN (no writes; pass --apply to commit)'}`);
  console.log('');

  // Unique normalized headlines → array of { headline, ids: [...] }
  const byHeadline = new Map();
  for (const r of rows) {
    const norm = normalizeTitle(r.title);
    if (!byHeadline.has(norm)) byHeadline.set(norm, { headline: r.title, ids: [] });
    byHeadline.get(norm).ids.push(r.id);
  }
  const uniqueHeadlines = Array.from(byHeadline.values());
  console.log(`[backfill] ${uniqueHeadlines.length} unique headlines to search\n`);

  let updated = 0, skipped = 0, notFound = 0;
  let counter = 0;

  await poolMap(uniqueHeadlines, async ({ headline, ids }) => {
    counter++;
    let resolved = null;
    try {
      resolved = await resolveUrlForHeadline(headline);
    } catch (e) {
      console.log(`  [${counter}/${uniqueHeadlines.length}] ERROR: ${e.message}`);
      notFound += ids.length;
      return;
    }
    if (resolved) {
      updated += ids.length;
      console.log(`  [${counter}/${uniqueHeadlines.length}] ✓ ${ids.length} row(s) → ${resolved}`);
      console.log(`     "${headline.slice(0, 70)}"`);
      if (APPLY) {
        await pool.query(
          `UPDATE news_feed SET source_url = $1 WHERE id = ANY($2::int[])`,
          [resolved, ids]
        );
      }
    } else {
      notFound += ids.length;
      skipped++;
      if (skipped <= 5 || skipped % 10 === 0) {
        console.log(`  [${counter}/${uniqueHeadlines.length}] ✗ no match (skipped)`);
        console.log(`     "${headline.slice(0, 70)}"`);
      }
    }
  }, CONCURRENCY);

  console.log('');
  console.log(`[backfill] done — would update ${updated} rows, ${notFound} had no Bing match`);
  if (!APPLY) {
    console.log('[backfill] dry-run only — re-run with --apply to commit changes');
  } else {
    console.log('[backfill] changes committed ✓');
  }
  await pool.end();
}

main().catch(e => {
  console.error('[backfill] fatal:', e);
  process.exit(1);
});
