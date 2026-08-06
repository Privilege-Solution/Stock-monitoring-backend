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
import { TAXONOMY_CATEGORIES, ALLOWED_CATEGORIES } from '../news-taxonomy.mjs';
import {
  normalizeHeadline, normalizeDateYear,
  isHomepageUrl, deepenHomepageUrl, mapLimit,
} from './news-rss-helpers.mjs';

const MODEL = 'gemini-2.5-flash';
// Matches rss-property/rss-extended — each deepen is up to 2 Bing requests and
// Bing throttles an unbounded fan-out silently (a throttled response just looks
// like "no article found").
const BING_CONCURRENCY = 4;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

// Thai long-form date so Gemini can disambiguate "วันนี้" — eg. "2 กรกฎาคม
// พ.ศ. 2569". toLocaleDateString returns Buddhist Era by default in th-TH.
//
// timeZone MUST be pinned to Asia/Bangkok: without it toLocaleDateString uses
// the SYSTEM timezone (UTC on Railway), so any run in the 00:00–07:00 ICT
// window asked Gemini for YESTERDAY's Thai date while todayISO() — which does
// use ICT — stamped the resulting rows with TODAY's date. The prompt and the
// DB key have to agree on which day "วันนี้" is.
const todayThai = () =>
  new Date().toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: 'long', day: 'numeric',
  });

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

const CATEGORY_OPTIONS = TAXONOMY_CATEGORIES.join(' | ');

// Date discipline, appended to every news prompt.
//
// The failure this exists to stop: an outlet republishes or recaps an OLD event
// today, Gemini returns it as today's news, and the feed shows a months-old
// cabinet resolution as breaking. The tell is that the article's publish date is
// today while the event inside it is not, so the model is asked to separate the
// two explicitly and judge on the EVENT date.
//
// Thai-language cues matter here: "ก่อนหน้านี้", "เมื่อเดือนที่แล้ว" and
// "มีผลตั้งแต่วันที่ <past date>" in the body are reliable signals that a
// present-tense headline ("ต่ออายุ", "ขยายเวลา") is describing an approval that
// already happened. Four outlets covering the same ครม. transfer-fee extension
// on different days is exactly this pattern.
const DATE_DISCIPLINE = (today, todayIso) => `

=== กฎการตรวจสอบวันที่ (สำคัญมาก ห้ามข้าม) ===
เอาเฉพาะข่าวที่ "เหตุการณ์จริง" เกิดขึ้นใน${today} (${todayIso}) หรือถูกประกาศ/รายงานอย่างเป็นทางการครั้งแรกในวันนี้เท่านั้น
ห้ามเอาข่าวเก่าที่ถูกนำมาเผยแพร่ซ้ำ อ้างอิงถึง หรือสรุปย้อนหลัง

สำหรับทุกข่าว ต้องแยกวันที่ออกเป็น 2 อย่าง:
- EVENT_DATE  = วันที่เหตุการณ์เกิดขึ้นจริง (เช่น วันที่ ครม. มีมติ, วันที่ประกาศงบ)
- PUBLISH_DATE = วันที่บทความถูกเผยแพร่หรือแก้ไขล่าสุด

เกณฑ์ตัดสิน: ถ้า EVENT_DATE ไม่ใช่ ${todayIso} → ห้ามใส่ข่าวนั้น แม้ PUBLISH_DATE จะเป็นวันนี้ก็ตาม

ระวังรูปแบบข่าวเก่าที่ถูกทำให้ดูเหมือนใหม่:
1. มีคำว่า "ก่อนหน้านี้" / "เมื่อเดือนที่แล้ว" / "มีผลตั้งแต่วันที่ <วันที่ในอดีต>" → เหตุการณ์เป็นของเก่า
2. หลายสำนักข่าวรายงานมติรัฐ/ประกาศเดียวกัน โดยในเนื้อข่าวระบุวันมีผลเดียวกัน → ให้ดูวันที่มีมติในเนื้อข่าว ไม่ใช่แค่พาดหัว
3. พาดหัวใช้รูปปัจจุบัน/อนาคต ("ต่ออายุ", "ขยายเวลา") แต่เนื้อข่าวบอกว่า ครม. อนุมัติไปแล้วหลายสัปดาห์/เดือน → EVENT_DATE คือวันอนุมัติเดิม ไม่ใช่วันนี้

ถ้าไม่แน่ใจว่าเป็นข่าวใหม่จริงหรือข่าวเก่าโผล่ซ้ำ ให้ใส่ CONFIDENCE: low และคงข้อมูลไว้ ห้ามใส่เงียบ ๆ โดยไม่ระบุ

เพิ่ม 3 บรรทัดนี้ต่อท้ายทุกข่าว:
EVENT_DATE: [YYYY-MM-DD]
PUBLISH_DATE: [YYYY-MM-DD]
CONFIDENCE: [high | medium | low]`;

const PROMPT_COMPANY = (today, todayIso) => `คุณเป็น analyst หุ้นไทย ค้นหาข่าวของ "Assetwise" หรือ "ASW" หรือ "แอสเซทไวส์"
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
URL: https://...${DATE_DISCIPLINE(today, todayIso)}`;

