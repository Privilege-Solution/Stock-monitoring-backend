// =============================================================================
// EXHAUSTIVE historical news sweep for TITLE (ร่มโพธิ์ พร็อพเพอร์ตี้ — SET: TITLE),
// from its 2017-11-02 mai listing to today. Goal: find as much as the free
// tier can reach, not a representative sample.
//
// Three things make this deeper than gemini-title-backfill.mjs:
//
//   1. MULTI-ANGLE. Six independent search angles per period. A single prompt
//      returns whatever Gemini ranks highest and stops; asking the same
//      quarter about brand launches, about the Phuket market, and about
//      Russian-buyer conditions surfaces three disjoint sets. Angles are
//      blind to each other by construction.
//   2. LOOP-UNTIL-DRY. Each (period, angle) repeats, feeding back the
//      headlines already found so the model must return DIFFERENT ones, until
//      a round yields nothing new or MAX_ROUNDS is hit. Fixed round counts
//      stop early on rich quarters and waste calls on empty ones.
//   3. QUARTERLY TO THE IPO. 2017-2020 is thin (a small mai company), but
//      thin is not empty — and the driver events of that era are what the
//      chart's early years otherwise leave blank.
//
// Writes incrementally, one period at a time: a long run that dies at hour
// two keeps everything it found in hour one. A JSON progress file makes the
// script resumable — re-running skips periods already completed.
//
// PINS: severity comes from the model's IMPACT_LEVEL and `show_pin` is left
// unset so db.writeNewsItems() derives it (severity === 'high'). Passing an
// explicit false is what once left 105 ASW rows invisible on the chart.
//
// Run:
//   node scripts/gemini-title-deep-backfill.mjs                    # dry-run, 1 period
//   node scripts/gemini-title-deep-backfill.mjs --apply
//   node scripts/gemini-title-deep-backfill.mjs --apply --from=2024
//   node scripts/gemini-title-deep-backfill.mjs --apply --rounds=3 # deeper per angle
//   node scripts/gemini-title-deep-backfill.mjs --apply --reset    # ignore progress file
// =============================================================================

import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHeadline } from '../backend/lib/fetchers/news-rss-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env'), quiet: true });

const { default: db } = await import('../backend/db.js');
const { categoriesForStock } = await import('../backend/lib/news-taxonomy.mjs');

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');
const FROM_YEAR = Number(arg('from', '2017'));
const MAX_ROUNDS = Number(arg('rounds', '2'));
const SLEEP_MS = Number(arg('sleep', '2500'));
// Angles within a period are independent searches, so they run concurrently.
// A grounded call takes ~30s, so 3 in flight is ~6 calls/min — comfortably
// under the free tier's 15 RPM while cutting a 3.7-hour sweep to about one.
// Rounds INSIDE an angle stay sequential: round 2 exists to ask for what
// round 1 did not return.
const CONCURRENCY = Number(arg('concurrency', '3'));
const PROGRESS_FILE = join(__dirname, '.title-deep-progress.json');

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!process.env.GEMINI_API_KEY) {
  console.error('[deep] GEMINI_API_KEY not set.');
  process.exit(1);
}

// ── periods: every quarter from the IPO quarter to the current one ──────────
function buildPeriods() {
  const THAI_Q = ['มกราคม-มีนาคม', 'เมษายน-มิถุนายน', 'กรกฎาคม-กันยายน', 'ตุลาคม-ธันวาคม'];
  const out = [];
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  const endY = now.getUTCFullYear(), endQ = Math.floor(now.getUTCMonth() / 3);
  for (let y = 2017; y <= endY; y++) {
    for (let q = 0; q < 4; q++) {
      if (y === 2017 && q < 3) continue;            // IPO is 2017-11-02 → Q4 only
      if (y === endY && q > endQ) break;
      out.push({ ce: y, be: y + 543, q: q + 1, m: THAI_Q[q],
        from: `${y}-${String(q * 3 + 1).padStart(2, '0')}-01`,
        to: `${y}-${String(q * 3 + 3).padStart(2, '0')}-31` });
    }
  }
  return out.filter(p => p.ce >= FROM_YEAR);
}

// ── six angles, deliberately disjoint ───────────────────────────────────────
const COMMON_FORMAT = `
ตอบเป็นบล็อกละข่าว คั่นด้วย --- รูปแบบนี้เท่านั้น:
HEADLINE: [พาดหัวข่าวจริง]
DATE: [YYYY-MM-DD ถ้าไม่แน่ใจวันให้ใส่ YYYY-MM]
SOURCE: [ชื่อสำนักข่าว]
CATEGORY: [เลือกจากรายการที่ระบุด้านบน]
IMPACT_LEVEL: [HIGH | MEDIUM | LOW]
---
ห้ามแต่งข่าวขึ้นเอง เอาเฉพาะข่าวที่ค้นเจอจริงเท่านั้น ถ้าไม่มีข่าวในช่วงนี้ ตอบ NONE`;

