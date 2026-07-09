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

// ISO date key (YYYY-MM-DD) for `daily.date` writes. MUST be used for any DB
// key — todayThai() returns a Buddhist-era display string ("2 กรกฎาคม 2569")
// that never matches a stored 'YYYY-MM-DD' primary key, so pin UPDATEs would
// silently touch 0 rows. Uses ICT (+7) so the day rolls at Thai midnight, not
// UTC midnight (matches the daily price row's date).
const todayISO = () =>
  new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// =============================================================================
// PROMPTS (verbatim from user spec — keep formatting literal)
// =============================================================================
//
// Taxonomy v2 (migrate-v9): the legacy 13-value vocabulary was collapsed
// into 6 user-facing categories + impact_level. Prompts now ask Gemini to
// emit one of {COMPANY, RATES, GOV_POLICY, POLITICS, INDUSTRY, MACRO} and a
// separate {HIGH, MEDIUM, LOW} impact magnitude. Disambiguation rules in
// the prompt mirror the user spec — ASW-name always wins, then narrowest
// specific category. The old `corporate | project | dividend | fundraise |
// insider | sector_policy | sector_data | peer_news | interest_rate |
// economic_data | political | disaster | global` vocabulary is retired.
// =============================================================================

const CATEGORY_OPTIONS = 'COMPANY | RATES | GOV_POLICY | POLITICS | INDUSTRY | MACRO';

const PROMPT_COMPANY = (today) => `คุณเป็น analyst หุ้นไทย ค้นหาข่าวของ "Assetwise" หรือ "ASW" หรือ "แอสเซทไวส์"
ที่เกิดขึ้นใน${today}

ค้นหาเฉพาะข่าวที่เกี่ยวกับ:
- งบการเงิน / ผลประกอบการ / Presale / โอนกรรมสิทธิ์
- การเปิดโครงการใหม่ / JV / M&A
- ปันผล / หุ้นกู้ / Warrant / เพิ่มทุน
- แถลงข่าว / Oppday / Roadshow
- ผู้บริหารซื้อขายหุ้น (insider / Form 59)
- SET Smart Alert / cash balance alert

ถ้าไม่มีข่าว ASW วันนี้ ตอบว่า NONE

ถ้ามีข่าว ตอบในรูปแบบนี้เท่านั้น (ไม่ต้องมีคำอธิบายเพิ่ม):
CATEGORY: [COMPANY]
HEADLINE: [หัวข้อข่าวภาษาไทย ไม่เกิน 60 ตัวอักษร]
SUMMARY: [ขยายความ 1-2 ประโยคภาษาไทย อธิบายว่าเกิดอะไรขึ้น กระทบอย่างไร ไม่เกิน 200 ตัวอักษร]
IMPACT_LEVEL: [HIGH | MEDIUM | LOW]
SOURCE: [ชื่อแหล่งข่าว]
URL: [url จริงเท่านั้น ห้ามว่าง ถ้าหา source ไม่ได้ใส่ NONE]

หมายเหตุเรื่อง CATEGORY: ข่าวที่กล่าวถึง ASW / AssetWise / แอสเซทไวส์ โดยตรง ถือเป็น COMPANY เสมอ
แม้หัวข้อจะเป็นเรื่องดอกเบี้ยหรือนโยบายรัฐก็ตาม (กฎข้อนี้สำคัญที่สุด)

หมายเหตุเรื่อง IMPACT_LEVEL:
- HIGH   = กระทบพื้นฐาน/กระแสเงินสด/มูลค่าบริษัท ASW โดยตรงและทันที เช่น งบประกอบการ ASW,
            ปันผล, เพิ่มทุน, หุ้นกู้ดีฟอลต์, ผู้บริหารขายหุ้นจำนวนมาก
- MEDIUM = เกี่ยวข้องทางอ้อม เช่น โครงการใหม่, presale milestone, JV ยังไม่ปิด,
            มาตรการรัฐที่อาจส่งผลดีในอีก 1-2 ไตรมาส
- LOW    = ข่าวบรรยากาศ / ภาพรวม / บริษัทจัดงาน / ประชุมนักลงทุนทั่วไป ไม่ขยับพื้นฐาน

ตัวอย่างผลลัพธ์ที่ถูกต้อง:
CATEGORY: COMPANY
HEADLINE: ASW รายงาน Presale 9 เดือน 79% ของเป้าหมายปี
SUMMARY: ยอด Presale 9 เดือนแตะ 1.6 หมื่นล้านบาท ใกล้เป้าทั้งปี 2 หมื่นล้าน แนวโน้ม Q4 เร่งเปิดโครงการใหม่หนุนรายได้
IMPACT_LEVEL: HIGH
SOURCE: SET
URL: https://...`;

