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

export const TAXONOMY_CATEGORIES = [
  'COMPANY', 'COMPETITOR', 'RATES', 'GOV_POLICY', 'POLITICS', 'INDUSTRY', 'MACRO',
];
export const ALLOWED_CATEGORIES = new Set(TAXONOMY_CATEGORIES);

// ASW / Assetwise tokens — the monitored stock.
export const ASW_TOKENS = ['ASW', 'Assetwise', 'แอสเซทไวส์', 'แอสเสทไวส์'];

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

export function classifyCategory(title, hint) {
  if (!title) return 'MACRO';

  // (a) ASW-name wins over everything per the disambiguation rules.
  if (headlineMentionsAsw(title)) return 'COMPANY';

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
