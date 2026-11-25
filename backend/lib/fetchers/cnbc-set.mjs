// SET Composite Index daily closes from CNBC's public chart feed (symbol .SETI).
//
// Why this exists: since ~20 Jul 2026 Yahoo's ^SET.BK returns only the current
// day's candle — every period/range query, including ones wholly in the past,
// comes back with at most one row. The peers and ASW/TITLE are unaffected.
// CNBC's chart feed (the one behind cnbc.com's quote pages) still serves full
// daily history, and its closes match the stored Yahoo values to the cent on
// every overlapping day checked (e.g. 2026-07-17 1639.04).
//
// Used only to FILL dates Yahoo's SET series is missing (see fillMissingDates);
// Yahoo stays the primary source whenever it has the day.

const CHART_URL = 'https://ts-api.cnbc.com/harmony/app/charts/';
export const CNBC_SET_SYMBOL = '.SETI';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json',
};

// Smallest CNBC range that still covers `sinceDate`. 1M ≈ 30 days, 1Y has
// shown ~2 years of bars, 5Y for IPO-length backfills.
export function rangeFor(sinceDate, now = new Date()) {
  if (!sinceDate) return '5Y';
  const days = (now.getTime() - new Date(sinceDate + 'T00:00:00Z').getTime()) / 86_400_000;
  if (days <= 25) return '1M';
  if (days <= 330) return '1Y';
  return '5Y';
}

// { barData: { priceBars: [{ close: "1639.0400", tradeTime: "20260717000000", ... }] } }
// → [{ date: '2026-07-17', close: 1639.04 }] sorted, one row per date, junk dropped.
export function parseCnbcBars(json) {
  const bars = json?.barData?.priceBars;
  if (!Array.isArray(bars)) return [];
  const byDate = new Map();
  for (const b of bars) {
    const t = String(b?.tradeTime ?? '');
    if (!/^\d{8}/.test(t)) continue;
    const close = Number(b.close);
    if (!Number.isFinite(close) || close <= 0) continue;
    const date = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
    byDate.set(date, { date, close }); // last bar for a date wins
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchSetIndexDaily({ sinceDate } = {}) {
  const url = CHART_URL + rangeFor(sinceDate) + '.json?symbol=' + encodeURIComponent(CNBC_SET_SYMBOL);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`CNBC ${CNBC_SET_SYMBOL} HTTP ${res.status}`);
      const rows = parseCnbcBars(await res.json());
      return sinceDate ? rows.filter(r => r.date >= sinceDate) : rows;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

// Primary series plus any date only the fallback has. Primary wins on overlap.
export function fillMissingDates(primary, fallback) {
  const have = new Set((primary || []).map(r => r.date));
  const extra = (fallback || []).filter(r => !have.has(r.date));
  if (!extra.length) return primary || [];
  return [...(primary || []), ...extra].sort((a, b) => a.date.localeCompare(b.date));
}

// True when the primary series lacks any date the reference (the stock's own
// trading days) has — i.e. the fallback is worth one extra request.
export function hasGaps(primary, referenceRows) {
  const have = new Set((primary || []).map(r => r.date));
  return (referenceRows || []).some(r => r.close != null && !have.has(r.date));
}
