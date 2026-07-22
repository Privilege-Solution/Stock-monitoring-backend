// =============================================================================
// Historical news backfill via Gemini + Google Search grounding.
//
// Bing News RSS only indexes ~30-90 days of recent news. Gemini with
// google_search grounding uses Google's full web index, which goes back
// years — making it the only free-tier source for ASW news from IPO (2021)
// onwards.
//
// For each year since IPO, asks Gemini for the 5 most important ASW news
// articles. Parses the structured HEADLINE/DATE/SOURCE response and uses
// grounding metadata URLs (resolved via vertexaisearch redirect) as the
// source_url. Inserts into news_feed with pipeline='gemini-historical'.
//
// Run:
//   node scripts/gemini-historical-backfill.mjs            # dry-run
//   node scripts/gemini-historical-backfill.mjs --apply    # commit to DB
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

const YEARS = [
  { year: 2021, label: 'IPO year — April 2021 onwards, BE 2564' },
  { year: 2022, label: 'BE 2565' },
  { year: 2023, label: 'BE 2566' },
  { year: 2024, label: 'BE 2567' },
  { year: 2025, label: 'BE 2568, first half' },
  { year: 2026, label: 'BE 2569, current year' },
];

const PROMPT = (year, label) => `Find 5 most important news articles about Assetwise PCL (ASW.BK, Thai real estate developer) from ${year} (${label}).

For each, provide:
---
HEADLINE: [exact headline in Thai or English, as published]
DATE: [approximate date in YYYY-MM-DD format if known, or YYYY-MM if only month known]
SOURCE: [publisher name]
---

Focus on: earnings/financial results, dividends, new project launches, debt/bond issuance, major corporate actions, credit rating changes.

If fewer than 5 articles exist, list what you can find. If none exist, reply NONE.`;

// Follow the vertexaisearch redirect to get the real publisher URL.
// Returns null on failure (caller falls back to constructing from chunk title).
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

// Parse Gemini's structured response into items.
function parseItems(text) {
  if (!text || text.trim() === 'NONE') return [];
  const blocks = text.split('---').filter(b => b.trim());
  return blocks.map(block => {
    const get = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(.+)`));
      return m ? m[1].trim() : null;
    };
    const headline = get('HEADLINE');
    const date = get('DATE');
    const source = get('SOURCE');
    if (!headline) return null;
    return { headline, date, source };
  }).filter(Boolean);
}

// Pick the best grounding chunk URL for a parsed item by matching source name
// or just taking the first chunk (Gemini grounds the whole response together).
function bestGroundUrl(item, chunks) {
  if (!chunks || !chunks.length) return null;
  // Try to match source name → chunk title
  if (item.source) {
    const srcLower = item.source.toLowerCase();
    for (const c of chunks) {
      const title = (c.web?.title || '').toLowerCase();
      if (title.includes(srcLower) || srcLower.includes(title)) {
        return { url: c.web?.uri, title: c.web?.title };
      }
    }
  }
  // Fall back to first chunk
  return { url: chunks[0]?.web?.uri, title: chunks[0]?.web?.title };
}

async function fetchYear(yearCfg) {
  const prompt = PROMPT(yearCfg.year, yearCfg.label);
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
  const items = parseItems(text);
  return { items, chunks, raw: text };
}

async function main() {
  console.log(`[gemini-backfill] mode: ${APPLY ? 'APPLY' : 'DRY-RUN (--apply to commit)'}`);
  console.log(`[gemini-backfill] years: ${YEARS.map(y => y.year).join(', ')}\n`);

  // Check existing hashes to avoid re-inserting
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
      // Resolve date — use YYYY-MM if full date not available
      let date = item.date || `${y.year}-01-01`;
      // Truncate to YYYY-MM-DD; if only YYYY-MM, pad to -01
      if (/^\d{4}-\d{2}$/.test(date)) date = date + '-01';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = `${y.year}-06-01`; // mid-year fallback

      // Find URL from grounding chunks
      const ground = bestGroundUrl(item, result.chunks);
      let url = '';
      if (ground?.url) {
        // Resolve vertexaisearch redirect to get real publisher URL
        const resolved = await resolveVertexUrl(ground.url);
        url = resolved || `https://${ground.title?.replace(/^www\./, '')}/` || '';
      }

      const hash = sha1(normalizeHeadline(item.headline) || item.headline);
      if (existingHashes.has(hash)) {
        totalSkipped++;
        continue;
      }
      existingHashes.add(hash); // prevent dupes within this batch

      toInsert.push({
        title: item.headline,
        date,
        category: 'COMPANY',
        source_url: url || '',
        source_label: item.source || 'Gemini Historical',
        title_hash: hash,
        pipeline: 'gemini-historical',
        impact: null,
        severity: 'medium',
        show_pin: false,
        summary: null,
      });
      totalInserted++;
      console.log(`  ✓ ${date}  "${item.headline.slice(0, 60)}"  → ${url.slice(0, 60) || '(no url)'}`);
    }
    console.log('');
  }

  console.log(`[gemini-backfill] found=${totalFound}  inserted=${totalInserted}  skipped_dup=${totalSkipped}`);

  if (APPLY && toInsert.length) {
    // Use the same writeNewsItems path as production fetchers
    const { default: db } = await import('../backend/db.js');
    const { inserted } = await db.writeNewsItems(toInsert);
    console.log(`[gemini-backfill] committed ${inserted} rows to news_feed ✓`);
  } else if (!APPLY) {
    console.log('[gemini-backfill] dry-run only — re-run with --apply to commit');
  }

  await pool.end();
}

main().catch(e => { console.error('[gemini-backfill] fatal:', e); process.exit(1); });
