'use strict';

// =============================================================================
// Multi-stock registry (migrate-v13). Single source of truth for which stocks
// this app monitors, their Yahoo symbols, and which news categories each
// panel uses. CommonJS on purpose: db.js / server.js / prop-basket.js are CJS
// and need synchronous access; ESM modules (news-taxonomy.mjs, fetchers)
// pull it in via createRequire, same as yahoo.mjs already does for
// prop-basket.js.
//
// NAMING HAZARD: this codebase uses "title" to mean *headline* everywhere
// (title_hash, title-match.mjs). The stock is always the value 'TITLE' in a
// variable named `stock` — never a bare `title` variable.
//
// Category vocabularies differ by design:
//   ASW   — Bangkok-resi developer: the original 7-way taxonomy.
//   TITLE — Phuket leisure-residence developer whose buyers are mostly
//           FOREIGN (Russians #1 by Phuket transfer value, then Chinese), so
//           its panel tracks the demand drivers of those buyers: wars &
//           sanctions (GEOPOLITICS), oil as the Russian-wealth proxy (OIL),
//           currencies & money movement (FX), and travel access (TOURISM).
//           No POLITICS bucket: Thai politics reaches TITLE through
//           tourism/FX, so the TITLE classifier folds it into MACRO.
// =============================================================================

const STOCKS = {
  ASW: {
    yahoo: 'ASW.BK',
    label: 'ASW',
    nameTh: 'แอสเซทไวส์',
    nameEn: 'AssetWise',
    ipoDate: '2021-04-28',   // SET debut (close ฿8.76)
    categories: ['COMPANY', 'COMPETITOR', 'RATES', 'GOV_POLICY', 'POLITICS', 'INDUSTRY', 'MACRO'],
  },
  TITLE: {
    yahoo: 'TITLE.BK',
    label: 'TITLE',
    nameTh: 'ร่มโพธิ์ พร็อพเพอร์ตี้',
    nameEn: 'Rhom Bho Property',
    // 2 Nov 2017 per SET's company profile — mai debut; moved to SET Jan 2026
    // under the same ticker. Anchors the empty-DB backfill window (the old
    // 5-year default was an ASW-era assumption and cut 2017→2021 off).
    ipoDate: '2017-11-02',
    // Order = tab order on the news view (product decision, scrutiny pass 4):
    // the user's named drivers (wars, oil, foreign money, tourism) come right
    // after COMPANY; the shared long-tail buckets close the row.
    categories: ['COMPANY', 'GEOPOLITICS', 'OIL', 'FX', 'TOURISM', 'GOV_POLICY', 'COMPETITOR', 'RATES', 'INDUSTRY', 'MACRO'],
  },
};

const STOCK_KEYS = Object.keys(STOCKS);
const DEFAULT_STOCK = 'ASW';

function isValidStock(s) {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(STOCKS, s);
}

// For WRITE paths: a missed/typo'd stock must fail loudly, not silently
// update both stocks' rows (the pre-v13 remark writers updated `daily` by
// date alone — with two stocks in the table that UPDATE would hit both).
function assertStock(s, context) {
  if (!isValidStock(s)) {
    throw new Error(`invalid stock ${JSON.stringify(s)}${context ? ` in ${context}` : ''} — expected one of: ${STOCK_KEYS.join(', ')}`);
  }
  return s;
}

// For READ paths / HTTP params: absent → default, present-but-garbage → null
// so the route can 400 instead of silently serving ASW data for a typo.
function normalizeStockParam(raw) {
  if (raw == null || raw === '') return DEFAULT_STOCK;
  const s = String(raw).toUpperCase();
  return isValidStock(s) ? s : null;
}

module.exports = { STOCKS, STOCK_KEYS, DEFAULT_STOCK, isValidStock, assertStock, normalizeStockParam };
