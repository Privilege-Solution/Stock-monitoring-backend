// =============================================================================
// Pass 3 backfill — fixes pass2's two known problems:
//
//   1. PASS2 ADDED `www.` BLANKETLY → some hostnames only work without it
//      (e.g. `homeday.co.th` 404s on `www.homeday.co.th`). This pass tests
//      both forms and stores whichever returns 2xx.
//
//   2. PASS2 SET HOMEPAGE URLS — they load (no 404) but don't show the
//      article. This pass tries one more aggressive Bing search for each
//      homepage URL: any Bing result whose hostname matches the publisher
//      is accepted, even if the title doesn't match exactly. Old news may
//      not be in Bing's current index, but for many items it is.
//
// Run:
//   node scripts/backfill-urls-pass3.mjs            # dry-run
//   node scripts/backfill-urls-pass3.mjs --apply    # commit to DB
// =============================================================================

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { bingNewsRssUrl, extractPublisherUrl } from '../backend/lib/fetchers/news-rss-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env') });

const APPLY = process.argv.includes('--apply');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (() => {
    const u = new URL(process.env.DATABASE_URL);
    if (u.hostname.includes('.railway.internal') || u.hostname === 'localhost') return false;
    return { rejectUnauthorized: false };
  })(),
  max: 4,
});

