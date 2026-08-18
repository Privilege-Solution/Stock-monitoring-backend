// rescaleToStored: the continuity chain between a freshly-computed PROP
// window (always re-based to 100 by computePropBasket) and the stored series.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { rescaleToStored } = require('../prop-basket.js');

const pts = (arr) => arr.map(([date, close]) => ({ date, close }));

test('window lands exactly on the stored level at the earliest overlap', () => {
  const fresh = pts([['2026-08-11', 100.0], ['2026-08-12', 101.0], ['2026-08-13', 99.5]]);
  const stored = new Map([['2026-08-11', 67.0]]);
  const out = rescaleToStored(fresh, stored);
  assert.equal(out[0].close, 67.0);
  // daily ratios preserved exactly: day2/day1 = 101/100, day3/day2 = 99.5/101
  assert.ok(Math.abs(out[1].close / out[0].close - 101 / 100) < 1e-6);
  assert.ok(Math.abs(out[2].close / out[1].close - 99.5 / 101) < 1e-6);
});

test('anchors on the EARLIEST overlapping date, not the latest', () => {
  // The latest stored days may carry the old sawtooth corruption (~100-scale);
  // the earliest overlap predates it within any 7-day window.
  const fresh = pts([['2026-08-11', 100.0], ['2026-08-12', 102.0]]);
  const stored = new Map([['2026-08-11', 50.0], ['2026-08-12', 999.0]]);
  const out = rescaleToStored(fresh, stored);
  assert.equal(out[0].close, 50.0);
  assert.equal(out[1].close, 51.0); // 50 × 1.02 — the 999 never matters
});

test('no stored overlap → window kept as computed (fresh DB becomes reference)', () => {
  const fresh = pts([['2026-08-11', 100.0]]);
  assert.deepEqual(rescaleToStored(fresh, new Map([['2020-01-01', 42]])), fresh);
  assert.deepEqual(rescaleToStored(fresh, new Map()), fresh);
  assert.deepEqual(rescaleToStored([], new Map([['2026-08-11', 42]])), []);
});

test('degenerate stored values never poison the window', () => {
  const fresh = pts([['2026-08-11', 100.0], ['2026-08-12', 101.0]]);
  assert.deepEqual(rescaleToStored(fresh, new Map([['2026-08-11', 0]])), fresh);      // k=0
  assert.deepEqual(rescaleToStored(fresh, new Map([['2026-08-11', -5]])), fresh);     // k<0
  assert.deepEqual(rescaleToStored(fresh, new Map([['2026-08-11', NaN]])), fresh);    // k NaN
  assert.deepEqual(rescaleToStored(fresh, new Map([['2026-08-11', 100.0]])), fresh);  // k=1 no-op
});
