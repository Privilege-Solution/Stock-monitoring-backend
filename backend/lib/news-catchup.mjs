// =============================================================================
// Catch-up for the Gemini news pipelines: re-run a pipeline for the ICT days it
// missed.
//
// WHY: a live run only ever asks Gemini about TODAY, and its write gate admits
// events from the last DEDUP_WINDOW_HOURS (48h) only. So a day on which every
// run of a pipeline failed — Gemini 503s/timeouts that outlast the 3 retries,
// quota, a deploy outage — is asked about by nobody once two days have passed,
// and that day's news is lost for good. A pre-v13 backup showed 18–23 failed
// runs per pipeline in five weeks.
//
// WHAT COUNTS AS COVERED: pipeline P covers ICT day D when fetch_log holds an
// ok=1 row for P that either
//   - is a live run (target_date NULL) that STARTED on D, ICT; or
//   - is a catch-up run whose target_date is D.
// Anything else in the lookback window — the `lookbackDays` days before today;
// today itself is the live pass's job — is missed.
//
// BOUNDS, so a long outage cannot turn into a quota burn:
//   - at most `maxRunsPerBatch` catch-up runs per news batch (5 batches a day);
//   - a (pipeline, day) that has failed `maxAttempts` catch-ups is given up on;
//   - the pass stops at the first failure that looks like Gemini itself being
//     down (429 / 5xx / timeout): every remaining run would fail the same way,
//     each after ~100 s of retries;
//   - the caller skips the pass entirely when no live Gemini run in the batch
//     succeeded.
//
// ORDER: round-robin across pipelines, so one pipeline's long outage cannot
// starve the others; oldest day first within a pipeline, because it is the next
// to fall out of the lookback window.
//
// DAILY SUMMARIES: the day's digest (news_daily_summary) was written — or
// failed — while the day's news was missing, so once a catch-up adds rows to a
// day, that stock's summary for the day is regenerated in the same pass. The
// need is read from fetch_log, not remembered in memory: a stock-day needs one
// while a catch-up that ADDED rows to it (rows_added > 0) has no successful
// summary row (target_date = that day) started after it. A summary that fails,
// or is skipped because Gemini went down mid-pass, is therefore retried on the
// next pass, up to maxAttempts failures per recovery, and a later recovery of
// the same day asks for a fresh one.
//
// Pure planning (findMissedDays / planCatchUp / findStaleSummaries) is separate
// from the executor (runCatchUp), which takes its DB and fetch functions as
// arguments so the whole loop can be tested against an in-memory fetch_log.
// =============================================================================

// The five Gemini news-search pipelines. The stock is part of the pipeline
// (title-* are TITLE's), so "per stock and pipeline" is "per source".
export const CATCHUP_SOURCES = Object.freeze([
  'gemini-company',
  'gemini-sector',
  'gemini-macro',
  'gemini-title-company',
  'gemini-title-drivers',
]);

const STOCK_OF_SOURCE = Object.freeze({
  'gemini-company':       'ASW',
  'gemini-sector':        'ASW',
  'gemini-macro':         'ASW',
  'gemini-title-company': 'TITLE',
  'gemini-title-drivers': 'TITLE',
});

// The daily-summary fetch source per stock (same names the evening batch and
// POST /api/daily-summary/refresh use).
export const SUMMARY_SOURCE = Object.freeze({
  ASW:   'gemini-daily-summary',
  TITLE: 'gemini-title-daily-summary',
});

export const CATCHUP_DEFAULTS = Object.freeze({
  lookbackDays: 7,
  maxRunsPerBatch: 5,
  maxAttempts: 3,
});

const ICT_OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 864e5;

