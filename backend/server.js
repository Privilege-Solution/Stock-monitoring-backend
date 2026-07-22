'use strict';

// Load .env (gitignored) BEFORE any module that reads process.env at import
// time — dotenv mutates process.env in place, so require-order matters.
// Path is resolved from __dirname (backend/) so it works regardless of the
// CWD `npm run dev` is launched from — the env file lives at backend/.env.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const db = require('./db');
const { runFetch, runIntraday } = require('./lib/fetchers');
const { expectedTradingDays, classify, isMarketOpen } = require('./lib/thai-trading-days');

// Lazy ESM import of the shared news taxonomy (news-taxonomy.mjs is ESM;
// server.js is CommonJS, so we use dynamic import() and cache it). Used by
// POST /api/news to auto-classify the category of a manually-added headline.
let _taxonomy = null;
async function loadTaxonomy() {
  if (!_taxonomy) _taxonomy = await import('./lib/news-taxonomy.mjs');
  return _taxonomy;
}

const PORT = process.env.PORT || 3000;
const app = express();
app.use(cors());
app.use(express.json());
// Static: serve the frontend/ dir (HTML/CSS), plus an explicit route for the
// repo-root `sample_data.js` (the frontend loads it via <script src> and the
// seed function below reads it from disk — both need an exact path).
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const REPO_ROOT    = path.join(__dirname, '..');
app.get('/sample_data.js', (req, res) =>
  res.sendFile('sample_data.js', { root: REPO_ROOT })
);
app.use(express.static(FRONTEND_DIR));

// In-memory live-ticker cache. Decoupled from `daily.close` so the chart's
// ASW line shows only end-of-day closes while the KPI shows the latest
// intraday tick. Populated by the `*/3` intraday cron and reset on process
// restart (acceptable: first poll after restart falls back to DATA[last]).
const INTRADAY = {
  price: null,
  prevClose: null,
  ts: null,         // unix ms of latest Yahoo tick
  marketOpen: false,
  source: null,     // 'yahoo'
  lastError: null,
};

// --- Seed from sample_data.js on first boot ---
// sample_data.js still ships a window.SAMPLE_DATA array; we use it as a
// last-resort seed ONLY when the DB is empty AND Postgres is unreachable.
// In the Postgres-only world this is rarely hit, but kept for offline dev.
//
// SKIP_SAMPLE_SEED=1  →  bypass this entirely (used after a fresh wipe so the
// dashboard stays empty until a real backfill is triggered, rather than
// showing 595 rows of stale sample prices that get overwritten seconds later).
function seedFromSampleData() {
  if (process.env.SKIP_SAMPLE_SEED === '1') {
    console.log('[seed] SKIP_SAMPLE_SEED=1 — skipping sample_data.js');
    return 0;
  }
  const samplePath = path.join(__dirname, '..', 'sample_data.js');
  if (!fs.existsSync(samplePath)) return 0;
  const txt = fs.readFileSync(samplePath, 'utf8');
  const match = txt.match(/window\.SAMPLE_DATA\s*=\s*(\[[\s\S]*\])\s*;?/);
  if (!match) return 0;
  let parsed;
  try { parsed = JSON.parse(match[1]); } catch (e) { return 0; }
  if (!Array.isArray(parsed) || !parsed.length) return 0;
  // writeRows is async, but seed is fire-and-forget at boot — return value is
  // best-effort and the rows will land shortly after.
  db.writeRows(parsed).then(({ added, updated }) => {
    console.log(`[seed] inserted ${added + updated} rows from sample_data.js`);
  }).catch(e => console.error('[seed] failed:', e.message || e));
  return parsed.length;
}

// --- Routes ---

// Debug-only: confirms whether Express sees the request. Logs every hit
// with a timestamp + key headers so we can compare against Railway logs
// when the response is 500. Gated to non-production.
app.get('/api/debug/trace', (req, res) => {
  console.log('[trace]', new Date().toISOString(), req.method, req.path,
    'origin=', req.headers.origin || '(none)',
    'ua=', req.headers['user-agent'] || '(none)');
  res.json({
    ok: true,
    pid: process.pid,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    origin: req.headers.origin || null,
    method: req.method,
    path: req.path,
  });
});

