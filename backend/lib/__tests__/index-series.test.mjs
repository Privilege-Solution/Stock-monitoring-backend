// SET / PROP index series: the PROP basket's tolerance of a flaky peer, and
// the CNBC fallback that fills SET days Yahoo no longer serves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { parseCnbcBars, fillMissingDates, hasGaps, rangeFor } from '../fetchers/cnbc-set.mjs';
const require = createRequire(import.meta.url);
const { computePropBasket } = require('../prop-basket.js');

const DAYS = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];
// n tickers that all move +1% a day.
const basket = (n, days = DAYS) => Array.from({ length: n }, () =>
  days.map((date, i) => ({ date, close: 10 * 1.01 ** i })));

test('every peer present → one point per day after the first, +1% each', () => {
  const out = computePropBasket(basket(20));
  assert.deepEqual(out.map(p => p.date), DAYS.slice(1));
  assert.equal(out[0].close, 101);
  assert.ok(Math.abs(out[3].close - 100 * 1.01 ** 4) < 1e-3);
});

test('one peer missing a day no longer blanks that day', () => {
  const peers = basket(20);
  peers[7] = peers[7].filter(r => r.date !== '2026-08-12');
  const out = computePropBasket(peers);
  assert.deepEqual(out.map(p => p.date), DAYS.slice(1));
});

test('a peer cut short to its last two rows does not blank the earlier days', () => {
  // The old start rule took the LATEST second date across tickers, so this
  // one ticker moved the start to 08-14 and the other days went NULL.
  const peers = basket(20);
  peers[3] = peers[3].slice(-2);
  const out = computePropBasket(peers);
  assert.deepEqual(out.map(p => p.date), DAYS.slice(1));
});

test('a day with too few peers trading is skipped, not guessed', () => {
  const peers = basket(20);
  for (let t = 0; t < 6; t++) peers[t] = peers[t].filter(r => r.date !== '2026-08-12');
  const out = computePropBasket(peers); // 14 of 20 < 15
  assert.ok(!out.some(p => p.date === '2026-08-12'));
  assert.ok(out.some(p => p.date === '2026-08-13'));
});

test('most fetches failed (empty series) → nothing, so stored values stay', () => {
  const peers = basket(20);
  for (let t = 0; t < 10; t++) peers[t] = [];
  assert.deepEqual(computePropBasket(peers), []);
});

test('a ticker back after a missing day counts its whole move once', () => {
  const peers = basket(20);
  peers[0] = peers[0].filter(r => r.date !== '2026-08-12');
  const out = computePropBasket(peers);
  // Every ticker is +1%/day, so the reappearing ticker's 2-day move is +2.01%:
  // 08-13 mean = (19 × 1% + 2.01%) / 20.
  const d12 = out.find(p => p.date === '2026-08-12').close;
  const d13 = out.find(p => p.date === '2026-08-13').close;
  assert.ok(Math.abs(d13 / d12 - (1 + (19 * 0.01 + 0.0201) / 20)) < 1e-6);
});

test('parseCnbcBars: dates from tradeTime, numeric closes, junk dropped', () => {
  const rows = parseCnbcBars({ barData: { priceBars: [
    { close: '1646.0000', tradeTime: '20260720000000' },
    { close: '1639.0400', tradeTime: '20260717000000' },
    { close: 'n/a', tradeTime: '20260721000000' },
    { close: '0', tradeTime: '20260722000000' },
    { close: '1700', tradeTime: 'bad' },
  ] } });
  assert.deepEqual(rows, [
    { date: '2026-07-17', close: 1639.04 },
    { date: '2026-07-20', close: 1646 },
  ]);
  assert.deepEqual(parseCnbcBars({}), []);
  assert.deepEqual(parseCnbcBars(null), []);
});

test('fillMissingDates: primary wins on overlap, fallback fills the rest', () => {
  const yahoo = [{ date: '2026-11-25', close: 1432.39 }];
  const cnbc = [{ date: '2026-11-24', close: 1451.65 }, { date: '2026-11-25', close: 1431.37 }];
  assert.deepEqual(fillMissingDates(yahoo, cnbc), [
    { date: '2026-11-24', close: 1451.65 },
    { date: '2026-11-25', close: 1432.39 },
  ]);
  assert.equal(fillMissingDates(yahoo, []), yahoo);
});

test('hasGaps compares against the stock\'s own trading days', () => {
  const asw = [{ date: '2026-11-24', close: 7.38 }, { date: '2026-11-25', close: null }];
  assert.equal(hasGaps([{ date: '2026-11-24', close: 1 }], asw), false); // null-close day ignored
  assert.equal(hasGaps([], asw), true);
});

test('rangeFor picks the smallest CNBC range covering the window', () => {
  const now = new Date('2026-11-25T00:00:00Z');
  assert.equal(rangeFor('2026-11-18', now), '1M');
  assert.equal(rangeFor('2026-07-01', now), '1Y');
  assert.equal(rangeFor('2021-01-01', now), '5Y');
  assert.equal(rangeFor(undefined, now), '5Y');
});
