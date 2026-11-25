// =============================================================================
// One-off: restore the SET and PROP index values the daily price runs erased.
//
// Two faults stacked (both fixed in the same commit as this script):
//   - Yahoo's ^SET.BK stopped serving history around 20 Jul 2026 — every query
//     returns only today's candle — and writeRows() overwrote setIdx with
//     whatever the run had, so each 7-day self-heal run nulled six stored SET
//     closes. Result: no SET from 2026-07-20 to 2026-11-23.
//   - computePropBasket() needed all 20 peers on a day; one peer with a missing
//     or truncated series blanked the rest of the run's window, and the same
//     upsert wrote those NULLs over stored propIdx. Result: PROP mostly missing
//     from 2026-08-11, with stray single days between.
//
// What it writes (both stocks — setIdx/propIdx are shared across stock rows):
//   SET  — only where setIdx IS NULL, from CNBC's .SETI daily closes. Aborts if
//          CNBC disagrees with any stored SET close by more than 0.5%.
//   PROP — recomputed from Yahoo's peer history (complete again) with the
//          fixed basket, chained onto the last stored value before the first
//          gap, and written for every day after that anchor. The stray single
//          days in between came from broken windows, so they are replaced too,
//          giving one consistent series the nightly run then chains onto.
// Today is skipped (the session may still be open); the cron fills it.
//
// Run:
//   node scripts/repair-index-gaps.mjs                  # dry run
//   node scripts/repair-index-gaps.mjs --apply          # backup → one transaction
//   --from=YYYY-MM-DD  earliest date considered (default 2026-07-01)
// Undo: the backup file has every touched (stock, date, setIdx, propIdx) as it
//       was; write those values back.
// =============================================================================

import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env'), quiet: true });
const require = createRequire(import.meta.url);
const { default: db } = await import('../backend/db.js');
const { computePropBasket, rescaleToStored, PEER_TICKERS } = require('../backend/lib/prop-basket.js');
const { fetchSymbolDaily } = await import('../backend/lib/fetchers/yahoo.mjs');
const { fetchSetIndexDaily } = await import('../backend/lib/fetchers/cnbc-set.mjs');