app.get('/api/daily', async (req, res) => {
  try {
    const { start, end } = req.query;
    const rows = await db.readAllRows(start, end);
    res.json({ rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'read_failed' });
  }
});

// Migrate-v7: User-remark popover on the daily price table.
// POST /api/daily/:date/remark  body: {note: string|null}
// Single-tenant — all clients see the same user notes. Coexists with the
// Gemini-generated `daily.remark` column (different writer).
app.post('/api/daily/:date/remark', async (req, res) => {
  try {
    const date = req.params.date;
    // Light date validation (YYYY-MM-DD only). DB will reject anything weirder
    // because `daily.date` is the PRIMARY KEY.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD', code: 'date_bad_format' });
    }
    const note = (req.body && typeof req.body.note === 'string') ? req.body.note : null;
    await db.setDailyRemark(date, note);
    // Echo back the trimmed note (or null) so the client can confirm.
    res.json({ ok: true, date, note: note && note.trim() ? note.trim() : null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'daily_remark_failed' });
  }
});

app.get('/api/peers', async (req, res) => {
  try {
    const { date, rows } = await db.readLatestPeers();
    res.json({ date, rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'peers_failed' });
  }
});

// Debug-only: hits Yahoo chart API once for ASW and returns status +
// latency + first ~500 chars of the body. Useful for diagnosing Railway
// IP blocks vs transient errors. Gated to non-production to keep it
// from being abused if someone exposes the service publicly.
app.get('/api/debug/yahoo-test', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'not found' });
  }
  const symbol = (req.query.symbol || 'ASW.BK').toString();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=1700000000&period2=1750000000&interval=1d&includeAdjustedClose=true&events=history`;
  const startedAt = Date.now();
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });
    const body = await r.text();
    res.json({
      ok: r.ok,
      status: r.status,
      latencyMs: Date.now() - startedAt,
      symbol,
      bodyPreview: body.slice(0, 500),
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      symbol,
      error: String(e.message || e),
      errorCode: e.code || null,
    });
  }
});

// Live ticker — the intraday partial close (latest 1-min candle) populated
// by the */3 cron. Distinct from /api/daily which returns EOD closes only.
// `prevClose` is yesterday's settled close so the client can show the
// % change vs the prior session, not vs another intraday tick.
app.get('/api/intraday', async (req, res) => {
  try {
    // Refresh the marketOpen flag in case it's been a while since the cron fired.
    const cacheAgeMs = INTRADAY.ts ? (Date.now() - INTRADAY.ts) : Infinity;
    const marketOpen = isMarketOpen(new Date());
    if (marketOpen !== INTRADAY.marketOpen) INTRADAY.marketOpen = marketOpen;
    res.json({
      price: INTRADAY.price,
      prevClose: INTRADAY.prevClose,
      ts: INTRADAY.ts,
      marketOpen: INTRADAY.marketOpen,
      source: INTRADAY.source,
      cacheAgeMs: cacheAgeMs === Infinity ? null : Math.round(cacheAgeMs / 1000),
      lastError: INTRADAY.lastError,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'intraday_failed' });
  }
});

app.get('/api/metadata', async (req, res) => {
  try {
    res.json(await db.metadata());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'metadata_failed' });
  }
});

app.post('/api/refresh', async (req, res) => {
  const source = (req.body && req.body.source) || 'yahoo';
  const sinceDate = (req.body && req.body.sinceDate) || null;
  const id = await db.logFetchStart();
  try {
    const { rows, peersWritten } = await runFetch({ source, sinceDate });
    const { added, updated } = await db.writeRows(rows);
    await db.logFetchFinish(id, 1, source, added, updated, null);
    res.json({ ok: true, added, updated, peersWritten: peersWritten || 0, ...(await db.metadata()) });
  } catch (e) {
    await db.logFetchFinish(id, 0, source, 0, 0, String(e.message || e));
    res.json({ ok: false, error: String(e.message || e), ...(await db.metadata()) });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const meta = await db.metadata();
    if (!meta.dateMin || !meta.dateMax) {
      return res.json({ expected: 0, stored: 0, missingDates: [], missingGaps: 0, ok: true });
    }
    const expected = expectedTradingDays(meta.dateMin, meta.dateMax);
    const stored = await db.getStoredDates();
    const missingDates = expected
      .filter(d => !stored.has(d))
      .map(d => ({ date: d, reason: classify(d) }))
      .slice(0, 200); // cap payload
    const missingGaps = missingDates.filter(m => m.reason === 'gap').length;
    res.json({
      expected: expected.length,
      stored: stored.size,
      missingDates,
      missingGaps,
      lastFetched: meta.lastFetched,
      dateMin: meta.dateMin,
      dateMax: meta.dateMax,
      ok: true,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'health_failed' });
  }
});

app.post('/api/health/refresh', async (req, res) => {
  const meta = await db.metadata();
  const sinceDate = meta.dateMin || null;
  const source = (req.body && req.body.source) || 'yahoo';
  const delays = [60_000, 5 * 60_000, 15 * 60_000];
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const id = await db.logFetchStart();
    try {
      const { rows } = await runFetch({ source, sinceDate });
      const { added, updated } = await db.writeRows(rows);
      await db.logFetchFinish(id, 1, source, added, updated, null);
      return res.json({ ok: true, attempts: attempt, added, updated });
    } catch (e) {
      lastError = String(e.message || e);
      await db.logFetchFinish(id, 0, source, 0, 0, lastError);
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, delays[attempt - 1]));
      }
    }
  }
  res.json({ ok: false, attempts: maxAttempts, error: lastError });
});

// --- AI Remarks (Gemini-search pipeline) ---

// Manually trigger a Gemini-company run (writes 1 pin to daily.remark +
// inserts all headlines to news_feed).
app.post('/api/remarks/refresh', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(400).json({
      ok: false,
      error: 'GEMINI_API_KEY not set in server environment',
      code: 'gemini_key_missing',
    });
  }
  const sinceDate = (req.body && req.body.sinceDate) || null;
  const id = await db.logFetchStart();
  try {
    const result = await runFetch({ source: 'gemini-company', sinceDate });
    await db.logFetchFinish(id, result.ok ? 1 : 0, 'gemini-company', result.inserted || 0, 0, result.error || null);
    res.json({ ok: result.ok, ...result });
  } catch (e) {
    await db.logFetchFinish(id, 0, 'gemini-company', 0, 0, String(e.message || e));
    res.json({ ok: false, error: String(e.message || e) });
  }
});

// --- News feed (Gemini-search: gemini-sector + gemini-macro) ---

// Read recent news items, newest first. Optional ?category= and ?since= filters.
// User-hidden rows are always excluded (see db.readNewsFeed).
app.get('/api/news', async (req, res) => {
  try {
    const { category, since, limit } = req.query;
    const rows = await db.readNewsFeed({
      category: category || null,
      since: since || null,
      limit: Math.min(parseInt(limit || '100', 10) || 100, 500),
    });
    res.json({ rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'news_read_failed' });
  }
});

// Manually add a news item (single-tenant — all clients see it). Reuses the same
// news_feed table + dedup (title_hash) + severity-first sort as the pipelines, so
// the row flows into the existing feed with no special-casing. pipeline='manual'
// tags it for the "เพิ่มเอง" badge + the manual-only DELETE guard.
//
//   body: { title, source_url, category?, severity? }
//   category omitted  → auto-classified from the headline (classifyCategory)
//   severity omitted  → null (renders as low priority, no severity pill)
app.post('/api/news', async (req, res) => {
  try {
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      return res.status(400).json({ ok: false, error: 'title required', code: 'news_add_bad_title' });
    }
    if (title.length > 500) {
      return res.status(400).json({ ok: false, error: 'title too long (max 500)', code: 'news_add_bad_title' });
    }

    const rawUrl = typeof body.source_url === 'string' ? body.source_url.trim() : '';
    let parsed;
    try { parsed = new URL(rawUrl); } catch {
      return res.status(400).json({ ok: false, error: 'source_url must be a valid URL', code: 'news_add_bad_url' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(400).json({ ok: false, error: 'source_url must be http(s)', code: 'news_add_bad_url' });
    }

    // Category: explicit (validated against the taxonomy) or auto-classified.
    const { classifyCategory, ALLOWED_CATEGORIES } = await loadTaxonomy();
    let category = null;
    if (body.category != null && body.category !== '') {
      if (!ALLOWED_CATEGORIES.has(body.category)) {
        return res.status(400).json({ ok: false, error: 'unknown category', code: 'news_add_bad_category' });
      }
      category = body.category;
    }
    if (!category) category = classifyCategory(title);

    // Severity: optional, must be high|medium|low.
    let severity = null;
    if (body.severity != null && body.severity !== '') {
      if (!['high', 'medium', 'low'].includes(body.severity)) {
        return res.status(400).json({ ok: false, error: 'severity must be high|medium|low', code: 'news_add_bad_severity' });
      }
      severity = body.severity;
    }

    const { inserted } = await db.insertManualNews({ title, source_url: rawUrl, category, severity });
    if (inserted === 0) {
      // title_hash collision — same headline+link already in the feed.
      return res.json({ ok: true, duplicate: true, inserted: 0 });
    }
    res.json({ ok: true, inserted: 1 });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'news_add_failed' });
  }
});

// Delete a news item — manual OR pipeline. db.deleteNewsItem() used to
// guard on pipeline='manual' but the operator sometimes wants to remove
// a stale/wrong pipeline item too. The DELETE is unconditional now; the
// frontend confirms before sending.
app.delete('/api/news/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: 'invalid id', code: 'news_delete_bad_id' });
    }
    const { deleted } = await db.deleteNewsItem(id);
    if (deleted === 0) {
      return res.status(404).json({ ok: false, error: 'not found or not deletable', code: 'not_deletable' });
    }
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'news_delete_failed' });
  }
});

// Unified-feed pipeline status (per sub-pipeline last run + counts).
// Powers the #newsStatusRow indicator strip on the new "ข่าวและปัจจัย" view.
app.get('/api/news/status', async (req, res) => {
  try {
    res.json(await db.readNewsStatus());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'news_status_failed' });
  }
});

// Manually trigger a Gemini-sector pull + insert. Body can pass
// `{"source": "gemini-sector"}` or `{"source": "gemini-macro"}` to choose.
app.post('/api/news/refresh', async (req, res) => {
  const source = (req.body && req.body.source) || 'gemini-sector';
  const id = await db.logFetchStart();
  try {
    const result = await runFetch({ source });
    // Use result.ok when present — Gemini pipelines can return {ok:false}
    // without throwing (e.g. morning-brief reason:'empty'); logging ok=1 in
    // that case hides the failure from /api/news/status.
    await db.logFetchFinish(id, result.ok !== false ? 1 : 0, source, result.inserted || 0, 0, null);
    res.json({ ok: true, ...result });
  } catch (e) {
    await db.logFetchFinish(id, 0, source, 0, 0, String(e.message || e));
    res.json({ ok: false, error: String(e.message || e) });
  }
});

// Manually trigger an RSS pull. Body can pass `{"source": "rss-property" |
// "rss-extended", "maxAgeDays": 7}`. Default source=rss-property,
// maxAgeDays=7 (rss-property) or 14 (rss-extended).
app.post('/api/news/rss-refresh', async (req, res) => {
  const source = (req.body && req.body.source) || 'rss-property';
  const defaultAge = source === 'rss-extended' ? 14 : 7;
  const maxAgeDays = (req.body && req.body.maxAgeDays) || defaultAge;
  const id = await db.logFetchStart();
  try {
    const result = await runFetch({ source, maxAgeDays });
    await db.logFetchFinish(id, result.ok !== false ? 1 : 0, source, result.inserted || 0, 0, null);
    res.json({ ok: true, source, ...result });
  } catch (e) {
    await db.logFetchFinish(id, 0, source, 0, 0, String(e.message || e));
    res.json({ ok: false, source, error: String(e.message || e) });
  }
});

// One-click "refresh everything" — runs the same batch the morning/evening
// crons run (rss-property + rss-extended + gemini-{company,sector,macro}).
// Use this when you want fresh news without waiting for the next cron tick.
// Skips the daily-summary chain (only the evening cron writes that) so the
// response stays quick. Each source is logged independently in fetch_log.
app.post('/api/news/refresh-all', async (req, res) => {
  try {
    // Run the batch in the background — respond immediately so the caller
    // doesn't wait through 5 sequential fetches (can take 30-60s total).
    // The frontend polls /api/news for new rows; the refresh button just
    // kicks off the fetch.
    runNewsBatch('manual').catch(e => {
      console.error('[refresh-all] batch failed:', e.message || e);
    });
    res.json({ ok: true, message: 'refresh batch started in background' });
  } catch (e) {
    res.json({ ok: false, error: String(e.message || e) });
  }
});

// User actions on a single news row.
//
//   POST /api/news/:id/note   body: {note: string|null}— empty/null clears
//   POST /api/news/:id/mark   body: {marked: true|false} — pin on dashboard chart
//
// Single-tenant model — no per-user scope. All clients see the same state.
app.post('/api/news/:id/note', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id', code: 'news_note_bad_id' });
    const note = (req.body && typeof req.body.note === 'string') ? req.body.note : null;
    await db.setNewsNote(id, note);
    // Echo back the trimmed note (or null) so the client can confirm.
    res.json({ ok: true, id, note: note && note.trim() ? note.trim() : null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'news_note_failed' });
  }
});

