// =============================================================================
// One government decision, reported for a week, should be ONE row.
//
// The live table has the same cabinet resolution three times:
//
//   8130  2026-08-04  รัฐต่ออายุลดค่าโอน-จดจำนอง และผ่อนคลาย LTV ถึงกลางปี 70
//   8035  2026-08-04  รัฐขยายมาตรการลดค่าโอน-จดจำนองถึงกลางปี 70
//   7364  2026-08-02  รัฐขยายมาตรการลดค่าโอน-จำนองถึงกลางปี 70
//
// The existing defences all miss it. title_hash is exact. news-dedup.mjs works
// on a 48h window and on general text similarity, so 08-02 vs 08-04 falls
// outside it and the rewording ("ต่ออายุ" vs "ขยายมาตรการ", "จดจำนอง" vs
// "จำนอง") reads as different text.
//
// A fingerprint fixes it by throwing away exactly the parts publishers vary —
// the verb, the ministry-vs-cabinet framing, the year notation — and keeping
// the parts that identify the decision: the measure, the rate, the deadline.
//
// THE HARD PART IS NOT MERGING TOO MUCH. These are NOT duplicates of the rows
// above, and the table has them:
//
//   4485  ราชกิจจาฯ ประกาศ ลดค่าโอน-จำนอง ... ไม่เกิน 7 ล้าน   ← gazetted: a new step
//   4489  กรมที่ดิน พร้อมให้บริการ ลดค่าโอน–จำนอง 0.01% ...      ← in force: a new step
//   4490  สูตรคำนวณ ค่าโอน-จำนอง 0.01% ...                    ← explainer, new content
//
// Same measure, different developments. So the fingerprint carries a STAGE
// component, and any headline that revises rather than repeats — ปรับ, เปลี่ยน,
// แก้ไข, ยกเลิก — or that introduces a new number is deliberately given a
// different fingerprint.
//
// This module only IDENTIFIES clusters. It never deletes; scripts/remediate-
// news-urls.mjs requires explicit IDs and a preview for that.
// =============================================================================

const THAI = '฀-๿';

// Verbs that mean "this decision happened" — interchangeable across outlets
// covering the same act. Collapsed to one token.
const APPROVE_VERBS = [
  'ไฟเขียว', 'อนุมัติ', 'เห็นชอบ', 'มีมติ', 'มติ', 'ผ่านความเห็นชอบ',
  'ต่ออายุ', 'ขยายเวลา', 'ขยายมาตรการ', 'ขยาย', 'คงไว้', 'เดินหน้า', 'ชง',
];

// Verbs that mean "this decision CHANGED". A headline carrying one of these is
// a new development even when everything else matches, so it keeps its own
// token and therefore its own fingerprint.
const REVISE_VERBS = ['ปรับ', 'เปลี่ยน', 'แก้ไข', 'ยกเลิก', 'ทบทวน', 'ลดวงเงิน', 'เพิ่มวงเงิน'];

// Who announced it — cabinet, government, a ministry — varies by outlet for
// the same act, so these all collapse to one actor token.
const ACTOR_ALIASES = [
  // Ordered: a named institution wins over the generic "the government",
  // because ธปท. commenting and ธอส. commenting on one measure are two items.
  [/ธปท\.?|ธนาคารแห่งประเทศไทย|แบงก์ชาติ|ผู้ว่าฯ?\s*ธปท/g, 'BOT'],
  [/ธอส\.?|ธนาคารอาคารสงเคราะห์/g, 'GHB'],
  [/กนง\.?/g, 'MPC'],
  [/กรมที่ดิน/g, 'DOL'],
  [/ครม\.?|คณะรัฐมนตรี|ที่ประชุมคณะรัฐมนตรี/g, 'CABINET'],
  [/รัฐบาล|ภาครัฐ|รัฐ(?![ก-ฮ])/g, 'CABINET'],
  [/กระทรวงการคลัง|ก\.?คลัง|คลัง(?![ก-ฮ])/g, 'CABINET'],
];

