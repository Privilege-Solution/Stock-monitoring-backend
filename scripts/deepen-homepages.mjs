// Deepen homepage-style URLs to real article URLs by searching Bing News RSS
// for each row's headline. Strict matching: the result MUST contain the
// company ticker (ASW/AP/LH/...) AND share ≥60% of distinctive tokens with
// the original headline — prevents the FPT-instead-of-ASW bug we hit earlier.
//
// Run:
//   node scripts/deepen-homepages.mjs            # dry-run
//   node scripts/deepen-homepages.mjs --apply    # commit
//
// Two Bing passes per item:
//   Pass 1: search the raw headline
//   Pass 2 (if pass 1 misses): search headline + source_label name
//                              (e.g. "TRIS Rating ASW kaohoon")

import { extractPublisherUrl, extractSourceName } from '../backend/lib/fetchers/news-rss-helpers.mjs';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env') });

const APPLY = process.argv.includes('--apply');
const CONCURRENCY = 4;
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

// Publisher display name → hostname. Used both to pin Bing queries and to
// score candidate results (a result from the matching publisher ranks first).
const PUBLISHER_HOST = {
  'ข่าวหุ้นธุรกิจออนไลน์': 'kaohoon.com',
  'มิติหุ้น': 'mitihoon.com',
  'สำนักข่าวอินโฟเควสท์': 'infoquest.co.th',
  'สำนักข่าวอิศรา': 'isranews.org',
  'Marketeer Online': 'marketeeronline.co',
  'LINE TODAY': 'today.line.me',
  'HoonVision': 'hoonvision.com',
  'Hoonsmart': 'hoonsmart.com',
  'Thunhoon': 'thunhoon.com',
  'TerraBKK': 'terrabkk.com',
  'Share2Trade': 'share2trade.com',
  'RYT9': 'ryt9.com',
  'efinanceThai': 'efinancethai.com',
  'TNN': 'tnnthailand.com',
  'TNN Thailand': 'tnnthailand.com',
  'ThaiPublica': 'thaipublica.org',
  'ไทยพับลิก้า': 'thaipublica.org',
  'thepeople': 'thepeople.co',
  'Matichon Online': 'matichon.co.th',
  'Tatler Asia': 'tatlerasia.com',
  'TrueID': 'trueid.net',
  'ประชาชาติธุรกิจ': 'prachachat.net',
  'ผู้จัดการออนไลน์': 'manager.co.th',
  'วารสารการเงินธนาคาร': 'bot.or.th',
  'ศูนย์ข้อมูลอสังหาริมทรัพย์': 'reic.or.th',
  'แนวหน้า': 'naewna.com',
  'เดลินิวส์': 'dailynews.co.th',
  'ไทยรัฐ': 'thairath.co.th',
  'ข่าวสด': 'khaosod.co.th',
  'thestandard.co': 'thestandard.co',
  'thaitv5hd.com': 'thaitv5hd.com',
  'banmuang.co.th': 'banmuang.co.th',
  'homeday.co.th': 'homeday.co.th',
  'wealthythai.com': 'wealthythai.com',
  'PPTV HD': 'pptvhd36.com',
  'pptvhd36': 'pptvhd36.com',
  'amarin tv': 'amarin.co.th',
  'thebangkokinsight': 'thebangkokinsight.com',
  'Bangkok Insight': 'thebangkokinsight.com',
};

function publisherHost(label) {
  if (!label) return '';
  for (const [key, host] of Object.entries(PUBLISHER_HOST)) {
    if (label.includes(key)) return host;
  }
  const parts = label.split(/[,/]/).map(s => s.trim());
  for (const p of parts) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(p)) return p.toLowerCase();
  }
  return '';
}