// Toggle the dashboard chart "mark" on a news row. chart_marked replaces the
// digest-driven Event Pins on the Dashboard chart only (Price History view is
// unchanged). Any feed row can be marked — there is no pipeline guard.
app.post('/api/news/:id/mark', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id', code: 'news_mark_bad_id' });
    const marked = !!(req.body && req.body.marked);
    await db.setNewsMark(id, marked);
    res.json({ ok: true, id, chart_marked: marked });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'news_mark_failed' });
  }
});

// --- Monday morning brief (Gemini-search: gemini-morning-brief) ---

// Read the latest non-null morning brief.
app.get('/api/morning-brief', async (req, res) => {
  try {
    const row = await db.readMorningBrief();
    res.json(row || { date: null, morning_brief: null, morning_watch: null, morning_remark: null, morning_weekly_at: null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'morning_brief_failed' });
  }
});

// Manually trigger a morning-brief run.
app.post('/api/morning-brief/refresh', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(400).json({
      ok: false,
      error: 'GEMINI_API_KEY not set in server environment',
      code: 'gemini_key_missing',
    });
  }
  const id = await db.logFetchStart();
  try {
    const result = await runFetch({ source: 'gemini-morning-brief' });
    await db.logFetchFinish(id, result.ok ? 1 : 0, 'gemini-morning-brief', 1, 0, result.error || null);
    res.json({ ok: result.ok, ...result });
  } catch (e) {
    await db.logFetchFinish(id, 0, 'gemini-morning-brief', 0, 0, String(e.message || e));
    res.json({ ok: false, error: String(e.message || e) });
  }
});

