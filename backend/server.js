'use strict';

// Load .env (gitignored) BEFORE any module that reads process.env at import
// time — dotenv mutates process.env in place, so require-order matters.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const db = require('./db');
const { runFetch, runIntraday } = require('./lib/fetchers');
const { expectedTradingDays, classify, isMarketOpen } = require('./lib/thai-trading-days');

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
function seedFromSampleData() {
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
// ?showHidden=1 includes user-hidden rows (default = hidden only) — used by the
// "Show hidden" toggle on the unified feed so the client cache is complete.
app.get('/api/news', async (req, res) => {
  try {
    const { category, since, limit, showHidden } = req.query;
    const rows = await db.readNewsFeed({
      category: category || null,
      since: since || null,
      limit: Math.min(parseInt(limit || '100', 10) || 100, 500),
      includeHidden: showHidden === '1' || showHidden === 'true',
    });
    res.json({ rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'news_read_failed' });
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
    await db.logFetchFinish(id, 1, source, result.inserted || 0, 0, null);
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
    await db.logFetchFinish(id, 1, source, result.inserted || 0, 0, null);
    res.json({ ok: true, source, ...result });
  } catch (e) {
    await db.logFetchFinish(id, 0, source, 0, 0, String(e.message || e));
    res.json({ ok: false, source, error: String(e.message || e) });
  }
});

// User actions on a single news row (migrate-v6).
//
//   POST /api/news/:id/hide   body: {hidden: bool}     — default true
//   POST /api/news/:id/note   body: {note: string|null}— empty/null clears
//   GET  /api/news/hidden     — list user-hidden rows, newest hide first
//
// Single-tenant model — no per-user scope. All clients see the same state.
app.post('/api/news/:id/hide', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id', code: 'news_hide_bad_id' });
    // Default hidden=true when the caller doesn't pass it (e.g. a one-click
    // "hide" button with no body). `!== false` means anything but explicit
    // false counts as hide.
    const hidden = !!(req.body && req.body.hidden !== false);
    await db.setNewsHidden(id, hidden);
    res.json({ ok: true, id, hidden });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'news_hide_failed' });
  }
});

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