const PROMPT_SECTOR = (today, todayIso) => `คุณเป็น analyst หุ้นอสังหาริมทรัพย์ไทย ค้นหาข่าวอสังหาฯ ไทย
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
- COMPETITOR : ข่าวที่กล่าวถึง developer คู่แข่งโดยเฉพาะ (LH, AP, SPALI, SIRI, NOBLE, ORI, ANAN, LPN, WHA, QH) ที่ไม่ใช่ ASW — เช่น งบการเงิน/โครงการใหม่/คำแนะนำหุ้นของบริษัทคู่แข่ง
- RATES      : มติ กนง., ประกาศอัตราดอกเบี้ยนโยบาย, การประชุม กนง. — หัวข้อหลักคือ "ดอกเบี้ย" เอง
- GOV_POLICY : มาตรการรัฐที่ "เจาะจงอสังหาฯ" — LTV, ลดค่าโอน-จดจำนอง, กฎต่างด้าวถือครองคอนโด, กระตุ้นที่อยู่อาศัย
- POLITICS   : ข่าวการเมืองทั่วไปที่อาจกระทบเศรษฐกิจ/นโยบาย (ไม่ใช่มาตรการที่อยู่อาศัย)
- INDUSTRY   : แนวโน้มตลาดอสังหาฯ ภาพรวม, สมาคมอสังหาฯ, supply/demand — ไม่ใช่ข่าว ASW หรือคู่แข่งรายใดรายหนึ่งโดยตรง และไม่ใช่นโยบายรัฐ
- MACRO      : ตัวเลองเศรษฐกิจมหภาคทั่วไป GDP/CPI/FX/การค้า — ไม่เกี่ยวอสังหาฯ โดยตรง

กฎการเลือก CATEGORY (สำคัญ):
1. ถ้าหัวข้อกล่าวถึง ASW / AssetWise / แอสเซทไวส์ → COMPANY เสมอ (แม้เนื้อหาจะเป็นเรื่องดอกเบี้ยหรือนโยบายรัฐ)
2. ถ้าเป็นมาตรการรัฐที่ "เจาะจงอสังหาฯ" → GOV_POLICY (ไม่ใช่ POLITICS)
3. ถ้าเป็นข่าว กนง./ดอกเบี้ยนโยบาย → RATES (ไม่ใช่ MACRO)
4. ถ้ากล่าวถึง developer คู่แข่งรายใดรายหนึ่งโดยเฉพาะ (ไม่ใช่ ASW) → COMPETITOR (ไม่ใช่ INDUSTRY)
5. ถ้าข่าวเกี่ยวกับอสังหาฯ ภาพรวม แต่ไม่ใช่นโยบายรัฐ ไม่ใช่ ASW และไม่ใช่คู่แข่งรายใดรายหนึ่ง → INDUSTRY
6. ข่าวอื่น ๆ ที่เหลือ → MACRO

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
---${DATE_DISCIPLINE(today, todayIso)}`;

const PROMPT_MACRO = (today, todayIso) => `คุณเป็น analyst เศรษฐกิจไทย ค้นหาข่าวสำคัญ
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
- COMPETITOR : ข่าว developer คู่แข่งโดยเฉพาะ (LH/AP/SPALI/SIRI/NOBLE/ORI/ANAN/LPN/WHA/QH ที่ไม่ใช่ ASW)
- INDUSTRY   : แนวโน้มอสังหาฯ/ดัชนี REIC/supply-demand (ไม่ใช่มาตรการรัฐ)
- MACRO      : GDP, CPI, FX, การค้า, การท่องเที่ยว, Fed — ตัวเลขเศรษฐกิจมหภาค
- COMPANY    : (ไม่ค่อยเจอใน macro pipeline — ใช้กรณีที่ข่าวกล่าวถึง ASW โดยตรง)

กฎการเลือก CATEGORY (สำคัญ):
1. ถ้าเป็นมติ กนง./ดอกเบี้ย → RATES
2. ถ้าเป็นมาตรการที่อยู่อาศัย → GOV_POLICY
3. ถ้าเป็นข่าวการเมืองทั่วไป → POLITICS
4. ถ้ากล่าวถึง developer คู่แข่งโดยเฉพาะ (ไม่ใช่ ASW) → COMPETITOR
5. ถ้าเป็นแนวโน้มอสังหาฯ/REIC → INDUSTRY
6. ตัวเลขเศรษฐกิจมหภาคอื่น ๆ → MACRO

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
---${DATE_DISCIPLINE(today, todayIso)}`;

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