// --- Daily news summary (Gemini-search: gemini-daily-summary) ---
//
// One AI digest per ICT date of that day's news_feed rows, generated after the
// day's final pull (chained into the rss-extended cron below). Source news
// rows are kept untouched — the digest is additive.

// Read the latest digest, or a specific date via ?date=YYYY-MM-DD.
app.get('/api/daily-summary', async (req, res) => {
  try {
    const date = req.query.date || null;
    const row = await db.readDailySummary(date);
    res.json(row || {
      date: null, digest: null, headline: null, tone: null, reason: null,
      bullets: null, source_count: null, generated_at: null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'daily_summary_failed' });
  }
});

// Every digest (ascending by date). Powers the chart "pin per day" and the
// Remark column on the daily price tables: the frontend derives a short
// remark from each day's first bullet, so each day with a digest gets one
// pin + one Remark cell, updating as new digests arrive.
app.get('/api/daily-summaries', async (req, res) => {
  try {
    const items = await db.readAllDailySummaries();
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'daily_summaries_failed' });
  }
});

// Manually (re)generate a digest. Body may pass {date} to backfill a past day;
// defaults to today. Gated on GEMINI_API_KEY.
app.post('/api/daily-summary/refresh', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(400).json({
      ok: false,
      error: 'GEMINI_API_KEY not set in server environment',
      code: 'gemini_key_missing',
    });
  }
  const sinceDate = (req.body && req.body.date) || null;
  const id = await db.logFetchStart();
  try {
    const result = await runFetch({ source: 'gemini-daily-summary', sinceDate });
    await db.logFetchFinish(id, result.ok ? 1 : 0, 'gemini-daily-summary', result.ok ? 1 : 0, 0, result.error || null);
    res.json({ ok: result.ok, ...result });
  } catch (e) {
    await db.logFetchFinish(id, 0, 'gemini-daily-summary', 0, 0, String(e.message || e));
    res.json({ ok: false, error: String(e.message || e) });
  }
});