// Stage markers. Each is a genuinely different moment in a measure's life, so
// they must NOT collapse into the announcement.
const STAGE_MARKERS = [
  [/ราชกิจจา\w*|ประกาศราชกิจจา/g, 'GAZETTE'],
  [/กรมที่ดิน|เริ่มใช้|มีผลบังคับ|พร้อมให้บริการ|เริ่มแล้ว/g, 'IN_FORCE'],
  // A measure ENDING is not the measure being announced. Without this,
  // "มาตรการผ่อนคลาย LTV สิ้นสุดลง ณ สิ้นปี 2565" merged with an explainer
  // about the same year's LTV rules — opposite events, one fingerprint.
  [/สิ้นสุด|หมดอายุ|ครบกำหนด|ยุติ|ไม่ต่ออายุ/g, 'EXPIRY'],
  [/สูตรคำนวณ|วิธีคำนวณ|เช็คสิทธิ|คู่มือ|ตอบข้อสงสัย|อย่างไร|คืออะไร|ทำความเข้าใจ/g, 'EXPLAINER'],
  [/เตรียมเสนอ|จ่อเสนอ|เตรียมชง|เสนอ ครม|จ่อขยาย|เตรียมขยาย/g, 'PROPOSED'],
  // Reaction and analysis ABOUT a measure, not the measure. Different bodies
  // commenting on one policy are separate items, so this pairs with the
  // broadened actor list below to keep them apart.
  [/ชี้|มอง|เผย|ระบุ|คาดว่า|ห่วง|กังวล|ประเมิน|วิเคราะห์|แนะ|อุ้ม/g, 'COMMENTARY'],
];

// The measures this fingerprint knows about. Anything not matching one of
// these gets no fingerprint at all — the module declines rather than guesses.
const MEASURES = [
  [/ค่าโอน|ค่าธรรมเนียมการโอน|จดจำนอง|จำนอง/g, 'TRANSFER_FEE'],
  [/\bLTV\b|มาตรการ\s*LTV|loan.?to.?value/gi, 'LTV'],
  [/ดอกเบี้ยนโยบาย|อัตราดอกเบี้ยนโยบาย|กนง/g, 'POLICY_RATE'],
  [/ภาษีที่ดิน|ภาษีโรงเรือน/g, 'LAND_TAX'],
  [/บ้านล้านหลัง|บ้านเพื่อคนไทย|ที่อยู่อาศัยผู้มีรายได้น้อย/g, 'HOUSING_SCHEME'],
  [/กระตุ้นอสังหา\w*|มาตรการอสังหา\w*/g, 'PROPERTY_STIMULUS'],
  [/ต่างชาติ.*(?:ถือครอง|ซื้อ).*(?:คอนโด|ที่ดิน)|เช่าที่ดิน\s*99\s*ปี/g, 'FOREIGN_OWNERSHIP'],
  [/ค่าแรงขั้นต่ำ/g, 'MIN_WAGE'],
  [/ดิจิทัลวอลเล็ต|เงินดิจิทัล/g, 'DIGITAL_WALLET'],
];

/** Percentages, money caps and deadline years — the parameters that identify
 *  WHICH version of a measure a headline is about. A change here is a new
 *  development, not a duplicate. */
function parametersIn(text) {
  const out = new Set();
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) out.add('p' + m[1]);
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*ล้าน/g)) out.add('m' + m[1].replace(',', ''));
  // Deadline year, Buddhist Era in either notation: "ปี 70" and "2570" are one.
  for (const m of text.matchAll(/\b(25[0-9]{2})\b/g)) out.add('y' + m[1]);
  // Short Buddhist year, but ONLY where it is unambiguously a year: after
  // "ปี" or after a Thai month abbreviation. A bare `ถึง\s*(\d{2})` also
  // matched the DAY in "ถึง30 มิ.ย.70" and produced y2530 — a deadline four
  // decades wrong, which would split a cluster that should merge.
  for (const m of text.matchAll(/ปี\s*(\d{2})\b/g)) out.add('y' + (2500 + parseInt(m[1], 10)));
  for (const m of text.matchAll(/[ก-ฮ]{1,2}\.\s?[ก-ฮ]\.\s*(\d{2})\b/g)) out.add('y' + (2500 + parseInt(m[1], 10)));
  return out;
}

