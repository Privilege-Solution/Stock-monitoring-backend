// Parser unit tests for the daily-summary / morning-brief helpers.
// These are PURE functions — no Gemini call, no DB. They guard against the
// format-drift regressions that caused the garbled digest (single-line mash)
// and the leaked impact-level tone ("MEDIUM").
//
// Run:  node --test backend/lib/fetchers/__tests__/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTone, normalizeBullets, extractSection, parseAIResult } from '../gemini-search.mjs';

// ---- parseTone -----------------------------------------------------------
test('parseTone maps canonical values (case-insensitive)', () => {
  assert.equal(parseTone('bullish').tone, 'bullish');
  assert.equal(parseTone('Bearish').tone, 'bearish');
  assert.equal(parseTone('NEUTRAL').tone, 'neutral');
});

test('parseTone tolerates a trailing explanation', () => {
  assert.equal(parseTone('bullish (ข่าวดี)').tone, 'bullish');
  assert.equal(parseTone('neutral — ดอกเบี้ยคงที่').tone, 'neutral');
});

test('parseTone coerces leaked impact-level vocab and blanks to neutral', () => {
  assert.equal(parseTone('MEDIUM').tone, 'neutral');
  assert.equal(parseTone('high').tone, 'neutral');
  assert.equal(parseTone('').tone, 'neutral');
});

// ---- normalizeBullets ----------------------------------------------------
test('normalizeBullets leaves a proper multi-line digest untouched', () => {
  const raw = '- ประเด็น 1\n- ประเด็น 2\n- ประเด็น 3';
  assert.equal(normalizeBullets(raw), raw);
});

test('normalizeBullets splits a single-line mash on •', () => {
  assert.equal(normalizeBullets('ข่าว A • ข่าว B • ข่าว C'), 'ข่าว A\nข่าว B\nข่าว C');
});

test('normalizeBullets splits a single-line mash on inter-clause " - "', () => {
  assert.equal(normalizeBullets('ข่าว A - ข่าว B - ข่าว C'), 'ข่าว A\nข่าว B\nข่าว C');
});

test('normalizeBullets returns a genuine single point as-is', () => {
  assert.equal(normalizeBullets('ไม่มี marker เลย'), 'ไม่มี marker เลย');
  assert.equal(normalizeBullets(''), '');
});

// ---- extractSection ------------------------------------------------------
test('extractSection captures KEY_POINTS up to the next SECTION:', () => {
  const text = 'KEY_POINTS:\n- a\n- b\n\nTONE: bullish\nREASON: ...';
  assert.equal(extractSection(text, 'KEY_POINTS'), '- a\n- b');
});

test('extractSection captures a single-line value', () => {
  const text = 'KEY_POINTS: mashed headline here\nTONE: MEDIUM';
  assert.equal(extractSection(text, 'KEY_POINTS'), 'mashed headline here');
});

test('extractSection returns empty when the marker is absent', () => {
  assert.equal(extractSection('no markers here', 'KEY_POINTS'), '');
});

// ---- integration: the exact production failure ---------------------------
test('mashed digest + leaked "MEDIUM" tone is repaired end-to-end', () => {
  const text = 'KEY_POINTS: headline1 • headline2 • headline3\nTONE: MEDIUM\nREASON: mix';
  const bullets = normalizeBullets(extractSection(text, 'KEY_POINTS'));
  const { tone } = parseTone(text.match(/TONE:\s*(.+)/)[1]);
  assert.equal(bullets, 'headline1\nheadline2\nheadline3');
  assert.equal(tone, 'neutral');
});

// ---- URL: line is a TOKEN, not a line -------------------------------------
// Gemini answers `URL:` with prose attached — a second link, a comma list, or
// Thai commentary. The whole line used to be stored as the href, which 404s.
// 87 rows in news_feed carry one of these.
const block = (url, extra = '') =>
  `CATEGORY: MACRO\nHEADLINE: หัวข้อทดสอบ\nSUMMARY: ย่อ\nIMPACT_LEVEL: LOW\n` +
  `SOURCE: ทดสอบ\nURL: ${url}\n${extra}`;

test('URL: keeps only the first link when a second is appended', () => {
  const [r] = parseAIResult(
    block('https://a.co/x / https://b.co/y'), 'sector', null);
  assert.equal(r.url, 'https://a.co/x');
});

