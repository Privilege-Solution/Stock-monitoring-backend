// Historical multi-category news backfill via Gemini.
//
// Searches ALL categories per quarter — not just ASW/COMPANY:
//   1. COMPANY  — ASW direct news (earnings, dividends, projects, bonds)
//   2. SECTOR   — competitors (AP/LH/SPALI/SIRI/...), industry trends, REIC
//   3. MACRO    — BOT rates, GDP, FX, gov policy (LTV, transfer fees)
//
// Items without URLs are still stored (headline text only) — the user
// prefers content coverage over URL completeness for old news.
//
// Run:
//   node scripts/gemini-all-category-backfill.mjs --apply

import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHeadline } from '../backend/lib/fetchers/news-rss-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env'), quiet: true });

const EP = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const sha1 = s => createHash('sha1').update(String(s)).digest('hex');

async function gsearch(prompt) {
  for (let i = 1; i <= 5; i++) {
    try {
      const r = await fetch(`${EP}?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
          tools: [{ google_search: {} }] }),
        signal: AbortSignal.timeout(90_000),
      });
      if (r.status === 503) { await new Promise(x => setTimeout(x, 30000)); continue; }
      if (!r.ok) return null;
      const j = await r.json();
      const c = j.candidates?.[0] || {};
      return { text: c.content?.parts?.[0]?.text || '', chunks: c.groundingMetadata?.groundingChunks || [] };
    } catch { if (i < 5) await new Promise(x => setTimeout(x, 15000)); }
  }
  return null;
}

async function resolve(url) {
  if (!url?.includes('vertexaisearch')) return url;
  try {
    const r = await fetch(url, { method: 'GET', headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (r.url && !r.url.includes('vertexaisearch')) return r.url;
  } catch {}
  return null;
}

const QUARTERS = [
  { ce: 2021, be: 2564, m: 'เมษายน-มิถุนายน' }, { ce: 2021, be: 2564, m: 'กรกฎาคม-กันยายน' },
  { ce: 2021, be: 2564, m: 'ตุลาคม-ธันวาคม' }, { ce: 2022, be: 2565, m: 'มกราคม-มีนาคม' },
  { ce: 2022, be: 2565, m: 'เมษายน-มิถุนายน' }, { ce: 2022, be: 2565, m: 'กรกฎาคม-กันยายน' },
  { ce: 2022, be: 2565, m: 'ตุลาคม-ธันวาคม' }, { ce: 2023, be: 2566, m: 'มกราคม-มีนาคม' },
  { ce: 2023, be: 2566, m: 'เมษายน-มิถุนายน' }, { ce: 2023, be: 2566, m: 'กรกฎาคม-กันยายน' },
  { ce: 2023, be: 2566, m: 'ตุลาคม-ธันวาคม' }, { ce: 2024, be: 2567, m: 'มกราคม-มีนาคม' },
  { ce: 2024, be: 2567, m: 'เมษายน-มิถุนายน' }, { ce: 2024, be: 2567, m: 'กรกฎาคม-กันยายน' },
  { ce: 2024, be: 2567, m: 'ตุลาคม-ธันวาคม' }, { ce: 2025, be: 2568, m: 'มกราคม-มิถุนายน' },
  { ce: 2025, be: 2568, m: 'กรกฎาคม-ธันวาคม' }, { ce: 2026, be: 2569, m: 'มกราคม-กรกฎาคม' },
];

// Three prompt templates — one per category group. These mirror the
// PROMPT_COMPANY / PROMPT_SECTOR / PROMPT_MACRO logic in gemini-search.mjs.
const PROMPTS = {
  company: (q) => `Find 3-5 major news about Assetwise (ASW.BK) from ${q.m} ${q.be} (${q.ce}).
Search: earnings, dividends, new projects, bonds, TRIS rating, insider, JV, M&A, strategic plans.
HEADLINE: [exact headline]
DATE: [YYYY-MM-DD or YYYY-MM]
SOURCE: [publisher]
CATEGORY: [COMPANY | COMPETITOR | RATES | GOV_POLICY | INDUSTRY | MACRO]
IMPACT_LEVEL: [HIGH | MEDIUM | LOW]
If none, reply NONE.`,

  sector: (q) => `Find 3-5 important news about Thai real estate sector from ${q.m} ${q.be} (${q.ce}).
Search: competitor developers (AP, LH, SPALI, SIRI, NOBLE, ORI, ANAN, QH), industry trends, REIC data,
presale/transfer volumes, foreign buyers, government housing policy (LTV, transfer fees).
HEADLINE: [exact headline]
DATE: [YYYY-MM-DD or YYYY-MM]
SOURCE: [publisher]
CATEGORY: [COMPETITOR | GOV_POLICY | INDUSTRY | COMPANY]
IMPACT_LEVEL: [HIGH | MEDIUM | LOW]
If none, reply NONE.`,

  macro: (q) => `Find 3-5 important macro/economic news from ${q.m} ${q.be} (${q.ce}) that affected Thai real estate.
Search: BOT/กนง. rate decisions, GDP, inflation, baht/USD, Fed, government policy, politics.
HEADLINE: [exact headline]
DATE: [YYYY-MM-DD or YYYY-MM]
SOURCE: [publisher]
CATEGORY: [RATES | GOV_POLICY | POLITICS | MACRO]
IMPACT_LEVEL: [HIGH | MEDIUM | LOW]
If none, reply NONE.`,
};

function parseItems(text) {
  if (!text || text.trim() === 'NONE') return [];
  const blocks = text.split(/---|\n(?=HEADLINE)/).filter(b => b.includes('HEADLINE'));
  return blocks.map(block => {
    const get = k => (block.match(new RegExp(k + ':\\s*(.+)')) || [])[1]?.trim();
    const h = get('HEADLINE'); if (!h || h === 'NONE') return null;
    let d = get('DATE') || '';
    if (/^\d{4}-\d{2}$/.test(d)) d += '-01';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) d = '';
    const rawCat = (get('CATEGORY') || '').toUpperCase().trim();
    const ALLOWED = new Set(['COMPANY', 'COMPETITOR', 'RATES', 'GOV_POLICY', 'POLITICS', 'INDUSTRY', 'MACRO']);
    return {
      headline: h,
      date: d,
      source: get('SOURCE') || 'unknown',
      category: ALLOWED.has(rawCat) ? rawCat : null,
      impact: (get('IMPACT_LEVEL') || 'MEDIUM').toUpperCase(),
    };
  }).filter(Boolean);
}

const { default: db } = await import('../backend/db.js');
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const { rows: existing } = await pool.query('SELECT title_hash FROM news_feed');
const seen = new Set(existing.map(r => r.title_hash));

const all = [];
let searchNum = 0;

for (const q of QUARTERS) {
  for (const [promptType, promptFn] of Object.entries(PROMPTS)) {
    searchNum++;
    process.stdout.write(`[${searchNum}] ${q.ce} ${q.m.slice(0,8)} [${promptType}].. `);
    const r = await gsearch(promptFn(q));
    if (!r) { process.stdout.write('FAIL\n'); continue; }
    const items = parseItems(r.text);
    let n = 0;
    for (const item of items) {
      // Resolve URL from grounding chunks (best effort — null is OK)
      let url = null;
      for (const c of r.chunks) {
        const u = await resolve(c.web?.uri);
        if (u && /^https?:\/\/(?!vertexaisearch|google\.com)/.test(u)) { url = u; break; }
      }
      // Determine date — use item date or middle of quarter
      const monthMap = { 'มกราคม-มีนาคม': '02', 'เมษายน-มิถุนายน': '05', 'กรกฎาคม-กันยายน': '08', 'ตุลาคม-ธันวาคม': '11' };
      const date = item.date || `${q.ce}-${monthMap[q.m] || '06'}-15`;

      const hash = sha1(normalizeHeadline(item.headline) || item.headline);
      if (seen.has(hash)) continue;
      seen.add(hash);

      all.push({
        title: item.headline,
        date,
        category: item.category || 'INDUSTRY',
        source_url: url || '',
        source_label: item.source,
        title_hash: hash,
        pipeline: 'gemini-historical',
        impact: null,
        severity: item.impact === 'HIGH' ? 'high' : item.impact === 'LOW' ? 'low' : 'medium',
        show_pin: false,
        summary: null,
      });
      n++;
    }
    process.stdout.write(`${n} items (${items.length - n} dupes)\n`);
    await new Promise(x => setTimeout(x, 5000));
  }
}

// Insert
if (all.length) {
  const { inserted } = await db.writeNewsItems(all);
  process.stdout.write(`\nInserted ${inserted} new items\n`);
} else {
  process.stdout.write('\nNo new items\n');
}

// Summary
const byCat = {};
all.forEach(i => byCat[i.category] = (byCat[i.category] || 0) + 1);
process.stdout.write('By category: ' + Object.entries(byCat).map(([k,v]) => `${k}:${v}`).join(', ') + '\n');
const withUrl = all.filter(i => i.source_url).length;
process.stdout.write(`With URLs: ${withUrl}/${all.length}\n`);

await pool.end();
