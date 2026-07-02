'use strict';

// =============================================================================
// PROP INDEX GAP:
// yahoo-finance2 does not provide a Thai real-estate sector index (no SETPROP
// ticker is published on Yahoo Finance in our tested region/build).
//
// We compute a DERIVED value from a 10-ticker peer basket:
//   AP, LH, QH, SIRI, SPALI, NOBLE, ORI, ANAN, LPN, WHA
//
// Method: equal-weighted mean of daily % changes; base 100.00 on the first
// common date; then accumulate (1 + meanPct) cumulatively per trading day.
//
// If a real SETPROP index becomes available (e.g. SET Smart, Bloomberg, or a
// new Yahoo ticker), swap this entire file:
//   - replace with: yahoo.historical('^SETPROP.BK', opts).then(mapSeries)
//   - the rest of the pipeline treats propIdx identically.
// =============================================================================

const PEER_TICKERS = ['AP.BK','LH.BK','QH.BK','SIRI.BK','SPALI.BK','NOBLE.BK','ORI.BK','ANAN.BK','LPN.BK','WHA.BK'];

function computePropBasket(peerSeries) {
  // peerSeries: [{ date, close, ... }] per ticker; may have different date ranges.
  // Build per-ticker sorted-by-date array.
  const sorted = peerSeries
    .map(s => s.slice().sort((a, b) => a.date.localeCompare(b.date)))
    .filter(s => s.length >= 2);

  if (!sorted.length) return [];

  // Find the first date for which ALL tickers have a row (so we have a % chg for every one).
  const tickerIndices = sorted.map(() => 1); // start at index 1 so we can look back at index 0
  let startDate = null;
  // Walk: find the max of all "first-after-prev" dates where every ticker has prior + current.
  const firstDates = sorted.map(s => s[1]?.date).filter(Boolean);
  if (!firstDates.length) return [];
  // Use the latest of these as startDate to ensure every ticker contributes.
  startDate = firstDates.sort().slice(-1)[0];

  // Now for each trading day at-or-after startDate that exists in every ticker,
  // compute equal-weighted mean % chg.
  const indices = sorted.map(s => {
    let i = 0;
    while (i < s.length && s[i].date < startDate) i++;
    return i; // first index >= startDate
  });

  const points = [];
  let level = 100.00;
  // Walk day by day using the union of all dates that are >= startDate and
  // present in every ticker at or after their start.
  const dateSets = sorted.map(s => new Set(s.map(r => r.date)));
  // Find max date among all tickers
  const maxDates = sorted.map(s => s[s.length - 1].date).filter(Boolean);
  const maxDate = maxDates.sort().slice(-1)[0];

  for (let d = new Date(startDate + 'T00:00:00'); d <= new Date(maxDate + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const pcts = [];
    let allHave = true;
    for (let t = 0; t < sorted.length; t++) {
      const s = sorted[t];
      // advance pointer while next is <= iso
      while (indices[t] + 1 < s.length && s[indices[t] + 1].date <= iso) indices[t]++;
      const cur = s[indices[t]];
      const prev = indices[t] > 0 ? s[indices[t] - 1] : null;
      if (!cur || !prev || !dateSets[t].has(iso) || !dateSets[t].has(prev.date)) { allHave = false; break; }
      pcts.push((cur.close - prev.close) / prev.close);
    }
    if (!allHave) continue;
    const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
    level = level * (1 + mean);
    points.push({ date: iso, close: Number(level.toFixed(4)) });
  }
  return points;
}

function joinByDate(asw, setSeries, propSeries) {
  // Each input: [{ date, close, volume? }]. Output: rows in SAMPLE_DATA schema.
  const idx = (s) => new Map(s.map(r => [r.date, r]));
  const a = idx(asw);
  const s = idx(setSeries);
  const p = idx(propSeries);
  const dates = new Set([...a.keys(), ...s.keys(), ...p.keys()]);
  const sorted = [...dates].sort();
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const d = sorted[i];
    const prev = i > 0 ? out[i - 1] : null;
    const close = a.get(d)?.close ?? null;
    let change = null;
    if (close != null && prev?.close != null) change = Number((((close - prev.close) / prev.close) * 100).toFixed(4));
    out.push({
      date: d,
      close,
      change,
      volume: a.get(d)?.volume ?? null,
      value: a.get(d)?.value ?? null,
      setIdx: s.get(d)?.close ?? null,
      propIdx: p.get(d)?.close ?? null,
      remark: null,
    });
  }
  return out;
}

module.exports = { computePropBasket, joinByDate, PEER_TICKERS };