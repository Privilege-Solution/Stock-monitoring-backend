// =============================================================================
// Shared news taxonomy + classifier (migrate-v10).
//
// Single source of truth for the 7-way category vocabulary so all three
// fetchers (rss-property, rss-extended, gemini-search) emit the same keys the
// frontend filters on. Migrated out of rss-extended.mjs (which previously
// owned the only copy of classifyCategory) and extended with a COMPETITOR
// bucket that splits rival-developer news out of INDUSTRY.
//
// Priority mirrors migrate-v9.js + the new COMPETITOR pass:
//   1. ASW mention             → COMPANY        (ASW always wins)
//   2. BoT rate keywords       → RATES
//   3. Housing-policy keywords → GOV_POLICY
//   4. Competitor mention      → COMPETITOR     (rival devs, not ASW)
//   5. legacy hint fallbacks   → GOV_POLICY / RATES / POLITICS / INDUSTRY
//   6. RE-market regex         → INDUSTRY
//   7. catch-all               → MACRO
// =============================================================================

// migrate-v13: 4 driver categories for the TITLE (Phuket / foreign-buyer)
// panel join the original 7. Which stock uses which subset lives in
// stocks.js (STOCKS[stock].categories) — this list is the superset the DB
// may contain.
export const TAXONOMY_CATEGORIES = [
  'COMPANY', 'COMPETITOR', 'RATES', 'GOV_POLICY', 'POLITICS', 'INDUSTRY', 'MACRO',
  'TOURISM', 'GEOPOLITICS', 'OIL', 'FX',
];
export const ALLOWED_CATEGORIES = new Set(TAXONOMY_CATEGORIES);

// stocks.js is CommonJS (db.js/server.js need it synchronously) — pull it in
// the same way yahoo.mjs pulls prop-basket.js.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { STOCKS, DEFAULT_STOCK } = require('./stocks.js');

// Categories a given stock's pipeline may emit. Unknown stock falls back to
// the ASW set — reads must never throw here (writes validate via assertStock
// long before classification happens).
export function categoriesForStock(stock) {
  return (STOCKS[stock] || STOCKS[DEFAULT_STOCK]).categories;
}

// ASW / Assetwise tokens — the monitored stock.
export const ASW_TOKENS = ['ASW', 'Assetwise', 'แอสเซทไวส์', 'แอสเสทไวส์'];

// ── TITLE (Rhom Bho Property) tokens ─────────────────────────────────────────
// Thai names are unambiguous and need no guard. The Latin ticker "TITLE" is a
// common English WORD, so it gets the same treatment this file already gives
// bare AP/LH/QH: never trusted alone. Three defenses, in order:
//   1. scrub "title deed(s)" first — the single most common English collocation
//      in Thai property news ("PHUKET TITLE DEED PROBE" is about โฉนด, not the
//      stock). โฉนด-adjacent TITLE is scrubbed for the same reason.
//   2. bounded UPPERCASE match only (headlines write tickers uppercase;
//      lowercase "title" never means the stock).
//   3. context cue required — a stock/property/Phuket word must appear
//      elsewhere in the headline. Bare `SET`/`mai` are deliberately NOT cues
//      ("SET TITLE SPONSOR" must not match); genuine ticker headlines carry
//      หุ้น/เทรด/งบ/ภูเก็ต alongside.
// Brand form "The Title <Project>" (e.g. "The Title Heritage Bang-Tao") is
// matched case-sensitively with a following capitalized word.
export const TITLE_STOCK_TOKENS_TH = ['ร่มโพธิ์', 'เดอะ ไทเทิล', 'เดอะไทเทิล'];
const TITLE_DEED_SCRUB_RE = /title[\s.-]?deeds?|โฉนด\s*TITLE|TITLE\s*โฉนด/gi;
const TITLE_TICKER_RE = /(?<![A-Za-z])TITLE(?![A-Za-z])/;      // case-sensitive
const TITLE_BRAND_RE = /(?<![A-Za-z])The Title\s+[A-Z฀-๿]/; // "The Title Serenity", "The Title ภูเก็ต"
const TITLE_CONTEXT_CUE_RE = /หุ้น|ภูเก็ต|Phuket|อสังหา|คอนโด|วิลล่า|villa|condo|ผลประกอบการ|งบ|กำไร|รายได้|ปันผล|เทรด|ตลาดหลักทรัพย์|ร่มโพธิ์/i;

export function headlineMentionsTitleStock(title) {
  if (!title) return false;
  const t = String(title);
  if (TITLE_STOCK_TOKENS_TH.some(kw => t.includes(kw))) return true;
  if (/rhom\s*bho/i.test(t)) return true;
  const scrubbed = t.replace(TITLE_DEED_SCRUB_RE, ' ');
  if (TITLE_BRAND_RE.test(scrubbed)) return true;
  return TITLE_TICKER_RE.test(scrubbed) && TITLE_CONTEXT_CUE_RE.test(scrubbed);
}

