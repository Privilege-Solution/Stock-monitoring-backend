'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const db = require('./db');
const { runFetch } = require('./lib/fetchers');
const { expectedTradingDays, classify } = require('./lib/thai-trading-days');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

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

// --- News (NewsAPI.org) ---

app.get('/api/news', async (req, res) => {
  try {
    const { from, tag, limit } = req.query;
    const rows = await db.readNews({
      from: from || null,
      tag:  tag  || null,
      limit: limit ? Math.min(parseInt(limit, 10) || 200, 500) : 200,
    });
    res.json({ rows, count: rows.length, ...(await db.newsMetadata()) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: 'news_read_failed' });
  }
});

app.post('/api/news/refresh', async (req, res) => {
  if (!process.env.NEWSAPI_KEY) {
    return res.status(400).json({
      ok: false,
      error: 'NEWSAPI_KEY not set in server environment',
      code: 'newsapi_key_missing',
    });
  }
  const id = await db.logFetchStart();
  try {
    const { newsAdded, newsScanned } = await runFetch({ source: 'news' });
    await db.logFetchFinish(id, 1, 'news', newsAdded || 0, 0, null);
    res.json({ ok: true, added: newsAdded, scanned: newsScanned, ...(await db.newsMetadata()) });
  } catch (e) {
    await db.logFetchFinish(id, 0, 'news', 0, 0, String(e.message || e));
    res.json({ ok: false, error: String(e.message || e), ...(await db.newsMetadata()) });
  }
});

// --- AI Remarks (Tavily) ---

// Manually trigger a Tavily fetch + remark update for the latest trading day.
app.post('/api/remarks/refresh', async (req, res) => {
  if (!process.env.TAVILY_KEY) {
    return res.status(400).json({
      ok: false,
      error: 'TAVILY_KEY not set in server environment',
      code: 'tavily_key_missing',
    });
  }
  const id = await db.logFetchStart();
  try {
    const { date, remark, queriesRun } = await runFetch({ source: 'ai-remarks' });
    await db.logFetchFinish(id, 1, 'ai-remarks', queriesRun || 0, 0, null);
    res.json({ ok: true, date, remark, queriesRun: queriesRun || 0 });
  } catch (e) {
    await db.logFetchFinish(id, 0, 'ai-remarks', 0, 0, String(e.message || e));
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

// News fetch at 17:40 ICT (10:40 UTC) — runs only when NEWSAPI_KEY is set.
if (process.env.NEWSAPI_KEY) {
  cron.schedule('40 10 * * *', async () => {
    console.log('[scheduler] daily news fetch triggered');
    const id = await db.logFetchStart();
    try {
      const { newsAdded, newsScanned } = await runFetch({ source: 'news' });
      await db.logFetchFinish(id, 1, 'news', newsAdded || 0, 0, null);
      console.log(`[scheduler] news ok added=${newsAdded} scanned=${newsScanned}`);
    } catch (e) {
      await db.logFetchFinish(id, 0, 'news', 0, 0, String(e.message || e));
      console.error('[scheduler] news failed:', e.message || e);
    }
  }, { timezone: 'Asia/Bangkok' });
} else {
  console.log('[scheduler] NEWSAPI_KEY not set — news cron disabled.');
}

// AI remarks at 17:45 ICT (10:45 UTC) — runs only when TAVILY_KEY is set.
if (process.env.TAVILY_KEY) {
  cron.schedule('45 10 * * *', async () => {
    console.log('[scheduler] daily AI-remarks triggered');
    const id = await db.logFetchStart();
    try {
      const { date, remark, queriesRun } = await runFetch({ source: 'ai-remarks' });
      await db.logFetchFinish(id, 1, 'ai-remarks', queriesRun || 0, 0, null);
      console.log(`[scheduler] remarks ok date=${date} queries=${queriesRun}`);
    } catch (e) {
      await db.logFetchFinish(id, 0, 'ai-remarks', 0, 0, String(e.message || e));
      console.error('[scheduler] remarks failed:', e.message || e);
    }
  }, { timezone: 'Asia/Bangkok' });
} else {
  console.log('[scheduler] TAVILY_KEY not set — AI-remarks cron disabled.');
}

app.listen(PORT, () => {
  console.log(`ASW Monitor backend on http://localhost:${PORT}`);
});