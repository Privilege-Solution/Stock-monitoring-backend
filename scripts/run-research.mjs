import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { normalizeHeadline } from '../backend/lib/fetchers/news-rss-helpers.mjs';
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

async function resolve(url) {
  if (!url?.includes('vertexaisearch')) return url;
  try {
    const r = await fetch(url, { method: 'GET', headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (r.url && !r.url.includes('vertexaisearch')) return r.url;
  } catch {}
  return null;
}

const QUARTERS = [
  { ce: 2021, be: 2564, m: 'มีนาคม-พฤษภาคม' }, { ce: 2021, be: 2564, m: 'มิถุนายน-สิงหาคม' },
  { ce: 2021, be: 2564, m: 'กันยายน-ธันวาคม' }, { ce: 2022, be: 2565, m: 'มกราคม-มีนาคม' },
  { ce: 2022, be: 2565, m: 'เมษายน-มิถุนายน' }, { ce: 2022, be: 2565, m: 'กรกฎาคม-กันยายน' },
  { ce: 2022, be: 2565, m: 'ตุลาคม-ธันวาคม' }, { ce: 2023, be: 2566, m: 'มกราคม-มีนาคม' },
  { ce: 2023, be: 2566, m: 'เมษายน-มิถุนายน' }, { ce: 2023, be: 2566, m: 'กรกฎาคม-กันยายน' },
  { ce: 2023, be: 2566, m: 'ตุลาคม-ธันวาคม' }, { ce: 2024, be: 2567, m: 'มกราคม-มีนาคม' },
  { ce: 2024, be: 2567, m: 'เมษายน-มิถุนายน' }, { ce: 2024, be: 2567, m: 'กรกฎาคม-กันยายน' },
  { ce: 2024, be: 2567, m: 'ตุลาคม-ธันวาคม' }, { ce: 2025, be: 2568, m: 'มกราคม-มิถุนายน' },
  { ce: 2025, be: 2568, m: 'กรกฎาคม-ธันวาคม' }, { ce: 2026, be: 2569, m: 'มกราคม-กรกฎาคม' },
];

const seen = new Set();
const all = [];
let searchNum = 0;

for (const q of QUARTERS) {
  for (const angle of ['ASW', 'แอสเซทไวส์']) {
    searchNum++;
    process.stdout.write(`[${searchNum}/36] ${q.ce} ${q.m.slice(0,8)} [${angle}].. `);
    const r = await gsearch(
      `Find 3-5 major news about "${angle}" (ASW.BK, Assetwise PCL, Thai real estate) from ${q.m} ${q.be} (${q.ce}).\n` +
      `Search Thai financial sites: ryt9.com, kaohoon.com, thinkofliving.com, bangkokbiznews.com, settrade.com, efinancethai.com.\n` +
      `Focus: IPO, earnings, dividends, new projects, bonds, TRIS rating, insider, JV/M&A, strategic plans, management changes.\n\n` +
      `For each, provide:\nHEADLINE: [exact headline as published]\nDATE: [YYYY-MM-DD]\nSOURCE: [publisher]\n\nIf none, reply NONE.`
    );
    if (!r) { process.stdout.write('FAIL\n'); continue; }
    const blocks = r.text.split(/---|\n(?=HEADLINE)/).filter(b => b.includes('HEADLINE'));
    let n = 0;
    for (const b of blocks) {
      const get = k => (b.match(new RegExp(k + ':\\s*(.+)')) || [])[1]?.trim();
      const h = get('HEADLINE'); if (!h || h === 'NONE') continue;
      const key = sha1(normalizeHeadline(h));
      if (seen.has(key)) continue; seen.add(key);
      let d = get('DATE') || `${q.ce}-06-01`;
      if (/^\d{4}-\d{2}$/.test(d)) d += '-01';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) d = `${q.ce}-06-01`;
      let url = null;
      for (const c of r.chunks) {
        const u = await resolve(c.web?.uri);
        if (u && /^https?:\/\/(?!vertexaisearch|google\.com)/.test(u)) { url = u; break; }
      }
      all.push({
        date_be: `${d.slice(8,10)}/${d.slice(5,7)}/${parseInt(d.slice(0,4))+543}`,
        date_ce: d, source: get('SOURCE') || 'unknown', headline: h,
        url, url_verified: !!url, category: 'ASW', impact: 'HIGH',
        reason: 'major ASW corporate event',
      });
      n++;
    }
    process.stdout.write(`${n} items\n`);
    await new Promise(x => setTimeout(x, 5000));
  }
}

all.sort((a, b) => b.date_ce.localeCompare(a.date_ce));
const fs = await import('node:fs');
fs.writeFileSync('/tmp/asw-timeline-complete.json', JSON.stringify(all, null, 2));
process.stdout.write(`\nDONE: ${all.length} items, ${all.filter(i=>i.url).length} with URLs\n`);
