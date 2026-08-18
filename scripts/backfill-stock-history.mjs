// =============================================================================
// One-off: extend a stock's price history back to its IPO date.
//
// WHY THIS EXISTS: the daily fetcher's window defaulted to "5 years back"
// whenever a stock's table was empty — an assumption from the era when ASW
// (IPO 2021-04-28) was the only stock. TITLE listed on mai on 2017-11-02, so
// its first backfill silently started at 2021-08-19 and lost ~3.75 years.
// lib/fetchers/index.js now anchors an empty stock at STOCKS[s].ipoDate; this
// script repairs the rows that were already written under the old rule.
//
// SURGICAL BY DESIGN — it writes ONLY rows strictly BEFORE the stock's current
// dateMin, for that ONE stock:
//   - no other stock's rows are read or written
//   - propIdx is left NULL on the new rows instead of recomputing the peer
//     basket. computePropBasket() re-bases to 100.00 at its first common date,
//     and ASW.BK is a basket member, so a wider fetch would silently re-anchor
//     the PROP series and rewrite the ASW dashboard's existing propIdx values.
//     Refusing to touch it is the whole point. (The basket cannot describe
//     2017-2021 anyway — several members, ASW included, had not listed yet.)
//   - setIdx IS filled: the SET index is an absolute level, not a re-based
//     synthetic, so old dates carry their true value.
//
// Run (dry-run prints the plan):
//     node scripts/backfill-stock-history.mjs --stock=TITLE
//     node scripts/backfill-stock-history.mjs --stock=TITLE --apply
// =============================================================================

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config({ path: new URL('../backend/.env', import.meta.url).pathname, quiet: true });

const db = require('../backend/db.js');
const { STOCKS, assertStock } = require('../backend/lib/stocks.js');
const yahoo = await import('../backend/lib/fetchers/yahoo.mjs');

const arg = (k, d = null) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const stock = (arg('stock') || '').toUpperCase();
const apply = process.argv.includes('--apply');
assertStock(stock, 'backfill-stock-history');

const cfg = STOCKS[stock];
if (!cfg.ipoDate) {
  console.error(`[backfill] ${stock} has no ipoDate in stocks.js — nothing to anchor on.`);
  process.exit(1);
}

db.openDb();
const meta = await db.metadata(stock);
console.log(`[backfill] ${stock} (${cfg.yahoo}) — IPO ${cfg.ipoDate}, stored ${meta.dateMin} → ${meta.dateMax} (${meta.rowCount} rows)`);

if (meta.dateMin && meta.dateMin <= cfg.ipoDate) {
  console.log('[backfill] history already reaches the IPO — nothing to do.');
  await db.closeDb();
  process.exit(0);
}
const boundary = meta.dateMin;   // first date we already have; new rows stay strictly before it

// Pull the stock's own series and the SET index over the missing span.
const [series, setSeries] = await Promise.all([
  yahoo.fetchSymbolDaily(cfg.yahoo, { sinceDate: cfg.ipoDate }),
  yahoo.fetchSymbolDaily(yahoo.SYMBOLS.set, { sinceDate: cfg.ipoDate }),
]);
const setByDate = new Map(setSeries.map(r => [r.date, r.close]));

// Chronological, gap-only, with day-over-day % change computed inside the gap.
const gap = series.filter(r => r.date < boundary).sort((a, b) => a.date.localeCompare(b.date));
const rows = gap.map((r, i) => ({
  date: r.date,
  close: r.close,
  change: i > 0 && gap[i - 1].close ? Number((((r.close - gap[i - 1].close) / gap[i - 1].close) * 100).toFixed(4)) : null,
  volume: r.volume ?? null,
  value: null,
  setIdx: setByDate.get(r.date) ?? null,
  propIdx: null,     // deliberate — see the header note
  remark: null,
}));

console.log(`[backfill] fetched ${series.length} candles; ${rows.length} fall before ${boundary}`);
if (!rows.length) { console.log('[backfill] nothing to write.'); await db.closeDb(); process.exit(0); }
console.log(`[backfill] first: ${rows[0].date} close=${rows[0].close?.toFixed(3)} setIdx=${rows[0].setIdx?.toFixed(2) ?? '∅'}`);
console.log(`[backfill] last:  ${rows[rows.length - 1].date} close=${rows[rows.length - 1].close?.toFixed(3)}`);

if (!apply) {
  console.log(`\n[backfill] DRY RUN — pass --apply to write these ${rows.length} rows (stock='${stock}' only).`);
  await db.closeDb();
  process.exit(0);
}

const { added, updated } = await db.writeRows(stock, rows);
console.log(`[backfill] wrote ${stock}: added=${added} updated=${updated}`);

// The old first row had change=null (nothing preceded it). Now something does.
const last = rows[rows.length - 1];
if (last.close) {
  const cur = await db.readAllRows(stock, boundary, boundary);
  const b = cur[0];
  if (b && b.close != null && b.change == null) {
    const pct = Number((((b.close - last.close) / last.close) * 100).toFixed(4));
    await db.setBoundaryChange(stock, boundary, pct);
    console.log(`[backfill] set ${boundary} change=${pct}% (was null — it used to be the earliest row)`);
  }
}

const after = await db.metadata(stock);
console.log(`[backfill] ${stock} now ${after.dateMin} → ${after.dateMax} (${after.rowCount} rows)`);
await db.closeDb();