test('URL: drops trailing Thai commentary', () => {
  const [r] = parseAIResult(
    block('https://a.co/set-august-3-2569/ (อ้างอิงจากข่าวที่เกี่ยวข้อง)'), 'sector', null);
  assert.equal(r.url, 'https://a.co/set-august-3-2569/');
});

test('URL: drops a comma-separated second link', () => {
  const [r] = parseAIResult(
    block('https://reic.or.th/News/Detail/1169, https://thaipost.net/x'), 'macro', null);
  assert.equal(r.url, 'https://reic.or.th/News/Detail/1169,');   // sanitizer trims the comma
});

test('URL: a clean single link is untouched', () => {
  const [r] = parseAIResult(block('https://a.co/clean-article'), 'sector', null);
  assert.equal(r.url, 'https://a.co/clean-article');
});

// ---- the row date is the EVENT date, not the crawl date --------------------
// parseAIResult already extracted EVENT_DATE; it used to discard it and stamp
// every row with todayISO(), so a story found tonight that broke yesterday was
// filed under today and landed on the wrong day of the price chart.
const todayIct = () =>
  new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

test('date comes from EVENT_DATE when present', () => {
  const [r] = parseAIResult(
    block('https://a.co/x', 'EVENT_DATE: 2026-08-15\nPUBLISH_DATE: 2026-08-17'),
    'sector', null);
  assert.equal(r.date, '2026-08-15');
  assert.equal(r.event_date, '2026-08-15');
});

test('date falls back to PUBLISH_DATE when EVENT_DATE is missing', () => {
  const [r] = parseAIResult(
    block('https://a.co/x', 'PUBLISH_DATE: 2026-08-16'), 'sector', null);
  assert.equal(r.date, '2026-08-16');
});

test('date falls back to ICT today when the model gives neither', () => {
  const [r] = parseAIResult(block('https://a.co/x'), 'sector', null);
  assert.equal(r.date, todayIct());
});

test('a Buddhist-era EVENT_DATE is converted, not stored as year 2569', () => {
  const [r] = parseAIResult(
    block('https://a.co/x', 'EVENT_DATE: 2569-08-15'), 'sector', null);
  assert.equal(r.date, '2026-08-15');
});

// ---- a run-together record must not collapse into one field ---------------
// When Gemini emits the whole record on one line, `HEADLINE: (.+)` used to
// capture everything after it. 126 rows in news_feed store the entire record
// as the title (longest: 6,368 chars) and the feed renders that as a headline.
test('a single-line record splits into fields instead of collapsing', () => {
  const text =
    'CATEGORY: RATES HEADLINE: กนง. คงดอกเบี้ย 0.50% SUMMARY: คณะกรรมการมีมติเอกฉันท์ ' +
    'IMPACT_LEVEL: HIGH SOURCE: Finnomena URL: https://a.co/x';
  const [r] = parseAIResult(text, 'macro', null);
  assert.equal(r.headline, 'กนง. คงดอกเบี้ย 0.50%');
  assert.equal(r.summary, 'คณะกรรมการมีมติเอกฉันท์');
  assert.equal(r.category, 'RATES');
  assert.equal(r.impact_level, 'HIGH');
  assert.equal(r.source, 'Finnomena');
  assert.equal(r.url, 'https://a.co/x');
});

test('bracketed placeholders on one line also split', () => {
  const text =
    'CATEGORY: [COMPANY] HEADLINE: [ASW เสนอขายหุ้นกู้] SUMMARY:[รายละเอียด] ' +
    'IMPACT_LEVEL:[HIGH] SOURCE:[SET] URL:[https://a.co/y]';
  const [r] = parseAIResult(text, 'company', null);
  assert.equal(r.headline, '[ASW เสนอขายหุ้นกู้]');
  assert.equal(r.category, 'COMPANY');
  assert.equal(r.url, 'https://a.co/y');
});

test('the normal one-field-per-line shape is unaffected', () => {
  const text = 'CATEGORY: MACRO\nHEADLINE: ปกติ\nSUMMARY: ย่อ\nIMPACT_LEVEL: LOW\n' +
               'SOURCE: ทดสอบ\nURL: https://a.co/z';
  const [r] = parseAIResult(text, 'macro', null);
  assert.equal(r.headline, 'ปกติ');
  assert.equal(r.summary, 'ย่อ');
  assert.equal(r.url, 'https://a.co/z');
});
