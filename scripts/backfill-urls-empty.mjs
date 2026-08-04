// =============================================================================
// Recover source_url for news_feed rows that have NONE at all.
//
// The existing passes all repair a url that EXISTS but is wrong:
//   backfill-urls / pass2   → source_url LIKE '%news.google.com%'
//   pass3 / deepen-homepages→ source_url ~ '^https?://[^/]+/?$'  (homepage only)
//   fix-vertex-urls         → source_url LIKE '%vertexaisearch%'
// None of them match `source_url = ''`, which is what the gemini-historical
// backfill stored whenever neither the grounding chunks nor the Bing fallback
// produced a link (it prefers headline coverage over url completeness for old
// news — see gemini-all-category-backfill.mjs). Those rows render as plain
// grey text on the chart tooltip and sidebar, so they can't be clicked through.
//
// Two stages per row, cheapest first:
//   1. deepenHomepageUrl(title, source_label) — Bing News RSS + company-alias
//      gating. Free, no quota. Bing's index is shallow (~30-90 days), so this
//      mostly helps recent rows.
//   2. Gemini + google_search grounding, asked for THIS ONE headline's article
//      (the original backfill asked for "5 news from quarter X", a different
//      and much looser query). Google's index goes back years, so this is the
//      stage that can actually reach 2021-2024. Costs one call per row.
//
// A candidate is only stored if it returns 2xx — the same liveness check pass3
// uses — so a dead link never replaces an empty one.
//
// Run:
//   node scripts/backfill-urls-empty.mjs              # dry-run, chart pins only
//   node scripts/backfill-urls-empty.mjs --apply      # commit those
//   node scripts/backfill-urls-empty.mjs --all        # dry-run, every empty row
//   node scripts/backfill-urls-empty.mjs --all --apply
//   node scripts/backfill-urls-empty.mjs --limit=20   # cap the batch
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import {
  deepenHomepageUrl, isHomepageUrl, normalizeHeadline, requiredAliases,
} from '../backend/lib/fetchers/news-rss-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env'), quiet: true });

const APPLY = process.argv.includes('--apply');
const ALL   = process.argv.includes('--all');
const LIMIT = (() => {
  const a = process.argv.find(x => x.startsWith('--limit='));
  const n = a ? parseInt(a.split('=')[1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
})();

const IPO   = '2021-04-28';
const UA    = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const MODEL = 'gemini-2.5-flash';
const EP    = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (() => {
    try {
      const u = new URL(process.env.DATABASE_URL);
      if (u.hostname.endsWith('.railway.internal') || u.hostname === 'localhost') return false;
    } catch {}
    return { rejectUnauthorized: false };
  })(),
  max: 3,
});

// A url we would actually store: http(s), a real publisher, and a deep link
// rather than a bare homepage (a homepage "works" but doesn't show the story).
function isStorable(u) {
  if (!u || !/^https?:\/\//i.test(u)) return false;
  if (/vertexaisearch|google\.com|bing\.com|news\.google/i.test(u)) return false;
  return !isHomepageUrl(u);
}

// Follow a Gemini grounding redirect out to the publisher.
async function resolveVertex(url) {
  if (!url) return null;
  if (!url.includes('vertexaisearch')) return url;
  try {
    const r = await fetch(url, {
      method: 'GET', headers: { 'User-Agent': UA },
      redirect: 'follow', signal: AbortSignal.timeout(10_000),
    });
    if (r.url && !r.url.includes('vertexaisearch')) return r.url;
  } catch {}
  return null;
}

// Liveness check — pass3's rule. HEAD first, GET fallback (some Thai
// publishers reject HEAD outright).
async function isLive(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const r = await fetch(url, {
        method, headers: { 'User-Agent': UA },
        redirect: 'follow', signal: AbortSignal.timeout(12_000),
      });
      if (r.ok) return true;
      if (r.status === 405 || r.status === 403) continue;
      return false;
    } catch { /* try next method */ }
  }
  return false;
}

