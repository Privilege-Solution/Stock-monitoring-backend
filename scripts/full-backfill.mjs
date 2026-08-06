import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import {
  normalizeHeadline, normalizeDateYear, bingNewsRssUrl, extractPublisherUrl,
  isHomepageUrl, deepenHomepageUrl, mapLimit,
} from '../backend/lib/fetchers/news-rss-helpers.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function resolveVertex(url) {
  if (!url?.includes('vertexaisearch')) return url;
  try {
    const r = await fetch(url, { method: 'GET', headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (r.url && !r.url.includes('vertexaisearch') && !r.url.includes('google.com')) return r.url;
  } catch {}
  return null;
}

async function bingSearch(query) {
  try {
    const res = await fetch(bingNewsRssUrl(query), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    return items.map(it => {
      const title = (it.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]?.trim() || '';
      const link = (it.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1]?.trim() || '';
      return { title, url: extractPublisherUrl(link) };
    }).filter(x => x.title);
  } catch { return []; }
}

function titleMatch(a, b) {
  const na = normalizeHeadline(a), nb = normalizeHeadline(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = na.split(' ').filter(w => w.length >= 4);
  const tb = new Set(nb.split(' ').filter(w => w.length >= 4));
  if (!ta.length) return false;
  return ta.filter(w => tb.has(w)).length / ta.length >= 0.5;
}

const Q = [];
for (let y = 2021; y <= 2026; y++) {
  const be = y + 543;
  if (y === 2021) { Q.push({ce:y,be,m:'เมษายน-มิถุนายน'},{ce:y,be,m:'กรกฎาคม-กันยายน'},{ce:y,be,m:'ตุลาคม-ธันวาคม'}); continue; }
  Q.push({ce:y,be,m:'มกราคม-มีนาคม'},{ce:y,be,m:'เมษายน-มิถุนายน'},{ce:y,be,m:'กรกฎาคม-กันยายน'});
  if (y < 2026) Q.push({ce:y,be,m:'ตุลาคม-ธันวาคม'});
  if (y === 2026) Q.push({ce:y,be,m:'เมษายน-กรกฎาคม'});
}

const PROMPTS = {
  c: q => `Find 5 major news about Assetwise (ASW.BK) from ${q.m} ${q.be} (${q.ce}). Focus: IPO, earnings, dividends, projects, bonds, TRIS, insider, JV. HEADLINE: [h] DATE: [YYYY-MM-DD] SOURCE: [s] URL: [url or NONE] CATEGORY: [COMPANY] IMPACT_LEVEL: [HIGH|MEDIUM|LOW] If none, NONE.`,
  s: q => `Find 5 news about Thai real estate from ${q.m} ${q.be} (${q.ce}). Focus: competitors (AP,LH,SPALI,SIRI,NOBLE,ORI), REIC, presale, foreign buyers, LTV. HEADLINE: [h] DATE: [YYYY-MM-DD] SOURCE: [s] URL: [url or NONE] CATEGORY: [COMPETITOR|GOV_POLICY|INDUSTRY] IMPACT_LEVEL: [HIGH|MEDIUM|LOW] If none, NONE.`,
  m: q => `Find 5 macro news from ${q.m} ${q.be} (${q.ce}) affecting Thai real estate. Focus: BOT rate, GDP, inflation, baht, Fed, politics. HEADLINE: [h] DATE: [YYYY-MM-DD] SOURCE: [s] URL: [url or NONE] CATEGORY: [RATES|GOV_POLICY|POLITICS|MACRO] IMPACT_LEVEL: [HIGH|MEDIUM|LOW] If none, NONE.`,
};

const ALLOWED = new Set(['COMPANY','COMPETITOR','RATES','GOV_POLICY','POLITICS','INDUSTRY','MACRO']);
const mm = {'มกราคม-มีนาคม':'02','เมษายน-มิถุนายน':'05','กรกฎาคม-กันยายน':'08','ตุลาคม-ธันวาคม':'11','เมษายน-กรกฎาคม':'06'};

const { default: db } = await import('../backend/db.js');
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const { rows: existing } = await pool.query('SELECT title_hash FROM news_feed');
const seen = new Set(existing.map(r => r.title_hash));
const all = [];
let n = 0;

for (const q of Q) {
  for (const [t, fn] of Object.entries(PROMPTS)) {
    n++;
    process.stdout.write(`[${n}/${Q.length*3}] ${q.ce} ${q.m.slice(0,6)} [${t}] `);
    const r = await gsearch(fn(q));
    if (!r) { process.stdout.write("FAIL\n"); continue; }

    // Collect ALL valid URLs from grounding chunks
    const validUrls = [];
    for (const c of r.chunks) {
      const u = await resolveVertex(c.web?.uri);
      if (u && /^https?:\/\/(?!vertexaisearch|google\.com)/.test(u)) validUrls.push(u);
    }

    const blocks = r.text.split(/---|\n(?=HEADLINE)/).filter(b => b.includes('HEADLINE'));
    let cnt = 0;
    for (const b of blocks) {
      const get = k => (b.match(new RegExp(k + ':\\s*(.+)')) || [])[1]?.trim();
      const h = get('HEADLINE'); if (!h || h === 'NONE') continue;
      const hash = sha1(normalizeHeadline(h) || h);
      if (seen.has(hash)) continue; seen.add(hash);
      const rawCat = (get('CATEGORY') || 'INDUSTRY').toUpperCase().trim();
      const cat = ALLOWED.has(rawCat) ? rawCat : 'INDUSTRY';
      const imp = (get('IMPACT_LEVEL') || 'MEDIUM').toUpperCase();
      let d = get('DATE') || '';
      if (/^\d{4}-\d{2}$/.test(d)) d += '-01';
      // No usable date → SKIP the item. This used to invent
      // `${year}-${quarterMiddleMonth}-15`, which put 470 rows on a date no
      // outlet ever published on (Feb/May/Aug/Nov the 15th, ~35% of the feed)
      // and dropped them on the wrong day of the chart. A headline with an
      // unknown date is worth less than the damage a fabricated one does.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        process.stdout.write('·');   // counted in the per-quarter tally below
        continue;
      }
      d = normalizeDateYear(d);

      // Try to get URL: 1) Gemini's stated URL 2) Bing match 3) grounding chunk
      let url = '';
      const statedUrl = get('URL');
      if (statedUrl && statedUrl !== 'NONE' && /^https?:\/\//.test(statedUrl)) {
        url = statedUrl;
      }
      if (!url && validUrls.length) {
        url = validUrls[cnt % validUrls.length];
      }
      if (!url) {
        // Try Bing search as last resort
        const bingResults = await bingSearch(h);
        const match = bingResults.find(br => titleMatch(h, br.title));
        url = match?.url || bingResults[0]?.url || '';
      }

      all.push({ title:h, date:d, category:cat, source_url:url, source_label:get('SOURCE')||'Gemini',
        title_hash:hash, pipeline:'gemini-historical', impact:null,
        severity:imp==='HIGH'?'high':imp==='LOW'?'low':'medium',
        show_pin: imp==='HIGH', summary:null });
      cnt++;
    }
    process.stdout.write(`${cnt} (${validUrls.length} URLs)\n`);
    await new Promise(x => setTimeout(x, 3000));
  }
}

if (all.length) {
  // Deepen publisher-homepage URLs into real article links before writing, the
  // same step gemini-search.mjs and the RSS fetchers run. Without it this
  // script stores `https://www.<publisher>/` links that load but never show the
  // story — and since the chart only pins a day whose news has a usable article
  // URL, those rows would be dead weight: fetched, stored, never surfaced.
  const homepages = all.filter(i => isHomepageUrl(i.source_url));
  if (homepages.length) {
    process.stdout.write(`\ndeepening ${homepages.length} homepage URL(s)...`);
    await mapLimit(homepages, 4, async (i) => {
      const deep = await deepenHomepageUrl(i.title, i.source_label);
      if (deep) i.source_url = deep;
    });
    const stillHome = all.filter(i => isHomepageUrl(i.source_url)).length;
    process.stdout.write(` ${homepages.length - stillHome} resolved, ${stillHome} cleared to no-url\n`);
    // Keep the headline (this backfill values coverage for old news) but drop
    // the misleading link, so the row cannot masquerade as clickable.
    for (const i of all) if (isHomepageUrl(i.source_url)) i.source_url = '';
  }

  const { inserted } = await db.writeNewsItems(all);
  const withUrl = all.filter(i => i.source_url).length;
  process.stdout.write(`\nDONE: ${inserted} inserted, ${withUrl}/${all.length} with URLs (${Math.round(withUrl/all.length*100)}%)\n`);
} else {
  process.stdout.write('\nNo new items\n');
}
await pool.end();