app.get('/api/news/hidden', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
    const rows = await db.readHiddenNews(limit);
    res.json({ rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'news_hidden_failed' });
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

// --- Bootstrap ---

db.openDb();

(async () => {
  try {
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
      INTRADAY.source = 'yahoo';
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
// TEST: trigger 5 min from now (05:25 UTC) to verify the parallel cron path.
// Restore to '35 3 * * *' after confirming the schedule fires.
cron.schedule('25 5 * * *', async () => {
  if (_yahooDailyGuard()) await _runDailyYahoo();
});

// Gemini-search pipeline — 4 cron jobs, all gated on GEMINI_API_KEY.
//
// Schedule (ICT):
//   17:45 daily      gemini-company       → 1 pin to daily.remark + headlines to news_feed
//   17:50 daily      gemini-sector        → 0–3 sector headlines to news_feed
//   17:55 daily      gemini-macro         → 0–2 macro headlines (severity=high → pin)
//   08:00 Monday     gemini-morning-brief → weekly brief to daily.morning_*
//
// All three 17:xx jobs run after SET close (17:30 ICT) so today's headlines
// are searchable. The morning-brief runs Monday 08:00 ICT (01:00 UTC) — 1h
// before market open so analysts have it ready.
if (process.env.GEMINI_API_KEY) {
  // 17:45 ICT — company pin
  cron.schedule('45 10 * * *', async () => {
    console.log('[scheduler] gemini-company triggered');
    const id = await db.logFetchStart();
    try {
      const result = await runFetch({ source: 'gemini-company' });
      await db.logFetchFinish(id, result.ok ? 1 : 0, 'gemini-company', result.inserted || 0, 0, result.error || null);
      console.log(`[scheduler] gemini-company ok date=${result.date} cat=${result.category || '∅'} text="${result.text || '∅'}"`);
    } catch (e) {
      await db.logFetchFinish(id, 0, 'gemini-company', 0, 0, String(e.message || e));
      console.error('[scheduler] gemini-company failed:', e.message || e);
    }
  }, { timezone: 'Asia/Bangkok' });

  // 17:50 ICT — sector news
  cron.schedule('50 10 * * *', async () => {
    console.log('[scheduler] gemini-sector triggered');
    const id = await db.logFetchStart();
    try {
      const result = await runFetch({ source: 'gemini-sector' });
      await db.logFetchFinish(id, 1, 'gemini-sector', result.inserted || 0, 0, null);
      console.log(`[scheduler] gemini-sector ok fetched=${result.fetched} inserted=${result.inserted}`);
    } catch (e) {
      await db.logFetchFinish(id, 0, 'gemini-sector', 0, 0, String(e.message || e));
      console.error('[scheduler] gemini-sector failed:', e.message || e);
    }
  }, { timezone: 'Asia/Bangkok' });

  // 17:55 ICT — macro news + severity=high → pin
  cron.schedule('55 10 * * *', async () => {
    console.log('[scheduler] gemini-macro triggered');
    const id = await db.logFetchStart();
    try {
      const result = await runFetch({ source: 'gemini-macro' });
      await db.logFetchFinish(id, 1, 'gemini-macro', result.inserted || 0, 0, null);
      console.log(`[scheduler] gemini-macro ok fetched=${result.fetched} inserted=${result.inserted} high=${result.high || 0}`);
    } catch (e) {
      await db.logFetchFinish(id, 0, 'gemini-macro', 0, 0, String(e.message || e));
      console.error('[scheduler] gemini-macro failed:', e.message || e);
    }
  }, { timezone: 'Asia/Bangkok' });

  // 08:00 ICT Monday — weekly morning brief
  cron.schedule('0 1 * * 1', async () => {
    console.log('[scheduler] gemini-morning-brief triggered');
    const id = await db.logFetchStart();
    try {
      const result = await runFetch({ source: 'gemini-morning-brief' });
      await db.logFetchFinish(id, result.ok ? 1 : 0, 'gemini-morning-brief', 1, 0, result.error || null);
      console.log(`[scheduler] gemini-morning-brief ok date=${result.date} tone=${result.tone}`);
    } catch (e) {
      await db.logFetchFinish(id, 0, 'gemini-morning-brief', 0, 0, String(e.message || e));
      console.error('[scheduler] gemini-morning-brief failed:', e.message || e);
    }
  }, { timezone: 'Asia/Bangkok' });
} else {
  console.log('[scheduler] GEMINI_API_KEY not set — all gemini-* cron disabled.');
}

// Google News RSS pull — every 30 min during market hours + 1 final pull at
// 18:00 ICT. Cheap (8 parallel HTTPS GETs to Google, no key, no JS render).
// Google News returns recent items only, so a high-frequency cron is safe
// — the GUID-based title_hash keeps re-runs idempotent.
cron.schedule('*/30 10-17 * * 1-5', async () => {
  console.log('[scheduler] rss-property triggered (market hours)');
  const id = await db.logFetchStart();
  try {
    const result = await runFetch({ source: 'rss-property', maxAgeDays: 2 });
    await db.logFetchFinish(id, 1, 'rss-property', result.inserted || 0, 0, null);
    console.log(`[scheduler] rss-property ok fetched=${result.fetched || 0} inserted=${result.inserted || 0}`);
  } catch (e) {
    await db.logFetchFinish(id, 0, 'rss-property', 0, 0, String(e.message || e));
    console.error('[scheduler] rss-property failed:', e.message || e);
  }
}, { timezone: 'Asia/Bangkok' });

// 18:00 ICT — post-close RSS pull. Casts a wider net (maxAge=7d) so the
// evening feed covers anything we missed during the day.
cron.schedule('0 11 * * 1-5', async () => {
  console.log('[scheduler] rss-property triggered (post-close)');
  const id = await db.logFetchStart();
  try {
    const result = await runFetch({ source: 'rss-property', maxAgeDays: 7 });
    await db.logFetchFinish(id, 1, 'rss-property', result.inserted || 0, 0, null);
    console.log(`[scheduler] rss-property ok fetched=${result.fetched || 0} inserted=${result.inserted || 0}`);
  } catch (e) {
    await db.logFetchFinish(id, 0, 'rss-property', 0, 0, String(e.message || e));
    console.error('[scheduler] rss-property failed:', e.message || e);
  }
}, { timezone: 'Asia/Bangkok' });

// Migrate-v8 — extended news (SET filings / broker / insider / Smart Alert /
// USD/THB FX / debt rating). Daily at 18:30 ICT (UTC 11:30) — runs after
// the rss-property post-close pull so it sees the same-day SET filings
// without contention. maxAge=14d because insider-trading + broker reports
// lose actionability fast and a 14-day trailing window ensures we don't
// miss late retro-published entries from SET.
cron.schedule('30 11 * * *', async () => {
  console.log('[scheduler] rss-extended triggered (daily 18:30 ICT)');
  const id = await db.logFetchStart();
  try {
    const result = await runFetch({ source: 'rss-extended', maxAgeDays: 14 });
    await db.logFetchFinish(id, 1, 'rss-extended', result.inserted || 0, 0, null);
    console.log(`[scheduler] rss-extended ok fetched=${result.fetched || 0} inserted=${result.inserted || 0} byCat=${JSON.stringify(result.byCat || {})}`);
  } catch (e) {
    await db.logFetchFinish(id, 0, 'rss-extended', 0, 0, String(e.message || e));
    console.error('[scheduler] rss-extended failed:', e.message || e);
  }
}, { timezone: 'Asia/Bangkok' });

app.listen(PORT, () => {
  console.log(`ASW Monitor backend on http://localhost:${PORT}`);
});