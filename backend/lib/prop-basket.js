'use strict';

// =============================================================================
// PROP INDEX GAP:
// yahoo-finance2 does not provide a Thai real-estate sector index (no SETPROP
// ticker is published on Yahoo Finance in our tested region/build).
//
// We compute a DERIVED value from a 20-ticker peer basket (Thai residential
// real-estate developers, ordered so ASW leads as the primary tracked ticker,
// followed by approximate-market-cap ordering of peers):
//   ASW, AP, SIRI, LH, SPALI, SC, S, PSH, FPT, ORI,
//   PRIME, NOBLE, QH, LPN, PF, SENA, ANAN, LALIN, CI, MJD
//
// Note: ASW (AssetWise) — our primary tracked ticker — is included in the
// basket, which gives the synthetic PROP index a 5% ASW self-bias by design.
// Method: equal-weighted mean of daily % changes; base 100.00 on the first
// common date; then accumulate (1 + meanPct) cumulatively per trading day.
//
// If a real SETPROP index becomes available (e.g. SET Smart, Bloomberg, or a
// new Yahoo ticker), swap this entire file:
//   - replace with: yahoo.historical('^SETPROP.BK', opts).then(mapSeries)
//   - the rest of the pipeline treats propIdx identically.
// =============================================================================

const PEER_TICKERS = [
  'ASW.BK', 'AP.BK', 'SIRI.BK', 'LH.BK', 'SPALI.BK',
  'SC.BK', 'S.BK', 'PSH.BK', 'FPT.BK', 'ORI.BK',
  'PRIME.BK', 'NOBLE.BK', 'QH.BK', 'LPN.BK', 'PF.BK',
  'SENA.BK', 'ANAN.BK', 'LALIN.BK', 'CI.BK', 'MJD.BK',
];

// Single source of truth for ticker → display name. Kept here (instead of in
// fetchers/index.js) so any change to the peer list flows in one place.
const PEER_NAMES = {
  'AP.BK':    'AP Thailand',
  'SIRI.BK':  'Sansiri',
  'LH.BK':    'Land & Houses',
  'ASW.BK':   'ASSETWISE PUBLIC COMPANY LIMITED',
  'SPALI.BK': 'Supalai',
  'SC.BK':    'SC Asset',
  'S.BK':     'Singha Estate',
  'PSH.BK':   'Pruksa Holding',
  'FPT.BK':   'Frasers Property',
  'ORI.BK':   'Origin Property',
  'PRIME.BK': 'Proud Real Estate',
  'NOBLE.BK': 'Noble Development',
  'QH.BK':    'Quality Houses',
  'LPN.BK':   'L.P.N. Development',
  'PF.BK':    'Property Perfect',
  'SENA.BK':  'Sena Development',
  'ANAN.BK':  'Ananda Development',
  'LALIN.BK': 'Lalin Property',
  'CI.BK':    'Charn Issara Development',
  'MJD.BK':   'Major Development',
};

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

module.exports = { computePropBasket, joinByDate, PEER_TICKERS, PEER_NAMES };