// A catch-up run asks about the MISSED day: its prompt, its date-discipline
// window, its write gate and its fallback row date are built for that day, not
// for the clock. A live run (no target date) must be exactly what it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayContext, windowStartIso, newsPrompt, applyDateGate, parseAIResult,
} from '../gemini-search.mjs';
import { CATCHUP_SOURCES } from '../../news-catchup.mjs';

const TODAY = '2026-11-24';
const PAST = dayContext('2026-11-17', TODAY);

// ---- the window ------------------------------------------------------------------
test('the date-discipline window ends on the target day and reaches back 48h', () => {
  assert.equal(windowStartIso('2026-11-20'), '2026-11-18');
  assert.equal(windowStartIso('2026-12-01'), '2026-11-29');
  assert.equal(windowStartIso('2027-01-01'), '2026-12-30');
});

test('a live run gets the same window the old now-based formula gave', () => {
  const live = dayContext();
  const oldFormula = new Date(Date.now() + 7 * 3600 * 1000 - 48 * 3600 * 1000).toISOString().slice(0, 10);
  assert.equal(live.isToday, true);
  assert.equal(live.oldestIso, oldFormula);
});

test('dayContext for a past day', () => {
  assert.equal(PAST.iso, '2026-11-17');
  assert.equal(PAST.isToday, false);
  assert.equal(PAST.oldestIso, '2026-11-15');
  assert.match(PAST.thai, /^17 พฤศจิกายน 2569$/);
  assert.equal(PAST.word, 'วันดังกล่าว');
  assert.equal(dayContext(TODAY, TODAY).word, 'วันนี้');
});

test('dayContext refuses future and malformed dates', () => {
  assert.throws(() => dayContext('2026-11-25', TODAY), /future/);
  assert.throws(() => dayContext('2026-13-01', TODAY), /bad target date/);
  assert.throws(() => dayContext('17/11/2026', TODAY), /bad target date/);
});

// ---- the prompts -------------------------------------------------------------------
for (const source of CATCHUP_SOURCES) {
  test(`${source}: a catch-up prompt is about the missed day, not today`, () => {
    const p = newsPrompt(source, PAST);
    assert.ok(p.includes('17 พฤศจิกายน 2569'), 'asks about the target day');
    assert.ok(p.includes('ระหว่างวันที่ 2026-11-15 ถึง 2026-11-17'), 'window ends on the target day');
    assert.ok(p.includes('นอกช่วง 2026-11-15 ถึง 2026-11-17'), 'the rejection rule uses the same window');
    assert.ok(p.includes('ห้ามใส่ข่าวที่เกิดขึ้นหลังวันที่ 2026-11-17'), 'says the day is in the past');
    assert.ok(!p.includes('วันนี้'), 'no "today" left to point Gemini at the wrong day');
    assert.ok(!p.includes(TODAY), 'today does not appear at all');
  });

  test(`${source}: a live prompt still says today and has no catch-up note`, () => {
    const day = dayContext();
    const p = newsPrompt(source, day);
    assert.ok(p.includes(`ระหว่างวันที่ ${day.oldestIso} ถึง ${day.iso} (${day.thai})`));
    assert.ok(p.includes('วันนี้'));
    assert.ok(!p.includes('เก็บข่าวย้อนหลัง'));
  });
}

test('newsPrompt rejects a source that has no news prompt', () => {
  assert.throws(() => newsPrompt('gemini-daily-summary', PAST), /no news prompt/);
});

// ---- the write gate -----------------------------------------------------------------
test('the gate keeps events inside the target day\'s window and nothing after it', () => {
  const items = ['2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', null]
    .map((event_date, i) => ({ headline: `h${i}`, event_date }));
  const { kept, stale } = applyDateGate(items, PAST);
  assert.deepEqual(kept.map(i => i.event_date), ['2026-11-15', '2026-11-16', '2026-11-17', null]);
  assert.deepEqual(stale.map(i => i.event_date), ['2026-11-14', '2026-11-18']);
});

test('the same item is stale for one day and fine for another', () => {
  const item = { headline: 'x', event_date: '2026-11-21' };
  assert.equal(applyDateGate([item], dayContext('2026-11-22', TODAY)).kept.length, 1);
  assert.equal(applyDateGate([item], PAST).kept.length, 0);
});

// ---- the fallback row date ----------------------------------------------------------
test('an undated item from a catch-up run is filed under the target day, not today', () => {
  const text = 'CATEGORY: MACRO\nHEADLINE: ข่าวไม่มีวันที่\nIMPACT_LEVEL: LOW\nSOURCE: X\nURL: NONE';
  const [row] = parseAIResult(text, 'macro', null, 'ASW', { fallbackDate: '2026-11-17' });
  assert.equal(row.date, '2026-11-17');
  const [dated] = parseAIResult(`${text}\nEVENT_DATE: 2026-11-16`, 'macro', null, 'ASW', { fallbackDate: '2026-11-17' });
  assert.equal(dated.date, '2026-11-16', 'a stated event date still wins');
});