function urlHostname(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function hostnamesRelated(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

function normalizeTitle(s) {
  return String(s || '')
    .replace(/\s*-\s*[^-]+$/, '')
    .toLowerCase()
    .replace(/[()[\]{}""'`.!,?;:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// HEAD request with browser UA. Returns final HTTP code after redirects.
// Returns 0 on network failure / timeout so caller can treat it as "unknown".
// 403 is treated as "ok" — many Thai news sites (terrabkk, khaosod, matichon)
// run Cloudflare anti-bot that blocks curl but serves real browsers fine.
async function probeUrl(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(7000),
    });
    return res.status;
  } catch {
    return 0;
  }
}

// A URL "works" if it returns 2xx, 3xx, OR 403 (anti-bot, fine in browser).
// Only 404 / 410 / 5xx / network failure count as broken.
function isWorkingStatus(s) {
  return (s >= 200 && s < 400) || s === 401 || s === 403 || s === 429;
}

// Try Bing with just the headline (no source pinning). Return the first
// result whose hostname matches `expectedHost`. Old articles may have
// slightly different titles in Bing's index, so we accept any result from
// the right publisher — better a deep link with a near-miss title than a
// homepage that doesn't show the article.
async function findArticleUrl(headline, expectedHost) {
  if (!expectedHost) return null;
  try {
    const res = await fetch(bingNewsRssUrl(headline), {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    const normHeadline = normalizeTitle(headline);
    // First pass: tight match (title AND hostname).
    for (const itemXml of items) {
      const title = normalizeTitle((itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '');
      const link = (itemXml.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || '';
      const pub = extractPublisherUrl(link);
      if (!pub) continue;
      if (hostnamesRelated(urlHostname(pub), expectedHost) &&
          (title.includes(normHeadline.slice(0, 25)) || normHeadline.includes(title.slice(0, 25)))) {
        return pub;
      }
    }
    // Second pass: hostname match only (any title from the right publisher).
    for (const itemXml of items) {
      const link = (itemXml.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || '';
      const pub = extractPublisherUrl(link);
      if (pub && hostnamesRelated(urlHostname(pub), expectedHost)) return pub;
    }
  } catch {
    // fall through
  }
  return null;
}

// Pick the working form of a publisher's homepage URL. Tries with-www first
// (most common), then without (some sites like homeday.co.th reject www).
// Returns null if neither works — caller can leave the URL alone.
async function pickWorkingHomepage(host) {
  const withWww = `https://www.${host}/`;
  const noWww = `https://${host}/`;
  const s1 = await probeUrl(withWww);
  if (isWorkingStatus(s1)) return withWww;
  const s2 = await probeUrl(noWww);
  if (isWorkingStatus(s2)) return noWww;
  return null;
}

async function poolMap(items, worker, concurrency) {
  const queue = items.slice();
  let idx = 0;
  async function run() {
    while (queue.length) {
      const item = queue.shift();
      const myIdx = idx++;
      try { await worker(item, myIdx); } catch (e) { console.log(`  ERR id=${item.id}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => run()));
}

async function main() {
  // Only consider rows whose URL looks like a pass2 homepage (https://www.host/
  // or https://host/ with no path). These are the ones pass2 set.
  const { rows } = await pool.query(`
    SELECT id, title, source_label, source_url
    FROM news_feed
    WHERE source_url NOT LIKE '%news.google.com%'
      AND source_url NOT LIKE '%bing.com%'
      AND source_url NOT LIKE '%vertexaisearch%'
      AND (
        source_url ~ '^https?://[^/]+/?$'              -- homepage form: host + optional slash
      )
    ORDER BY date DESC, id DESC
  `);
  console.log(`[pass3] ${rows.length} homepage-style URLs to refine`);
  console.log(`[pass3] mode: ${APPLY ? 'APPLY (will UPDATE DB)' : 'DRY-RUN (--apply to commit)'}\n`);

  let deepened = 0, fixedHost = 0, untouched = 0;
  let counter = 0;

  await poolMap(rows, async (r) => {
    counter++;
    const host = urlHostname(r.source_url);
    if (!host) { untouched++; return; }

    // Try to upgrade to a deep article URL first.
    const deep = await findArticleUrl(r.title, host);
    if (deep && urlHostname(deep) !== host) {
      // Bing gave us a different publisher — skip (don't trust mismatched host).
    } else if (deep) {
      deepened++;
      console.log(`  [${counter}/${rows.length}] DEEPEN  ${urlHostname(deep)}  (id=${r.id})`);
      console.log(`     "${r.title.slice(0, 65)}"`);
      if (APPLY) {
        await pool.query('UPDATE news_feed SET source_url = $1 WHERE id = $2', [deep, r.id]);
      }
      return;
    }

    // Couldn't find article — make sure the homepage URL actually works.
    const s = await probeUrl(r.source_url);
    if (isWorkingStatus(s)) {
      untouched++;
      return;
    }
    // Homepage 404s/fails — try the alternate www form.
    const alt = r.source_url.includes('://www.')
      ? r.source_url.replace('://www.', '://')
      : r.source_url.replace('://', '://www.');
    const sAlt = await probeUrl(alt);
    if (isWorkingStatus(sAlt)) {
      fixedHost++;
      console.log(`  [${counter}/${rows.length}] FIXHOST ${host}  ${s}→${sAlt}  ${alt}  (id=${r.id})`);
      if (APPLY) {
        await pool.query('UPDATE news_feed SET source_url = $1 WHERE id = $2', [alt, r.id]);
      }
      return;
    }
    // Neither form works — last resort: probe the bare host and use whatever responds.
    const working = await pickWorkingHomepage(host);
    if (working && working !== r.source_url) {
      fixedHost++;
      console.log(`  [${counter}/${rows.length}] FIXHOST ${host}  → ${working}  (id=${r.id})`);
      if (APPLY) {
        await pool.query('UPDATE news_feed SET source_url = $1 WHERE id = $2', [working, r.id]);
      }
    } else {
      untouched++;
      console.log(`  [${counter}/${rows.length}] MISS    ${host} all forms failed  (id=${r.id})`);
    }
  }, 4);

  console.log('');
  console.log(`[pass3] done — deepened=${deepened}, host-fixed=${fixedHost}, untouched=${untouched} (of ${rows.length})`);
  if (!APPLY) console.log('[pass3] dry-run only — re-run with --apply to commit');
  else        console.log('[pass3] changes committed ✓');
  await pool.end();
}

main().catch(e => { console.error('[pass3] fatal:', e); process.exit(1); });
