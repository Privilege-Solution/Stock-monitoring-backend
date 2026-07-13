// Parser unit tests for the daily-summary / morning-brief helpers.
// These are PURE functions — no Gemini call, no DB. They guard against the
// format-drift regressions that caused the garbled digest (single-line mash)
// and the leaked impact-level tone ("MEDIUM").
//
// Run:  node --test backend/lib/fetchers/__tests__/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTone, normalizeBullets, extractSection } from '../gemini-search.mjs';

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