// Daily digest of the day's news_feed rows (run after the last pull). Feeds
// the day's headlines grouped by category and asks for a concise digest —
// Gemini summarizes what we already pulled, so source news rows are never
// mutated. `date` is an ISO (ICT) key; `items` carry title/category/source.
const PROMPT_DAILY_SUMMARY = (date, items) => {
  const order = ['COMPANY', 'COMPETITOR', 'RATES', 'GOV_POLICY', 'POLITICS', 'INDUSTRY', 'MACRO'];
  const byCat = {};
  for (const it of items) {
    const c = order.includes(it.category) ? it.category : 'MACRO';
    (byCat[c] = byCat[c] || []).push(it);
  }
  const block = order
    .filter(c => byCat[c] && byCat[c].length)
    .map(c => `${c}:\n` + byCat[c].slice(0, 6)
      .map(it => `- [${it.impact_level || '—'}] ${it.title} (${it.source_label || '—'})`).join('\n'))
    .join('\n\n');
  return `คุณเป็น analyst หุ้นอสังหาฯ ไทย สรุปข่าวประจำวันที่ ${date}

นี่คือข่าวทั้งหมดของวันนี้ (จัดกลุ่มตามหมวด):

${block}

งานของคุณ: สรุปประเด็นสำคัญของวันนี้ให้ผู้บริหารอ่านเร็ว
กฎ:
- สรุปและรวมประเด็นด้วยภาษาของคุณเอง — ห้ามทำซ้ำ headline ต้นฉบับ ห้ามตัดแปะชื่อข่าวมาต่อกันเป็นประโยคเดียว
- ไม่เกิน 6 ประเด็น เรียงจากสำคัญที่สุด → น้อยที่สุด สำหรับหุ้น ASW
- แต่ละประเด็นอยู่คนละบรรทัด ขึ้นต้นด้วย "- "
- HEADLINE คือ 1 ประโยคสรุปข่าวทั้งวัน ไม่เกิน 100 ตัวอักษร (นับรวมช่องว่าง) จะใช้เป็น Remark — เขียนตามกฎ:
  1) เริ่มจากข่าว impact สูงสุดก่อน (HIGH > MEDIUM > LOW) เป็นประเด็นหลักของประโยค
  2) ข่าวบริษัทเป้าหมาย (ASW) ใส่เป็นประธานประโยค แม้ไม่ใช่ HIGH ก็ตาม
  3) ข่าวรอง (มหภาค/ตลาดโดยรวม) ย่อต่อท้ายด้วยวลีสั้น ๆ คั่นคำเชื่อม เช่น "ท่ามกลาง..." หรือ "พร้อม..."
  4) ตัดซ้ำ — หลายข่าวเรื่องเดียวกัน (เช่น TRIS อัปเกรดเครดิต ถูกรายงานซ้ำจากหลายสำนัก) นับเป็นประเด็นเดียว ไม่พูดซ้ำ
  5) ใช้ตัวเลขสำคัญแทนคำอธิบายยาว (เช่น "หุ้นกู้ 920 ลบ." แทน "เสนอขายหุ้นกู้ 2 ชุด มูลค่ารวมไม่เกิน 920 ล้านบาท")
  6) ห้ามใส่ชื่อแหล่งข่าว/สำนักข่าวในประโยคสรุป
  7) ใช้ภาษากระชับแบบข่าวหุ้น เช่น "ปรับขึ้น" "อ่อนค่า" "อัปเกรด" "เสนอขาย" แทนประโยคเต็ม
- TONE ต้องเป็นค่าใดค่าหนึ่งจาก bullish | bearish | neutral เท่านั้น (ห้ามใช้ HIGH/MEDIUM/LOW)

ตัวอย่างรูปแบบคำตอบ (ห้ามคัดลอกเนื้อหา — เขียนจากข่าวจริงของวันนี้เท่านั้น):

HEADLINE: ASW เปิดโครงการ 5 พันล้าน ท่ามกลางดอกเบี้ยลดและแรงกดดันจากคู่แข่ง
KEY_POINTS:
- บริษัทเปิดตัวโครงการใหม่มูลค่า 5 พันล้านบาท น่าจะเพิ่มรายได้ในปีหน้า
- ธปก. ลดดอกเบี้ย 0.25% ช่วยลดต้นทุนทางการเงิน
- คู่แข่งออกผลิตภัณฑ์ทดแทน กดดันส่วนแบ่งในตลาดเป้าหมายเดียวกัน

TONE: bullish
REASON: ปัจจัยบวกจากโครงการใหม่และดอกเบี้ยที่ลดลง มีน้ำหนักมากกว่าแรงกดดันจากคู่แข่ง`;
};

// =============================================================================
// PARSER (verbatim from user spec + migrate-v9 taxonomy)
// =============================================================================

// Category whitelist is imported from news-taxonomy.mjs (7-way vocabulary
// incl. COMPETITOR). Gemini output outside the set is coerced to MACRO so a
// stray legacy category (corporate, sector_policy, ...) doesn't poison the
// dashboard.
const ALLOWED_IMPACT_LEVELS = new Set(['HIGH', 'MEDIUM', 'LOW']);

// Normalize a raw enum value (CATEGORY / IMPACT_LEVEL) out of Gemini's text.
//
// WHY: the prompt templates literally show the placeholder syntax —
// "CATEGORY: [COMPANY]" and "IMPACT_LEVEL: [HIGH | MEDIUM | LOW]" — so Gemini
// frequently echoes the brackets (and sometimes the whole alternation list).
// The raw value "[COMPANY]" then failed ALLOWED_CATEGORIES.has() and was
// SILENTLY coerced to 'MACRO', which mis-filed ASW company news into the macro
// bucket and, via the same path on IMPACT_LEVEL, downgraded every HIGH to
// MEDIUM — killing the macro HIGH chart pins entirely.
//
// Strip the brackets, then take the first token before whitespace or the "|"
// alternation bar, uppercased.
function normalizeEnumValue(raw) {
  return String(raw || '')
    .replace(/[[\]]/g, ' ')
    .trim()
    .split(/[\s|]+/)[0]
    .toUpperCase();
}

// Map legacy sentiment IMPACT (positive/negative/neutral) onto the new
// impact_level vocabulary as a fallback for older Gemini runs that haven't
// been updated yet. positive → HIGH (good news moves valuation), negative
// → HIGH (bad news moves valuation), neutral → MEDIUM.
function severityFromImpactLevel(impactLevel) {
  return impactLevel === 'HIGH' ? 'high'
       : impactLevel === 'LOW'  ? 'low'
       : 'medium';
}

// Normalize the Grounding API's `groundingMetadata` into a smaller, typed
// shape the rest of this module uses. Returns null when the candidate had no
// grounding metadata (which happens for synthesis tasks that pass
// { ground:false } — morning brief / daily summary — and for any grounded
// call where the model chose not to cite anything).
function extractGrounding(candidate) {
  const gm = candidate?.groundingMetadata;
  if (!gm) return null;
  const chunks = (gm.groundingChunks || [])
    .map(c => ({ uri: c.web?.uri || '', title: c.web?.title || '' }))
    .filter(c => c.uri || c.title);
  const supports = (gm.groundingSupports || [])
    .map(s => ({
      // Gemini sometimes omits startIndex when the support spans from the
      // very beginning of the response — treat undefined as 0 so the range
      // check in resolveGroundedUrl() still works.
      start: s.segment?.startIndex ?? 0,
      end:   s.segment?.endIndex ?? 0,
      chunkIndices: s.groundingChunkIndices || [],
      confidence: s.confidenceScores?.[0] || 0,
    }))
    .filter(s => s.chunkIndices.length && s.end > s.start);
  return chunks.length ? { chunks, supports } : null;
}