// ICT calendar day of an instant ('YYYY-MM-DD'), or null if unparseable.
export function ictDate(ts) {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + ICT_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

// The days a catch-up may target, oldest first: the `lookbackDays` days before
// `todayIso`. Today is excluded — the batch that runs this has just done
// today's live pass.
export function candidateDays(todayIso, lookbackDays) {
  const out = [];
  for (let n = lookbackDays; n >= 1; n--) out.push(addDays(todayIso, -n));
  return out;
}

// The earliest started_at that can matter for this window: midnight ICT of the
// oldest candidate day, as an ISO UTC string (fetch_log.started_at's format).
export function runsSinceTs(todayIso, lookbackDays) {
  const oldest = addDays(todayIso, -lookbackDays);
  return new Date(Date.parse(`${oldest}T00:00:00Z`) - ICT_OFFSET_MS).toISOString();
}

// From fetch_log rows ({ source, ok, started_at, target_date }), the
// (source, day) pairs in the window with no successful run. `exhausted` lists
// the pairs skipped because their catch-ups have already failed maxAttempts
// times — reported so the operator can see what was given up on.
export function findMissedDays(runs, {
  todayIso,
  sources = CATCHUP_SOURCES,
  lookbackDays = CATCHUP_DEFAULTS.lookbackDays,
  maxAttempts = CATCHUP_DEFAULTS.maxAttempts,
} = {}) {
  const covered = new Map(sources.map(s => [s, new Set()]));
  const failures = new Map();                    // `${source}|${day}` → count
  for (const r of runs || []) {
    const days = covered.get(r.source);
    if (!days) continue;                         // another source, or a 'pending' row
    if (Number(r.ok) === 1) {
      const day = r.target_date || ictDate(r.started_at);
      if (day) days.add(day);
    } else if (r.target_date) {
      // A failed LIVE run does not count against the day: it is the very
      // thing catch-up exists to repair. Only failed catch-ups are capped.
      const key = `${r.source}|${r.target_date}`;
      failures.set(key, (failures.get(key) || 0) + 1);
    }
  }

  const missed = [], exhausted = [];
  for (const source of sources) {
    for (const date of candidateDays(todayIso, lookbackDays)) {
      if (covered.get(source).has(date)) continue;
      const attempts = failures.get(`${source}|${date}`) || 0;
      if (attempts >= maxAttempts) exhausted.push({ source, date, attempts });
      else missed.push({ source, date, attempts });
    }
  }
  return { missed, exhausted };
}

// Pick at most `maxRuns` of the missed pairs: round-robin across sources,
// oldest day first within each.
export function planCatchUp(missed, maxRuns) {
  const bySource = new Map();
  for (const m of missed) {
    if (!bySource.has(m.source)) bySource.set(m.source, []);
    bySource.get(m.source).push(m);
  }
  const queues = [...bySource.values()].map(q => [...q].sort((a, b) => a.date.localeCompare(b.date)));
  const plan = [];
  while (plan.length < maxRuns && queues.some(q => q.length)) {
    for (const q of queues) {
      if (plan.length >= maxRuns) break;
      if (q.length) plan.push(q.shift());
    }
  }
  return plan;
}

// The stock-days whose daily summary is out of date because a catch-up added
// rows to them after the last successful summary for that day (see the header).
// `exhausted` lists the ones whose summary has failed maxAttempts times since
// the latest recovery. Oldest day first.
export function findStaleSummaries(runs, {
  todayIso,
  sources = CATCHUP_SOURCES,
  lookbackDays = CATCHUP_DEFAULTS.lookbackDays,
  maxAttempts = CATCHUP_DEFAULTS.maxAttempts,
} = {}) {
  const window = new Set(candidateDays(todayIso, lookbackDays));
  const pipelines = new Set(sources);
  const recoveredAt = new Map();                 // `${stock}|${day}` → latest started_at
  for (const r of runs || []) {
    if (!pipelines.has(r.source) || !r.target_date || !window.has(r.target_date)) continue;
    if (Number(r.ok) !== 1 || !(Number(r.rows_added) > 0)) continue;
    const key = `${STOCK_OF_SOURCE[r.source]}|${r.target_date}`;
    if (!recoveredAt.has(key) || r.started_at > recoveredAt.get(key)) recoveredAt.set(key, r.started_at);
  }

  const stale = [], exhausted = [];
  for (const [key, since] of recoveredAt) {
    const [stock, date] = key.split('|');
    const source = SUMMARY_SOURCE[stock];
    let done = false, attempts = 0;
    for (const r of runs) {
      if (r.source !== source || r.target_date !== date || !(r.started_at > since)) continue;
      if (Number(r.ok) === 1) done = true;
      else attempts++;
    }
    if (done) continue;
    (attempts >= maxAttempts ? exhausted : stale).push({ stock, source, date, attempts });
  }
  const byDay = (a, b) => a.date.localeCompare(b.date) || a.stock.localeCompare(b.stock);
  return { stale: stale.sort(byDay), exhausted: exhausted.sort(byDay) };
}

// Read the bounds from the environment. GEMINI_CATCHUP_MAX_PER_BATCH=0 turns
// catch-up off; GEMINI_CATCHUP_DAYS is clamped to 1..14 (Gemini's grounded
// search is not much use for news older than that, and every day in the
// window is a potential Gemini call per pipeline).
export function catchUpConfig(env = {}) {
  const int = (v, dflt, lo, hi) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    lookbackDays:    int(env.GEMINI_CATCHUP_DAYS, CATCHUP_DEFAULTS.lookbackDays, 1, 14),
    maxRunsPerBatch: int(env.GEMINI_CATCHUP_MAX_PER_BATCH, CATCHUP_DEFAULTS.maxRunsPerBatch, 0, 25),
    maxAttempts:     CATCHUP_DEFAULTS.maxAttempts,
  };
}

