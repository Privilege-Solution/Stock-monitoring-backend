import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { normalizeHeadline, normalizeDateYear, bingNewsRssUrl, extractPublisherUrl } from '../backend/lib/fetchers/news-rss-helpers.mjs';
import { dirname, join } from 'node:path'; import { fileURLToPath } from 'node:url'; const __d = dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: join(__d, '..', 'backend', '.env'), quiet: true });

const EP = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const sha1 = s => createHash('sha1').update(String(s)).digest('hex');

async function gsearch(prompt) {
  for (let i = 1; i <= 5; i++) {
    try {
      const r = await fetch(`${EP}?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
          tools: [{ google_search: {} }] }),
        signal: AbortSignal.timeout(90_000) });
      if (r.status === 503) { await new Promise(x => setTimeout(x, 30000)); continue; }
      if (!r.ok) return null;
      const j = await r.json();
      const c = j.candidates?.[0] || {};
      return { text: c.content?.parts?.[0]?.text || '', chunks: c.groundingMetadata?.groundingChunks || [] };
    } catch { if (i < 5) await new Promise(x => setTimeout(x, 15000)); }
  }
  return null;
}

async function bingUrl(headline) {
  try {
    const res = await fetch(bingNewsRssUrl(headline), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return '';
    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    for (const it of items) {
      const t = ((it.match(/<title[^>]*>([\s\S]*?)<\/title>/)||[])[1]||'').toLowerCase();
      const link = (it.match(/<link[^>]*>([\s\S]*?)<\/link>/)||[])[1]||'';
      const na = normalizeHeadline(headline).toLowerCase();
      if (na.includes(t.slice(0,25)) || t.includes(na.slice(0,25))) {
        const u = extractPublisherUrl(link);
        if (u) return u;
      }
    }
    // fallback: first result
    if (items.length) {
      const link = (items[0].match(/<link[^>]*>([\s\S]*?)<\/link>/)||[])[1]||'';
      return extractPublisherUrl(link);
    }
  } catch {}
  return '';
}

const Q = [];
for (let y = 2021; y <= 2026; y++) {
  const be = y + 543;
  if (y === 2021) { Q.push({ce:y,be,m:'เมษายน-มิถุนายน'},{ce:y,be,m:'กรกฎาคม-กันยายน'},{ce:y,be,m:'ตุลาคม-ธันวาคม'}); continue; }
  Q.push({ce:y,be,m:'มกราคม-มีนาคม'},{ce:y,be,m:'เมษายน-มิถุนายน'},{ce:y,be,m:'กรกฎาคม-กันยายน'});
  if (y < 2026) Q.push({ce:y,be,m:'ตุลาคม-ธันวาคม'});
  if (y === 2026) Q.push({ce:y,be,m:'เมษายน-กรกฎาคม'});
}

const P = {
  c: q => `Find 5 ASW (Assetwise ASW.BK) news from ${q.m} ${q.be}. HEADLINE:[h] DATE:[YYYY-MM-DD] SOURCE:[s] CATEGORY:[COMPANY] IMPACT:[HIGH|MEDIUM|LOW] NONE if none.`,
  s: q => `Find 5 Thai real estate news from ${q.m} ${q.be}. Focus: AP,LH,SPALI,SIRI,REIC,presale,LTV. HEADLINE:[h] DATE:[YYYY-MM-DD] SOURCE:[s] CATEGORY:[COMPETITOR|GOV_POLICY|INDUSTRY] IMPACT:[HIGH|MEDIUM|LOW] NONE if none.`,
  m: q => `Find 5 macro news from ${q.m} ${q.be} affecting Thai property. Focus: BOT,GDP,baht,Fed. HEADLINE:[h] DATE:[YYYY-MM-DD] SOURCE:[s] CATEGORY:[RATES|MACRO|POLITICS] IMPACT:[HIGH|MEDIUM|LOW] NONE if none.`,
};

const AL = new Set(['COMPANY','COMPETITOR','RATES','GOV_POLICY','POLITICS','INDUSTRY','MACRO']);
const mm = {'มกราคม-มีนาคม':'02','เมษายน-มิถุนายน':'05','กรกฎาคม-กันยายน':'08','ตุลาคม-ธันวาคม':'11','เมษายน-กรกฎาคม':'06'};

const { default: db } = await import('../backend/db.js');
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const { rows: ex } = await pool.query('SELECT title_hash FROM news_feed');
const seen = new Set(ex.map(r => r.title_hash));
const all = [];
let n = 0;

for (const q of Q) {
  for (const [t, fn] of Object.entries(P)) {
    n++;
    process.stdout.write(`[${n}/${Q.length*3}] ${q.ce} ${q.m.slice(0,4)}[${t}] `);
    const r = await gsearch(fn(q));
    if (!r) { process.stdout.write("FAIL\n"); continue; }
    const blocks = r.text.split(/---|\n(?=HEADLINE)/).filter(b => b.includes('HEADLINE'));
    let cnt = 0;
    for (const b of blocks) {
      const get = k => (b.match(new RegExp(k + ':\\s*(.+)')) || [])[1]?.trim();
      const h = get('HEADLINE'); if (!h || h === 'NONE') continue;
      const hash = sha1(normalizeHeadline(h) || h);
      if (seen.has(hash)) continue; seen.add(hash);
      const cat = (AL.has((get('CATEGORY')||'').toUpperCase()) ? get('CATEGORY').toUpperCase() : 'INDUSTRY');
      const imp = (get('IMPACT')||get('IMPACT_LEVEL')||'MEDIUM').toUpperCase();
      let d = get('DATE')||'';
      if (/^\d{4}-\d{2}$/.test(d)) d+='-01';
      // Skip rather than invent a quarter-midpoint date — see full-backfill.mjs.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      d = normalizeDateYear(d);
      // Get URL from Bing
      const url = await bingUrl(h);
      all.push({title:h,date:d,category:cat,source_url:url,source_label:get('SOURCE')||'Gemini',
        title_hash:hash,pipeline:'gemini-historical',impact:null,
        severity:imp==='HIGH'?'high':imp==='LOW'?'low':'medium',show_pin:imp==='HIGH',summary:null});
      cnt++;
    }
    process.stdout.write(`${cnt}\n`);
    await new Promise(x => setTimeout(x, 3000));
  }
}

if (all.length) {
  const { inserted } = await db.writeNewsItems(all);
  const wu = all.filter(i => i.source_url).length;
  process.stdout.write(`\nDONE: ${inserted} inserted, ${wu}/${all.length} with URLs (${Math.round(wu/all.length*100)}%)\n`);
} else process.stdout.write('\nNo new items\n');
await pool.end();
