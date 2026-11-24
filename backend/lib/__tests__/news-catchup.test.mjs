// Gemini catch-up: which (pipeline, ICT day) pairs count as missed, how a pass
// is bounded, and that the executor's fetch_log rows close the loop. No DB, no
// Gemini — fetch_log is an in-memory array.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATCHUP_SOURCES, ictDate, addDays, candidateDays, runsSinceTs,
  findMissedDays, planCatchUp, catchUpConfig, runCatchUp,
} from '../news-catchup.mjs';

const TODAY = '2026-11-24';
// A live run that started at `hhmm` ICT on `day`.
const live = (source, day, ok = 1, hhmm = '08:00') => ({
  source, ok, started_at: new Date(`${day}T${hhmm}:00+07:00`).toISOString(), target_date: null,
});
const catchup = (source, target, ok = 1) => ({
  source, ok, started_at: new Date(`${TODAY}T21:10:00+07:00`).toISOString(), target_date: target,
});
const only = (source) => ({ todayIso: TODAY, sources: [source], lookbackDays: 7 });
const dates = (list) => list.map(m => m.date);

// ---- day arithmetic ------------------------------------------------------------
test('ictDate files an instant under its Bangkok calendar day', () => {
  assert.equal(ictDate('2026-11-19T16:59:59.000Z'), '2026-11-19');   // 23:59:59 ICT
  assert.equal(ictDate('2026-11-19T17:00:00.000Z'), '2026-11-20');   // 00:00 ICT
  assert.equal(ictDate('not a date'), null);
});

