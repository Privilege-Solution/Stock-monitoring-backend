// =============================================================================
// Gemini 2.5 Flash + Google Search grounding — single fetcher for all 4
// pipelines: company / sector / macro / morning-brief.
//
// Replaces the old ai-remarks.mjs + set-news.mjs + thai-sec.mjs + bot-rss.mjs +
// google-news.mjs + news-feed.mjs + remark-classifier.mjs. No HTML scrape,
// no RSS — every line of text comes from Gemini with `tools: [{ google_search:
// {} }]` so the URL + SOURCE come from real news articles, not the model's
// memory.
//
// Run shape (dispatched by runFetch in lib/fetchers/index.js):
//   source: 'gemini-company'       → updates daily.remark (1 pin/day)
//   source: 'gemini-sector'        → inserts 0–3 rows to news_feed
//   source: 'gemini-macro'         → inserts 0–2 rows; severity=high → also pin
//   source: 'gemini-morning-brief' → updates daily.morning_brief (Monday only)
//
// Prompts come from the user-authored spec at `/Users/minjai/.claude/plans/
// pipeline-a-cozy-lynx.md`. Categories follow the 13-value mapping table.
// =============================================================================

import { createHash } from 'crypto';
import db from '../../db.js';

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

// Thai long-form date so Gemini can disambiguate "วันนี้" — eg. "2 กรกฎาคม
// พ.ศ. 2569". toLocaleDateString returns Buddhist Era by default in th-TH.
const todayThai = () =>
  new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });

// =============================================================================
// PROMPTS (verbatim from user spec — keep formatting literal)
// =============================================================================

const PROMPT_COMPANY = (today) => `คุณเป็น analyst หุ้นไทย ค้นหาข่าวของ "Assetwise" หรือ "ASW" หรือ "แอสเซทไวส์"
ที่เกิดขึ้นใน${today}

ค้นหาเฉพาะข่าวที่เกี่ยวกับ:
- งบการเงิน / ผลประกอบการ / Presale
- การเปิดโครงการใหม่ / JV / M&A
- ปันผล / หุ้นกู้ / Warrant / เพิ่มทุน
- แถลงข่าว / Oppday / Roadshow
- ผู้บริหารซื้อขายหุ้น (insider)

ถ้าไม่มีข่าว ASW วันนี้ ตอบว่า NONE

ถ้ามีข่าว ตอบในรูปแบบนี้เท่านั้น (ไม่ต้องมีคำอธิบายเพิ่ม):
CATEGORY: [corporate | project | dividend | fundraise | insider]
HEADLINE: [หัวข้อข่าวภาษาไทย ไม่เกิน 60 ตัวอักษร]
SUMMARY: [ขยายความ 1-2 ประโยคภาษาไทย อธิบายว่าเกิดอะไรขึ้น กระทบอย่างไร ไม่เกิน 200 ตัวอักษร]
SOURCE: [ชื่อแหล่งข่าว]
URL: [url จริงเท่านั้น ห้ามว่าง ถ้าหา source ไม่ได้ใส่ NONE]

ตัวอย่างผลลัพธ์ที่ถูกต้อง:
CATEGORY: corporate
HEADLINE: ASW รายงาน Presale 9 เดือน 79% ของเป้าหมายปี
SUMMARY: ยอด Presale 9 เดือนแตะ 1.6 หมื่นล้านบาท ใกล้เป้าทั้งปี 2 หมื่นล้าน แนวโน้ม Q4 เร่งเปิดโครงการใหม่หนุนรายได้
SOURCE: SET
URL: https://...`;

