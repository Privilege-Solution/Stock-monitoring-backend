// =============================================================================
// Historical news backfill via Gemini — keyword-driven approach.
//
// Uses the SAME query catalog as rss-property.mjs so historical coverage
// matches what the live cron tracks. For each keyword, asks Gemini for
// 3-5 historical articles since ASW's IPO (April 2021).
//
// Run:
//   node scripts/gemini-keyword-backfill.mjs            # dry-run
//   node scripts/gemini-keyword-backfill.mjs --apply    # commit to DB
// =============================================================================

import dotenv from 'dotenv';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHeadline } from '../backend/lib/fetchers/news-rss-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env') });

const APPLY = process.argv.includes('--apply');
const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (() => {
    const u = new URL(process.env.DATABASE_URL);
    if (u.hostname.includes('.railway.internal') || u.hostname === 'localhost') return false;
    return { rejectUnauthorized: false };
  })(),
  max: 4,
});

// Same query catalog as rss-property.mjs — keeps historical coverage
// aligned with what the live cron tracks.
const KEYWORDS = [
  // ASW direct
  { q: 'แอสเซทไวส์ ASW',                    cat: 'COMPANY' },
  { q: 'Assetwise ข่าว',                     cat: 'COMPANY' },
  // Per-competitor
  { q: 'AP Thailand แอ็น ไทยแลนด์',         cat: 'COMPETITOR' },
  { q: 'LH แลนด์แอนด์เฮ้าส์',                cat: 'COMPETITOR' },
  { q: 'SPALI ศุภาลัย',                      cat: 'COMPETITOR' },
  { q: 'SIRI แสนสิริ',                       cat: 'COMPETITOR' },
  { q: 'NOBLE โนเบล',                        cat: 'COMPETITOR' },
  { q: 'ORI ออริจิ้น โพรเพอร์ตี้',            cat: 'COMPETITOR' },
  { q: 'QH ควอลิตี้เฮ้าส์',                  cat: 'COMPETITOR' },
  { q: 'PRUK พฤกษา',                         cat: 'COMPETITOR' },
  { q: 'PROUD พรู๊ด รีล เอสเตท',            cat: 'COMPETITOR' },
  { q: 'ANAN อนันดา ดีเวลลอปเมนต์',          cat: 'COMPETITOR' },
  // Sector-wide
  { q: 'อสังหาริมทรัพย์ ไทย',                cat: 'INDUSTRY' },
  { q: 'ครม. อสังหาริมทรัพย์ ที่อยู่อาศัย',    cat: 'GOV_POLICY' },
  // Macro
  { q: 'ธปท. ดอกเบี้ย นโยบาย กนง.',          cat: 'RATES' },
  { q: 'เศรษฐกิจไทย GDP เงินเฟ้อ',           cat: 'MACRO' },
  { q: 'ค่าเงินบาท USD',                     cat: 'MACRO' },
  // Industry metrics
  { q: 'REIC ดัชนี อสังหา',                  cat: 'INDUSTRY' },
  { q: 'presale โอน คอนโด ไทย',              cat: 'INDUSTRY' },
  { q: 'ค่าโอน จดจำนอง 0.01%',               cat: 'GOV_POLICY' },
  { q: 'LTV สินเชื่อบ้าน',                   cat: 'GOV_POLICY' },
  { q: 'ต่างชาติ ซื้อ คอนโด ไทย',            cat: 'INDUSTRY' },
];

const PROMPT = (keyword, hintCat) => `Find 3-5 important news articles about "${keyword}" (Thai real estate / property sector) published between 2021 and 2025.

For each article, provide:
---
HEADLINE: [exact headline as published — Thai or English]
DATE: [YYYY-MM-DD or YYYY-MM if only month is known]
SOURCE: [publisher/website name]
CATEGORY: [one of: COMPANY | COMPETITOR | RATES | GOV_POLICY | POLITICS | INDUSTRY | MACRO]
---

CATEGORY definitions:
- COMPANY     : mentions ASW / AssetWise / แอสเซทไวส์ directly
- COMPETITOR  : about a competitor developer (AP, LH, SPALI, SIRI, NOBLE, ORI, ANAN, LPN, QH) — NOT ASW
- RATES       : BOT/กนง. rate decision, policy rate — main topic IS interest rates
- GOV_POLICY  : housing-specific government measures (LTV, transfer fees, foreign ownership)
- POLITICS    : general political news affecting economy
- INDUSTRY   : real estate market trends, supply/demand, REIC
- MACRO      : GDP, CPI, FX, trade — general macro

Hint: articles for "${keyword}" are likely in the "${hintCat}" category, but classify each one based on its actual main topic.

If fewer than 3 articles exist, list what you can find. If none, reply NONE.`;