test('candidateDays is the lookback window before today, oldest first, today excluded', () => {
  assert.deepEqual(candidateDays(TODAY, 3), ['2026-11-21', '2026-11-22', '2026-11-23']);
  assert.deepEqual(candidateDays('2026-03-02', 3), ['2026-02-27', '2026-02-28', '2026-03-01']);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('runsSinceTs starts at midnight ICT of the oldest candidate day', () => {
  assert.equal(runsSinceTs(TODAY, 7), '2026-11-16T17:00:00.000Z');    // 2026-11-17 00:00 ICT
});

// ---- findMissedDays --------------------------------------------------------------
test('with no runs at all, every day of the window is missed for every pipeline', () => {
  const { missed } = findMissedDays([], { todayIso: TODAY, lookbackDays: 7 });
  assert.equal(missed.length, 7 * CATCHUP_SOURCES.length);
  assert.ok(!missed.some(m => m.date === TODAY), 'today is the live pass, never a catch-up');
});

test('one successful live run covers its ICT day; failed ones do not', () => {
  const runs = [];
  for (const d of candidateDays(TODAY, 7)) runs.push(live('gemini-macro', d));
  runs.push(live('gemini-macro', '2026-11-20', 0));                    // extra failure: harmless
  // 2026-11-21: every run that day failed.
  runs.splice(runs.findIndex(r => ictDate(r.started_at) === '2026-11-21'), 1,
    live('gemini-macro', '2026-11-21', 0, '08:00'), live('gemini-macro', '2026-11-21', 0, '21:00'));
  assert.deepEqual(dates(findMissedDays(runs, only('gemini-macro')).missed), ['2026-11-21']);
});

test('a run just after midnight ICT covers the new day, not the UTC one', () => {
  // 00:30 ICT on 11-23 is 17:30 UTC on 11-22.
  const runs = candidateDays(TODAY, 7).filter(d => d !== '2026-11-23').map(d => live('gemini-sector', d));
  runs.push(live('gemini-sector', '2026-11-23', 1, '00:30'));
  assert.deepEqual(findMissedDays(runs, only('gemini-sector')).missed, []);
});

test('coverage is per pipeline: a company success does not cover sector', () => {
  const runs = candidateDays(TODAY, 7).map(d => live('gemini-company', d));
  const { missed } = findMissedDays(runs, { todayIso: TODAY, sources: ['gemini-company', 'gemini-sector'], lookbackDays: 7 });
  assert.deepEqual([...new Set(missed.map(m => m.source))], ['gemini-sector']);
  assert.equal(missed.length, 7);
});

test('a successful catch-up covers its TARGET day, not the day it ran', () => {
  const runs = candidateDays(TODAY, 7)
    .filter(d => d !== '2026-11-19')
    .map(d => live('gemini-title-drivers', d));
  runs.push(catchup('gemini-title-drivers', '2026-11-19'));
  assert.deepEqual(findMissedDays(runs, only('gemini-title-drivers')).missed, []);
});

test('failed catch-ups are counted, and the day is given up on at maxAttempts', () => {
  const src = 'gemini-title-company';
  const runs = candidateDays(TODAY, 7).filter(d => d !== '2026-11-18' && d !== '2026-11-22').map(d => live(src, d));
  runs.push(catchup(src, '2026-11-18', 0), catchup(src, '2026-11-18', 0), catchup(src, '2026-11-18', 0));
  runs.push(catchup(src, '2026-11-22', 0));
  const { missed, exhausted } = findMissedDays(runs, { ...only(src), maxAttempts: 3 });
  assert.deepEqual(missed.map(m => [m.date, m.attempts]), [['2026-11-22', 1]]);
  assert.deepEqual(exhausted.map(m => [m.date, m.attempts]), [['2026-11-18', 3]]);
});

test('rows from other sources and unfinished "pending" rows are ignored', () => {
  const runs = candidateDays(TODAY, 7).map(d => live('gemini-company', d));
  runs.push({ source: 'pending', ok: 0, started_at: new Date().toISOString(), target_date: null });
  runs.push(live('rss-property', '2026-11-20'));
  assert.deepEqual(findMissedDays(runs, only('gemini-company')).missed, []);
});

test('runs outside the window neither cover nor count', () => {
  const runs = [live('gemini-macro', '2026-11-10'), live('gemini-macro', TODAY)];
  assert.equal(findMissedDays(runs, only('gemini-macro')).missed.length, 7);
});

// ---- planCatchUp ------------------------------------------------------------------
test('planCatchUp round-robins across pipelines, oldest day first, and stops at the bound', () => {
  const { missed } = findMissedDays([], { todayIso: TODAY, lookbackDays: 3 });
  const plan = planCatchUp(missed, 7);
  assert.equal(plan.length, 7);
  assert.deepEqual(plan.slice(0, 5).map(p => p.source), CATCHUP_SOURCES);
  assert.ok(plan.slice(0, 5).every(p => p.date === '2026-11-21'));
  assert.deepEqual(plan.slice(5).map(p => `${p.source}@${p.date}`),
    ['gemini-company@2026-11-22', 'gemini-sector@2026-11-22']);
});

test('planCatchUp gives one pipeline the whole budget when it is the only one behind', () => {
  const missed = [{ source: 'gemini-sector', date: '2026-11-23' }, { source: 'gemini-sector', date: '2026-11-20' }];
  assert.deepEqual(dates(planCatchUp(missed, 5)), ['2026-11-20', '2026-11-23']);
  assert.deepEqual(planCatchUp(missed, 0), []);
});

// ---- catchUpConfig ------------------------------------------------------------------
test('catchUpConfig: defaults, an off switch, and clamps', () => {
  assert.deepEqual(catchUpConfig({}), { lookbackDays: 7, maxRunsPerBatch: 5, maxAttempts: 3 });
  assert.equal(catchUpConfig({ GEMINI_CATCHUP_MAX_PER_BATCH: '0' }).maxRunsPerBatch, 0);
  assert.equal(catchUpConfig({ GEMINI_CATCHUP_MAX_PER_BATCH: '999' }).maxRunsPerBatch, 25);
  assert.equal(catchUpConfig({ GEMINI_CATCHUP_MAX_PER_BATCH: 'lots' }).maxRunsPerBatch, 5);
  assert.equal(catchUpConfig({ GEMINI_CATCHUP_DAYS: '60' }).lookbackDays, 14);
  assert.equal(catchUpConfig({ GEMINI_CATCHUP_DAYS: '-2' }).lookbackDays, 1);
});

// ---- runCatchUp (executor) ---------------------------------------------------------
// In-memory fetch_log with the same contract as db.js.
function fakeDb(rows = []) {
  const log = rows.map((r, i) => ({ id: i + 1, ...r }));
  return {
    log,
    async readFetchRuns(sources, sinceTs) {
      return log.filter(r => sources.includes(r.source) && r.started_at >= sinceTs);
    },
    async logFetchStart() {
      const row = { id: log.length + 1, source: 'pending', ok: 0, started_at: new Date(`${TODAY}T21:05:00+07:00`).toISOString(), target_date: null };
      log.push(row);
      return row.id;
    },
    async logFetchFinish(id, ok, source, added, updated, error, targetDate = null) {
      Object.assign(log.find(r => r.id === id), { ok, source, rows_added: added, error, target_date: targetDate });
    },
  };
}

// Every pipeline fully covered except the listed (source, day) pairs.
function coveredExcept(gaps) {
  const rows = [];
  for (const s of CATCHUP_SOURCES) {
    for (const d of candidateDays(TODAY, 7)) {
      if (!gaps.some(([gs, gd]) => gs === s && gd === d)) rows.push(live(s, d));
    }
  }
  return rows;
}

test('runCatchUp re-runs each missed day with its target date and records it in fetch_log', async () => {
  const db = fakeDb(coveredExcept([['gemini-company', '2026-11-20'], ['gemini-title-drivers', '2026-11-21']]));
  const calls = [];
  const runFetch = async (args) => { calls.push(args); return { ok: true, inserted: 2, fetched: 3 }; };

  const s = await runCatchUp({ db, runFetch, todayIso: TODAY });
  assert.deepEqual(calls, [
    { source: 'gemini-company', targetDate: '2026-11-20' },
    { source: 'gemini-title-drivers', targetDate: '2026-11-21' },
  ]);
  assert.equal(s.planned, 2);
  const written = db.log.filter(r => r.target_date);
  assert.deepEqual(written.map(r => [r.source, r.target_date, r.ok, r.rows_added]), [
    ['gemini-company', '2026-11-20', 1, 2],
    ['gemini-title-drivers', '2026-11-21', 1, 2],
  ]);

  // The rows it wrote close the gap: the next pass has nothing to do.
  calls.length = 0;
  const again = await runCatchUp({ db, runFetch, todayIso: TODAY });
  assert.equal(again.planned, 0);
  assert.deepEqual(calls, []);
});

test('runCatchUp never exceeds maxRunsPerBatch, however far behind', async () => {
  const db = fakeDb();                                  // a week of nothing
  let n = 0;
  const s = await runCatchUp({ db, runFetch: async () => { n++; return { ok: true }; }, todayIso: TODAY, maxRunsPerBatch: 5 });
  assert.equal(n, 5);
  assert.equal(s.missed, 35);
});

test('runCatchUp stops at the first outage-type failure and logs it as a failed attempt', async () => {
  const db = fakeDb(coveredExcept([
    ['gemini-company', '2026-11-20'], ['gemini-sector', '2026-11-20'], ['gemini-macro', '2026-11-20'],
  ]));
  const outage = Object.assign(new Error('Gemini 503: overloaded'), { status: 503 });
  let n = 0;
  const s = await runCatchUp({
    db, todayIso: TODAY,
    runFetch: async () => { n++; throw outage; },
    isOutage: (e) => e.status === 503,
  });
  assert.equal(n, 1);
  assert.equal(s.stoppedEarly, true);
  const failed = db.log.filter(r => r.target_date);
  assert.deepEqual(failed.map(r => [r.source, r.target_date, r.ok]), [['gemini-company', '2026-11-20', 0]]);
  assert.match(failed[0].error, /503/);
});

test('a non-outage failure (bad answer for one day) does not stop the pass', async () => {
  const db = fakeDb(coveredExcept([['gemini-company', '2026-11-20'], ['gemini-sector', '2026-11-20']]));
  const seen = [];
  await runCatchUp({
    db, todayIso: TODAY,
    isOutage: (e) => e.status >= 500,
    runFetch: async ({ source }) => {
      seen.push(source);
      if (source === 'gemini-company') throw new Error('Gemini returned no usable text (finishReason=MAX_TOKENS)');
      return { ok: true, inserted: 1 };
    },
  });
  assert.deepEqual(seen, ['gemini-company', 'gemini-sector']);
});

test('a day that keeps failing is retried maxAttempts times in all, then left alone', async () => {
  const db = fakeDb(coveredExcept([['gemini-macro', '2026-11-22']]));
  let n = 0;
  const pass = () => runCatchUp({ db, todayIso: TODAY, runFetch: async () => { n++; throw new Error('bad'); } });
  for (let i = 0; i < 5; i++) await pass();
  assert.equal(n, 3);
  const last = await pass();
  assert.equal(last.exhausted, 1);
  assert.equal(last.planned, 0);
});

test('maxRunsPerBatch = 0 turns catch-up off without touching fetch_log', async () => {
  let read = false;
  const db = { ...fakeDb(), readFetchRuns: async () => { read = true; return []; } };
  const s = await runCatchUp({ db, runFetch: async () => ({ ok: true }), todayIso: TODAY, maxRunsPerBatch: 0 });
  assert.equal(read, false);
  assert.equal(s.planned, 0);
});
