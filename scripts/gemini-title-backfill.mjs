// =============================================================================
// Historical news backfill for TITLE (ร่มโพธิ์ พร็อพเพอร์ตี้ — SET: TITLE),
// the ASW subsidiary whose buyers are mostly foreign.
//
// Mirrors the ASW historical backfills (gemini-all-category-backfill.mjs) but
// searches TITLE's two distinct streams per period:
//
//   company — ร่มโพธิ์ / THE TITLE: earnings, presale, project launches,
//             hotel JVs (IHG), bonds/dividends, the Jan-2026 mai→SET move.
//   drivers — the events that moved PHUKET FOREIGN DEMAND in that period:
//             war/sanctions (Russian buyers), oil, THB/RUB/CNY, tourism
//             access (visas, flights, arrivals), foreign-ownership policy.
//             This is what the TITLE panel exists to show, and what the
//             chart pins should mark.
//
// WHY THIS SCRIPT AND NOT THE CRON: the live gemini-title-* pipelines only
// look at the last 48 hours (DATE_DISCIPLINE), and Bing News RSS indexes
// ~30-90 days. Google Search grounding is the only free-tier source that
// reaches back years — the same reason the ASW backfills exist.
//
// PINS: severity is derived from the model's IMPACT_LEVEL, and `show_pin` is
// deliberately NOT set here — db.writeNewsItems() derives it as
// `severity === 'high'`. Passing an explicit false is what previously left
// 105 ASW rows invisible on the chart (see gemini-all-category-backfill.mjs).
//
// Run:
//   node scripts/gemini-title-backfill.mjs                 # dry-run
//   node scripts/gemini-title-backfill.mjs --apply
//   node scripts/gemini-title-backfill.mjs --from=2024 --apply
// =============================================================================

import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHeadline } from '../backend/lib/fetchers/news-rss-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env'), quiet: true });

const { default: db } = await import('../backend/db.js');
const { categoriesForStock } = await import('../backend/lib/news-taxonomy.mjs');

const APPLY = process.argv.includes('--apply');
const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const FROM_YEAR = Number(arg('from', '2021'));
const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

if (!process.env.GEMINI_API_KEY) {
  console.error('[title-backfill] GEMINI_API_KEY not set — nothing to search with.');
  process.exit(1);
}

// Half-years through the quiet mai era, quarters once TITLE became an ASW
// subsidiary with real project flow. 2017-2020 is deliberately skipped by
// default (--from=2018 to include it): a small mai company left almost no
// indexed Thai-language coverage, and the driver events of that era did not
// yet move a Russian-buyer-led Phuket market.
const PERIODS = [
  { ce: 2021, be: 2564, m: 'มกราคม-มิถุนายน' },   { ce: 2021, be: 2564, m: 'กรกฎาคม-ธันวาคม' },
  { ce: 2022, be: 2565, m: 'มกราคม-มิถุนายน' },   { ce: 2022, be: 2565, m: 'กรกฎาคม-ธันวาคม' },
  { ce: 2023, be: 2566, m: 'มกราคม-มิถุนายน' },   { ce: 2023, be: 2566, m: 'กรกฎาคม-ธันวาคม' },
  { ce: 2024, be: 2567, m: 'มกราคม-มีนาคม' },     { ce: 2024, be: 2567, m: 'เมษายน-มิถุนายน' },
  { ce: 2024, be: 2567, m: 'กรกฎาคม-กันยายน' },   { ce: 2024, be: 2567, m: 'ตุลาคม-ธันวาคม' },
  { ce: 2025, be: 2568, m: 'มกราคม-มีนาคม' },     { ce: 2025, be: 2568, m: 'เมษายน-มิถุนายน' },
  { ce: 2025, be: 2568, m: 'กรกฎาคม-กันยายน' },   { ce: 2025, be: 2568, m: 'ตุลาคม-ธันวาคม' },
  { ce: 2026, be: 2569, m: 'มกราคม-มีนาคม' },     { ce: 2026, be: 2569, m: 'เมษายน-กรกฎาคม' },
].filter(p => p.ce >= FROM_YEAR);

const TITLE_CATS = categoriesForStock('TITLE');

