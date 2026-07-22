// =============================================================================
// Historical ASW company news backfill via Gemini.
//
// Searches ONLY for ASW-specific news (earnings, dividends, projects, bonds,
// insider, SET alerts) — NOT general sector/macro. Uses Gemini's Google
// Search grounding to find archived articles going back to IPO (2021).
//
// Category rules (from the user's taxonomy spec):
//   - ASW / AssetWise / แอสเซทไวส์ mentioned → COMPANY (always, regardless of sub-topic)
//   - Competitor developer (AP/LH/SPALI/SIRI/NOBLE/ORI/ANAN/LPN/WHA/QH) → COMPETITOR
//   - BOT/กนง. rate decision → RATES
//   - Housing gov policy (LTV/transfer fees) → GOV_POLICY
//   - Market trends/REIC → INDUSTRY
//   - GDP/CPI/FX → MACRO
//
// Run:
//   node scripts/gemini-asw-backfill.mjs            # dry-run
//   node scripts/gemini-asw-backfill.mjs --apply    # commit to DB
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

// Search per year — ASW company news only (the topics the user specified).
const YEARS = [
  { year: 2021, be: '2564', label: 'IPO year (April 2021 onwards)' },
  { year: 2022, be: '2565', label: 'BE 2565' },
  { year: 2023, be: '2566', label: 'BE 2566' },
  { year: 2024, be: '2567', label: 'BE 2567' },
  { year: 2025, be: '2568', label: 'BE 2568' },
  { year: 2026, be: '2569', label: 'BE 2569 (current)' },
];

const PROMPT = (year, be, label) => `คุณเป็น analyst หุ้นไทย ค้นหาข่าวในปี ${be} (${label}) ของบริษัท "Assetwise" หรือ "ASW" หรือ "แอสเซทไวส์"

ค้นหาเฉพาะข่าวที่เกี่ยวกับ:
- งบการเงิน / ผลประกอบการ / Presale / โอนกรรมสิทธิ์
- การเปิดโครงการใหม่ / JV / M&A
- ปันผล / หุ้นกู้ / Warrant / เพิ่มทุน
- แถลงข่าว / Oppday / Roadshow
- ผู้บริหารซื้อขายหุ้น (insider / Form 59)
- SET Smart Alert / cash balance alert
- การจัดอันดับเครดิต (TRIS Rating)

ตอบได้สูงสุด 8 ข่าวสำคัญ รูปแบบนี้:
---
HEADLINE: [หัวข้อข่าวภาษาไทยหรืออังกฤษตามที่ตีพิมพ์จริง]
DATE: [YYYY-MM-DD หรือ YYYY-MM ถ้ารู้แค่เดือน]
SOURCE: [ชื่อแหล่งข่าว]
CATEGORY: [COMPANY | COMPETITOR | RATES | GOV_POLICY | INDUSTRY | MACRO]
IMPACT_LEVEL: [HIGH | MEDIUM | LOW]
---

กฎ CATEGORY (สำคัญที่สุด):
1. ข่าวที่กล่าวถึง ASW / AssetWise / แอสเซทไวส์ โดยตรง → COMPANY เสมอ
2. ข่าวที่กล่าวถึง developer คู่แข่ง (AP, LH, SPALI, SIRI, NOBLE, ORI, ANAN, QH) โดยเฉพาะ → COMPETITOR
3. มติ กนง./ดอกเบี้ยนโยบาย → RATES
4. มาตรการรัฐที่เจาะจงอสังหาฯ (LTV, ลดค่าโอน) → GOV_POLICY
5. แนวโน้มตลาดอสังหาฯ/REIC → INDUSTRY
6. GDP/CPI/FX → MACRO

IMPACT_LEVEL:
- HIGH   = กระทบพื้นฐาน ASW โดยตรง (งบ, ปันผล, หุ้นกู้, TRIS rating)
- MEDIUM = เกี่ยวข้องทางอ้อม (โครงการใหม่, presale, JV)
- LOW    = ข่าวบรรยากาศ / ประชาสัมพันธ์

ถ้าไม่พบข่าว ASW ในปีนี้ ตอบว่า NONE`;

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
    const category = ALLOWED.has(rawCat) ? rawCat : 'COMPANY';
    const rawImpact = (get('IMPACT_LEVEL') || '').toUpperCase().trim();
    const impactLevel = ['HIGH', 'MEDIUM', 'LOW'].includes(rawImpact) ? rawImpact : 'MEDIUM';
    return {
      headline,
      date: get('DATE'),
      source: get('SOURCE'),
      category,
      impactLevel,
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

async function fetchYear(yearCfg) {
  const prompt = PROMPT(yearCfg.year, yearCfg.be, yearCfg.label);
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
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
  console.log(`[asw-backfill] ${YEARS.length} years × up to 8 items each`);
  console.log(`[asw-backfill] mode: ${APPLY ? 'APPLY' : 'DRY-RUN (--apply to commit)'}\n`);

  const { rows: existing } = await pool.query('SELECT title_hash FROM news_feed');
  const existingHashes = new Set(existing.map(r => r.title_hash));

  let totalFound = 0, totalInserted = 0, totalSkipped = 0;
  const toInsert = [];

  for (const y of YEARS) {
    console.log(`--- ${y.year} (${y.label}) ---`);
    let result;
    try {
      result = await fetchYear(y);
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
      continue;
    }
    console.log(`  Parsed ${result.items.length} items, ${result.chunks.length} grounding URLs`);

    for (const item of result.items) {
      totalFound++;
      let date = item.date || `${y.year}-06-01`;
      if (/^\d{4}$/.test(date)) date = date + '-06-01';
      if (/^\d{4}-\d{2}$/.test(date)) date = date + '-01';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = `${y.year}-06-01`;

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
        severity: item.impactLevel === 'HIGH' ? 'high' : item.impactLevel === 'LOW' ? 'low' : 'medium',
        show_pin: false,
        summary: null,
      });
      totalInserted++;
      console.log(`  ✓ ${date}  [${item.category.padEnd(11)}] [${item.impactLevel.padEnd(6)}]  "${item.headline.slice(0, 55)}"`);
    }
    console.log('');
  }

  console.log(`[asw-backfill] found=${totalFound}  inserted=${totalInserted}  skipped_dup=${totalSkipped}`);

  const byCat = {};
  for (const it of toInsert) byCat[it.category] = (byCat[it.category] || 0) + 1;
  console.log('Category breakdown:');
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(12)} ${n}`);
  }

  if (APPLY && toInsert.length) {
    const { default: db } = await import('../backend/db.js');
    const { inserted } = await db.writeNewsItems(toInsert);
    console.log(`\n[asw-backfill] committed ${inserted} rows to news_feed ✓`);
  } else if (!APPLY) {
    console.log('\n[asw-backfill] dry-run only — re-run with --apply to commit');
  }

  await pool.end();
}

main().catch(e => { console.error('[asw-backfill] fatal:', e); process.exit(1); });