// --- Bootstrap ---

db.openDb();

(async () => {
  try {
    // Bootstrap the schema before any query. Idempotent (CREATE ... IF NOT
    // EXISTS) so it's a no-op on the already-migrated Supabase DB, but it makes
    // a fresh Railway Postgres deploy work with zero manual migration steps —
    // without it, /api/health 500s and the Railway healthcheck crash-loops.
    await db.ensureSchema();
    const before = await db.metadata();
    if (before.rowCount === 0) {
      console.log('[startup] empty DB — seeding from sample_data.js');
      seedFromSampleData();
    }
    const m = await db.metadata();
    console.log(`[startup] rows=${m.rowCount} range=${m.dateMin} → ${m.dateMax}`);
  } catch (e) {
    console.error('[startup] DB error:', e.message || e);
  }
})();

// Intraday poller — every 3 min during SET market hours (10:00–17:30 ICT,
// Mon–Fri excluding holidays). Skipped silently outside market hours.
// IMPORTANT: this no longer writes to `daily.close`. We only update the
// in-memory INTRADAY cache so the KPI can show a live tick without
// polluting the chart's ASW line with intraday partials. The 17:35 daily
// cron below remains the sole writer of today's `daily.close` (true EOD).
cron.schedule('*/3 * * * *', async () => {
  if (!isMarketOpen()) {
    INTRADAY.marketOpen = false;
    return;
  }
  INTRADAY.marketOpen = true;
  console.log('[scheduler] intraday tick poll');
  try {
    const t = await runIntraday();
    if (t && t.price != null) {
      INTRADAY.price = t.price;
      INTRADAY.prevClose = t.prevClose;
      INTRADAY.ts = t.ts;
      INTRADAY.source = t.source || 'yahoo';
      INTRADAY.lastError = null;
      console.log(`[scheduler] intraday tick price=${t.price.toFixed(2)} prevClose=${t.prevClose != null ? t.prevClose.toFixed(2) : '∅'} ts=${new Date(t.ts).toISOString()}`);
    }
  } catch (e) {
    INTRADAY.lastError = String(e.message || e);
    console.error('[scheduler] intraday tick failed:', e.message || e);
  }
}, { timezone: 'Asia/Bangkok' });