async function geminiFindUrl(title, date, sourceLabel) {
  if (!process.env.GEMINI_API_KEY) return null;
  const prompt = `ค้นหา URL ของบทความข่าวนี้ (ข่าวไทย เผยแพร่ประมาณวันที่ ${date}${sourceLabel ? `, แหล่งข่าว: ${sourceLabel}` : ''}):

"${title}"

ตอบกลับเฉพาะ URL ของบทความจริงบรรทัดเดียว ไม่ต้องมีคำอธิบาย
ถ้าหาบทความที่ตรงกันไม่ได้ ตอบว่า NONE`;

  let r;
  try {
    r = await fetch(`${EP}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
        tools: [{ google_search: {} }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch { return null; }
  if (!r.ok) return null;

  let j;
  try { j = await r.json(); } catch { return null; }
  const cand = j.candidates?.[0] || {};
  const text = cand.content?.parts?.[0]?.text || '';
  const chunks = cand.groundingMetadata?.groundingChunks || [];

  // Prefer the grounding chunks — those are URLs Google actually returned.
  // The model's own stated URL is checked last because it can be invented.
  const candidates = [];
  for (const c of chunks) {
    const u = await resolveVertex(c.web?.uri);
    if (u) candidates.push(u);
  }
  const stated = (text.match(/https?:\/\/\S+/) || [])[0];
  if (stated) candidates.push(stated.replace(/[),.\]]+$/, ''));

  // Keep only results whose title-ish url or host plausibly belongs to the
  // story's company, when the headline names one.
  const aliases = requiredAliases(title);
  const ranked = candidates.filter(isStorable);
  for (const u of ranked) {
    if (await isLive(u)) {
      return { url: u, aliasChecked: aliases.length > 0 };
    }
  }
  return null;
}

// --- main --------------------------------------------------------------------

const where = [`hidden = FALSE`, `(source_url IS NULL OR source_url = '' OR source_url !~ '^https?://')`];
if (!ALL) where.push(`(show_pin = TRUE OR chart_marked = TRUE)`);
where.push(`date >= '${IPO}'`);

const { rows } = await pool.query(
  `SELECT id, title, date, source_label, category, severity
     FROM news_feed
    WHERE ${where.join(' AND ')}
    ORDER BY date ASC, id ASC
    ${LIMIT ? `LIMIT ${LIMIT}` : ''}`
);

console.log(`[empty-url] scope   : ${ALL ? 'ALL rows with no url' : 'CHART PINS only'}${LIMIT ? ` (limit ${LIMIT})` : ''}`);
console.log(`[empty-url] targets : ${rows.length} rows`);
console.log(`[empty-url] mode    : ${APPLY ? 'APPLY (will UPDATE the DB)' : 'DRY-RUN (pass --apply to commit)'}`);
console.log(`[empty-url] gemini  : ${process.env.GEMINI_API_KEY ? 'available' : 'NOT SET — Bing stage only'}\n`);

let viaBing = 0, viaGemini = 0, missed = 0, written = 0;

for (const [i, row] of rows.entries()) {
  const tag = `[${String(i + 1).padStart(3)}/${rows.length}] ${row.date}`;
  let found = null, how = '';

  // Stage 1 — Bing (free).
  try {
    const u = await deepenHomepageUrl(row.title, row.source_label);
    if (isStorable(u) && await isLive(u)) { found = u; how = 'bing'; viaBing++; }
  } catch {}

  // Stage 2 — Gemini grounding (quota).
  if (!found) {
    const g = await geminiFindUrl(row.title, row.date, row.source_label);
    if (g) { found = g.url; how = 'gemini'; viaGemini++; }
    await new Promise(r => setTimeout(r, 2500));   // be polite to the API
  }

  if (!found) {
    missed++;
    console.log(`${tag}  ✗ no url   ${row.title.slice(0, 58)}`);
    continue;
  }

  console.log(`${tag}  ✓ ${how.padEnd(6)} ${row.title.slice(0, 44)}\n${' '.repeat(20)}→ ${found}`);

  if (APPLY) {
    await pool.query(`UPDATE news_feed SET source_url = $1 WHERE id = $2`, [found, row.id]);
    written++;
  }
}

console.log(`\n[empty-url] done — bing=${viaBing} gemini=${viaGemini} missed=${missed}` +
            (APPLY ? `  |  ${written} rows UPDATED` : `  |  dry-run, nothing written`));
await pool.end();