// Rival Thai property developers — the COMPETITOR bucket. Thai full names are
// the reliable signal (low false-positive) and are the workhorse for both the
// RSS classifier and the migrate-v10 SQL backfill. Longer English SET tickers
// are also matched case-sensitively on letter-boundaries so an English-only
// headline still tags; bare 2-letter tickers (AP/LH/QH) are intentionally NOT
// matched as tickers (their Thai names below cover them, and "LH"/"AP" as bare
// tokens collide with e.g. LH Securities the broker or unrelated words).
export const COMPETITOR_TOKENS = [
  'แลนด์แอนด์เฮ้าส์', 'แลนด์ แอนด์ เฮ้าส์',   // LH
  'เอพี',                                   // AP (Asian Property)
  'ศุภาลัย',                                // SPALI
  'สิริ เวนเชอร์', 'สิริวงศ์พร็อพเพอร์ตี้',  // SIRI
  'โนเบิล',                                 // NOBLE
  'ออริจิ้น',                               // ORI
  'อนันดา',                                 // ANAN
  'แอล.พี.เอ็น', 'แอลพีเอ็น',                // LPN
  'ควอลิตี้เฮาส์',                           // QH
  'ดับบลิวเอชเอ',                            // WHA
];
// ≥3-char English tickers safe to match as bounded uppercase tokens. Lookaround
// boundaries (`(?<![A-Za-z])…(?![A-Za-z])`) stop a match inside another word.
const COMPETITOR_TICKER_RE = /(?<![A-Za-z])(SPALI|SIRI|NOBLE|ORI|ANAN|LPN|WHA|QH)(?![A-Za-z])/;

export function headlineMentionsAsw(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return ASW_TOKENS.some(kw => t.includes(kw.toLowerCase()));
}

export function headlineMentionsCompetitor(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  if (COMPETITOR_TOKENS.some(kw => t.includes(kw.toLowerCase()))) return true;
  return COMPETITOR_TICKER_RE.test(title); // case-sensitive — uppercase tickers only
}

// Per-stock dispatch (migrate-v13). Default 'ASW' keeps every existing call
// site behaving exactly as before.
export function classifyCategory(title, hint, stock = 'ASW') {
  if (stock === 'TITLE') return classifyCategoryTitleStock(title, hint);
  return classifyCategoryAsw(title, hint);
}

// ── TITLE branch ─────────────────────────────────────────────────────────────
// Priority mirrors the panel's reason to exist: the stock itself, then rates,
// then policy that gates foreign buying, then the four demand drivers, then
// the Phuket property market. Thai politics folds into MACRO (it reaches
// TITLE through tourism/FX — no POLITICS bucket on this panel).
function classifyCategoryTitleStock(title, hint) {
  if (!title) return 'MACRO';

  // (a) TITLE-name wins over everything (same rule as ASW-name for ASW).
  if (headlineMentionsTitleStock(title)) return 'COMPANY';

  // (b) BoT rate keywords — shared with the ASW branch.
  if (/กนง\.|ดอกเบี้ยนโยบาย|อัตราดอกเบี้ย/.test(title)) return 'RATES';

  // (c) Policy that gates foreign ownership/buying — quota, nominee
  //     crackdown, leasehold, transfer/mortgage fees, LTV.
  if (/LTV|ค่าโอน|ค่าจดจำนอง|โควตาต่างชาติ|ต่างชาติถือครอง|นอมินี|nominee|ลีสโฮลด์|leasehold|เช่าระยะยาว|มาตรการอสังหาฯ|ลดค่าธรรมเนียม.*(โอน|จดจำนอง)/i.test(title)) return 'GOV_POLICY';

  // (d) Travel access — visas, arrivals, flights, airport capacity. Checked
  //     BEFORE geopolitics so "นักท่องเที่ยวรัสเซีย..." lands here, not in war news.
  if (/วีซ่า|visa|นักท่องเที่ยว|เที่ยวบิน|สายการบิน|สนามบิน|ท่องเที่ยว|tourist|flight|airport|arrival/i.test(title)) return 'TOURISM';

  // (e) Oil — the Russian-buyer wealth proxy. Before GEOPOLITICS so
  //     "คว่ำบาตรน้ำมันรัสเซีย" files under the finer bucket.
  if (/น้ำมันดิบ|ราคาน้ำมัน|Urals|Brent|WTI|OPEC|โอเปก/i.test(title)) return 'OIL';

  // (f) Currencies & moving money — baht strength, RUB/CNY, transfer rules.
  if (/ค่าเงินบาท|เงินบาท|บาทแข็ง|บาทอ่อน|รูเบิล|เงินหยวน|อัตราแลกเปลี่ยน|โอนเงิน(ระหว่าง|ต่าง)ประเทศ|USD\/THB|(?<![A-Za-z])(RUB|CNY)(?![A-Za-z])|SWIFT/.test(title)) return 'FX';

  // (g) Wars, sanctions, ceasefire talks — the buyers' home-front news.
  if (/สงคราม|ยูเครน|รัสเซีย|เครมลิน|คว่ำบาตร|หยุดยิง|เจรจาสันติภาพ|ceasefire|sanction|(?<![A-Za-z])war(?![A-Za-z])|Ukraine|Russia|Kremlin|NATO|ตะวันออกกลาง|อิสราเอล|Israel/i.test(title)) return 'GEOPOLITICS';

  // (h) TITLE-specific RSS hints (rss queries tag these).
  if (hint === 'tourism') return 'TOURISM';
  if (hint === 'foreign_demand' || hint === 'phuket_sector') return 'INDUSTRY';
  // Shared legacy hints keep their meaning, except 'political' → MACRO here.
  if (hint === 'sector_policy') return 'GOV_POLICY';
  if (hint === 'interest_rate') return 'RATES';
  if (hint === 'macro_fx') return 'FX';
  if (hint === 'sector_data' || hint === 'peer_news') return 'INDUSTRY';

  // (i) Phuket / property-market trends, incl. foreign-buyer demand data.
  if (/อสังหา|ที่อยู่อาศัย|คอนโด|วิลล่า|บ้านจัดสรร|ภูเก็ต|Phuket|ต่างชาติ.*(ซื้อ|โอน|ถือครอง)/i.test(title)) return 'INDUSTRY';

  // (j) Everything else — including Thai politics — is MACRO on this panel.
  return 'MACRO';
}