/**
 * A stable key for the EVENT a policy headline describes, or null when the
 * headline is not about a policy measure this module recognises.
 *
 * Shape:  MEASURE|ACTOR|STAGE|REVISION|param,param,...
 *
 * Two rows sharing a fingerprint are the same decision reported twice. Rows
 * differing only in STAGE or REVISION are the same measure at different points
 * and must both be kept.
 */
export function eventFingerprint(headline) {
  const raw = String(headline || '');
  if (!raw.trim()) return null;

  let measure = null;
  for (const [re, key] of MEASURES) { re.lastIndex = 0; if (re.test(raw)) { measure = key; break; } }
  if (!measure) return null;                 // not a policy headline — decline

  let actor = 'UNSPEC';
  for (const [re, key] of ACTOR_ALIASES) { re.lastIndex = 0; if (re.test(raw)) { actor = key; break; } }

  let stage = 'ANNOUNCE';
  for (const [re, key] of STAGE_MARKERS) { re.lastIndex = 0; if (re.test(raw)) { stage = key; break; } }

  // A revising verb makes this a distinct event even if everything else is equal.
  const revision = REVISE_VERBS.some(v => raw.includes(v)) ? 'REVISED' : 'SAME';

  // Approve-verbs are interchangeable, so they contribute nothing to the key.
  // (Listed for documentation and to keep the two vocabularies side by side.)
  void APPROVE_VERBS;

  const params = [...parametersIn(raw)].sort().join(',');
  return `${measure}|${actor}|${stage}|${revision}|${params}`;
}

/**
 * Group rows by event fingerprint. Only groups of 2+ are returned, each with a
 * suggested row to KEEP — the earliest by date, because the first report is the
 * one that sits on the day the market actually moved. Ties break on the longest
 * headline (most detail) and then the lowest id.
 *
 * Rows with no fingerprint are not grouped at all.
 *
 * @param rows [{ id, title, date, source_url, source_url_status }]
 * @param opts.windowDays only cluster rows within this many days of each other
 *                        (default 14) — two identical-looking measures a year
 *                        apart are different decisions.
 */
export function groupByEvent(rows, { windowDays = 14 } = {}) {
  const byFp = new Map();
  for (const r of rows) {
    const fp = eventFingerprint(r.title);
    if (!fp) continue;
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(r);
  }

  const clusters = [];
  for (const [fingerprint, group] of byFp) {
    if (group.length < 2) continue;
    // Split the group into date-contiguous runs so an annual repeat of the same
    // measure does not merge with this year's.
    const sorted = [...group].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let run = [sorted[0]];
    const runs = [];
    for (let i = 1; i < sorted.length; i++) {
      const gap = (new Date(sorted[i].date + 'T00:00:00Z') - new Date(run[run.length - 1].date + 'T00:00:00Z')) / 864e5;
      if (gap <= windowDays) run.push(sorted[i]);
      else { runs.push(run); run = [sorted[i]]; }
    }
    runs.push(run);

    for (const r of runs) {
      if (r.length < 2) continue;
      const keep = [...r].sort((a, b) =>
        String(a.date).localeCompare(String(b.date)) ||
        String(b.title).length - String(a.title).length ||
        a.id - b.id)[0];
      clusters.push({
        fingerprint,
        keep,
        duplicates: r.filter(x => x.id !== keep.id),
        span: [r[0].date, r[r.length - 1].date],
      });
    }
  }
  clusters.sort((a, b) => b.duplicates.length - a.duplicates.length);
  return clusters;
}

export default { eventFingerprint, groupByEvent };
