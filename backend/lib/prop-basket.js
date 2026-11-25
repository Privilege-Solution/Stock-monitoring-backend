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
// Method: equal-weighted mean of daily % changes over the tickers that traded
// that day (at least MIN_BASKET_COVERAGE of the basket); base 100.00 on the
// first such date; then accumulate (1 + meanPct) cumulatively per trading day.
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

// A day gets a basket value when at least this share of the basket has a
// price for it (and for the ticker's previous trading day). Was effectively
// 100%: one peer with a missing candle — or one Yahoo response cut short to a
// couple of rows, which pushed the start date to the window's last day — left
// every other day of the run without a propIdx, and the upsert then wrote
// those NULLs over the stored values. 15 of 20 keeps the basket representative
// while a single flaky ticker no longer blanks the series.
const MIN_BASKET_COVERAGE = 0.75;

function computePropBasket(peerSeries, { minCoverage = MIN_BASKET_COVERAGE } = {}) {
  // peerSeries: [{ date, close, ... }] per ticker; may have different date ranges.
  // Failed fetches arrive as [] and still count toward the basket size, so a
  // run where most peers failed produces nothing rather than a thin basket.
  const basketSize = peerSeries.length;
  const sorted = peerSeries
    .map(s => s.slice().sort((a, b) => a.date.localeCompare(b.date)))
    .filter(s => s.length >= 2);

  const need = Math.max(1, Math.ceil(basketSize * minCoverage));
  if (sorted.length < need) return [];

  // Start on the first date by which `need` tickers have a prior row to
  // measure a % change against (each ticker's 2nd date, the need-th earliest).
  // Tickers whose history starts later simply join when they have one.
  const secondDates = sorted.map(s => s[1].date).sort();
  const startDate = secondDates[need - 1];

  // Now for each trading day at-or-after startDate that exists in every ticker,
  // compute equal-weighted mean % chg.
  const indices = sorted.map(s => {
    let i = 0;
    while (i < s.length && s[i].date < startDate) i++;
    return i; // first index >= startDate
  });

  const points = [];
  let level = 100.00;
  // Walk day by day from startDate; a day counts when enough tickers traded.
  // Find max date among all tickers
  const maxDates = sorted.map(s => s[s.length - 1].date).filter(Boolean);
  const maxDate = maxDates.sort().slice(-1)[0];

  // Iterate the calendar entirely in UTC. The bounds are parsed with an
  // explicit 'Z' and the cursor advances with setUTCDate, so `toISOString()`
  // renders exactly the calendar day we asked for.
  //
  // Previously the bounds were parsed WITHOUT 'Z' — i.e. in LOCAL time — while
  // toISOString() rendered UTC. That was dormant only because the Railway
  // container runs with no TZ set (so local === UTC); setting TZ=Asia/Bangkok
  // would have made every `iso` land one calendar day EARLIER than intended,
  // shifting the whole propIdx series and silently misaligning it against
  // `close` / `setIdx` in joinByDate() — a wrong chart with no error anywhere.
  //
  // The end bound is also hoisted out of the loop condition: it was being
  // re-parsed from a string on every single iteration of a multi-year walk.
  const endMs = new Date(maxDate + 'T00:00:00Z').getTime();
  for (let d = new Date(startDate + 'T00:00:00Z'); d.getTime() <= endMs; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const pcts = [];
    for (let t = 0; t < sorted.length; t++) {
      const s = sorted[t];
      // advance pointer while next is <= iso
      while (indices[t] + 1 < s.length && s[indices[t] + 1].date <= iso) indices[t]++;
      const cur = s[indices[t]];
      const prev = indices[t] > 0 ? s[indices[t] - 1] : null;
      // No row today (or nothing before it) → this ticker sits the day out.
      // When it trades again its change runs from its own last row, so its
      // move is still counted once, on the day it reappears.
      if (!cur || !prev || cur.date !== iso || !(prev.close > 0)) continue;
      pcts.push((cur.close - prev.close) / prev.close);
    }
    if (pcts.length < need) continue;
    const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
    level = level * (1 + mean);
    points.push({ date: iso, close: Number(level.toFixed(4)) });
  }
  return points;
}

// Chain a freshly-computed basket window onto the stored series.
//
// computePropBasket() re-bases every window to 100.00 at the window's own
// start. For the nightly cron that window is ~7 days, so it wrote ~100-scale
// values over a stored series sitting at a different level — and the next
// full-window refresh snapped them back. A sawtooth in daily.propIdx that the
// chart's normalized axis mostly hid, but the KPI reads raw values.
//
// Fix: multiply the whole window by one factor so its earliest point that
// also exists in the stored series lands exactly on the stored value. One
// factor (not per-point) preserves every daily % change inside the window.
// No stored overlap (fresh DB, or a backfill preceding all data) → return
// as-is, i.e. the window keeps its own base and BECOMES the reference.
function rescaleToStored(points, storedByDate) {
  if (!points || !points.length || !storedByDate || !storedByDate.size) return points;
  const hit = points.find(p => storedByDate.has(p.date) && p.close);
  if (!hit) return points;
  const k = storedByDate.get(hit.date) / hit.close;
  if (!Number.isFinite(k) || k <= 0) return points;
  if (Math.abs(k - 1) < 1e-9) return points;
  return points.map(p => ({ ...p, close: Number((p.close * k).toFixed(4)) }));
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

module.exports = { computePropBasket, rescaleToStored, joinByDate, PEER_TICKERS, PEER_NAMES };