const PROMPT_SECTOR = (today) => `คุณเป็น analyst หุ้นอสังหาริมทรัพย์ไทย ค้นหาข่าวอสังหาฯ ไทย
ที่เกิดขึ้นใน${today}

ค้นหาข่าวที่เกี่ยวกับหัวข้อเหล่านี้:
- ยอดโอนกรรมสิทธิ์ / ยอด Presale ของกลุ่มอสังหาฯ
- นโยบายรัฐที่กระทบอสังหาฯ เช่น มาตรการ LTV / ลดค่าธรรมเนียม
- ข่าว developer รายอื่น: LH, SPALI, AP, SIRI, NOBLE, ORI
- ดัชนี REIC / ความเชื่อมั่นผู้บริโภค
- Supply/Demand คอนโด / บ้านแนวราบ กรุงเทพ

ถ้าไม่มีข่าว sector วันนี้ ตอบว่า NONE

ถ้ามี ตอบได้สูงสุด 3 ข่าว รูปแบบนี้:
---
CATEGORY: [sector_policy | sector_data | peer_news]
HEADLINE: [หัวข้อข่าวภาษาไทย ไม่เกิน 60 ตัวอักษร]
SUMMARY: [ขยายความ 1-2 ประโยคภาษาไทย ไม่เกิน 200 ตัวอักษร]
IMPACT: [positive | negative | neutral]
SOURCE: [ชื่อแหล่งข่าว]
URL: [url จริงเท่านั้น ห้ามว่าง ถ้าหา source ไม่ได้ใส่ NONE]
---

ตัวอย่างผลลัพธ์ที่ถูกต้อง:
---
CATEGORY: sector_policy
HEADLINE: ธนาคารแห่งประเทศไทยผ่อนคลายเกณฑ์ LTV สำหรับบ้านหลังที่ 2
SUMMARY: กนง. ปรับลดเกณฑ์สินเชื่อบ้านหลังที่ 2 เหลือ LTV 90% มีผล 1 ส.ค. คาดกระตุ้นดีมานด์กลุ่มรายได้สูง
IMPACT: positive
SOURCE: กรุงเทพธุรกิจ
URL: https://...
---`;

const PROMPT_MACRO = (today) => `คุณเป็น analyst เศรษฐกิจไทย ค้นหาข่าวสำคัญ
ที่เกิดขึ้นใน${today}

ค้นหาเฉพาะเหตุการณ์ที่อาจกระทบตลาดหุ้นไทย ได้แก่:
- การประชุม กนง. / ประกาศอัตราดอกเบี้ยนโยบาย
- ตัวเลขเศรษฐกิจสำคัญ: GDP, เงินเฟ้อ, การส่งออก, นักท่องเที่ยว
- ความเคลื่อนไหวทางการเมืองที่กระทบเสถียรภาพ
- ภัยพิบัติ / เหตุการณ์พิเศษที่กระทบความเชื่อมั่น
- Fed / ธนาคารกลางโลก ที่กระทบค่าเงินบาทหรือ Fund flow

ถ้าไม่มีข่าวมหภาคสำคัญวันนี้ ตอบว่า NONE

ถ้ามี ตอบได้สูงสุด 2 ข่าว เฉพาะที่สำคัญจริง ๆ รูปแบบนี้:
---
CATEGORY: [interest_rate | economic_data | political | disaster | global]
HEADLINE: [หัวข้อข่าวภาษาไทย ไม่เกิน 60 ตัวอักษร]
SUMMARY: [ขยายความ 1-2 ประโยคภาษาไทย ไม่เกิน 200 ตัวอักษร]
IMPACT: [positive | negative | neutral]
SEVERITY: [high | medium | low]
SOURCE: [ชื่อแหล่งข่าว]
URL: [url จริงเท่านั้น ห้ามว่าง ถ้าหา source ไม่ได้ใส่ NONE]
---

ข่าว SEVERITY: high เท่านั้นที่แสดงเป็น event pin บนกราฟราคา
ข่าว medium/low แสดงใน news feed เท่านั้น`;

const PROMPT_BRIEF = () => `คุณเป็น analyst หุ้นอสังหาฯ ไทย สรุปสถานการณ์ให้ผู้บริหาร

สัปดาห์ที่ผ่านมา (จันทร์-ศุกร์ก่อนหน้า) มีเหตุการณ์อะไรบ้างที่กระทบ
หุ้นกลุ่มอสังหาริมทรัพย์ไทยหรือหุ้น ASW โดยเฉพาะ?

และสัปดาห์นี้มีปัจจัยอะไรที่ต้องติดตาม?

ตอบในรูปแบบนี้เท่านั้น:

LAST_WEEK:
- [bullet สั้น ๆ ภาษาไทย ไม่เกิน 3 ข้อ]

THIS_WEEK_WATCH:
- [สิ่งที่ต้องติดตาม ไม่เกิน 3 ข้อ เช่น ประชุม กนง. / งบบริษัท / ตัวเลขเศรษฐกิจ]

TONE: [bullish | bearish | neutral]
REASON: [1 ประโยคอธิบาย tone]`;

