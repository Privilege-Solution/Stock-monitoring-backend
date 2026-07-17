import { extractPublisherUrl } from '../backend/lib/fetchers/news-rss-helpers.mjs';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (() => {
    const u = new URL(process.env.DATABASE_URL);
    if (u.hostname.includes('.railway.internal') || u.hostname === 'localhost') return false;
    return { rejectUnauthorized: false };
  })(),
});

const SOURCE_HOST = {
  'Pi Securities': 'kssresearch.com',
  'ก.ล.ต.': 'sec.or.th',
  'efinanceThai': 'efinancethai.com',
  'กรุงเทพธุรกิจ': 'bangkokbiznews.com',
  'Infoquest': 'infoquest.co.th',
  'ข่าวหุ้นธุรกิจ': 'kaohoon.com',
  'ข่าวหุ้นธุรกิจออนไลน์': 'kaohoon.com',
};

function sourceHostname(label) {
  if (!label) return '';
  // Substring match first — handles "สำนักงานคณะกรรมการกำกับหลักทรัพย์... (ก.ล.ต.)"
  // matching the "ก.ล.ต." key without needing the full formal name in the map.
  for (const [key, host] of Object.entries(SOURCE_HOST)) {
    if (label.includes(key)) return host;
  }
  const parts = label.split(/[,/]/).map(s => s.trim());
  for (const p of parts) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(p)) return p.toLowerCase();
  }
  return '';
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[()[\]{}"'`.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function bingSearch(q) {
  const url = 'https://www.bing.com/news/search?q=' + encodeURIComponent(q) + '&format=rss';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    return items.map(it => {
      const title = (it.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]?.trim() || '';
      const link = (it.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1]?.trim() || '';
      return { title, url: extractPublisherUrl(link), norm: normalize(title) };
    }).filter(x => x.url);
  } catch { return []; }
}

function strongMatch(origNorm, resultNorm) {
  const origTokens = origNorm.split(' ').filter(w => w.length >= 4);
  if (!origTokens.length) return false;
  const hits = origTokens.filter(t => resultNorm.includes(t)).length;
  return hits / origTokens.length >= 0.6;
}

const { rows } = await pool.query(
  `SELECT id, title, source_label FROM news_feed
   WHERE source_url LIKE $1 OR source_url LIKE $2
   ORDER BY id`,
  ['%vertexaisearch%', '%cloud.google.com%']
);
console.log(`Found ${rows.length} rows with vertexaisearch URLs\n`);

const updates = [];
for (const r of rows) {
  console.log(`--- id=${r.id}  source="${r.source_label}" ---`);
  console.log(`    "${r.title.slice(0, 70)}"`);
  const origNorm = normalize(r.title);
  const results = await bingSearch(r.title);
  let chosen = null;
  for (const res of results) {
    if (strongMatch(origNorm, res.norm)) {
      chosen = res;
      console.log(`    STRONG bing match  ${res.url}`);
      console.log(`      bing title: ${res.title.slice(0, 70)}`);
      break;
    }
  }
  if (!chosen) {
    const host = sourceHostname(r.source_label);
    if (host) {
      chosen = { url: `https://www.${host.replace(/^www\./, '')}/`, fallback: true };
      console.log(`    FALLBACK  publisher homepage  ${chosen.url}`);
    } else {
      console.log(`    no bing match and no source_hostname`);
    }
  }
  if (chosen) updates.push({ id: r.id, url: chosen.url });
}

console.log(`\nApplying ${updates.length} updates:`);
for (const u of updates) {
  await pool.query('UPDATE news_feed SET source_url = $1 WHERE id = $2', [u.url, u.id]);
  console.log(`  #${u.id}  ${u.url}`);
}

const { rows: rem } = await pool.query(
  `SELECT count(*)::int as n FROM news_feed
   WHERE source_url LIKE $1 OR source_url LIKE $2`,
  ['%vertexaisearch%', '%cloud.google.com%']
);
console.log(`\nRemaining vertexaisearch rows: ${rem[0].n}`);
await pool.end();
