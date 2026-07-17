// =============================================================================
// Second-pass backfill: handles stale rows the first pass couldn't match by
// headline alone. Two strategies, tried in order:
//
//   1. TARGETED BING SEARCH — search Bing with `<headline> <source_label>`
//      (e.g. "TRIS Rating ASW BBB ข่าวหุ้นธุรกิจออนไลน์"). This narrows
//      results to the publisher that originally ran the story. Accept any
//      result whose URL hostname matches the publisher's known canonical
//      hostname (looked up from PUBLISHER_HOSTS below). Yields a deep link.
//
//   2. HOMEPAGE FALLBACK — when no Bing result matches, replace the stale
//      Google News URL with the publisher's homepage URL derived from
//      PUBLISHER_HOSTS (or used directly if source_label is already a
//      hostname like "homeday.co.th"). Better a stable homepage than a
//      redirect that 404s.
//
// Run:
//   node scripts/backfill-urls-pass2.mjs            # dry-run
//   node scripts/backfill-urls-pass2.mjs --apply    # commit to DB
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
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const CONCURRENCY = 4;

// Publisher display name → canonical hostname. Covers every source_label we
// saw in news_feed. When the label is already a hostname (e.g. "homeday.co.th"),
// it isn't listed here — the `asHostname()` helper handles those directly.
const PUBLISHER_HOSTS = {
  // Thai language labels
  'ข่าวหุ้นธุรกิจออนไลน์':  'kaohoon.com',
  'มิติหุ้น':               'mitihoon.com',
  'สำนักข่าวอินโฟเควสท์':  'infoquest.co.th',
  'แนวหน้า':                'naewna.com',
  'สำนักข่าวอิศรา':         'isranews.org',
  'ประชาชาติธุรกิจ':       'prachachat.net',
  'ผู้จัดการออนไลน์':       'manager.co.th',
  'วารสารการเงินธนาคาร':   'bot.or.th',
  'ศูนย์ข้อมูลอสังหาริมทรัพย์': 'reic.or.th',
  'แนวหน้าออนไลน์':         'naewna.com',
  // English / mixed labels
  'Marketeer Online':   'marketeeronline.co',
  'LINE TODAY':         'today.line.me',
  'HoonVision':         'hoonvision.com',
  'Hoonsmart':          'hoonsmart.com',
  'Thunhoon':           'thunhoon.com',
  'TerraBKK':           'terrabkk.com',
  'Share2Trade':        'share2trade.com',
  'RYT9':               'ryt9.com',
  'efinanceThai':       'efinancethai.com',
  'TNN':                'tnnthailand.com',
  'TNN Thailand':       'tnnthailand.com',
  'ThaiPublica':        'thaipublica.org',
  'thepeople':          'thepeople.co',
  'Matichon Online':    'matichon.co.th',
  'Tatler Asia':        'tatlerasia.com',
  'TrueID':             'trueid.net',
  'ไทยพับลิก้า':          'thaipublica.org',
  'เดลินิวส์':            'dailynews.co.th',
  'ไทยรัฐ':               'thairath.co.th',
  'ข่าวสด':               'khaosod.co.th',
  'pring':               'pring.thaipost.net',
  'arin':                'arin.co.th',
  'amarin tv':           'amarin.co.th',
  'channel 3':           'ch3thailand.com',
  'ch3plus':             'ch3plus.com',
};

// Resolve source_label → hostname. Returns '' when the label isn't a known
// publisher and isn't itself a hostname.
function asHostname(label) {
  if (!label) return '';
  const l = label.trim();
  // Label is itself a hostname (e.g. "homeday.co.th", "banmuang.co.th")
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(l)) return l.toLowerCase();
  // Label has a hostname embedded (e.g. "thestandard.co", "Spring News")
  if (PUBLISHER_HOSTS[l]) return PUBLISHER_HOSTS[l];
  // Try case-insensitive lookup
  const key = Object.keys(PUBLISHER_HOSTS).find(k => k.toLowerCase() === l.toLowerCase());
  return key ? PUBLISHER_HOSTS[key] : '';
}