const PROMPT_SECTOR = (today) => `คุณเป็น analyst หุ้นอสังหาริมทรัพย์ไทย ค้นหาข่าวอสังหาฯ ไทย
ที่เกิดขึ้นใน${today}

ค้นหาข่าวที่เกี่ยวกับหัวข้อเหล่านี้:
- ยอดโอนกรรมสิทธิ์ / ยอด Presale ของกลุ่มอสังหาฯ
- นโยบายรัฐที่กระทบอสังหาฯ เช่น มาตรการ LTV / ลดค่าธรรมเนียมโอน-จดจำนอง
- ข่าว developer รายอื่น: LH, SPALI, AP, SIRI, NOBLE, ORI
- ดัชนี REIC / ความเชื่อมั่นผู้บริโษก
- Supply/Demand คอนโด / บ้านแนวราบ กรุงเทพ

ถ้าไม่มีข่าว sector วันนี้ ตอบว่า NONE

ถ้ามี ตอบได้สูงสุด 3 ข่าว รูปแบบนี้:
---
CATEGORY: [${CATEGORY_OPTIONS}]
HEADLINE: [หัวข้อข่าวภาษาไทย ไม่เกิน 60 ตัวอักษร]
SUMMARY: [ขยายความ 1-2 ประโยคภาษาไทย ไม่เกิน 200 ตัวอักษร]
IMPACT_LEVEL: [HIGH | MEDIUM | LOW]
SOURCE: [ชื่อแหล่งข่าว]
URL: [url จริงเท่านั้น ห้ามว่าง ถ้าหา source ไม่ได้ใส่ NONE]
---

คำจำกัดความ CATEGORY (เลือกให้ตรงกับ "ใจความหลัก" ของข่าว):
- COMPANY    : ข่าวที่กล่าวถึง ASW / AssetWise / แอสเซทไวส์ โดยตรง (ไม่ว่าหัวข้อจะเป็นอะไร)
- RATES      : มติ กนง., ประกาศอัตราดอกเบี้ยนโยบาย, การประชุม กนง. — หัวข้อหลักคือ "ดอกเบี้ย" เอง
- GOV_POLICY : มาตรการรัฐที่ "เจาะจงอสังหาฯ" — LTV, ลดค่าโอน-จดจำนอง, กฎต่างด้าวถือครองคอนโด, กระตุ้นที่อยู่อาศัย
- POLITICS   : ข่าวการเมืองทั่วไปที่อาจกระทบเศรษฐกิจ/นโยบาย (ไม่ใช่มาตรการที่อยู่อาศัย)
- INDUSTRY   : แนวโน้มตลาดอสังหาฯ, คู่แข่งเปิดโครงการ, สมาคมอสังหาฯ, supply/demand — ไม่ใช่ข่าว ASW โดยตรง และไม่ใช่นโยบายรัฐ
- MACRO      : ตัวเลองเศรษฐกิจมหภาคทั่วไป GDP/CPI/FX/การค้า — ไม่เกี่ยวอสังหาฯ โดยตรง

กฎการเลือก CATEGORY (สำคัญ):
1. ถ้าหัวข้อกล่าวถึง ASW / AssetWise / แอสเซทไวส์ → COMPANY เสมอ (แม้เนื้อหาจะเป็นเรื่องดอกเบี้ยหรือนโยบายรัฐ)
2. ถ้าเป็นมาตรการรัฐที่ "เจาะจงอสังหาฯ" → GOV_POLICY (ไม่ใช่ POLITICS)
3. ถ้าเป็นข่าว กนง./ดอกเบี้ยนโยบาย → RATES (ไม่ใช่ MACRO)
4. ถ้าข่าวเกี่ยวกับอสังหาฯ แต่ไม่ใช่นโยบายรัฐ และไม่ใช่ ASW → INDUSTRY
5. ข่าวอื่น ๆ ที่เหลือ → MACRO

IMPACT_LEVEL:
- HIGH   = กระทบ ASW/อุตสาหกรรมโดยตรงและทันที (เช่น LTV เปลี่ยน, ลดค่าโอน 0.01%, developer รายใหญ่ดีฟอลต์)
- MEDIUM = เกี่ยวข้องทางอ้อม (เช่น developer รายอื่นเปิดโครงการ, REIC ปรับขึ้น)
- LOW    = ภาพรวมตลาด / บทวิเคราะห์ / ข่าวประชาสัมพันธ์

ตัวอย่างผลลัพธ์ที่ถูกต้อง:
---
CATEGORY: GOV_POLICY
HEADLINE: ครม. ขยายลดค่าโอน-จดจำนองเหลือ 0.01% ถึงกลางปี 70
SUMMARY: มติ ครม. ต่ออายุมาตรการกระตุ้นอสังหาฯ ลดค่าธรรมเนียมโอนและจดจำนองเหลือ 0.01% สำหรับบ้านไม่เกิน 7 ล้านบาท คาดกระตุ้นดีมานด์กลุ่มรายได้กลาง-ล่าง
IMPACT_LEVEL: HIGH
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
CATEGORY: [${CATEGORY_OPTIONS}]
HEADLINE: [หัวข้อข่าวภาษาไทย ไม่เกิน 60 ตัวอักษร]
SUMMARY: [ขยายความ 1-2 ประโยคภาษาไทย ไม่เกิน 200 ตัวอักษร]
IMPACT_LEVEL: [HIGH | MEDIUM | LOW]
SOURCE: [ชื่อแหล่งข่าว]
URL: [url จริงเท่านั้น ห้ามว่าง ถ้าหา source ไม่ได้ใส่ NONE]
---

คำจำกัดความ CATEGORY (เลือกให้ตรงกับ "ใจความหลัก" ของข่าว):
- RATES      : มติ กนง., ประกาศอัตราดอกเบี้ยนโยบาย, การประชุม กนง.
- GOV_POLICY : มาตรการรัฐที่ "เจาะจงอสังหาฯ" (LTV, ลดค่าโอน-จดจำนอง) — ข่าวอสังหาฯที่กระทบผ่านนโยบาย
- POLITICS   : ข่าวการเมืองทั่วไป (ตั้งครม. ยุบสภา เลือกตั้ง ความขัดแย้ง)
- INDUSTRY   : แนวโน้มอสังหาฯ/ดัชนี REIC/supply-demand (ไม่ใช่มาตรการรัฐ)
- MACRO      : GDP, CPI, FX, การค้า, การท่องเที่ยว, Fed — ตัวเลขเศรษฐกิจมหภาค
- COMPANY    : (ไม่ค่อยเจอใน macro pipeline — ใช้กรณีที่ข่าวกล่าวถึง ASW โดยตรง)

กฎการเลือก CATEGORY (สำคัญ):
1. ถ้าเป็นมติ กนง./ดอกเบี้ย → RATES
2. ถ้าเป็นมาตรการที่อยู่อาศัย → GOV_POLICY
3. ถ้าเป็นข่าวการเมืองทั่วไป → POLITICS
4. ถ้าเป็นแนวโน้มอสังหาฯ/REIC → INDUSTRY
5. ตัวเลขเศรษฐกิจมหภาคอื่น ๆ → MACRO

IMPACT_LEVEL:
- HIGH   = กระทบตลาดทุนไทยทันที เช่น กนง. ลด/ขึ้นดอกเบี้ย, GDP shock, ค่าเงินร่วงหนัก
- MEDIUM = กระทบทางอ้อม เช่น Fed ส่งสัญญาณ, เงินเฟ้อเกินคาด
- LOW    = ภาพรวมทั่วไป เช่น ท่องเที่ยวฟื้นตัวต่อเนื่อง

ตัวอย่างผลลัพธ์ที่ถูกต้อง:
---
CATEGORY: RATES
HEADLINE: กนง. มีมติคงอัตราดอกเบี้ยนโยบายที่ 1.00% ต่อปี
SUMMARY: คณะกรรมการ กนง. มีมติเป็นเอกฉันท์คงอัตราดอกเบี้ยนโยบายที่ 1.00% ประเมินเศรษฐกิจไทยยังขยายตัวต่ำกว่าศักยภาพ แม้เงินเฟ้อเริ่มกลับเข้าสู่กรอบเป้าหมาย
IMPACT_LEVEL: HIGH
SOURCE: กรุงเทพธุรกิจ
URL: https://...
---`;

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
// PARSER (verbatim from user spec + migrate-v9 taxonomy)
// =============================================================================

