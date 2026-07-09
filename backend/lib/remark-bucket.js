'use strict';

// Single source of truth for "which column does a Thai remark text belong
// in?". Imported by db.js (seed path, writeRows legacy-shape adapter). The
// frontend's classifyEvent() in index.html duplicates the keyword logic —
// keep both in sync if you add new tokens.
//
// Output mapping (3 columns on daily):
//   remark_company — ASW-specific events (earnings, JV, presale, project)
//   remark_sector  — sector / property-developer / condo / land headlines
//   remark_macro   — BoT rate, policy, economy, political events
//
// A remark goes into EXACTLY ONE column (the first rule that matches wins)
// because the old single-text shape had no category info. The 3-column
// Gemini pipeline writes all 3 directly so a single day can have 1-3
// different category remarks.

const RULES = [
  // interest_rate → macro
  { test: /ดอกเบี้ย|กนง|ปรับขึ้นดอกเบี้ย|ปรับลงดอกเบี้ย/i, bucket: 'macro' },
  // political → macro
  { test: /การเมือง|เลือกตั้ง|กกต|ทักษิณ|นายก|สภา|โหวต|เศรษฐา|ครม\.|รัฐบาล/i, bucket: 'macro' },
  // macro (no political / rate keywords)
  { test: /แผ่นดินไหว|เศรษฐกิจ|เปิดประเทศ|สคบ|ปิดแคมป์|GDP|inflation|export|นำเข้า/i, bucket: 'macro' },
  // sector / property
  { test: /condo|คอนโด|ที่ดิน|Bangkok condo|property developer|Bangkok real estate|LH|SPALI|AP|QH|SIRI|NOBLE|ORI|ANAN|LPN|WHA/i, bucket: 'sector' },
  // project / company (corporate + JV + presale)
  { test: /โครงการ|talis|wellness|arbor|title|kave|embryo|honor|atmoz|jv|openday|site visit|oppday|เปิดโครงการ|ยอดจอง|presale/i, bucket: 'company' },
  // corporate (earnings, dividend, AGM, board)
  { test: /งบ|ปันผล|จ่ายเงินปันผล|รางวัล|q1|q2|q3|q4|AGM|oppday|XD/i, bucket: 'company' },
];

// Map a legacy single-text remark (the old `daily.remark` shape) into the
// 3 new bucket columns. Returns an object with one of company/sector/macro
// populated and the others null.
function classifyBucket(remark) {
  const r = String(remark || '').trim();
  if (!r) return { company: null, sector: null, macro: null };
  for (const { test, bucket } of RULES) {
    if (test.test(r)) return { company: null, sector: null, macro: null, [bucket]: r };
  }
  // Default: company — most ASW-specific events fall here when none of the
  // narrow keywords match (e.g. "แจ้งการเข้าซื้อหุ้นสามัญ..." in the old seed).
  return { company: r, sector: null, macro: null };
}

// Single-bucket mapper — used by db.js (seed path). Returns the highest-
// priority bucket that matches the Thai keyword rules, falling back to
// 'other' for unclassified text. The priority order (macro → sector →
// company) matches the JS RULES order.
function classifySingle(remark) {
  const r = String(remark || '').trim();
  if (!r) return { category: null, text: null };
  for (const { test, bucket } of RULES) {
    if (test.test(r)) return { category: bucket, text: r };
  }
  return { category: 'other', text: r };
}

module.exports = { classifyBucket, classifySingle, RULES };