// ── ASW branch (pre-v13 behaviour, unchanged except the subsidiary rule) ────
function classifyCategoryAsw(title, hint) {
  if (!title) return 'MACRO';

  // (a) ASW-name wins over everything per the disambiguation rules.
  if (headlineMentionsAsw(title)) return 'COMPANY';

  // (a') TITLE (ร่มโพธิ์) is ASW's 68.9% subsidiary — its results consolidate
  //      into ASW, and the market reads its news as ASW news ("ASW โตแรง
  //      TITLE หนุน"). A TITLE-only headline is COMPANY on the ASW panel too.
  if (headlineMentionsTitleStock(title)) return 'COMPANY';

  // (b) BoT rate-decision keywords — main subject IS the rate decision.
  if (/กนง\.|ดอกเบี้ยนโยบาย|อัตราดอกเบี้ย/.test(title)) return 'RATES';

  // (c) Housing-policy keywords — government measures specific to real estate.
  if (/LTV|ค่าโอน|ค่าจดจำนอง|สมาคมบ้านจัดสรร|มาตรการอสังหาฯ/.test(title)) return 'GOV_POLICY';

  // (c') Post-pass GOV_POLICY variants — "ลดค่าธรรมเนียมโอน", etc.
  if (/ลดค่าธรรมเนียม.*(โอน|จดจำนอง|จดทะเบียน|อสังหาฯ|ที่อยู่อาศัย)/.test(title)) return 'GOV_POLICY';
  if (/ค่าธรรมเนียม.*(โอน|จดจำนอง|จดทะเบียน).*(อสังหาฯ|ที่อยู่อาศัย)/.test(title)) return 'GOV_POLICY';
  if (/มาตรการกระตุ้นอสังหาฯ/.test(title)) return 'GOV_POLICY';

  // (d) Competitor mention (a rival developer named, not ASW) → COMPETITOR.
  //     Placed after rate/policy so a rate/policy article that happens to name
  //     a rival still classifies by its main subject.
  if (headlineMentionsCompetitor(title)) return 'COMPETITOR';

  // (e) Legacy hint fallbacks.
  if (hint === 'sector_policy') return 'GOV_POLICY';
  if (hint === 'interest_rate') return 'RATES';
  if (hint === 'political') return 'POLITICS';
  if (hint === 'sector_data' || hint === 'peer_news') return 'INDUSTRY';

  // (f) RE-market trends without a specific policy.
  if (/อสังหา|ที่อยู่อาศัย|คอนโด|บ้านจัดสรร/.test(title)) return 'INDUSTRY';

  // (g) Catch-all — FX/baht/employment + everything not covered above.
  return 'MACRO';
}

// Map severity (high/medium/low) to the impact magnitude axis.
export function impactLevelFromSeverity(sev) {
  if (sev === 'high') return 'HIGH';
  if (sev === 'low') return 'LOW';
  return 'MEDIUM';
}