// Hostname helpers used to validate Gemini's stated URL against the set of
// grounded publishers. `www.` is stripped before comparison so that
// "www.assetwise.co.th" matches the chunk title "assetwise.co.th".
function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

// Loose hostname equivalence: equal, or one is a parent domain of the other
// (handles cases like "blog.example.com" vs "example.com").
function hostnamesMatch(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase().replace(/^www\./, '');
  const y = b.toLowerCase().replace(/^www\./, '');
  return x === y || x.endsWith('.' + y) || y.endsWith('.' + x);
}

// Heuristic: does this string look like a domain (so we can construct a URL
// from it)? Gemini's web.title is usually a bare hostname but occasionally
// leaks the publisher's display name ("Bangkok Post") — we can't build a
// usable URL from those, so we skip them as a URL source.
function looksLikeHostname(s) {
  return typeof s === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s) && !/\s/.test(s);
}

// Given Gemini's stated URL and the grounding info, return the most reliable
// URL for this item. Policy:
//   1. If Gemini's URL hostname matches a grounded publisher, trust it —
//      this is the deep article URL (best outcome).
//   2. Otherwise find the chunk whose groundingSupport overlaps this item's
//      text position; build a publisher URL from its title.
//   3. If no support overlap, scan trusted hosts for a hostname match against
//      the stated URL one more time (in case supports were incomplete).
//   4. Last resort: return the stated URL unchanged. We'd rather keep a
//      suspect URL than drop the item — the cron operator can hide bad rows.
function resolveGroundedUrl(statedUrl, itemPos, grounding, trustedHosts) {
  // Reject Gemini's own grounding-redirect URLs outright. They look like
  // https://vertexaisearch.cloud.google.com/grounding-api-redirect/... and
  // expire quickly (often 404 within days). They are an internal Google
  // indirection, never a usable article URL. If Gemini stated one, treat it
  // as if no URL was given and rely on the grounding fallback below — better
  // to drop the item than store a guaranteed-to-404 link.
  const isGoogleInternal = (u) => {
    if (typeof u !== 'string') return false;
    if (u.includes('vertexaisearch.cloud.google.com')) return true;
    if (u.includes('grounding-api-redirect')) return true;
    try {
      const h = new URL(u).hostname;
      return h === 'vertexaisearch.cloud.google.com' || h.endsWith('.google.com');
    } catch { return false; }
  };
  const safeStatedUrl = isGoogleInternal(statedUrl) ? null : statedUrl;

  // 1. Validate stated URL against trusted hosts
  if (safeStatedUrl) {
    const urlHost = hostnameOf(safeStatedUrl);
    if (urlHost && trustedHosts.some(th => hostnamesMatch(urlHost, th))) {
      return safeStatedUrl;
    }
  }

  // 2. Find the grounding chunk that backs this item's HEADLINE text
  const matchingSupports = grounding.supports
    .filter(s => s.start < itemPos.end && s.end > itemPos.start)
    .sort((a, b) => b.confidence - a.confidence);

  for (const sup of matchingSupports) {
    for (const idx of sup.chunkIndices) {
      const chunk = grounding.chunks[idx];
      if (chunk?.title && looksLikeHostname(chunk.title)) {
        const host = chunk.title.replace(/^www\./, '');
        // Prefer the publisher's www subdomain for a stable homepage URL.
        return `https://www.${host}/`;
      }
    }
  }

  // 3. & 4. No grounding match — keep the safe URL (or null if it was a
  // rejected Google-internal redirect, so parseAIResult drops the item).
  return safeStatedUrl;
}