const PROMPTS = {
  company: (p) => `ค้นหาข่าวสำคัญ 3-5 ข่าวของบริษัท "ร่มโพธิ์ พร็อพเพอร์ตี้" (หุ้น TITLE) หรือแบรนด์ "The Title" ในช่วง ${p.m} ${p.be} (${p.ce})
บริษัทนี้พัฒนาอสังหาฯ ในภูเก็ต เป็นบริษัทลูกของ AssetWise (ASW)
ค้นหา: ผลประกอบการ/รายได้, ยอด presale-โอนกรรมสิทธิ์, เปิดโครงการใหม่ในภูเก็ต, ร่วมทุนโรงแรม (เช่น IHG),
หุ้นกู้/ปันผล/เพิ่มทุน, การย้ายจากตลาด mai เข้า SET, บทวิเคราะห์โบรกเกอร์
ระวัง: "title deed" (โฉนดที่ดิน) ไม่ใช่บริษัทนี้ ห้ามเอามา

ตอบเป็นบล็อกละข่าว รูปแบบนี้เท่านั้น:
HEADLINE: [พาดหัวข่าวจริง ภาษาไทย]
DATE: [YYYY-MM-DD ถ้าไม่แน่ใจวันให้ใส่ YYYY-MM]
SOURCE: [ชื่อสำนักข่าว]
CATEGORY: [COMPANY]
IMPACT_LEVEL: [HIGH | MEDIUM | LOW]
---
IMPACT_LEVEL: HIGH = งบ/ปันผล/เพิ่มทุน/backlog เปลี่ยนแรง/ย้ายตลาด · MEDIUM = เปิดโครงการ/JV · LOW = ข่าว PR
ถ้าไม่มีข่าวในช่วงนี้ ตอบ NONE`,

  drivers: (p) => `คุณเป็น analyst ตลาดอสังหาฯ ภูเก็ต ซึ่งผู้ซื้อหลักเป็นชาวต่างชาติ (รัสเซียอันดับ 1 ตามมูลค่าโอนคอนโด รองมาคือจีน)
ค้นหาเหตุการณ์สำคัญ 3-5 เหตุการณ์ในช่วง ${p.m} ${p.be} (${p.ce}) ที่ "กระทบกำลังซื้อหรือการเดินทางของผู้ซื้อต่างชาติในภูเก็ตอย่างมีนัยสำคัญ"

หัวข้อที่ต้องการ (เอาเฉพาะเหตุการณ์ที่เปลี่ยนสถานการณ์จริง ไม่ใช่ข่าวประจำวัน):
- สงครามรัสเซีย-ยูเครน / มาตรการคว่ำบาตร / การเจรจาหยุดยิง → GEOPOLITICS
- ราคาน้ำมันดิบเคลื่อนไหวรุนแรง / คว่ำบาตรน้ำมันรัสเซีย → OIL
- ค่าเงินบาท-รูเบิล-หยวนเคลื่อนไหวแรง / กฎการโอนเงินระหว่างประเทศ → FX
- วีซ่า / เที่ยวบินตรงเข้าภูเก็ต / จำนวนนักท่องเที่ยวเปลี่ยนแปลงมาก → TOURISM
- โควตาต่างชาติถือครองคอนโด / นอมินี / leasehold / มาตรการรัฐเรื่องต่างชาติ → GOV_POLICY
- ตลาดอสังหาฯ ภูเก็ต: ยอดโอนต่างชาติ, supply ใหม่, ราคา → INDUSTRY

ตอบเป็นบล็อกละข่าว รูปแบบนี้เท่านั้น:
HEADLINE: [พาดหัวข่าวจริง]
DATE: [YYYY-MM-DD ถ้าไม่แน่ใจวันให้ใส่ YYYY-MM]
SOURCE: [ชื่อสำนักข่าว]
CATEGORY: [GEOPOLITICS | OIL | FX | TOURISM | GOV_POLICY | INDUSTRY]
IMPACT_LEVEL: [HIGH | MEDIUM | LOW]
---
IMPACT_LEVEL มองจากดีมานด์อสังหาฯ ภูเก็ต:
HIGH = เปลี่ยนพฤติกรรมผู้ซื้อทันที (สงครามปะทุ/คว่ำบาตรรอบใหม่/วีซ่าเปลี่ยน/ค่าเงินผันผวนแรง/กฎถือครองเปลี่ยน)
MEDIUM = แนวโน้มสะสม (เที่ยวบินเพิ่ม-ลด, ยอดโอนรายไตรมาส, น้ำมันขยับ)
LOW = ภาพรวม/บทวิเคราะห์
ถ้าไม่มีเหตุการณ์สำคัญในช่วงนี้ ตอบ NONE`,
};

async function gemini(prompt) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
    tools: [{ google_search: {} }],
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${ENDPOINT}?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) {
        if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
        console.warn(`  ! HTTP ${r.status} (permanent) — skipping`);
        return { text: '', chunks: [] };
      }
      const j = await r.json();
      const cand = j.candidates?.[0];
      const text = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('\n');
      const chunks = (cand?.groundingMetadata?.groundingChunks || [])
        .map(c => c.web).filter(Boolean);
      return { text, chunks };
    } catch (e) {
      if (attempt === 3) { console.warn(`  ! ${e.message} — giving up on this search`); return { text: '', chunks: [] }; }
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  return { text: '', chunks: [] };
}

