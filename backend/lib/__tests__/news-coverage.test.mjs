// Coverage guards for the news-fetch fixes: disasters and FX must survive the
// RSS relevance filter and land in the right bucket, and a targeted query's
// opt-out from the drop list must not leak to broad queries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCategory, headlineIsDisaster } from '../news-taxonomy.mjs';
import { scoreItem } from '../fetchers/rss-property.mjs';

// ---- disasters → MACRO ------------------------------------------------------
test('disasters file as MACRO on both panels, ahead of industry/tourism', () => {
  // The 28 Mar 2025 earthquake: mentions condos, used to land in INDUSTRY.
  assert.equal(classifyCategory('แผ่นดินไหวฉุดยอด Presale อสังหาฯ Q2', null, 'ASW'), 'MACRO');
  assert.equal(classifyCategory('แผ่นดินไหวเมียนมา สะเทือนกรุงเทพ ตึกถล่ม', null, 'ASW'), 'MACRO');
  // TITLE: a disaster story first, even when tourists are in the headline.
  assert.equal(classifyCategory('น้ำท่วมภูเก็ต นักท่องเที่ยวติดค้าง', null, 'TITLE'), 'MACRO');
  assert.equal(classifyCategory('Floods hit Phuket, flights cancelled', null, 'TITLE'), 'MACRO');
});

test('the name rules still win over the disaster rule', () => {
  assert.equal(classifyCategory('ASW ยืนยันคอนโดปลอดภัยหลังแผ่นดินไหว', null, 'ASW'), 'COMPANY');
  assert.equal(classifyCategory('ร่มโพธิ์ ตรวจอาคารหลังแผ่นดินไหว', null, 'TITLE'), 'COMPANY');
  // A rate decision taken because of a flood is still a rate story.
  assert.equal(classifyCategory('กนง. ลดดอกเบี้ยหลังน้ำท่วมใหญ่', null, 'ASW'), 'RATES');
});

test('figurative "flood" / "storm" are not disasters', () => {
  assert.equal(headlineIsDisaster('Phuket property market faces a flood of new supply'), false);
  assert.equal(headlineIsDisaster('พายุทางเศรษฐกิจถล่มอสังหาฯ'), false);
  assert.equal(headlineIsDisaster('Thailand flooding to cut GDP'), true);
});

// ---- TITLE FX ---------------------------------------------------------------
test('TITLE FX catches any currency move and fund-flow wording', () => {
  assert.equal(classifyCategory('รูเบิลอ่อนค่าหนักสุดรอบ 2 ปี', null, 'TITLE'), 'FX');
  assert.equal(classifyCategory('ค่าเงินดอลลาร์แข็งค่า กดดันบาท', null, 'TITLE'), 'FX');
  assert.equal(classifyCategory('เงินทุนต่างชาติไหลออกตลาดหุ้นไทย', null, 'TITLE'), 'FX');
  assert.equal(classifyCategory('Baht exchange rate swings as Fed holds', null, 'TITLE'), 'FX');
  // A dollar AMOUNT is not a currency story.
  assert.equal(classifyCategory('ตลาดอสังหาฯ ภูเก็ตโต 12.8 พันล้านดอลลาร์', null, 'TITLE'), 'INDUSTRY');
});

// ---- RSS relevance filter -------------------------------------------------------
test('a targeted query keeps a baht headline that quotes a bank', () => {
  const h = 'กรุงศรีคาดเงินบาทแข็งค่าต่อ ทดสอบ 32.50';
  // Broad query, no opt-out: the bank name kills it (unchanged behaviour).
  assert.equal(scoreItem(h, 0, false), 0);
  // FX query (baseScore + skipDrop): kept.
  assert.ok(scoreItem(h, 20, true) > 0);
});

test('a flood headline scores on its own words; the drop list still guards broad queries', () => {
  assert.ok(scoreItem('น้ำท่วมกรุงเทพ กระทบเศรษฐกิจ', 0, false) > 0);
  assert.equal(scoreItem('ศูนย์วิจัยกสิกรไทยคาดน้ำท่วมกระทบ GDP', 0, false), 0);
  assert.ok(scoreItem('ศูนย์วิจัยกสิกรไทยคาดน้ำท่วมกระทบ GDP', 20, true) > 0);
  // Unrelated energy news from a broad query is still dropped.
  assert.equal(scoreItem('PTT ปรับราคาน้ำมัน คอนโด', 0, false), 0);
});