// Whitelist for the new 6-way category vocabulary. Gemini output that falls
// outside this set is coerced to MACRO (the broad catch-all bucket) so a
// stray legacy category (corporate, sector_policy, ...) doesn't poison the
// dashboard.
const ALLOWED_CATEGORIES = new Set([
  'COMPANY', 'RATES', 'GOV_POLICY', 'POLITICS', 'INDUSTRY', 'MACRO',
]);
const ALLOWED_IMPACT_LEVELS = new Set(['HIGH', 'MEDIUM', 'LOW']);

// Map legacy sentiment IMPACT (positive/negative/neutral) onto the new
// impact_level vocabulary as a fallback for older Gemini runs that haven't
// been updated yet. positive → HIGH (good news moves valuation), negative
// → HIGH (bad news moves valuation), neutral → MEDIUM.
function severityFromImpactLevel(impactLevel) {
  return impactLevel === 'HIGH' ? 'high'
       : impactLevel === 'LOW'  ? 'low'
       : 'medium';
}

function parseAIResult(text, pipeline) {
  if (!text || text.trim() === 'NONE') return [];
  const blocks = text.split('---').filter(b => b.trim());
  return blocks.map(block => {
    const get = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(.+)`));
      return m ? m[1].trim() : null;
    };
    const rawCategory = (get('CATEGORY') || '').toUpperCase();
    const category = ALLOWED_CATEGORIES.has(rawCategory) ? rawCategory : 'MACRO';
    const rawImpactLevel = (get('IMPACT_LEVEL') || '').toUpperCase();
    const impactLevel = ALLOWED_IMPACT_LEVELS.has(rawImpactLevel) ? rawImpactLevel : 'MEDIUM';
    return {
      date: new Date().toISOString().slice(0, 10),
      pipeline,
      category,                                  // taxonomy-v2: COMPANY / RATES / GOV_POLICY / POLITICS / INDUSTRY / MACRO
      headline:  get('HEADLINE'),
      summary:   get('SUMMARY') || null,
      impact:    'neutral',                      // legacy sentiment column — superseded by impact_level
      severity:  severityFromImpactLevel(impactLevel),  // map impact_level → severity for downstream pin logic
      impact_level: impactLevel,                 // taxonomy-v2: HIGH / MEDIUM / LOW
      source:    get('SOURCE'),
      url:       get('URL'),
      show_pin:  pipeline === 'company' ||
                 (pipeline === 'macro' && impactLevel === 'HIGH'),
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
  // Bound the wait: Node's global fetch has no default timeout, so a hung
  // Gemini connection would stall the cron indefinitely on Railway. 30s is
  // generous for a grounded-search generate call.
  const res = await fetch(`${ENDPOINT}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// =============================================================================
// HELPERS
// =============================================================================

// Map a parser-output row to db.writeNewsItems shape. The 4 new v3 columns
// (pipeline/impact/severity/show_pin) come from the parser directly. The
// 14th column (impact_level — migrate-v9) is also passed through here so
// the DB row carries the new magnitude tag. Hash is sha1(headline|source|
// url) — matches the unique index in migrate-v2/v3 so re-running the same
// Gemini call dedupes naturally.
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
    impact_level: it.impact_level,            // migrate-v9 — HIGH / MEDIUM / LOW
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
  // Write the pin against the ISO date key (todayISO), NOT the Thai display
  // string — otherwise the UPDATE matches no daily row and the pin is lost.
  await db.updateSingleRemark(todayISO(), {
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
    // ISO key (see runCompany) — the Thai display string never matches daily.date.
    await db.appendRemarkPin(todayISO(), `[${topHigh.category}] ${topHigh.headline}`, topHigh.category);
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