function parseItems(text, allowed) {
  if (!text || text.trim() === 'NONE') return [];
  const blocks = text.split(/---|\n(?=HEADLINE)/).filter(b => b.includes('HEADLINE'));
  return blocks.map(block => {
    const get = k => (block.match(new RegExp(k + ':\\s*(.+)')) || [])[1]?.trim();
    const h = get('HEADLINE');
    if (!h || h === 'NONE' || /^\[/.test(h)) return null;      // skip echoed placeholders
    let d = (get('DATE') || '').replace(/[[\]]/g, '').trim();
    if (/^\d{4}-\d{2}$/.test(d)) d += '-15';                   // month-only → mid-month
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;           // undatable → drop (pins need a date)
    const cat = (get('CATEGORY') || '').toUpperCase().replace(/[[\]]/g, '').trim();
    const impact = (get('IMPACT_LEVEL') || 'MEDIUM').toUpperCase().replace(/[[\]]/g, '').trim();
    return {
      headline: h.replace(/^["“]|["”]$/g, '').trim(),
      date: d,
      source: (get('SOURCE') || 'ไม่ระบุ').replace(/[[\]]/g, '').trim(),
      // Coerce against the TITLE vocabulary — same rule the live parser uses.
      category: allowed.has(cat) ? cat : null,
      impact: ['HIGH', 'MEDIUM', 'LOW'].includes(impact) ? impact : 'MEDIUM',
    };
  }).filter(Boolean);
}

// A grounding chunk's URI is a vertexaisearch redirect; follow it once to get
// the publisher URL. db.sanitizeSourceUrl() rejects unresolved redirects, so a
// failure here costs the link, never the row.
async function resolveUrl(uri) {
  if (!uri) return '';
  try {
    const r = await fetch(uri, { redirect: 'follow', signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } });
    if (r.url && !r.url.includes('vertexaisearch')) return r.url;
  } catch {}
  return '';
}

db.openDb();
const allowed = new Set(TITLE_CATS);
const seen = new Set();
const collected = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log(`[title-backfill] ${PERIODS.length} periods × 2 searches = ${PERIODS.length * 2} Gemini calls (from ${FROM_YEAR})`);

for (const p of PERIODS) {
  for (const [kind, promptFn] of Object.entries(PROMPTS)) {
    process.stdout.write(`  ${p.ce} ${p.m} · ${kind} … `);
    const { text, chunks } = await gemini(promptFn(p));
    const items = parseItems(text, allowed);
    let kept = 0;
    for (const it of items) {
      // Keep the item inside its period — the model sometimes drifts.
      if (Number(it.date.slice(0, 4)) < p.ce - 1 || Number(it.date.slice(0, 4)) > p.ce + 1) continue;
      const hash = sha1(normalizeHeadline(it.headline) || it.headline);
      if (seen.has(hash)) continue;
      seen.add(hash);
      collected.push({
        title: it.headline,
        date: it.date,
        category: it.category || (kind === 'company' ? 'COMPANY' : 'INDUSTRY'),
        source_label: it.source,
        title_hash: hash,
        pipeline: `gemini-title-historical`,
        impact: null,
        // show_pin intentionally omitted → writeNewsItems derives it from
        // severity, which is how these land on the chart.
        severity: it.impact === 'HIGH' ? 'high' : it.impact === 'LOW' ? 'low' : 'medium',
        summary: null,
        _chunks: chunks,
      });
      kept++;
    }
    process.stdout.write(`${kept} kept\n`);
    await sleep(3000);   // stay well under the free-tier rate limit
  }
}

console.log(`\n[title-backfill] collected ${collected.length} unique items`);
const byCat = {};
const bySev = {};
for (const it of collected) {
  byCat[it.category] = (byCat[it.category] || 0) + 1;
  bySev[it.severity] = (bySev[it.severity] || 0) + 1;
}
console.log('  by category:', Object.entries(byCat).map(([k, v]) => `${k}:${v}`).join(', ') || '—');
console.log('  by severity:', Object.entries(bySev).map(([k, v]) => `${k}:${v}`).join(', ') || '—');
console.log(`  → ${bySev.high || 0} will pin the chart (severity=high)`);

if (!collected.length) { await db.closeDb(); process.exit(0); }

if (!APPLY) {
  console.log('\n  sample:');
  for (const it of collected.slice(0, 8)) console.log(`   ${it.date} [${it.category}/${it.severity}] ${it.title.slice(0, 62)}`);
  console.log(`\n[title-backfill] DRY RUN — pass --apply to insert into news_feed as stock='TITLE'.`);
  await db.closeDb();
  process.exit(0);
}

// Resolve one grounding URL per item (best effort, capped concurrency).
console.log('\n[title-backfill] resolving grounding URLs...');
for (let i = 0; i < collected.length; i += 5) {
  await Promise.all(collected.slice(i, i + 5).map(async (it) => {
    const chunk = (it._chunks || [])[0];
    it.source_url = await resolveUrl(chunk?.uri);
    delete it._chunks;
  }));
}
const withUrl = collected.filter(it => it.source_url).length;
console.log(`[title-backfill] ${withUrl}/${collected.length} items carry a resolved link (the rest keep full content, no link)`);

const { inserted, deduped } = await db.writeNewsItems('TITLE', collected);
console.log(`[title-backfill] inserted=${inserted} deduped=${deduped}`);
await db.closeDb();