const APPLY = process.argv.includes('--apply');
const FROM = (process.argv.find(a => a.startsWith('--from=')) || '--from=2026-07-01').slice(7);
if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM)) { console.error('bad --from'); process.exit(1); }
const TODAY = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); // ICT
const STOCKS = ['ASW', 'TITLE'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

const pool = db.openDb();
try {
  const { rows: stored } = await pool.query(
    `SELECT stock, date, close, "setIdx", "propIdx" FROM daily
      WHERE stock = ANY($1) AND date >= $2 AND date < $3 ORDER BY date`,
    [STOCKS, FROM, TODAY]);
  const byStock = Object.fromEntries(STOCKS.map(s => [s, stored.filter(r => r.stock === s)]));
  console.log(`stored rows ${FROM}..${addDays(TODAY, -1)}: ` + STOCKS.map(s => `${s} ${byStock[s].length}`).join(', '));

  // ── SET ────────────────────────────────────────────────────────────────────
  const cnbc = await fetchSetIndexDaily({ sinceDate: FROM });
  const cnbcBy = new Map(cnbc.map(r => [r.date, r.close]));
  let worst = 0, compared = 0;
  for (const r of byStock.ASW) {
    if (r.setIdx == null || !cnbcBy.has(r.date)) continue;
    compared++;
    worst = Math.max(worst, Math.abs(cnbcBy.get(r.date) / r.setIdx - 1));
  }
  console.log(`\nSET: CNBC ${cnbc.length} days (${cnbc[0]?.date}..${cnbc.at(-1)?.date}); vs ${compared} stored closes, worst diff ${(worst * 100).toFixed(3)}%`);
  if (!compared || worst > 0.005) throw new Error('CNBC does not match the stored SET series — aborting');
  const setFills = []; // [stock, date, value]
  const setMissing = [];
  for (const s of STOCKS) for (const r of byStock[s]) {
    if (r.setIdx != null) continue;
    if (cnbcBy.has(r.date)) setFills.push([s, r.date, cnbcBy.get(r.date)]);
    else if (r.close != null) setMissing.push(`${s} ${r.date}`);
  }
  console.log(`SET fills: ${setFills.length} (${STOCKS.map(s => `${s} ${setFills.filter(f => f[0] === s).length}`).join(', ')})`);
  if (setMissing.length) console.log(`  trading days CNBC also lacks: ${setMissing.join(', ')}`);

  // ── PROP ───────────────────────────────────────────────────────────────────
  const asw = byStock.ASW;
  const firstGap = asw.find(r => r.propIdx == null && r.close != null);
  let propWrites = [];
  if (!firstGap) {
    console.log('\nPROP: no gaps');
  } else {
    const anchor = [...asw].reverse().find(r => r.date < firstGap.date && r.propIdx != null);
    if (!anchor) throw new Error(`no stored propIdx before the first gap (${firstGap.date}) — widen --from`);
    console.log(`\nPROP: first gap ${firstGap.date}; anchor ${anchor.date} = ${anchor.propIdx}`);
    const peers = [];
    for (const t of PEER_TICKERS) {
      try { peers.push(await fetchSymbolDaily(t, { sinceDate: addDays(anchor.date, -14) })); }
      catch (e) { console.log(`  peer ${t} failed: ${e.message}`); peers.push([]); }
      await sleep(400);
    }
    const ok = peers.filter(p => p.length).length;
    console.log(`  peers fetched: ${ok}/${PEER_TICKERS.length}`);
    if (ok < PEER_TICKERS.length) throw new Error('not every peer came back — rerun later rather than repair from a thin basket');
    const raw = computePropBasket(peers);
    if (!raw.some(p => p.date === anchor.date)) throw new Error(`recomputed basket has no point on the anchor ${anchor.date}`);
    const chained = rescaleToStored(raw, new Map([[anchor.date, Number(anchor.propIdx)]]));
    const newBy = new Map(chained.filter(p => p.date > anchor.date && p.date < TODAY).map(p => [p.date, p.close]));

    // How far the stray stored days sit from the clean series (information only).
    const diffs = asw.filter(r => r.date > anchor.date && r.propIdx != null && newBy.has(r.date))
      .map(r => `${r.date} ${Number(r.propIdx).toFixed(2)}→${newBy.get(r.date).toFixed(2)}`);
    console.log(`  recomputed ${newBy.size} days after the anchor; stored values it replaces (${diffs.length}): ${diffs.join(', ') || 'none'}`);
    const stillMissing = asw.filter(r => r.date > anchor.date && r.close != null && !newBy.has(r.date)).map(r => r.date);
    if (stillMissing.length) console.log(`  ASW trading days still without PROP: ${stillMissing.join(', ')}`);

    for (const s of STOCKS) for (const r of byStock[s]) {
      if (r.date > anchor.date && newBy.has(r.date)) propWrites.push([s, r.date, newBy.get(r.date)]);
    }
    const sample = [...newBy].filter((_, i, a) => i % 10 === 0 || i === a.length - 1);
    console.log(`  sample: ${sample.map(([d, v]) => `${d} ${v.toFixed(2)}`).join(' | ')}`);
    console.log(`PROP writes: ${propWrites.length} (${STOCKS.map(s => `${s} ${propWrites.filter(f => f[0] === s).length}`).join(', ')})`);
  }

  if (!APPLY) { console.log('\ndry run — pass --apply to write'); process.exit(0); }
  if (!setFills.length && !propWrites.length) { console.log('\nnothing to write'); process.exit(0); }

  // ── backup + write ─────────────────────────────────────────────────────────
  const touched = new Set([...setFills, ...propWrites].map(([s, d]) => `${s}|${d}`));
  const backupRows = stored.filter(r => touched.has(`${r.stock}|${r.date}`))
    .map(r => ({ stock: r.stock, date: r.date, setIdx: r.setIdx, propIdx: r.propIdx }));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = join(__dirname, `backup-index-repair-${stamp}.json`);
  writeFileSync(backup, JSON.stringify(backupRows, null, 2));
  console.log(`\nbackup of ${backupRows.length} rows → ${backup}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const set = await client.query(
      `UPDATE daily d SET "setIdx" = v.val
         FROM unnest($1::text[], $2::text[], $3::float8[]) AS v(stock, dt, val)
        WHERE d.stock = v.stock AND d.date = v.dt AND d."setIdx" IS NULL`,
      [setFills.map(f => f[0]), setFills.map(f => f[1]), setFills.map(f => f[2])]);
    const prop = await client.query(
      `UPDATE daily d SET "propIdx" = v.val
         FROM unnest($1::text[], $2::text[], $3::float8[]) AS v(stock, dt, val)
        WHERE d.stock = v.stock AND d.date = v.dt`,
      [propWrites.map(f => f[0]), propWrites.map(f => f[1]), propWrites.map(f => f[2])]);
    await client.query('COMMIT');
    console.log(`updated setIdx ${set.rowCount}, propIdx ${prop.rowCount}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await db.closeDb();
}
