// Tests for the migrate-v13 multi-stock taxonomy: the TITLE token guards
// (the ticker is a common English word — the false-positive surface is real)
// and the per-stock category routing the TITLE panel depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCategory,
  headlineMentionsTitleStock,
  categoriesForStock,
  TAXONOMY_CATEGORIES,
  ALLOWED_CATEGORIES,
} from '../news-taxonomy.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { STOCKS, assertStock, normalizeStockParam } = require('../stocks.js');

// ── stocks registry ──────────────────────────────────────────────────────────

test('every per-stock category is in the shared superset', () => {
  for (const [key, cfg] of Object.entries(STOCKS)) {
    for (const c of cfg.categories) {
      assert.ok(ALLOWED_CATEGORIES.has(c), `${key} category ${c} missing from TAXONOMY_CATEGORIES`);
    }
  }
});

test('assertStock throws on junk, passes real stocks', () => {
  assert.equal(assertStock('ASW'), 'ASW');
  assert.equal(assertStock('TITLE'), 'TITLE');
  assert.throws(() => assertStock('title'));     // case matters on writes
  assert.throws(() => assertStock(undefined));
  assert.throws(() => assertStock('XX'));
});

test('normalizeStockParam: absent → ASW, junk → null, case-insensitive', () => {
  assert.equal(normalizeStockParam(undefined), 'ASW');
  assert.equal(normalizeStockParam(''), 'ASW');
  assert.equal(normalizeStockParam('title'), 'TITLE');
  assert.equal(normalizeStockParam('Asw'), 'ASW');
  assert.equal(normalizeStockParam('XX'), null);
});

// ── TITLE mention guard (scrutiny pass 4: the deed veto) ─────────────────────

test('TITLE DEED headlines never match the stock', () => {
  assert.equal(headlineMentionsTitleStock('PHUKET TITLE DEED PROBE'), false);
  assert.equal(headlineMentionsTitleStock('Phuket condo TITLE DEEDS investigated'), false);
  assert.equal(headlineMentionsTitleStock('ออกโฉนด TITLE ที่ดินภูเก็ต'), false);
});

test('lowercase "title" and cue-less TITLE never match', () => {
  assert.equal(headlineMentionsTitleStock('SET title sponsor announcement'), false);
  assert.equal(headlineMentionsTitleStock('SET TITLE SPONSOR DEAL'), false);
  assert.equal(headlineMentionsTitleStock('the title of the article'), false);
});

test('genuine TITLE stock headlines match', () => {
  assert.equal(headlineMentionsTitleStock('หุ้น TITLE เทรด SET วันแรก'), true);
  assert.equal(headlineMentionsTitleStock('TITLE คาดกำไรปี 69 โต'), true);
  assert.equal(headlineMentionsTitleStock('ร่มโพธิ์ เปิดโครงการใหม่หาดบางเทา'), true);
  assert.equal(headlineMentionsTitleStock('The Title Heritage Bang-Tao ยอดขายทะลุเป้า'), true);
  assert.equal(headlineMentionsTitleStock('Rhom Bho Property posts record H1'), true);
});

// ── per-stock category routing ───────────────────────────────────────────────

test('TITLE panel: driver categories route correctly', () => {
  assert.equal(classifyCategory('ครม. ลดวีซ่าฟรีเหลือ 30 วัน', null, 'TITLE'), 'TOURISM');
  assert.equal(classifyCategory('ราคาน้ำมันดิบ Urals พุ่งแตะ 100 ดอลลาร์', null, 'TITLE'), 'OIL');
  assert.equal(classifyCategory('รัสเซียปฏิเสธข้อเสนอหยุดยิงยูเครน', null, 'TITLE'), 'GEOPOLITICS');
  assert.equal(classifyCategory('เงินบาทแข็งค่าสุดในรอบปี', null, 'TITLE'), 'FX');
  assert.equal(classifyCategory('DBD ลุยสอบนอมินีต่างชาติถือครองอสังหาฯ ภูเก็ต', null, 'TITLE'), 'GOV_POLICY');
});

test('TITLE panel: tourism outranks geopolitics for Russian-tourist headlines', () => {
  assert.equal(classifyCategory('นักท่องเที่ยวรัสเซียแห่เที่ยวภูเก็ตทะลุล้านคน', null, 'TITLE'), 'TOURISM');
});

test('TITLE panel: oil outranks geopolitics for oil-sanction headlines', () => {
  assert.equal(classifyCategory('สหรัฐคว่ำบาตรน้ำมันดิบรัสเซียรอบใหม่', null, 'TITLE'), 'OIL');
});

test('TITLE panel: Thai politics folds into MACRO (no POLITICS bucket)', () => {
  assert.equal(classifyCategory('ยุบสภา เลือกตั้งใหม่ต้นปีหน้า', null, 'TITLE'), 'MACRO');
  assert.equal(classifyCategory('ยุบสภา เลือกตั้งใหม่ต้นปีหน้า', 'political', 'TITLE'), 'MACRO');
  assert.ok(!STOCKS.TITLE.categories.includes('POLITICS'));
});

test('TITLE panel: TITLE-specific RSS hints route', () => {
  assert.equal(classifyCategory('ข่าวทั่วไปไม่มีคีย์เวิร์ด', 'tourism', 'TITLE'), 'TOURISM');
  assert.equal(classifyCategory('ข่าวทั่วไปไม่มีคีย์เวิร์ด', 'foreign_demand', 'TITLE'), 'INDUSTRY');
  assert.equal(classifyCategory('ข่าวทั่วไปไม่มีคีย์เวิร์ด', 'phuket_sector', 'TITLE'), 'INDUSTRY');
  assert.equal(classifyCategory('ข่าวทั่วไปไม่มีคีย์เวิร์ด', 'macro_fx', 'TITLE'), 'FX');
});

test('TITLE mention → COMPANY on BOTH panels (subsidiary consolidates into ASW)', () => {
  assert.equal(classifyCategory('TITLE คาดกำไรปี 69 โต', null, 'TITLE'), 'COMPANY');
  assert.equal(classifyCategory('TITLE คาดกำไรปี 69 โต', null, 'ASW'), 'COMPANY');
  assert.equal(classifyCategory('ร่มโพธิ์ เปิดตัววิลล่าหรูเกาะแก้ว', null, 'ASW'), 'COMPANY');
});

test('ASW panel behaviour is unchanged (default stock)', () => {
  assert.equal(classifyCategory('กนง. คงอัตราดอกเบี้ยนโยบาย 1.00%', null), 'RATES');
  assert.equal(classifyCategory('ครม. ขยายลดค่าธรรมเนียมโอนบ้าน', null), 'GOV_POLICY');
  assert.equal(classifyCategory('ศุภาลัย เปิดโครงการใหม่', null), 'COMPETITOR');
  assert.equal(classifyCategory('ยุบสภา', 'political'), 'POLITICS');
  assert.equal(classifyCategory('อสังหาฯ กรุงเทพชะลอตัว', null), 'INDUSTRY');
  assert.equal(classifyCategory('ตัวเลขส่งออกเดือน ก.ค.', null), 'MACRO');
});

test('categoriesForStock: known stocks return their list, junk falls back to ASW', () => {
  assert.deepEqual(categoriesForStock('TITLE'), STOCKS.TITLE.categories);
  assert.deepEqual(categoriesForStock('nope'), STOCKS.ASW.categories);
});

test('superset is exactly the 7 legacy + 4 driver categories', () => {
  assert.equal(TAXONOMY_CATEGORIES.length, 11);
});
