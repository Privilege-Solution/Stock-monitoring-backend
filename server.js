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
app.use(express.static(__dirname));

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
  const samplePath = path.join(__dirname, 'sample_data.js');
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

app.get('/api/peers', async (req, res) => {
  try {
    const { date, rows } = await db.readLatestPeers();
    res.json({ date, rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'peers_failed' });
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
cron.schedule('35 10 * * *', async () => {
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
}, { timezone: 'Asia/Bangkok' });

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

app.listen(PORT, () => {
  console.log(`ASW Monitor backend on http://localhost:${PORT}`);
});