// Daily fetch at 17:35 ICT (10:35 UTC) — 5 min after SET close (17:30).
//
// We register TWO cron expressions pointing at the same handler:
//   - '35 10 * * *' Asia/Bangkok — the "official" schedule
//   - '35 3  * * *' UTC          — fallback for Railway, where
//     node-cron's timezone option has been observed to silently skip
//     some schedules (empirically, fetch_log shows zero `yahoo` rows
//     while gemini-* and rss-property crons fire correctly).
//
// An in-memory guard ensures only one of the two fires per day even if
// both schedules resolve to the same wall-clock moment.
let _yahooDailyRan = null; // ISO date in ICT — nulled on process restart
function _yahooDailyGuard() {
  const todayICT = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  if (_yahooDailyRan === todayICT) {
    console.log('[scheduler] daily fetch already ran today, skip');
    return false;
  }
  _yahooDailyRan = todayICT;
  return true;
}
async function _runDailyYahoo() {
  console.log('[scheduler] daily fetch triggered');
  const id = await db.logFetchStart();
  try {
    const { rows } = await runFetch({ source: 'yahoo' });
    const { added, updated } = await db.writeRows(rows);
    await db.logFetchFinish(id, 1, 'yahoo', added, updated, null);
    console.log(`[scheduler] yahoo ok added=${added} updated=${updated}`);
  } catch (e) {
    await db.logFetchFinish(id, 0, 'yahoo', 0, 0, String(e.message || e));
    console.error('[scheduler] yahoo failed:', e.message || e);
  }
}
cron.schedule('35 10 * * *', async () => {
  if (_yahooDailyGuard()) await _runDailyYahoo();
}, { timezone: 'Asia/Bangkok' });
cron.schedule('35 3 * * *', async () => {
  if (_yahooDailyGuard()) await _runDailyYahoo();
});