function urlHost(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

// Extract the company ticker / brand name from a headline. This MUST appear
// in the Bing result title — otherwise we don't have a real match.
function requiredToken(title) {
  const checks = [
    [/ASW|Assetwise|แอสเซทไวส์|AssetWise/i, 'ASW'],
    [/\bAP\b\s*(Thailand|ไทยแลนด์)/i, 'AP'],
    [/\bLH\b|แลนด์แอนด์เฮ้าส์/i, 'LH'],
    [/SPALI|ศุภาลัย/i, 'SPALI'],
    [/SIRI|แสนสิริ/i, 'SIRI'],
    [/NOBLE|โนเบล/i, 'NOBLE'],
    [/\bORI\b|ออริจิ้น/i, 'ORI'],
    [/\bQH\b|ควอลิตี้เฮ้าส์/i, 'QH'],
    [/PRUK|พฤกษา/i, 'PRUK'],
    [/PROUD|พรู๊ด/i, 'PROUD'],
    [/SENA|เซนา/i, 'SENA'],
    [/ANAN|อนันดา/i, 'ANAN'],
    [/LPN|แอล\.พี\.เอ็น/i, 'LPN'],
    [/PROUD|พรู๊ด/i, 'PROUD'],
    [/TRIS|ทริส/i, 'TRIS'],
    [/ธปท|BOT\b/i, 'ธปท'],
    [/กนง/i, 'กนง'],
    [/Fed|เฟด/i, 'Fed'],
    [/SET\s*Index|ดัชนี\s*SET/i, 'SET'],
  ];
  for (const [re, tok] of checks) if (re.test(title)) return tok;
  return '';
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[()[\]{}"'`.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Stop-words: too common to be distinctive. Tokens of length ≥4 that aren't
// in this set count toward the overlap score.
const STOP = new Set([
  'ข่าว','วัน','นี้','อีก','แล้ว','ใหม่','เพราะ','ว่า','แต่','ได้','มี','ไม่','จะ','ก็','จาก',
  'the','and','for','with','that','this','from','news','says','will','over','into','have',
]);

function tokensOf(s) {
  return normalize(s).split(' ').filter(w => w.length >= 4 && !STOP.has(w));
}

// A STRONG match: required token (company) present AND ≥60% of original
// distinctive tokens appear in result.
function matchScore(origTitle, resultTitle) {
  const req = requiredToken(origTitle);
  const normOrig = normalize(origTitle);
  const normRes = normalize(resultTitle);
  if (req && !normRes.includes(req.toLowerCase())) return 0;
  const origTokens = tokensOf(origTitle);
  if (!origTokens.length) return 0;
  const hits = origTokens.filter(t => normRes.includes(t)).length;
  return hits / origTokens.length;
}

async function bingSearch(q) {
  try {
    const res = await fetch(
      'https://www.bing.com/news/search?q=' + encodeURIComponent(q) + '&format=rss',
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12_000) },
    );
    if (!res.ok) return [];
    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    return items.map(it => {
      const title = (it.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]?.trim() || '';
      const link = (it.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1]?.trim() || '';
      const src = extractSourceName(it);
      return { title, url: extractPublisherUrl(link), source: src };
    }).filter(x => x.url);
  } catch { return []; }
}

// Try to deepen a single row. Returns { url, score, source } or null.
async function deepen(r) {
  const expectedHost = publisherHost(r.source_label);

  // Pass 1: search the raw headline
  let results = await bingSearch(r.title);

  // Pass 2 (if pass 1 was empty): headline + publisher name
  if (!results.length && expectedHost) {
    results = await bingSearch(`${r.title} ${expectedHost}`);
  }

  // Pass 3 (if 1+2 empty): first 6 distinctive tokens only (more permissive)
  if (!results.length) {
    const toks = tokensOf(r.title).slice(0, 6);
    if (toks.length >= 2) results = await bingSearch(toks.join(' '));
  }

  if (!results.length) return null;

  // Score every result, prefer same-publisher matches
  const scored = results
    .map(res => ({
      ...res,
      score: matchScore(r.title, res.title),
      hostMatch: expectedHost && hostnamesRelated(urlHost(res.url), expectedHost),
    }))
    .filter(res => res.score >= 0.6)
    .sort((a, b) => {
      // Same-publisher + high score wins
      if (a.hostMatch !== b.hostMatch) return a.hostMatch ? -1 : 1;
      return b.score - a.score;
    });

  return scored[0] || null;
}

function hostnamesRelated(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

async function poolMap(items, worker, concurrency) {
  const queue = items.slice();
  let idx = 0;
  async function run() {
    while (queue.length) {
      const item = queue.shift();
      const myIdx = idx++;
      try { await worker(item, myIdx); }
      catch (e) { console.log(`  ERR id=${item.id}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => run()));
}

async function main() {
  const { rows } = await pool.query(`
    SELECT id, title, source_label, source_url
    FROM news_feed
    WHERE source_url NOT LIKE '%news.google.com%'
      AND source_url NOT LIKE '%bing.com%'
      AND source_url NOT LIKE '%vertexaisearch%'
      AND source_url NOT LIKE '%cloud.google.com%'
      AND source_url ~ '^https?://[^/]+/?$'
    ORDER BY date DESC, id DESC
  `);
  console.log(`[deepen] ${rows.length} homepage-style URLs to deepen`);
  console.log(`[deepen] mode: ${APPLY ? 'APPLY' : 'DRY-RUN (--apply to commit)'}\n`);

  let deepened = 0, noMatch = 0;
  let counter = 0;
  const sample = [];

  await poolMap(rows, async (r) => {
    counter++;
    const hit = await deepen(r);
    if (hit) {
      deepened++;
      if (sample.length < 25 || deepened % 10 === 0) {
        sample.push(`  [${counter}/${rows.length}] ✓ score=${hit.score.toFixed(2)} ${urlHost(hit.url)}  (id=${r.id})`);
        sample.push(`     orig: ${r.title.slice(0, 70)}`);
        sample.push(`     bing: ${hit.title.slice(0, 70)}`);
        sample.push(`     url : ${hit.url}`);
      }
      if (APPLY) {
        await pool.query('UPDATE news_feed SET source_url = $1 WHERE id = $2', [hit.url, r.id]);
      }
    } else {
      noMatch++;
      if (noMatch <= 8) {
        sample.push(`  [${counter}/${rows.length}] ✗ no strong match  (id=${r.id}, source="${r.source_label}")`);
        sample.push(`     "${r.title.slice(0, 70)}"`);
      }
    }
  }, CONCURRENCY);

  for (const line of sample) console.log(line);

  console.log('');
  console.log(`[deepen] done — deepened=${deepened}, no-match=${noMatch} (of ${rows.length})`);
  if (!APPLY) console.log('[deepen] dry-run only — re-run with --apply to commit');
  else        console.log('[deepen] changes committed ✓');
  await pool.end();
}

main().catch(e => { console.error('[deepen] fatal:', e); process.exit(1); });