async function resolveVertexUrl(vertexUrl) {
  if (!vertexUrl || !vertexUrl.includes('vertexaisearch')) return vertexUrl;
  try {
    const res = await fetch(vertexUrl, {
      method: 'GET',
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (res.url && !res.url.includes('vertexaisearch')) return res.url;
  } catch {}
  return null;
}

function parseItems(text) {
  if (!text || text.trim() === 'NONE') return [];
  const blocks = text.split('---').filter(b => b.trim());
  return blocks.map(block => {
    const get = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(.+)`));
      return m ? m[1].trim() : null;
    };
    const headline = get('HEADLINE');
    if (!headline) return null;
    const rawCat = (get('CATEGORY') || '').toUpperCase().trim();
    const ALLOWED = new Set(['COMPANY', 'COMPETITOR', 'RATES', 'GOV_POLICY', 'POLITICS', 'INDUSTRY', 'MACRO']);
    const category = ALLOWED.has(rawCat) ? rawCat : 'INDUSTRY';
    return {
      headline,
      date: get('DATE'),
      source: get('SOURCE'),
      category,
    };
  }).filter(Boolean);
}

function bestGroundUrl(item, chunks) {
  if (!chunks || !chunks.length) return null;
  if (item.source) {
    const srcLower = item.source.toLowerCase();
    for (const c of chunks) {
      const title = (c.web?.title || '').toLowerCase();
      if (title.includes(srcLower) || srcLower.includes(title)) {
        return { url: c.web?.uri, title: c.web?.title };
      }
    }
  }
  return { url: chunks[0]?.web?.uri, title: chunks[0]?.web?.title };
}

async function fetchKeyword(kw) {
  const prompt = PROMPT(kw.q, kw.cat);
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    tools: [{ google_search: {} }],
  };
  const res = await fetch(`${ENDPOINT}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const cand = j.candidates?.[0] || {};
  const text = cand.content?.parts?.[0]?.text || '';
  const chunks = cand.groundingMetadata?.groundingChunks || [];
  return { items: parseItems(text), chunks };
}

async function main() {
  console.log(`[keyword-backfill] ${KEYWORDS.length} keywords × ~3-5 items each`);
  console.log(`[keyword-backfill] mode: ${APPLY ? 'APPLY' : 'DRY-RUN (--apply to commit)'}\n`);

  const { rows: existing } = await pool.query('SELECT title_hash FROM news_feed');
  const existingHashes = new Set(existing.map(r => r.title_hash));

  let totalFound = 0, totalInserted = 0, totalSkipped = 0;
  const toInsert = [];

  for (let i = 0; i < KEYWORDS.length; i++) {
    const kw = KEYWORDS[i];
    process.stdout.write(`[${i + 1}/${KEYWORDS.length}] "${kw.q}" ... `);
    let result;
    try {
      result = await fetchKeyword(kw);
    } catch (e) {
      console.log(`ERROR: ${e.message.slice(0, 60)}`);
      continue;
    }
    console.log(`${result.items.length} items, ${result.chunks.length} URLs`);

    for (const item of result.items) {
      totalFound++;
      let date = item.date || '2023-06-01';
      if (/^\d{4}$/.test(date)) date = date + '-06-01';
      if (/^\d{4}-\d{2}$/.test(date)) date = date + '-01';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = '2023-06-01';

      const ground = bestGroundUrl(item, result.chunks);
      let url = '';
      if (ground?.url) {
        const resolved = await resolveVertexUrl(ground.url);
        url = resolved || '';
      }

      const hash = sha1(normalizeHeadline(item.headline) || item.headline);
      if (existingHashes.has(hash)) { totalSkipped++; continue; }
      existingHashes.add(hash);

      toInsert.push({
        title: item.headline,
        date,
        category: item.category,
        source_url: url || '',
        source_label: item.source || 'Gemini Historical',
        title_hash: hash,
        pipeline: 'gemini-historical',
        impact: null,
        severity: item.category === 'COMPANY' ? 'high' : 'medium',
        show_pin: false,
        summary: null,
      });
      totalInserted++;
    }
  }

  console.log(`\n[keyword-backfill] found=${totalFound}  inserted=${totalInserted}  skipped_dup=${totalSkipped}`);

  // Category breakdown
  const byCat = {};
  for (const it of toInsert) byCat[it.category] = (byCat[it.category] || 0) + 1;
  console.log('Category breakdown:');
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(12)} ${n}`);
  }

  if (APPLY && toInsert.length) {
    const { default: db } = await import('../backend/db.js');
    const { inserted } = await db.writeNewsItems(toInsert);
    console.log(`\n[keyword-backfill] committed ${inserted} rows to news_feed ✓`);
  } else if (!APPLY) {
    console.log('\n[keyword-backfill] dry-run only — re-run with --apply to commit');
  }

  await pool.end();
}

main().catch(e => { console.error('[keyword-backfill] fatal:', e); process.exit(1); });