// One catch-up pass: missed pipeline-days first, then the daily summaries of
// the stock-days that gained rows.
//
//   db        — { readFetchRuns(sources, sinceTs), logFetchStart(),
//                 logFetchFinish(id, ok, source, added, updated, error, targetDate) }
//   runFetch  — ({ source, targetDate }) for a pipeline, ({ source, sinceDate })
//               for a daily summary → result with .ok / .inserted
//   isOutage  — (error) → true when the failure means Gemini itself is down
//
// Every run gets its own fetch_log row carrying target_date, success or
// failure — that row is what marks the day covered (ok=1) or counts an attempt
// (ok=0) for the next pass. Summaries are bounded by maxRunsPerBatch too; one
// pass cannot recover more stock-days than that, so the bound only bites when
// earlier passes left summaries owing.
export async function runCatchUp({
  db,
  runFetch,
  isOutage = () => false,
  todayIso,
  sources = CATCHUP_SOURCES,
  lookbackDays = CATCHUP_DEFAULTS.lookbackDays,
  maxRunsPerBatch = CATCHUP_DEFAULTS.maxRunsPerBatch,
  maxAttempts = CATCHUP_DEFAULTS.maxAttempts,
  log = () => {},
} = {}) {
  const summary = {
    missed: 0, exhausted: 0, planned: 0, results: [], summaries: [], stoppedEarly: false,
  };
  if (!(maxRunsPerBatch > 0)) return summary;

  const summarySources = [...new Set(sources.map(s => SUMMARY_SOURCE[STOCK_OF_SOURCE[s]]).filter(Boolean))];
  const readRuns = () => db.readFetchRuns([...sources, ...summarySources], runsSinceTs(todayIso, lookbackDays));
  const opts = { todayIso, sources, lookbackDays, maxAttempts };

  // One fetch_log row per run, target_date always set. Returns false when the
  // failure says Gemini is down and the rest of the pass should not try.
  const runLogged = async (label, source, date, args, rowsAdded, record) => {
    const id = await db.logFetchStart();
    try {
      const r = await runFetch(args);
      const ok = r?.ok !== false;
      await db.logFetchFinish(id, ok ? 1 : 0, source, rowsAdded(r, ok), 0, r?.error || null, date);
      record({ ok, r });
      // runDailySummary's `reason` is either a skip status or the tone's
      // rationale; only the statuses belong in this line.
      const why = ['no-news', 'empty'].includes(r?.reason) ? ` (${r.reason})` : '';
      log(`catch-up ${label} ${ok ? 'ok' : 'not ok'}${why} fetched=${r?.fetched ?? r?.sourceCount ?? '?'} inserted=${r?.inserted ?? 0}`);
      return true;
    } catch (e) {
      const msg = String(e?.message || e);
      await db.logFetchFinish(id, 0, source, 0, 0, msg, date);
      record({ ok: false, error: msg });
      log(`catch-up ${label} failed: ${msg.slice(0, 200)}`);
      if (!isOutage(e)) return true;
      summary.stoppedEarly = true;
      log('catch-up: Gemini looks unavailable — stopping this pass');
      return false;
    }
  };

  // 1. Missed pipeline-days.
  const { missed, exhausted } = findMissedDays(await readRuns(), opts);
  const plan = planCatchUp(missed, maxRunsPerBatch);
  Object.assign(summary, { missed: missed.length, exhausted: exhausted.length, planned: plan.length });
  if (exhausted.length) {
    log(`catch-up: giving up on ${exhausted.map(e => `${e.source}@${e.date}`).join(', ')} after ${maxAttempts} failed attempts each`);
  }
  if (plan.length) {
    log(`catch-up: ${missed.length} missed pipeline-day(s) in the last ${lookbackDays} days; running ${plan.length}`);
  }
  for (const job of plan) {
    const go = await runLogged(
      `${job.source}@${job.date}`, job.source, job.date,
      { source: job.source, targetDate: job.date },
      (r) => r?.inserted || 0,
      ({ ok, r, error }) => summary.results.push({ ...job, ok, inserted: r?.inserted || 0, ...(error ? { error } : {}) }),
    );
    if (!go) return summary;
  }

  // 2. Daily summaries of the stock-days that gained rows — read back from
  //    fetch_log, so it includes what step 1 just wrote and anything an
  //    earlier pass left owing.
  const { stale, exhausted: gaveUp } = findStaleSummaries(await readRuns(), opts);
  if (gaveUp.length) {
    log(`catch-up: giving up on the daily summary for ${gaveUp.map(e => `${e.stock}@${e.date}`).join(', ')} after ${maxAttempts} failed attempts each`);
  }
  for (const job of stale.slice(0, maxRunsPerBatch)) {
    const go = await runLogged(
      `${job.source}@${job.date}`, job.source, job.date,
      // sinceDate is the daily summary's "which day" parameter.
      { source: job.source, sinceDate: job.date },
      (r, ok) => (ok ? 1 : 0),                    // as the evening batch logs it
      ({ ok, error }) => summary.summaries.push({ ...job, ok, ...(error ? { error } : {}) }),
    );
    if (!go) break;
  }
  return summary;
}