// =============================================================================
// NEWS CRON — 5 runs per day, all in ICT (timezone option is set so the cron
// expressions are interpreted as Asia/Bangkok regardless of the server's
// system timezone).
//
// Schedule (ICT):
//   08:00 daily   morning   → full batch + Monday morning-brief
//   12:30 daily   midday    → full batch (lunch-time market pull)
//   15:00 daily   afternoon → full batch (late afternoon session)
//   17:30 daily   evening   → full batch + daily-summary (right at SET close)
//   21:00 daily   night     → full batch (evening wrap-up)
//
// Manual refresh still works anytime via:
//   POST /api/news/refresh       { source: "gemini-sector" }
//   POST /api/news/rss-refresh   { source: "rss-property" }
//   POST /api/news/refresh-all   (runs the full batch in one shot)
// =============================================================================

// Shared batch runner — runs all news sources serially. Each source is in
// its own try/catch with its own fetch_log entry so one failure doesn't
// block the others. `phase` is 'morning' | 'midday' | 'afternoon' |
// 'evening' | 'night' | 'manual' — used for log lines and the Monday
// morning-brief + evening daily-summary gates.
async function runNewsBatch(phase) {
  console.log(`[scheduler:${phase}] news batch start`);
  const sources = [
    // maxAge=30d for rss-property — Bing returns items up to ~30 days old
    // in its free-tier index. The previous maxAge=2d (set when the cron
    // ran every 30 min) filtered out almost everything; bumped to 7 then
    // 30 to surface more news per run. Dedup index keeps repeats out.
    { source: 'rss-property', maxAgeDays: 30 },
    { source: 'rss-extended', maxAgeDays: 30 },
  ];
  if (process.env.GEMINI_API_KEY) {
    sources.push(
      { source: 'gemini-company' },
      { source: 'gemini-sector' },
      { source: 'gemini-macro' },
    );
  }
  // Monday morning adds the weekly brief at the front of the batch.
  const isMonday = new Date(Date.now() + 7 * 3600 * 1000).getDay() === 1;
  if (phase === 'morning' && isMonday && process.env.GEMINI_API_KEY) {
    sources.unshift({ source: 'gemini-morning-brief' });
  }

  for (const cfg of sources) {
    const id = await db.logFetchStart();
    try {
      const opts = cfg.maxAgeDays != null ? { maxAgeDays: cfg.maxAgeDays } : {};
      const result = await runFetch({ source: cfg.source, ...opts });
      await db.logFetchFinish(
        id,
        result.ok !== false ? 1 : 0,
        cfg.source,
        result.inserted || 0,
        0,
        result.error || null,
      );
      console.log(`[scheduler:${phase}] ${cfg.source} ok fetched=${result.fetched ?? '?'} inserted=${result.inserted ?? '?'}`);
    } catch (e) {
      await db.logFetchFinish(id, 0, cfg.source, 0, 0, String(e.message || e));
      console.error(`[scheduler:${phase}] ${cfg.source} failed:`, e.message || e);
    }
  }

  // Evening batch chains the daily digest after the day's final news pull so
  // the summary sees the full day's news_feed rows. Only 'evening' phase
  // triggers this — midday/morning/night runs skip it. Gated on
  // GEMINI_API_KEY and run in its own try/catch with its own fetch_log entry.
  if (phase === 'evening' && process.env.GEMINI_API_KEY) {
    const sid = await db.logFetchStart();
    try {
      const s = await runFetch({ source: 'gemini-daily-summary' });
      await db.logFetchFinish(sid, s.ok ? 1 : 0, 'gemini-daily-summary', s.ok ? 1 : 0, 0, s.error || null);
      console.log(`[scheduler:${phase}] gemini-daily-summary ok tone=${s.tone || '∅'} items=${s.sourceCount ?? '?'}`);
    } catch (e) {
      await db.logFetchFinish(sid, 0, 'gemini-daily-summary', 0, 0, String(e.message || e));
      console.error(`[scheduler:${phase}] gemini-daily-summary failed:`, e.message || e);
    }
  }
  console.log(`[scheduler:${phase}] news batch done`);
}