function normalizeTitle(s) {
  return String(s || '')
    .replace(/\s*-\s*[^-]+$/, '')
    .toLowerCase()
    .replace(/[()[\]{}""'`.!,?;:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function urlHostname(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function hostnamesRelated(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

// Strategy 1: targeted Bing search using headline + source label. Returns a
// deep article URL whose hostname matches the publisher, or null.
async function targetedDeepLink(headline, sourceLabel, expectedHost) {
  const query = expectedHost
    ? `${headline} ${expectedHost}`          // pin the publisher hostname in the query
    : `${headline} ${sourceLabel}`;          // fall back to display name
  const url = bingNewsRssUrl(query);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    const normHeadline = normalizeTitle(headline);
    for (const itemXml of items) {
      const title = normalizeTitle((itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '');
      const link = (itemXml.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || '';
      const pub = extractPublisherUrl(link);
      if (!pub || !titlesMatch(normHeadline, title)) continue;
      // If we know the expected host, the result must come from it.
      if (expectedHost && !hostnamesRelated(urlHostname(pub), expectedHost)) continue;
      return pub;
    }
  } catch {
    // fall through
  }
  return null;
}

// Strategy 2: build a stable publisher homepage URL from the source label.
function homepageFallback(sourceLabel) {
  const host = asHostname(sourceLabel);
  if (!host) return '';
  return `https://www.${host.replace(/^www\./, '')}/`;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (() => {
    const u = new URL(process.env.DATABASE_URL);
    if (u.hostname.includes('.railway.internal') || u.hostname === 'localhost') return false;
    return { rejectUnauthorized: false };
  })(),
  max: 4,
});

async function poolMap(items, worker, concurrency) {
  const queue = items.slice();
  let idx = 0;
  async function run() {
    while (queue.length) {
      const item = queue.shift();
      const myIdx = idx++;
      try { await worker(item, myIdx); } catch (e) { console.log(`  ERR: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => run()));
}

async function main() {
  const { rows } = await pool.query(
    `SELECT id, title, source_label, source_url
     FROM news_feed
     WHERE source_url LIKE '%news.google.com%'
     ORDER BY date DESC, id DESC`
  );
  console.log(`[pass2] ${rows.length} stale rows remaining`);
  console.log(`[pass2] mode: ${APPLY ? 'APPLY (will UPDATE DB)' : 'DRY-RUN (pass --apply to commit)'}\n`);

  let deepFound = 0, homeFilled = 0, stillStale = 0;
  let counter = 0;

  await poolMap(rows, async (r) => {
    counter++;
    const expectedHost = asHostname(r.source_label);
    const deep = await targetedDeepLink(r.title, r.source_label, expectedHost);
    if (deep) {
      deepFound++;
      console.log(`  [${counter}/${rows.length}] DEEP  ${urlHostname(deep)}  (id=${r.id})`);
      console.log(`     "${r.title.slice(0, 70)}"`);
      if (APPLY) {
        await pool.query('UPDATE news_feed SET source_url = $1 WHERE id = $2', [deep, r.id]);
      }
      return;
    }
    const home = homepageFallback(r.source_label);
    if (home) {
      homeFilled++;
      if (homeFilled <= 15 || homeFilled % 10 === 0) {
        console.log(`  [${counter}/${rows.length}] HOME  ${home}  (id=${r.id}, source="${r.source_label}")`);
      }
      if (APPLY) {
        await pool.query('UPDATE news_feed SET source_url = $1 WHERE id = $2', [home, r.id]);
      }
      return;
    }
    stillStale++;
    if (stillStale <= 8) {
      console.log(`  [${counter}/${rows.length}] MISS  no publisher map for "${r.source_label}"  (id=${r.id})`);
    }
  }, CONCURRENCY);

  console.log('');
  console.log(`[pass2] done — deep=${deepFound}, homepage=${homeFilled}, still-stale=${stillStale} (of ${rows.length})`);
  if (!APPLY) console.log('[pass2] dry-run only — re-run with --apply to commit');
  else        console.log('[pass2] changes committed ✓');
  await pool.end();
}

main().catch(e => { console.error('[pass2] fatal:', e); process.exit(1); });