// =============================================================================
// PARSER (verbatim from user spec)
// =============================================================================

function parseAIResult(text, pipeline) {
  if (!text || text.trim() === 'NONE') return [];
  const blocks = text.split('---').filter(b => b.trim());
  return blocks.map(block => {
    const get = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(.+)`));
      return m ? m[1].trim() : null;
    };
    return {
      date: new Date().toISOString().slice(0, 10),
      pipeline,
      category:  get('CATEGORY'),
      headline:  get('HEADLINE'),
      summary:   get('SUMMARY') || null,
      impact:    get('IMPACT') || 'neutral',
      severity:  get('SEVERITY') || 'medium',
      source:    get('SOURCE'),
      url:       get('URL'),
      show_pin:  pipeline === 'company' ||
                 (pipeline === 'macro' && get('SEVERITY') === 'high'),
    };
  }).filter(r => {
    // Drop blocks missing any required field. URL is required because the
    // client-side valid-link filter in index.html drops items with empty
    // source_url — better to not insert at all than to insert a row the UI
    // will hide. Gemini's `url` is `null` if the URL: line was truncated or
    // omitted; we also treat the literal "NONE" sentinel as missing.
    if (!r.category || !r.headline) return false;
    if (!r.url || r.url.trim().toUpperCase() === 'NONE') return false;
    return true;
  });
}

// =============================================================================
// GEMINI HTTP CALL
// =============================================================================

// One POST per pipeline. The body shape is the v1beta `generateContent`
// format with `tools: [{ google_search: {} }]` enabling grounding. If Gemini
// ever returns 429 we surface the error to the caller — the scheduler wraps
// each invocation in logFetchFinish so retry logic lives at that layer.
async function geminiSearch(prompt) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  };
  const res = await fetch(`${ENDPOINT}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// =============================================================================
// HELPERS
// =============================================================================

// Map a parser-output row to db.writeNewsItems shape. The 4 new v3 columns
// (pipeline/impact/severity/show_pin) come from the parser directly. Hash is
// sha1(headline|source|url) — matches the unique index in migrate-v2/v3 so
// re-running the same Gemini call dedupes naturally.
function normalizeForNewsFeed(it) {
  // Gemini may return "NONE" (string) when it can't find a source URL.
  // Coerce both null/undefined AND the literal "NONE" sentinel to '' so the
  // client-side valid-link filter drops them, and so we don't store a bogus
  // "NONE" string in the DB.
  const rawUrl = (it.url && it.url.trim() && it.url.trim().toUpperCase() !== 'NONE')
    ? it.url.trim()
    : '';
  return {
    title:        it.headline,
    date:         it.date,
    category:     it.category,
    source_url:   rawUrl,
    source_label: it.source || 'Gemini',
    title_hash:   sha1(`${it.headline}|${it.source || ''}|${rawUrl}`),
    pipeline:     it.pipeline,
    impact:       it.impact,
    severity:     it.severity,
    show_pin:     it.show_pin,
    summary:      it.summary || null,
  };
}

// Extract a multi-line section from the morning brief (LAST_WEEK: /
// THIS_WEEK_WATCH:). The spec puts each section's value on multiple lines,
// indented with "- " bullets — we preserve them as a single newline-separated
// string for db storage, frontend splits them back into <li>.
function extractSection(text, key) {
  const re = new RegExp(`${key}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`);
  const m = text.match(re);
  if (!m) return '';
  return m[1].trim();
}

// =============================================================================
// 4 RUN FUNCTIONS
// =============================================================================

// (1) COMPANY — 1 pin per day, stored in daily.remark. All headlines also
// land in news_feed so the dashboard news sidebar can link to sources.
async function runCompany(sinceDate) {
  const td = todayThai();
  const text = await geminiSearch(PROMPT_COMPANY(td));
  const items = parseAIResult(text, 'company');
  if (!items.length) {
    console.log(`[gemini-company] ${td} → no items`);
    return { ok: true, date: td, category: null, text: null, sourceTitles: [] };
  }

  const top = items[0];
  await db.updateSingleRemark(td, {
    category: top.category,
    text: top.headline,
  });
  const { inserted } = await db.writeNewsItems(items.map(normalizeForNewsFeed));

  return {
    ok: true,
    date: td,
    category: top.category,
    text: top.headline,
    sourceTitles: items.map(it => it.source ? `${it.source}: ${it.headline}` : it.headline),
    inserted,
  };
}

// (2) SECTOR — news feed only. No chart pin (sector doesn't move ASW price
// on its own).
async function runSector(sinceDate) {
  const td = todayThai();
  const text = await geminiSearch(PROMPT_SECTOR(td));
  const items = parseAIResult(text, 'sector');
  const { inserted } = await db.writeNewsItems(items.map(normalizeForNewsFeed));
  console.log(`[gemini-sector] ${td} → fetched=${items.length} inserted=${inserted}`);
  return { ok: true, fetched: items.length, inserted };
}

// (3) MACRO — news feed for all items. severity=high items ALSO append to
// daily.remark so they show up as event pins (macro that moves the market).
async function runMacro(sinceDate) {
  const td = todayThai();
  const text = await geminiSearch(PROMPT_MACRO(td));
  const items = parseAIResult(text, 'macro');
  const { inserted } = await db.writeNewsItems(items.map(normalizeForNewsFeed));

  // The first severity=high item gets appended as a pin. We use
  // appendRemarkPin so the company pin from runCompany (above) is preserved.
  const topHigh = items.find(it => it.severity === 'high');
  if (topHigh) {
    await db.appendRemarkPin(td, `[${topHigh.category}] ${topHigh.headline}`, topHigh.category);
  }
  const highCount = items.filter(i => i.severity === 'high').length;
  console.log(`[gemini-macro] ${td} → fetched=${items.length} inserted=${inserted} high=${highCount}`);
  return { ok: true, fetched: items.length, inserted, high: highCount };
}

// (4) MORNING BRIEF — Monday-only weekly summary, lands in daily.{morning_*}.
async function runMorningBrief(sinceDate) {
  const text = await geminiSearch(PROMPT_BRIEF());
  if (!text || text.trim() === 'NONE') {
    console.log('[gemini-morning-brief] no content');
    return { ok: false, reason: 'empty' };
  }

  const lastWeek = extractSection(text, 'LAST_WEEK');
  const thisWeek = extractSection(text, 'THIS_WEEK_WATCH');
  const toneMatch = text.match(/TONE:\s*(.+)/);
  const reasonMatch = text.match(/REASON:\s*(.+)/);
  const tone = toneMatch ? toneMatch[1].trim() : 'neutral';
  const reason = reasonMatch ? reasonMatch[1].trim() : '';

  const date = new Date().toISOString().slice(0, 10);
  await db.updateMorningBrief(date, { lastWeek, thisWeek, tone, reason });
  console.log(`[gemini-morning-brief] ${date} tone=${tone} reason="${reason}"`);
  return { ok: true, date, tone, lastWeek, thisWeek, reason };
}

// =============================================================================
// DISPATCHER
// =============================================================================

async function run({ source, sinceDate } = {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set in environment');
  }
  switch (source) {
    case 'gemini-company':       return runCompany(sinceDate);
    case 'gemini-sector':        return runSector(sinceDate);
    case 'gemini-macro':         return runMacro(sinceDate);
    case 'gemini-morning-brief': return runMorningBrief(sinceDate);
    default:
      throw new Error(`gemini-search: unknown source "${source}"`);
  }
}

export { run, parseAIResult, geminiSearch, normalizeForNewsFeed };
export default { run };