// 08:00 ICT — pre-market morning pull (+ Monday morning-brief).
cron.schedule('0 8 * * *', async () => {
  await runNewsBatch('morning');
}, { timezone: 'Asia/Bangkok' });

// 12:30 ICT — lunch-time pull (during market lunch break).
cron.schedule('30 12 * * *', async () => {
  await runNewsBatch('midday');
}, { timezone: 'Asia/Bangkok' });

// 15:00 ICT — late-afternoon pull (during afternoon trading session).
cron.schedule('0 15 * * *', async () => {
  await runNewsBatch('afternoon');
}, { timezone: 'Asia/Bangkok' });

// 17:30 ICT — right at SET close. Chains the daily summary.
cron.schedule('30 17 * * *', async () => {
  await runNewsBatch('evening');
}, { timezone: 'Asia/Bangkok' });

// 21:00 ICT — evening wrap-up (catches late-breaking headlines).
cron.schedule('0 21 * * *', async () => {
  await runNewsBatch('night');
}, { timezone: 'Asia/Bangkok' });

if (!process.env.GEMINI_API_KEY) {
  console.log('[scheduler] GEMINI_API_KEY not set — gemini-* sources disabled, RSS-only.');
}

// Global error handler — must come last (4-arg signature). On Railway we
// saw 500s whenever the request had an Origin header (browser always sends
// one), even for static files that don't touch the DB. Express's default
// error page swallows the stack trace, so we replace it with a JSON
// responder that logs the full error to stdout for Railway logs.
app.use((err, req, res, next) => {
  console.error('[express error]', err.stack || err);
  if (res.headersSent) return next(err);
  res.status(500).json({
    ok: false,
    error: String(err.message || err),
    code: 'unhandled',
    path: req.path,
    method: req.method,
  });
});

app.listen(PORT, () => {
  console.log(`ASW Monitor backend on http://localhost:${PORT}`);
  // Warm the intraday cache immediately on boot. Earlier we waited for
  // the first cron tick (every 3 min) which meant /api/intraday returned
  // null for up to 3 minutes after a restart — the dashboard KPI card
  // showed "—" instead of the live price during that window. Fire-and-
  // forget so a slow Yahoo response doesn't block app.listen's callback.
  runIntraday().then(t => {
    if (t && t.price != null) {
      INTRADAY.price = t.price;
      INTRADAY.prevClose = t.prevClose;
      INTRADAY.ts = t.ts;
      INTRADAY.source = t.source || 'yahoo';
      INTRADAY.marketOpen = true;
      INTRADAY.lastError = null;
      console.log(`[startup] intraday warm price=${t.price.toFixed(2)} prevClose=${t.prevClose != null ? t.prevClose.toFixed(2) : '∅'}`);
    } else {
      console.log('[startup] intraday warm returned no tick (market closed or no data)');
    }
  }).catch(e => {
    console.warn('[startup] intraday warm failed:', e.message || e);
  });
});