function parseAIResult(text, pipeline, grounding) {
  if (!text || text.trim() === 'NONE') return [];

  // Trusted publisher hostnames extracted from grounding chunks. Gemini's
  // web.title field is consistently the publisher's canonical hostname
  // (e.g. "assetwise.co.th", "marketeeronline.co") — we use it both to
  // validate URLs Gemini states in its text and as a fallback hostname
  // when Gemini hallucinates or truncates a URL.
  const trustedHosts = (grounding?.chunks || [])
    .map(c => c.title)
    .filter(Boolean);

  // Split into blocks while tracking each block's character offsets in the
  // original text. The offsets let us look up which grounding chunk backs
  // each headline via groundingSupports (which maps text ranges to chunks).
  const blocks = [];
  let searchFrom = 0;
  const pushBlock = (part) => {
    if (!part.trim()) return;
    const start = text.indexOf(part, searchFrom);
    if (start < 0) return;                    // defensive — can't happen for substrings
    blocks.push({ text: part, start, end: start + part.length });
    searchFrom = start + part.length;
  };
  for (const part of text.split('---')) {
    if (!part.trim()) continue;
    // Gemini sometimes omits the "---" separators the prompt asks for and
    // returns 2–3 records back to back inside ONE block. `get()` below only
    // returns the FIRST match per key, so a 3-item response silently collapsed
    // to item #1 and items 2..N were lost with no log line anywhere. Detect it
    // by counting HEADLINE: occurrences and re-split on the line that starts
    // the next record (every record begins with CATEGORY:).
    if ((part.match(/HEADLINE:/g) || []).length > 1) {
      for (const sub of part.split(/\n(?=CATEGORY:)/)) pushBlock(sub);
    } else {
      pushBlock(part);
    }
  }

  return blocks.map(({ text: block, start, end }) => {
    const get = (key) => {
      const m = block.match(new RegExp(`${key}:\\s*(.+)`));
      return m ? m[1].trim() : null;
    };
    // Bracket-tolerant enum parsing (see normalizeEnumValue). Coercions are
    // WARNED rather than applied silently so genuine format drift shows up in
    // the Railway logs instead of quietly re-filing everything as MACRO/MEDIUM.
    const rawCategory = normalizeEnumValue(get('CATEGORY'));
    let category = rawCategory;
    if (!ALLOWED_CATEGORIES.has(category)) {
      if (rawCategory) console.warn(`[gemini] unexpected CATEGORY "${get('CATEGORY')}" → coerced to MACRO`);
      category = 'MACRO';
    }
    const rawImpactLevel = normalizeEnumValue(get('IMPACT_LEVEL'));
    let impactLevel = rawImpactLevel;
    if (!ALLOWED_IMPACT_LEVELS.has(impactLevel)) {
      if (rawImpactLevel) console.warn(`[gemini] unexpected IMPACT_LEVEL "${get('IMPACT_LEVEL')}" → coerced to MEDIUM`);
      impactLevel = 'MEDIUM';
    }
    // The prompts don't ask for a DATE: line (rows are stamped with the run's
    // ICT date), but grounded output occasionally volunteers one — and when it
    // does it is often a Buddhist-era year ("2569-07-14"), which the th-TH
    // frontend renders as year 3112. normalizeDateYear() is the BE→CE safety
    // net; we only accept the result if it's a well-formed CE date.
    const statedDate = normalizeDateYear(get('DATE') || '');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(statedDate) ? statedDate : todayISO();
    const statedUrl = get('URL');
    // Resolve the URL against grounding: keep Gemini's URL if its hostname
    // matches a grounded publisher, otherwise replace with the publisher
    // URL derived from the chunk that backs this headline.
    const resolvedUrl = grounding
      ? resolveGroundedUrl(statedUrl, { start, end }, grounding, trustedHosts)
      : statedUrl;
    // Date discipline (see DATE_DISCIPLINE): the model reports when the EVENT
    // happened separately from when the ARTICLE was published, so a months-old
    // cabinet resolution republished today can be told apart from real news.
    // Both are optional — an older model response without them simply falls
    // back to the previous behaviour rather than dropping everything.
    const eventDateRaw = normalizeDateYear(get('EVENT_DATE') || '');
    const publishDateRaw = normalizeDateYear(get('PUBLISH_DATE') || '');
    const isIso = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
    const confidence = (get('CONFIDENCE') || '').trim().toLowerCase() || null;

    return {
      date,                                      // Gemini's DATE: if valid (BE→CE normalized), else ICT today
      event_date:   isIso(eventDateRaw) ? eventDateRaw : null,
      publish_date: isIso(publishDateRaw) ? publishDateRaw : null,
      confidence:   ['high', 'medium', 'low'].includes(confidence) ? confidence : null,
      pipeline,
      category,                                  // taxonomy-v2: COMPANY / RATES / GOV_POLICY / POLITICS / INDUSTRY / MACRO
      headline:  get('HEADLINE'),
      summary:   get('SUMMARY') || null,
      impact:    'neutral',                      // legacy sentiment column — superseded by impact_level
      severity:  severityFromImpactLevel(impactLevel),  // map impact_level → severity for downstream pin logic
      impact_level: impactLevel,                 // taxonomy-v2: HIGH / MEDIUM / LOW
      source:    get('SOURCE'),
      url:       resolvedUrl,
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

// Is this Gemini failure worth another attempt? 429 (quota / rate limit), any
// 5xx ("the model is overloaded" comes back as a 503 and is routine on
// gemini-2.5-flash), and the abort/timeout errors AbortSignal.timeout() raises
// (they carry no `.status`). 400 / 403 / 404 are permanent — a malformed body
// or a bad API key will fail identically on every retry, so short-circuit
// rather than burn the cron slot sleeping.
function isRetryableGeminiError(e) {
  const status = e?.status;
  if (status === 429) return true;
  if (status && status >= 500) return true;
  if (status) return false;                     // 400/403/404 — permanent
  return e?.name === 'AbortError' || e?.name === 'TimeoutError';
}

// One POST per pipeline. The body shape is the v1beta `generateContent`
// format. Google Search grounding (`tools:[{google_search:{}}]`) is OPT-IN
// via the `ground` flag: the news-SEARCH pipelines (company/sector/macro)
// need it to pull real articles; synthesis tasks (daily summary) must work
// only from the provided items, so they pass { ground:false } and we omit
// `tools` entirely (grounding would send the model off to search and it'd
// regurgitate snippets).
//
// RETRY: this used to say "retry logic lives at the scheduler layer" — it did
// not. server.js only try/catches each fetcher and logs the failure, so a
// single transient `503 model overloaded` or a 429 lost that pipeline for the
// entire batch (and, for the Monday-only morning brief, for the whole week).
// Backoff now lives HERE, mirroring the approach in yahoo.mjs `withRetry`
// (kept local to this file rather than shared — the two differ in what they
// treat as retryable and yahoo's version carries a `.symbol` field).
//
// Default maxTokens raised 2048 → 8192: see thinkingConfig below.
async function geminiSearch(
  prompt,
  { ground = true, maxTokens = 8192, timeoutMs = 30_000, retries = 3 } = {},
) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: maxTokens,
      // gemini-2.5-flash has "thinking" ON by default and thinking tokens are
      // charged against maxOutputTokens. A long grounded search spent the whole
      // 2048-token budget thinking, returned finishReason:'MAX_TOKENS' with an
      // EMPTY content.parts array, `text` became '', parseAIResult() returned
      // [] and the company/sector/macro pipelines recorded a silent success
      // with zero rows. This is a fixed-format extraction task — we don't need
      // chain-of-thought at all, so switch it off and give the whole budget to
      // the answer. (The daily-summary path had already worked around the
      // symptom by bumping to 8192; that is now the default for every caller.)
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  if (ground) body.tools = [{ google_search: {} }];

  // One attempt. Bound the wait: Node's global fetch has no default timeout, so
  // a hung Gemini connection would stall the cron indefinitely on Railway. 30s
  // is generous for a grounded-search generate call; synthesis tasks that need
  // a bigger answer (daily summary) pass a larger budget + timeout. The signal
  // is built per-attempt so each retry gets a fresh clock.
  const attemptOnce = async () => {
    const res = await fetch(`${ENDPOINT}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const err = new Error(`Gemini ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      err.status = res.status;                  // read by isRetryableGeminiError
      throw err;
    }
    const j = await res.json();
    const candidate = j.candidates?.[0];
    // Read EVERY part, not just parts[0] — Gemini splits a long grounded answer
    // across multiple parts and taking only the first truncated the response
    // mid-record, so the tail items vanished.
    const text = (candidate?.content?.parts || []).map(p => p.text || '').join('');
    // A truncated or empty completion is a FAILURE, not "no news". Returning ''
    // here made parseAIResult() emit [] and the pipeline log `ok` — the exact
    // silent-success mode this fix exists to remove. Throw so logFetchFinish
    // records a real error the operator can see.
    if (candidate?.finishReason === 'MAX_TOKENS' || !text.trim()) {
      throw new Error(
        `Gemini returned no usable text (finishReason=${candidate?.finishReason || 'none'}, ` +
        `parts=${(candidate?.content?.parts || []).length}, maxOutputTokens=${maxTokens})`,
      );
    }
    // extractGrounding returns null when there's no metadata (synthesis tasks
    // pass ground:false). The 3 search pipelines (company/sector/macro) pass
    // the result straight to parseAIResult, which uses it to validate URLs.
    const grounding = extractGrounding(candidate);
    return { text, grounding };
  };

  // Exponential backoff with jitter: ~1s, then ~2s (3 attempts = 2 waits),
  // each scaled by 0.5–1.5x so concurrent pipelines don't retry in lockstep.
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await attemptOnce();
    } catch (e) {
      lastErr = e;
      if (!isRetryableGeminiError(e) || attempt === retries) break;
      const wait = 1000 * Math.pow(2, attempt - 1) * (0.5 + Math.random());
      console.warn(
        `[gemini] attempt ${attempt}/${retries} failed ` +
        `(${e.status || e.name || 'no-status'}: ${String(e.message).slice(0, 140)}); ` +
        `retry in ${Math.round(wait)}ms`,
      );
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
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
    // Dedup by normalized headline so a Gemini item + an RSS item covering
    // the same story collapse to one row (matches rss-property/rss-extended).
    // Was sha1(`${headline}|${source}|${rawUrl}`) which let the same story
    // slip in multiple times from different sources.
    title_hash:   sha1(normalizeHeadline(it.headline) || `${it.headline}|${it.source || ''}|${rawUrl}`),
    pipeline:     it.pipeline,
    impact:       it.impact,
    severity:     it.severity,
    show_pin:     it.show_pin,
    summary:      it.summary || null,
    impact_level: it.impact_level,            // migrate-v9 — HIGH / MEDIUM / LOW
  };
}

// Normalize → deepen → drop → write. The single path from parsed Gemini items
// to news_feed rows, used by all three feed pipelines.
//
// WHY THE DEEPEN STEP: resolveGroundedUrl() falls back to
// `https://www.<publisher>/` whenever the grounding chunk identifies only a
// hostname (see step 2 there — it calls that "a stable homepage URL"). Such a
// link loads fine but never shows the story, so the reader clicks through to
// nothing. By 2026-08 that had put 113 homepage-only rows in news_feed, all
// from sector/macro/company — and zero from rss-property/rss-extended, which
// have always run headlines through deepenHomepageUrl() and dropped whatever
// could not be resolved. This brings the Gemini pipelines to the same standard.
//
// Dropping (rather than keeping the homepage, or keeping an empty URL) is
// deliberate and matches the RSS fetchers: better to lose one row than to show
// a headline the reader cannot actually open.
async function writeFeedItems(items, tag) {
  // Date discipline gate. Keep only stories whose EVENT happened today — an
  // article published today about a cabinet resolution from June is a recap,
  // not news, and putting it in the feed dated today misrepresents when the
  // market actually moved.
  //
  // Items the model marked CONFIDENCE: low are kept but logged, per the spec:
  // it must flag rather than silently include, and a human can then judge.
  // Items with no EVENT_DATE at all (older prompt shape, or a truncated
  // response) pass through — this gate must not become a silent blackhole.
  const today = todayISO();
  const stale = [];
  items = items.filter(it => {
    if (!it.event_date) return true;
    if (it.event_date === today) return true;
    stale.push(it);
    return false;
  });
  if (stale.length) {
    console.log(`[${tag}] dropped ${stale.length} recap(s) — event predates today (${today}):`);
    for (const s of stale) {
      console.log(`   event=${s.event_date} published=${s.publish_date || '?'} conf=${s.confidence || '?'}  ${String(s.headline).slice(0, 56)}`);
    }
  }
  const lowConf = items.filter(it => it.confidence === 'low');
  if (lowConf.length) {
    console.log(`[${tag}] ${lowConf.length} item(s) flagged CONFIDENCE: low — kept, verify manually:`);
    for (const l of lowConf) console.log(`   ${String(l.headline).slice(0, 70)}`);
  }
  if (!items.length) return { inserted: 0, dropped: 0, staleDropped: stale.length, deduped: 0 };

  const rows = items.map(normalizeForNewsFeed);

  const homepages = rows.filter(r => isHomepageUrl(r.source_url));
  if (homepages.length) {
    console.log(`[${tag}] deepening ${homepages.length} homepage URL(s)...`);
    await mapLimit(homepages, BING_CONCURRENCY, async (r) => {
      const deep = await deepenHomepageUrl(r.title, r.source_label);
      if (deep) r.source_url = deep;
    });
  }

  const keep = rows.filter(r => !isHomepageUrl(r.source_url));
  const dropped = rows.length - keep.length;
  if (dropped) {
    console.log(`[${tag}] dropped ${dropped} item(s) — publisher homepage, no article URL found`);
  }

  // writeNewsItems applies content-level dedup against the last 48h and within
  // this batch, and reports how many it collapsed.
  const { inserted, deduped } = await db.writeNewsItems(keep);
  return { inserted, dropped, staleDropped: stale.length, deduped: deduped || 0 };
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

// Coerce a raw TONE: value to the canonical vocabulary the frontend knows
// (bullish/bearish/neutral). Gemini occasionally leaks the impact_level vocab
// (HIGH/MEDIUM/LOW) into TONE, or appends a trailing explanation
// ("bullish (ข่าวดี)"). startsWith tolerates the trailing text; anything
// unrecognized falls back to neutral and is logged so format drift is
// visible in Railway logs. Returns { tone, raw }.
function parseTone(raw) {
  const r = (raw || '').trim().toLowerCase();
  let tone;
  if (r.startsWith('bull')) tone = 'bullish';
  else if (r.startsWith('bear')) tone = 'bearish';
  else if (r.startsWith('neut')) tone = 'neutral';
  if (!tone) {
    if (r) console.warn(`[gemini] unexpected TONE "${raw}" → coerced to neutral`);
    tone = 'neutral';
  }
  return { tone, raw: r };
}

// Cut the daily-summary HEADLINE down to the ≤100-char Remark cell.
//
// Prefer cutting at a space so we don't sever a word, BUT only when that space
// lands reasonably deep into the string. Thai has NO inter-word spaces, so on a
// Thai headline the last space before index 100 is almost always the single
// space right after the leading Latin ticker — a 138-char
// "ASW เปิดโครงการ…" truncated to literally "ASW…", destroying the remark.
// Requiring cut >= MIN_SPACE_CUT keeps the word-safe cut for Latin/mixed
// headlines and falls back to a hard slice at 100 for Thai. A prefix slice is
// safe for Thai either way: combining marks attach to the preceding base
// character, so a cut never leaves a dangling mark.
const MAX_HEADLINE = 100;
const MIN_SPACE_CUT = 60;
function truncateHeadline(headline) {
  const s = String(headline || '');
  if (s.length <= MAX_HEADLINE) return s;
  const cut = s.lastIndexOf(' ', MAX_HEADLINE);
  return (cut >= MIN_SPACE_CUT ? s.slice(0, cut) : s.slice(0, MAX_HEADLINE)).trimEnd() + '…';
}

// Repair a KEY_POINTS section that Gemini collapsed onto a single line (the
// observed failure mode with grounding on). Happy path — multiple lines — is
// returned as-is. Only when the section is a single line do we try to recover
// bullets by splitting on • or inter-clause " - " (never on sentence
// boundaries — too risky for Thai). Returns a newline-joined string; the
// frontend splits it back into <li> and strips a leading "- ".
function normalizeBullets(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.includes('\n')) return text;
  let parts;
  if (text.includes('•')) parts = text.split('•');
  else if (/\s+-\s+/.test(text)) parts = text.split(/\s+-\s+/);
  else return text;
  return parts.map(p => p.replace(/^[-•\s]+/, '').trim()).filter(Boolean).join('\n');
}

// =============================================================================
// 4 RUN FUNCTIONS
// =============================================================================

// (1) COMPANY — 1 pin per day, stored in daily.remark. All headlines also
// land in news_feed so the dashboard news sidebar can link to sources.
async function runCompany(sinceDate) {
  const td = todayThai();
  const { text, grounding } = await geminiSearch(PROMPT_COMPANY(td, todayISO()));
  const items = parseAIResult(text, 'company', grounding);
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
  const { inserted, dropped } = await writeFeedItems(items, 'gemini-company');

  return {
    ok: true,
    date: td,
    category: top.category,
    text: top.headline,
    sourceTitles: items.map(it => it.source ? `${it.source}: ${it.headline}` : it.headline),
    inserted,
    dropped,
  };
}

// (2) SECTOR — news feed only. No chart pin (sector doesn't move ASW price
// on its own).
async function runSector(sinceDate) {
  const td = todayThai();
  const { text, grounding } = await geminiSearch(PROMPT_SECTOR(td, todayISO()));
  const items = parseAIResult(text, 'sector', grounding);
  const { inserted, dropped } = await writeFeedItems(items, 'gemini-sector');
  console.log(`[gemini-sector] ${td} → fetched=${items.length} inserted=${inserted} dropped=${dropped}`);
  return { ok: true, fetched: items.length, inserted, dropped };
}

// (3) MACRO — news feed for all items. severity=high items ALSO append to
// daily.remark so they show up as event pins (macro that moves the market).
async function runMacro(sinceDate) {
  const td = todayThai();
  const { text, grounding } = await geminiSearch(PROMPT_MACRO(td, todayISO()));
  const items = parseAIResult(text, 'macro', grounding);
  const { inserted, dropped } = await writeFeedItems(items, 'gemini-macro');

  // The first severity=high item gets appended as a pin. We use
  // appendRemarkPin so the company pin from runCompany (above) is preserved.
  const topHigh = items.find(it => it.severity === 'high');
  if (topHigh) {
    // ISO key (see runCompany) — the Thai display string never matches daily.date.
    await db.appendRemarkPin(todayISO(), `[${topHigh.category}] ${topHigh.headline}`, topHigh.category);
  }
  const highCount = items.filter(i => i.severity === 'high').length;
  console.log(`[gemini-macro] ${td} → fetched=${items.length} inserted=${inserted} dropped=${dropped} high=${highCount}`);
  return { ok: true, fetched: items.length, inserted, dropped, high: highCount };
}

// (4) MORNING BRIEF — Monday-only weekly summary, lands in daily.{morning_*}.
async function runMorningBrief(sinceDate) {
  const { text } = await geminiSearch(PROMPT_BRIEF());
  if (!text || text.trim() === 'NONE') {
    console.log('[gemini-morning-brief] no content');
    return { ok: false, reason: 'empty' };
  }
  console.log(`[gemini-morning-brief] raw=${text.slice(0, 500)}`);

  const lastWeek = extractSection(text, 'LAST_WEEK');
  const thisWeek = extractSection(text, 'THIS_WEEK_WATCH');
  const toneMatch = text.match(/TONE:\s*(.+)/);
  const reasonMatch = text.match(/REASON:\s*(.+)/);
  const { tone } = parseTone(toneMatch ? toneMatch[1] : '');
  const reason = reasonMatch ? reasonMatch[1].trim() : '';

  const date = todayISO();                          // ICT date — was UTC
  await db.updateMorningBrief(date, { lastWeek, thisWeek, tone, reason });
  console.log(`[gemini-morning-brief] ${date} tone=${tone} reason="${reason}"`);
  return { ok: true, date, tone, lastWeek, thisWeek, reason };
}

// (5) DAILY SUMMARY — one Gemini digest of the day's news_feed rows, stored
//     in news_daily_summary. Chained after the day's final pull (rss-extended)
//     so it summarizes the full day. Source rows are READ-ONLY here — never
//     writeNewsItems / UPDATE news_feed. Accepts an optional date (ICT ISO)
//     so the manual refresh route can regenerate a specific day.
async function runDailySummary(sinceDate) {
  // Look at today first; if there's nothing yet (quiet morning, weekend,
  // holiday), fall back to the most recent day that has news. This makes
  // the dashboard show the last available summary instead of "failed"
  // whenever today's cron hasn't pulled anything new yet. Returns
  // { ok: true, reason: 'no-news', date } when there's genuinely nothing
  // in the feed at all — that's not a failure, just an empty state.
  let date = sinceDate || todayISO();
  let items = await db.readNewsFeedForDate(date);

  if ((!items || !items.length) && !sinceDate) {
    // Auto-fallback: query the latest day that actually has rows.
    const latest = await db.readLatestNewsDate();
    if (latest && latest !== date) {
      console.log(`[gemini-daily-summary] ${date} → no news, falling back to ${latest}`);
      date = latest;
      items = await db.readNewsFeedForDate(date);
    }
  }

  if (!items || !items.length) {
    // Genuine empty state (no news in the last week). Log as ok=true with
    // reason:'no-news' so the dashboard doesn't render a "failed" status —
    // the absence of news isn't a pipeline failure.
    console.log(`[gemini-daily-summary] ${date} → no news, skipping`);
    return { ok: true, reason: 'no-news', date, sourceCount: 0 };
  }

  // maxTokens is stated explicitly even though 8192 is now the shared default
  // (this path is where the truncation was first diagnosed, so keep it pinned).
  // 90s is the matching upper bound on the wait — this is the longest prompt we
  // send and it has no grounding round-trip to hide behind.
  const { text } = await geminiSearch(PROMPT_DAILY_SUMMARY(date, items), {
    ground: false, maxTokens: 8192, timeoutMs: 90_000,
  });
  if (!text || text.trim() === 'NONE') {
    console.log(`[gemini-daily-summary] ${date} → empty digest`);
    return { ok: false, reason: 'empty', date };
  }
  console.log(`[gemini-daily-summary] raw=${text.slice(0, 500)}`);

  const keyPoints = normalizeBullets(extractSection(text, 'KEY_POINTS'));
  // HEADLINE: one ≤100-char sentence summing up the day — becomes the Remark
  // cell. First line only (the spec is a single sentence), leading bullet
  // stripped, then Thai-safe truncation (see truncateHeadline).
  const headline = truncateHeadline(
    String(extractSection(text, 'HEADLINE') || '')
      .split('\n')[0].replace(/^[-•*]\s*/, '').trim(),
  );
  const toneMatch = text.match(/TONE:\s*(.+)/);
  const reasonMatch = text.match(/REASON:\s*(.+)/);
  const { tone } = parseTone(toneMatch ? toneMatch[1] : '');
  const reason = reasonMatch ? reasonMatch[1].trim() : '';

  await db.upsertDailySummary(date, {
    digest: keyPoints,
    headline,
    tone,
    reason,
    sourceCount: items.length,
  });
  console.log(`[gemini-daily-summary] ${date} → tone=${tone} items=${items.length} reason="${reason}"`);
  return { ok: true, date, tone, reason, sourceCount: items.length };
}

// =============================================================================
// DISPATCHER
// =============================================================================

async function run({ source, sinceDate } = {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set in environment');
  }
  switch (source) {
    case 'gemini-company':        return runCompany(sinceDate);
    case 'gemini-sector':         return runSector(sinceDate);
    case 'gemini-macro':          return runMacro(sinceDate);
    case 'gemini-morning-brief':  return runMorningBrief(sinceDate);
    case 'gemini-daily-summary':  return runDailySummary(sinceDate);
    default:
      throw new Error(`gemini-search: unknown source "${source}"`);
  }
}

export {
  run, parseAIResult, geminiSearch, normalizeForNewsFeed, extractSection,
  parseTone, normalizeBullets, truncateHeadline, normalizeEnumValue,
};
export default { run };