const ANGLES = {
  // 1) the company itself
  company: (p) => `ค้นหาข่าวบริษัท "ร่มโพธิ์ พร็อพเพอร์ตี้" (หุ้น TITLE, ตลาด mai ก่อนย้ายเข้า SET ปี 2569) ช่วง ${p.m} ${p.be} (${p.ce})
ค้นหา: ผลประกอบการ/รายได้/กำไร, ยอดขาย-presale-โอนกรรมสิทธิ์, backlog, หุ้นกู้/ปันผล/เพิ่มทุน,
ผู้ถือหุ้นใหญ่/AssetWise เข้าถือหุ้น, การย้ายตลาด mai→SET, บทวิเคราะห์โบรกเกอร์, ผู้บริหารให้สัมภาษณ์
ระวัง: "title deed"/โฉนดที่ดิน ไม่ใช่บริษัทนี้
CATEGORY ที่ใช้ได้: COMPANY${COMMON_FORMAT}`,

  // 2) the brand's projects — different vocabulary, different sources
  brand: (p) => `ค้นหาข่าวโครงการอสังหาฯ แบรนด์ "THE TITLE" ในภูเก็ต ช่วง ${p.m} ${p.be} (${p.ce})
(เช่น The Title Serenity, Heritage, Legendary, Halo, V, Naiyang, Bangtao, Rawai, Kamala, Nai Harn, พูลวิลล่า, บีชคลับ)
ค้นหา: เปิดตัวโครงการใหม่, งานขาย/โรดโชว์, ก่อสร้างแล้วเสร็จ/โอน, ร่วมทุนโรงแรม (IHG, Hotel Indigo),
รางวัลอสังหาฯ, ราคาขาย/ยอดจอง
CATEGORY ที่ใช้ได้: COMPANY${COMMON_FORMAT}`,

  // 3) the Phuket market TITLE competes in
  phuket: (p) => `ค้นหาข่าวตลาดอสังหาริมทรัพย์ภูเก็ต ช่วง ${p.m} ${p.be} (${p.ce})
ค้นหา: ยอดโอนคอนโด-วิลล่าภูเก็ต, สัดส่วนผู้ซื้อต่างชาติ (รัสเซีย จีน ยุโรป), supply โครงการใหม่,
ราคาที่ดิน/ราคาขายเฉลี่ย, ดีเวลลอปเปอร์รายอื่นในภูเก็ต, รายงาน REIC/Colliers/Knight Frank เรื่องภูเก็ต
CATEGORY ที่ใช้ได้: INDUSTRY | COMPETITOR${COMMON_FORMAT}`,

  // 4) travel access — the demand pipe
  tourism: (p) => `ค้นหาข่าวการท่องเที่ยวภูเก็ตและการเดินทางเข้าไทย ช่วง ${p.m} ${p.be} (${p.ce})
ค้นหา: จำนวนนักท่องเที่ยวภูเก็ต, เที่ยวบินตรงเข้าภูเก็ต (โดยเฉพาะจากรัสเซีย จีน ตะวันออกกลาง),
นโยบายวีซ่า/วีซ่าฟรี, Phuket Sandbox, การเปิด-ปิดประเทศ, สนามบินภูเก็ต, ฤดูกาลท่องเที่ยว
CATEGORY ที่ใช้ได้: TOURISM${COMMON_FORMAT}`,

  // 5) the buyers' home-front economics
  money: (p) => `ค้นหาเหตุการณ์ที่กระทบ "กำลังซื้อของชาวต่างชาติที่ซื้ออสังหาฯ ในภูเก็ต" ช่วง ${p.m} ${p.be} (${p.ce})
(ผู้ซื้อหลักคือรัสเซีย รองมาคือจีน) ค้นหา:
- สงครามรัสเซีย-ยูเครน, มาตรการคว่ำบาตร, การเจรจาสันติภาพ → GEOPOLITICS
- ราคาน้ำมันดิบเคลื่อนไหวแรง, คว่ำบาตรน้ำมันรัสเซีย → OIL
- ค่าเงินบาท/รูเบิล/หยวน, การโอนเงินระหว่างประเทศ, SWIFT, เศรษฐกิจรัสเซีย-จีน → FX
CATEGORY ที่ใช้ได้: GEOPOLITICS | OIL | FX${COMMON_FORMAT}`,

  // 6) the rules that gate foreign ownership
  policy: (p) => `ค้นหาข่าวกฎหมาย/นโยบายรัฐไทยที่กระทบการถือครองอสังหาฯ ของชาวต่างชาติ ช่วง ${p.m} ${p.be} (${p.ce})
ค้นหา: โควตาต่างชาติ 49% ในคอนโด, การถือครองที่ดิน, นอมินี/บริษัทตัวแทน, สัญญาเช่าระยะยาว leasehold 30+30+30,
คำพิพากษาศาลฎีกาเรื่องเช่าที่ดิน, มาตรการลดค่าโอน-จดจำนอง, LTV, วีซ่า LTR/Elite สำหรับผู้ซื้ออสังหาฯ
CATEGORY ที่ใช้ได้: GOV_POLICY | RATES${COMMON_FORMAT}`,
};

