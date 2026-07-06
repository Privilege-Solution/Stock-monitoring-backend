'use strict';

// =============================================================================
// DETERMINISTIC RULES ENGINE (no AI).
//
// Inputs: window-range of DATA rows.
// Outputs: 3-5 bullets, in Thai or English.
//
// Rules (in priority order; first 5 that fire):
//   1. % chg ≥ +2% or ≤ -2%  →  "ปิดบวก/ลบ X% จากก่อนหน้า" / "Closed up/down X% from prior session"
//   2. volume > 2× 30d avg   →  volume surge bullet
//   3. biggest event impact  →  remark with largest |abs(% chg) − SET %|
//   4. 52W range position    →  position % within (lo, hi)
//   5. key event wins        →  count by category (ดอกเบี้ย / presale / โครงการ / การเมือง / งบ)
// =============================================================================

const TEXT = {
  th: {
    up:       (p) => `ราคาปิดบวก ${p.toFixed(2)}% จากก่อนหน้า`,
    down:     (p) => `ราคาปิดลบ ${Math.abs(p).toFixed(2)}% จากก่อนหน้า`,
    volume:   (x) => `ปริมาณซื้อขายพุ่ง ${x.toFixed(2)} เท่าของค่าเฉลี่ย 30 วัน`,
    event:    (remark) => `เหตุการณ์ที่มีผลกระทบมากที่สุด: ${remark}`,
    range52W: (pos) => `ราคาอยู่ที่ ${pos.toFixed(0)}% ของ 52W range`,
    wins:     (n, type) => `เหตุการณ์หลักในช่วง: ${type} ×${n}`,
    noEvents: () => 'ไม่พบเหตุการณ์ที่จัดประเภทได้ในช่วงนี้',
    noData:   () => 'ไม่มีข้อมูลในช่วงที่เลือก',
    eventTypes: ['ดอกเบี้ย', 'presale', 'งบ', 'โครงการ', 'การเมือง'],
    eventLabels: { 'ดอกเบี้ย': 'ดอกเบี้ย', 'presale': 'Presale', 'งบ': 'ผลประกอบการ', 'โครงการ': 'โครงการ', 'การเมือง': 'การเมือง' },
  },
  en: {
    up:       (p) => `Closed up ${p.toFixed(2)}% from prior session`,
    down:     (p) => `Closed down ${Math.abs(p).toFixed(2)}% from prior session`,
    volume:   (x) => `Volume surged ${x.toFixed(2)}× the 30-day average`,
    event:    (remark) => `Biggest event impact: ${remark}`,
    range52W: (pos) => `Price at ${pos.toFixed(0)}% of 52W range`,
    wins:     (n, type) => `Key events in range: ${type} ×${n}`,
    noEvents: () => 'No classifiable events in range',
    noData:   () => 'No data in selected range',
    eventTypes: ['interest', 'presale', 'earnings', 'project', 'political'],
    eventLabels: { 'interest': 'Interest rate', 'presale': 'Presale', 'earnings': 'Earnings', 'project': 'Project', 'political': 'Political' },
  },
};

function classifyEventType(remark) {
  const r = String(remark || '');
  if (/ดอกเบี้ย|กนง|ปรับขึ้นดอกเบี้ย/i.test(r)) return 'ดอกเบี้ย';
  if (/presale/i.test(r)) return 'presale';
  if (/งบ|ปันผล|รางวัล|จ่ายเงินปันผล/i.test(r)) return 'งบ';
  if (/โครงการ|เปิดโครงการ|ยอดจอง|openday|site visit|oppday|jv|atmoz|talis|kave|embryo|honor/i.test(r)) return 'โครงการ';
  if (/การเมือง|เลือกตั้ง|กกต|ทักษิณ|นายก|สภา|โหวต|เศรษฐา/i.test(r)) return 'การเมือง';
  return null;
}

// A row may carry up to 3 remark columns (company / sector / macro) since
// the schema split. Count each one independently — multiple categories can
// fire on the same day.
function rowRemarks(r) {
  const out = [];
  for (const k of ['remark_company', 'remark_sector', 'remark_macro']) {
    const v = r && r[k];
    if (v) out.push(v);
  }
  // Legacy single `remark` field for offline sample_data.js fallback.
  if (!out.length && r && r.remark) out.push(r.remark);
  return out;
}
function rowHasRemark(r) {
  return rowRemarks(r).length > 0;
}
function joinedRemark(r) {
  return rowRemarks(r).join(' | ');
}

function mapType(t, lang) {
  const labels = TEXT[lang]?.eventLabels || TEXT.th.eventLabels;
  if (lang === 'en') {
    const enMap = { 'ดอกเบี้ย': 'interest', 'presale': 'presale', 'งบ': 'earnings', 'โครงการ': 'project', 'การเมือง': 'political' };
    return labels[enMap[t]] || t;
  }
  return labels[t] || t;
}

function generate(data, lang = 'th') {
  const t = TEXT[lang] || TEXT.th;
  if (!data || !data.length) return [t.noData()];
  const withPrice = data.filter(r => r.close != null);
  if (!withPrice.length) return [t.noData()];
  const last = withPrice[withPrice.length - 1];
  const bullets = [];

  // Rule 1: big day
  if (last.change != null && Math.abs(last.change) >= 2) {
    bullets.push(last.change > 0 ? t.up(last.change) : t.down(last.change));
  }

  // Rule 2: volume surge
  const last30 = withPrice.slice(-31);
  const avg30 = last30.length
    ? last30.reduce((a, b) => a + (b.volume || 0), 0) / last30.length
    : 0;
  if (avg30 > 0 && last.volume > 2 * avg30) {
    bullets.push(t.volume(last.volume / avg30));
  }

  // Rule 3: biggest event impact
  const withRemark = withPrice.filter(r => rowHasRemark(r) && r.setIdx != null);
  if (withRemark.length) {
    const idxMap = new Map(withPrice.map((r, i) => [r.date, i]));
    const ranked = withRemark.map(r => {
      const i = idxMap.get(r.date);
      const prev = i > 0 ? withPrice[i - 1] : null;
      const setPct = prev?.setIdx && r.setIdx
        ? ((r.setIdx - prev.setIdx) / prev.setIdx) * 100 : 0;
      return { r, impact: Math.abs((r.change || 0) - setPct) };
    }).sort((a, b) => b.impact - a.impact);
    if (ranked[0]?.impact > 0) bullets.push(t.event(joinedRemark(ranked[0].r)));
  }

  // Rule 4: 52W range position
  const lookback = withPrice.slice(-252);
  if (lookback.length) {
    const lo = Math.min(...lookback.map(r => r.close));
    const hi = Math.max(...lookback.map(r => r.close));
    if (hi > lo) {
      const pos = ((last.close - lo) / (hi - lo)) * 100;
      bullets.push(t.range52W(pos));
    }
  }

  // Rule 5: event-type wins — count every non-empty remark column on every
  // row so a day with 3 different categories counts as 3 events.
  const counts = {};
  for (const r of withPrice.filter(r => rowHasRemark(r))) {
    for (const text of rowRemarks(r)) {
      const k = classifyEventType(text);
      if (k) counts[k] = (counts[k] || 0) + 1;
    }
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (top) bullets.push(t.wins(top[1], mapType(top[0], lang)));

  if (!bullets.length) bullets.push(t.noEvents());
  return bullets.slice(0, 5);
}

module.exports = { generate, TEXT, rowRemarks, rowHasRemark, joinedRemark, classifyEventType };