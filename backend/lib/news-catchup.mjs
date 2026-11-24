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
// Pure planning (findMissedDays / planCatchUp) is separate from the executor
// (runCatchUp), which takes its DB and fetch functions as arguments so the
// whole loop can be tested against an in-memory fetch_log.
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

// One catch-up pass.
//
//   db        — { readFetchRuns(sources, sinceTs), logFetchStart(),
//                 logFetchFinish(id, ok, source, added, updated, error, targetDate) }
//   runFetch  — ({ source, targetDate }) → result with .ok / .inserted
//   isOutage  — (error) → true when the failure means Gemini itself is down
//
// Every run gets its own fetch_log row carrying target_date, success or
// failure — that row is what marks the day covered (ok=1) or counts an attempt
// (ok=0) for the next pass.
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
  const summary = { missed: 0, exhausted: 0, planned: 0, results: [], stoppedEarly: false };
  if (!(maxRunsPerBatch > 0)) return summary;

  const runs = await db.readFetchRuns([...sources], runsSinceTs(todayIso, lookbackDays));
  const { missed, exhausted } = findMissedDays(runs, { todayIso, sources, lookbackDays, maxAttempts });
  const plan = planCatchUp(missed, maxRunsPerBatch);
  Object.assign(summary, { missed: missed.length, exhausted: exhausted.length, planned: plan.length });
  if (exhausted.length) {
    log(`catch-up: giving up on ${exhausted.map(e => `${e.source}@${e.date}`).join(', ')} after ${maxAttempts} failed attempts each`);
  }
  if (!plan.length) return summary;
  log(`catch-up: ${missed.length} missed pipeline-day(s) in the last ${lookbackDays} days; running ${plan.length}`);

  for (const job of plan) {
    const id = await db.logFetchStart();
    try {
      const r = await runFetch({ source: job.source, targetDate: job.date });
      const ok = r?.ok !== false;
      await db.logFetchFinish(id, ok ? 1 : 0, job.source, r?.inserted || 0, 0, r?.error || null, job.date);
      summary.results.push({ ...job, ok, inserted: r?.inserted || 0 });
      log(`catch-up ${job.source}@${job.date} ${ok ? 'ok' : 'not ok'} fetched=${r?.fetched ?? '?'} inserted=${r?.inserted ?? 0}`);
    } catch (e) {
      const msg = String(e?.message || e);
      await db.logFetchFinish(id, 0, job.source, 0, 0, msg, job.date);
      summary.results.push({ ...job, ok: false, error: msg });
      log(`catch-up ${job.source}@${job.date} failed: ${msg.slice(0, 200)}`);
      if (isOutage(e)) {
        summary.stoppedEarly = true;
        log('catch-up: Gemini looks unavailable — stopping this pass');
        break;
      }
    }
  }
  return summary;
}
