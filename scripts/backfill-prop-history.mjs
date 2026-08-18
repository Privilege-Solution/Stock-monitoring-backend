// =============================================================================
// One-off: extend the synthetic PROP index back through TITLE's mai era
// (2017-11-02 → the current series' first date) by BACK-CHAINING from the
// stored level — the stored values from the anchor date forward are preserved
// byte-identically, so the ASW dashboard's PROP KPI does not move.
//
// WHY BACK-CHAIN INSTEAD OF RECOMPUTING FROM 2017: computePropBasket()
// requires every basket member to trade on a date and re-bases to 100.00 at
// its window start. Several members (ASW itself, PRIME-era Proud) had not
// listed before 2021, so a full recompute would silently re-anchor the whole
// series and rewrite every stored value. Instead:
//
//   1. anchor  = the stored propIdx at --anchor (default 2021-08-19 — the
//      first date of the currently-consistent segment).
//   2. For dates before the anchor, compute the equal-weighted mean of daily
//      % changes across the basket members that DID trade (dynamic
//      membership, minimum --min-members, default 5).
//   3. Walk backwards: level[d_prev] = level[d] / (1 + meanPct[d]).
//   4. UPDATE daily.propIdx for dates strictly BEFORE the anchor — across
//      every stock's rows (the PROP series is shared context) — touching no
//      other column and no row at/after the anchor.
//
// The pre-anchor segment uses whichever members were listed at the time and
// is therefore a narrower basket than the post-anchor 20 — documented,
// deliberate, and strictly better than a blank line.
//
// Run:
//     node scripts/backfill-prop-history.mjs                 # dry-run
//     node scripts/backfill-prop-history.mjs --apply
//     node scripts/backfill-prop-history.mjs --anchor=YYYY-MM-DD --from=YYYY-MM-DD
// =============================================================================

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config({ path: new URL('../backend/.env', import.meta.url).pathname, quiet: true });

const db = require('../backend/db.js');
const { PEER_TICKERS } = require('../backend/lib/prop-basket.js');
const yahoo = await import('../backend/lib/fetchers/yahoo.mjs');

const arg = (k, d = null) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const apply = process.argv.includes('--apply');
const anchorDate = arg('anchor', '2021-08-19');
const fromDate = arg('from', '2017-10-15');     // a few weeks before TITLE's IPO for day-1 pct
const minMembers = Number(arg('min-members', '5'));

db.openDb();

// 1) the stored anchor level — first stored propIdx at/after --anchor.
const anchorRow = await (async () => {
  const m = await db.storedPropIdxMap(anchorDate, '9999-12-31');
  const first = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))[0];
  return first ? { date: first[0], level: first[1] } : null;
})();
if (!anchorRow) {
  console.error(`[prop-backfill] no stored propIdx at/after ${anchorDate} — nothing to chain from.`);
  process.exit(1);
}
console.log(`[prop-backfill] anchor: ${anchorRow.date} propIdx=${anchorRow.level.toFixed(4)} (stored values from here on are NOT touched)`);

// 2) peer closes over the gap (+ a little past the anchor so the anchor date
//    itself has a % change to divide out).
console.log(`[prop-backfill] fetching ${PEER_TICKERS.length} peers ${fromDate} → ~${anchorRow.date}...`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const seriesByTicker = [];
for (const t of PEER_TICKERS) {
  try {
    const rows = await yahoo.fetchSymbolDaily(t, { sinceDate: fromDate });
    seriesByTicker.push(rows.filter(r => r.date <= anchorRow.date));
  } catch (e) {
    console.warn(`[prop-backfill] ${t} failed (${e.message}) — continuing without it`);
    seriesByTicker.push([]);
  }
  await sleep(150);
}

// 3) per-date mean % change with dynamic membership.
const pctsByDate = new Map(); // date → number[]
for (const rows of seriesByTicker) {
  const s = rows.slice().sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < s.length; i++) {
    if (s[i].close == null || s[i - 1].close == null || !s[i - 1].close) continue;
    const list = pctsByDate.get(s[i].date) || [];
    list.push((s[i].close - s[i - 1].close) / s[i - 1].close);
    pctsByDate.set(s[i].date, list);
  }
}
const dates = [...pctsByDate.keys()].filter(d => d <= anchorRow.date).sort();
const meanAt = (d) => {
  const l = pctsByDate.get(d);
  return l && l.length >= minMembers ? l.reduce((a, b) => a + b, 0) / l.length : null;
};

// 4) walk backwards from the anchor. The anchor date's own % change is divided
//    out first so level[day-before-anchor] is consistent with the stored value.
const levels = new Map(); // date → level (dates strictly before the anchor)
let level = anchorRow.level;
for (let i = dates.length - 1; i >= 0; i--) {
  const d = dates[i];
  if (d > anchorRow.date) continue;
  const m = meanAt(d);
  if (m != null && m > -0.95) level = level / (1 + m);
  if (d < anchorRow.date) levels.set(d, Number(level.toFixed(4)));
}
const span = [...levels.keys()].sort();
const memberCounts = span.map(d => (pctsByDate.get(d) || []).length);
console.log(`[prop-backfill] chained ${span.length} dates ${span[0]} → ${span[span.length - 1]}`);
console.log(`[prop-backfill] level at ${span[0]}: ${levels.get(span[0])} | at ${span[span.length - 1]}: ${levels.get(span[span.length - 1])} | members min/median: ${Math.min(...memberCounts)}/${memberCounts.sort((a,b)=>a-b)[Math.floor(memberCounts.length/2)]}`);

if (!apply) {
  console.log('\n[prop-backfill] DRY RUN — pass --apply to write. Only rows with date <', anchorRow.date, 'are updated, propIdx column only.');
  await db.closeDb();
  process.exit(0);
}

// 5) one statement; both stocks' rows on those dates get the shared value.
const dArr = [...levels.keys()];
const vArr = dArr.map(d => levels.get(d));
const { getPool } = { getPool: null };
const pool = db.openDb();
const r = await pool.query(
  `UPDATE daily AS t SET "propIdx" = v.p
     FROM (SELECT unnest($1::text[]) AS d, unnest($2::float8[]) AS p) v
    WHERE t.date = v.d AND t.date < $3`,
  [dArr, vArr, anchorRow.date]
);
console.log(`[prop-backfill] updated ${r.rowCount} daily rows (across all stocks) — anchor and later untouched.`);
await db.closeDb();