async function gemini(prompt) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
    tools: [{ google_search: {} }],
  };
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(`${ENDPOINT}?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
      });
      if (r.status === 429) {                       // free-tier rate limit — back off hard
        const wait = 15_000 * attempt;
        process.stdout.write(`[429 wait ${wait / 1000}s]`);
        await sleep(wait);
        continue;
      }
      if (!r.ok) {
        if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
        return { text: '', chunks: [], err: `HTTP ${r.status}` };
      }
      const j = await r.json();
      const cand = j.candidates?.[0];
      return {
        text: (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('\n'),
        chunks: (cand?.groundingMetadata?.groundingChunks || []).map(c => c.web).filter(Boolean),
      };
    } catch (e) {
      if (attempt === 4) return { text: '', chunks: [], err: e.message };
      await sleep(3000 * attempt);
    }
  }
  return { text: '', chunks: [], err: 'exhausted' };
}

const ALLOWED = new Set(categoriesForStock('TITLE'));

function parseItems(text, period) {
  if (!text || text.trim() === 'NONE') return [];
  return text.split(/---|\n(?=HEADLINE)/).filter(b => b.includes('HEADLINE')).map(block => {
    const get = k => (block.match(new RegExp(k + ':\\s*(.+)')) || [])[1]?.trim();
    const h = (get('HEADLINE') || '').replace(/^["“]|["”]$/g, '').trim();
    if (!h || h === 'NONE' || /^\[/.test(h) || h.length < 8) return null;
    let d = (get('DATE') || '').replace(/[[\]]/g, '').trim();
    if (/^\d{4}-\d{2}$/.test(d)) d += '-15';                  // month-only → mid-month
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;          // a pin needs a real date
    // Keep the item near its period — the model drifts on vague quarters.
    if (d < `${period.ce - 1}-10-01` || d > `${period.ce + 1}-03-31`) return null;
    if (d > new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10)) return null;  // no future
    const cat = (get('CATEGORY') || '').toUpperCase().replace(/[[\]]/g, '').split(/[|,/]/)[0].trim();
    const imp = (get('IMPACT_LEVEL') || 'MEDIUM').toUpperCase().replace(/[[\]]/g, '').trim();
    return {
      headline: h, date: d,
      source: (get('SOURCE') || 'ไม่ระบุ').replace(/[[\]]/g, '').trim(),
      category: ALLOWED.has(cat) ? cat : null,
      impact: ['HIGH', 'MEDIUM', 'LOW'].includes(imp) ? imp : 'MEDIUM',
    };
  }).filter(Boolean);
}

async function resolveUrl(uri) {
  if (!uri) return '';
  try {
    const r = await fetch(uri, { redirect: 'follow', signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } });
    if (r.url && !r.url.includes('vertexaisearch')) return r.url;
  } catch {}
  return '';
}

// ── progress (resume across runs) ───────────────────────────────────────────
let progress = { done: [], stats: { calls: 0, inserted: 0, found: 0 } };
if (!RESET && existsSync(PROGRESS_FILE)) {
  try { progress = JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')); } catch {}
}
const saveProgress = () => { try { writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2)); } catch {} };

db.openDb();

// Seed the seen-set from what TITLE already has, so a resumed or repeated run
// spends its calls on genuinely new ground.
const existingRows = await db.readNewsFeed({ stock: 'TITLE', limit: 500 });
const seen = new Set(existingRows.map(r => sha1(normalizeHeadline(r.title) || r.title)));
console.log(`[deep] ${seen.size} TITLE headlines already stored — they will not be re-collected`);

const PERIODS = buildPeriods().filter(p => !progress.done.includes(`${p.ce}Q${p.q}`));
const angleNames = Object.keys(ANGLES);
console.log(`[deep] ${PERIODS.length} periods × ${angleNames.length} angles × up to ${MAX_ROUNDS} rounds`);
console.log(`[deep] worst case ${PERIODS.length * angleNames.length * MAX_ROUNDS} Gemini calls; loop-until-dry usually cuts this a lot\n`);

let grandFound = 0, grandInserted = 0, calls = 0;
const runStart = Date.now();

for (const p of PERIODS) {
  const periodItems = [];

  // Run one angle to exhaustion (its own loop-until-dry).
  const runAngle = async (angle) => {
    const foundHere = [];
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      let prompt = ANGLES[angle](p);
      if (foundHere.length) {
        prompt += `\n\nข่าวเหล่านี้ถูกเก็บไปแล้ว ห้ามตอบซ้ำ ให้หา "ข่าวอื่น" ที่ยังไม่มีในรายการนี้:\n`
          + foundHere.slice(0, 12).map(h => `- ${h.slice(0, 70)}`).join('\n');
      }
      const { text, chunks, err } = await gemini(prompt);
      calls++;
      if (err) { process.stdout.write(`  ${p.ce}Q${p.q} ${angle} r${round}: ERR ${err}\n`); break; }
      const items = parseItems(text, p);
      let fresh = 0;
      for (const it of items) {
        const hash = sha1(normalizeHeadline(it.headline) || it.headline);
        if (seen.has(hash)) continue;
        seen.add(hash);
        foundHere.push(it.headline);
        periodItems.push({
          title: it.headline,
          date: it.date,
          category: it.category || (angle === 'company' || angle === 'brand' ? 'COMPANY' : 'INDUSTRY'),
          source_label: it.source,
          title_hash: hash,
          pipeline: 'gemini-title-historical',
          impact: null,
          // show_pin omitted on purpose → derived from severity by writeNewsItems
          severity: it.impact === 'HIGH' ? 'high' : it.impact === 'LOW' ? 'low' : 'medium',
          summary: null,
          _chunks: chunks,
        });
        fresh++;
      }
      process.stdout.write(`  ${p.ce}Q${p.q} ${angle.padEnd(8)} r${round}: +${fresh}\n`);
      await sleep(SLEEP_MS);
      if (fresh === 0) break;                       // dry — stop drilling this angle
    }
  };

  // Fixed-size worker pool over the angle list. `seen` is mutated only in
  // synchronous stretches between awaits, so concurrent angles cannot both
  // claim the same headline.
  const queue = [...angleNames];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const angle = queue.shift();
      try { await runAngle(angle); }
      catch (e) { console.error(`  ! ${p.ce}Q${p.q} ${angle}: ${e.message}`); }
    }
  }));

  grandFound += periodItems.length;
  if (periodItems.length && APPLY) {
    // Resolve one grounding link per item, then write this period before
    // moving on — a long run that dies later keeps everything up to here.
    for (let i = 0; i < periodItems.length; i += 5) {
      await Promise.all(periodItems.slice(i, i + 5).map(async (it) => {
        it.source_url = await resolveUrl((it._chunks || [])[0]?.uri);
        delete it._chunks;
      }));
    }
    try {
      const { inserted, deduped } = await db.writeNewsItems('TITLE', periodItems);
      grandInserted += inserted;
      console.log(`  → ${p.ce}Q${p.q}: found ${periodItems.length}, inserted ${inserted}, deduped ${deduped}`);
    } catch (e) {
      console.error(`  ! ${p.ce}Q${p.q} write failed: ${e.message}`);
    }
  } else if (periodItems.length) {
    console.log(`  → ${p.ce}Q${p.q}: found ${periodItems.length} (dry-run, not written)`);
  }

  progress.done.push(`${p.ce}Q${p.q}`);
  progress.stats = { calls: (progress.stats.calls || 0) + calls, inserted: (progress.stats.inserted || 0) + grandInserted, found: grandFound };
  if (APPLY) saveProgress();
  if (!APPLY && progress.done.length >= 1) {
    console.log('\n[deep] DRY RUN stops after one period. Pass --apply for the full sweep.');
    break;
  }
}

const mins = ((Date.now() - runStart) / 60000).toFixed(1);
console.log(`\n[deep] done in ${mins} min — ${calls} Gemini calls, ${grandFound} new headlines found, ${grandInserted} inserted`);
if (APPLY) {
  const after = await db.readNewsStatus('TITLE');
  console.log(`[deep] TITLE now: ${after.counts.total} news rows, ${after.counts.high} high-severity (= chart pins)`);
}
await db.closeDb();
