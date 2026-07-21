'use strict';

// Postgres-only DB layer. Reads/writes go through a pg.Pool connected to the
// Supabase DATABASE_URL. All public functions are async — callers (server.js,
// fetchers/index.js) await them.
//
// Schema (auto-created by ensureSchema() below, fresh-install shape):
//   daily          — one row per trading day, PRIMARY KEY date
//                    single (remark, category) pair — was a 3-col shape
//                    (remark_company/sector/macro) in an earlier revision
//   peer_prices    — one row per (date, ticker)
//   news_feed      — SERIAL id, Gemini+RSS pipeline + user actions
//   fetch_log      — append-only fetch audit trail, SERIAL id

const { Pool } = require('pg');
const { createHash } = require('node:crypto');

// sha1 seed for title_hash — mirrors the fetchers (rss-property.mjs / gemini-search.mjs).
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

// normalizeHeadline — MUST mirror the ESM version in news-rss-helpers.mjs so
// manually-added rows compute the SAME hash as pipeline rows covering the
// same story. Kept inline (not imported) because db.js is CommonJS and
// mixing import styles would force the whole module to .mjs.
//
// IMPORTANT: only strip a trailing " - <Latin>" segment (publisher name like
// "Marketeer Online"); never strip a suffix that contains Thai chars, which
// is real headline content (e.g. "ASW - แนะนำซื้อ" must NOT become "ASW").
function normalizeHeadline(s) {
  return String(s || '')
    .replace(/\s+-\s+[^-\u0E00-\u0E7F]+$/, '')   // trailing " - <Latin publisher>"
    .toLowerCase()
    .replace(/[()[\]{}"'`.,!?;:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

let pool = null;

function parsePgUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || 'postgres',
  };
}

// Decide whether to open the connection over SSL. Supabase *requires* SSL, but
// Railway's managed Postgres reached over the private network
// (host ends in `.railway.internal`) does NOT offer SSL — forcing it there
// fails the connection with "The server does not support SSL connections".
// Precedence:
//   1. Explicit DATABASE_SSL env  ('disable'/'false'/'0' → off; else → on)
//   2. `sslmode=disable` in the DATABASE_URL query string → off
//   3. Host heuristic: localhost / 127.0.0.1 / *.railway.internal → off
//   4. Default → on, with rejectUnauthorized:false (Supabase, Railway proxy)
function resolveSslConfig(url) {
  const flag = (process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (flag) {
    return /^(disable|false|0|off|no)$/.test(flag) ? false : { rejectUnauthorized: false };
  }
  let u;
  try { u = new URL(url); } catch { return { rejectUnauthorized: false }; }
  if ((u.searchParams.get('sslmode') || '').toLowerCase() === 'disable') return false;
  const host = u.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.railway.internal')) {
    return false;
  }
  return { rejectUnauthorized: false };
}

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set in environment');
  }
  const cfg = parsePgUrl(process.env.DATABASE_URL);
  pool = new Pool({
    ...cfg,
    ssl: resolveSslConfig(process.env.DATABASE_URL),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // A pool-level error listener prevents an idle-client error (e.g. Supabase
  // dropping a connection) from crashing the process with an unhandled event.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message || err);
  });
  return pool;
}

// Sync startup hook — pool creation is lazy, so just verify the URL is set.
// All queries below are async.
function openDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set in environment');
  }
  return getPool();
}

async function closeDb() {
  if (pool) { await pool.end(); pool = null; }
}

// Idempotent schema bootstrap. Safe to run on every boot: uses CREATE TABLE /
// INDEX IF NOT EXISTS and ADD COLUMN IF NOT EXISTS so it neither drops data
// nor errors on an already-migrated Supabase DB. Its purpose is the fresh-
// deploy path — a brand-new Railway Postgres has no tables, so this is what
// creates them. db.writeNewsItems() / readNewsFeed() require the news_feed
// shape defined here.
async function ensureSchema() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS daily (
      date              TEXT PRIMARY KEY,
      close             DOUBLE PRECISION,
      "change"          DOUBLE PRECISION,
      volume            DOUBLE PRECISION,
      value             DOUBLE PRECISION,
      "setIdx"          DOUBLE PRECISION,
      "propIdx"         DOUBLE PRECISION,
      remark            TEXT,
      category          TEXT,
      morning_brief     TEXT,
      morning_watch     TEXT,
      morning_remark    TEXT,
      morning_weekly_at TEXT,
      fetched_at        TEXT NOT NULL,
      user_note         TEXT
    );
    CREATE INDEX IF NOT EXISTS daily_date_idx ON daily(date);
    CREATE INDEX IF NOT EXISTS daily_user_note_idx ON daily (date DESC) WHERE user_note IS NOT NULL;

    CREATE TABLE IF NOT EXISTS news_feed (
      id            SERIAL PRIMARY KEY,
      title         TEXT NOT NULL,
      date          TEXT NOT NULL,
      category      TEXT NOT NULL,
      source_url    TEXT NOT NULL,
      source_label  TEXT NOT NULL,
      title_hash    TEXT NOT NULL,
      pipeline      TEXT,
      impact        TEXT,
      severity      TEXT,
      show_pin      BOOLEAN,
      fetched_at    TEXT NOT NULL,
      display_priority SMALLINT NOT NULL DEFAULT 0,
      summary       TEXT,
      hidden        BOOLEAN     NOT NULL DEFAULT FALSE,
      hidden_at     TIMESTAMPTZ,
      user_note     TEXT,
      impact_level  TEXT
    );
    ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS impact_level TEXT;
    -- User-pinned "mark" on the dashboard chart (replaces digest Event Pins
    -- there). Distinct from show_pin, which the pipeline uses to boost display
    -- priority — kept separate so the two never interact.
    ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS chart_marked BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE UNIQUE INDEX IF NOT EXISTS news_feed_title_hash_idx ON news_feed (title_hash);
    CREATE INDEX IF NOT EXISTS news_feed_date_idx     ON news_feed (date DESC);
    CREATE INDEX IF NOT EXISTS news_feed_category_idx ON news_feed (category);
    CREATE INDEX IF NOT EXISTS news_feed_show_pin_idx ON news_feed (date DESC) WHERE show_pin = TRUE;
    CREATE INDEX IF NOT EXISTS news_feed_chart_marked_idx ON news_feed (date DESC) WHERE chart_marked = TRUE;
    CREATE INDEX IF NOT EXISTS news_feed_pipeline_idx ON news_feed (pipeline);
    CREATE INDEX IF NOT EXISTS news_feed_priority_date_idx ON news_feed (display_priority DESC, date DESC, id DESC);
    CREATE INDEX IF NOT EXISTS news_feed_hidden_at_idx ON news_feed (hidden_at DESC NULLS LAST) WHERE hidden = TRUE;
    CREATE INDEX IF NOT EXISTS news_feed_user_note_idx ON news_feed (id) WHERE user_note IS NOT NULL;

    CREATE TABLE IF NOT EXISTS peer_prices (
      date        TEXT NOT NULL,
      ticker      TEXT NOT NULL,
      name        TEXT,
      close       DOUBLE PRECISION,
      "change"    DOUBLE PRECISION,
      fetched_at  TEXT NOT NULL,
      PRIMARY KEY (date, ticker)
    );
    CREATE INDEX IF NOT EXISTS peer_prices_date_idx ON peer_prices(date);

    CREATE TABLE IF NOT EXISTS fetch_log (
      id           SERIAL PRIMARY KEY,
      started_at   TEXT NOT NULL,
      finished_at  TEXT,
      ok           INTEGER NOT NULL,
      source       TEXT NOT NULL,
      rows_added   INTEGER,
      rows_updated INTEGER,
      error        TEXT
    );

    -- Per-day AI digest of news_feed (migrate-v10). One row per ICT date,
    -- upserted on each run. Dedicated table (not the daily price row) so a
    -- summary can be written even on a non-trading day with no price row, and
    -- so backfilling a past date is a clean upsert.
    CREATE TABLE IF NOT EXISTS news_daily_summary (
      date         TEXT PRIMARY KEY,
      digest       TEXT,            -- newline-separated KEY_POINTS bullets
      headline     TEXT,            -- ≤30-char one-sentence summary → Remark cell
      tone         TEXT,            -- bullish | bearish | neutral
      reason       TEXT,            -- 1-sentence rationale (for ASW)
      bullets      JSONB,           -- future: structured {CATEGORY: [...]}
      source_count INTEGER,         -- how many news_feed rows were summarized
      generated_at TEXT NOT NULL
    );
    ALTER TABLE news_daily_summary ADD COLUMN IF NOT EXISTS headline TEXT;
  `);
}

// ── daily ──────────────────────────────────────────────────────────────────

// Upsert by date. The COALESCE on (remark, category) preserves existing AI
// remarks when the incoming row has none — both columns are owned by the
// AI-remarks pipeline (gemini-search.mjs), not by the price pipeline.
//
// Accepts the new shape ({remark, category}) and the legacy shapes too:
//   - {remark} (single-text, from sample_data.js + SQLite-era) → classified
//     via classifySingle() which assigns macro/sector/company/other
//   - {remark_company, remark_sector, remark_macro} (legacy 3-col, pre-v2) →
//     collapsed into one remark + category, company > sector > macro priority
const REMARK_BUCKET_HELPERS = require('./lib/remark-bucket');

async function writeRows(rows) {
  if (!rows || rows.length === 0) return { added: 0, updated: 0 };
  const p = getPool();
  const now = new Date().toISOString();

  // 1) Find which dates already exist — one round-trip, used to count added/updated.
  // date::text renders as 'YYYY-MM-DD' which matches the ISO strings from the
  // fetcher. Using text-vs-text avoids a cast on the $1 parameter (pg.js sends
  // JS arrays as text[]) and dodges the date/text operator mismatch.
  const dates = rows.map(r => r.date);
  const exists = await p.query(
    "SELECT date::text AS d FROM daily WHERE date::text = ANY($1)",
    [dates]
  );
  const existingSet = new Set(exists.rows.map(r => r.d));
  let added = 0, updated = 0;
  for (const r of rows) (existingSet.has(r.date) ? updated++ : added++);

  // 2) Single multi-row upsert. One statement = one round-trip = no statement
  // timeout risk even at ~2.2k rows (10y backfill). COALESCE on remark/category
  // preserves existing AI remarks when the incoming price row carries none —
  // both columns are owned by the AI-remarks pipeline, not the price pipeline.
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const base = i * 10;
    const rm = normalizeRemarks(r);
    values.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10})`);
    params.push(
      r.date,
      r.close ?? null,
      r.change ?? null,
      r.volume ?? null,
      r.value ?? null,
      r.setIdx ?? null,
      r.propIdx ?? null,
      rm.remark,
      rm.category,
      now,
    );
  });

  await p.query(`
    INSERT INTO daily (date, close, "change", volume, value, "setIdx", "propIdx",
                       remark, category, fetched_at)
    VALUES ${values.join(',')}
    ON CONFLICT (date) DO UPDATE SET
      close      = EXCLUDED.close,
      "change"   = EXCLUDED."change",
      volume     = EXCLUDED.volume,
      value      = EXCLUDED.value,
      "setIdx"   = EXCLUDED."setIdx",
      "propIdx"  = EXCLUDED."propIdx",
      remark     = COALESCE(EXCLUDED.remark,    daily.remark),
      category   = COALESCE(EXCLUDED.category,  daily.category),
      fetched_at = EXCLUDED.fetched_at
  `, params);

  return { added, updated };
}

// Map a single-row object to {remark, category} for the v9 single-column shape.
// Accepts the legacy 3-col shape ({remark_company/sector/macro}) by picking
// the first non-null and back-classifying into a category — this keeps any
// stray legacy callers working without a code fork. The {remark} single-text
// shape uses classifySingle() so seed data (sample_data.js) keeps working.
function normalizeRemarks(r) {
  if (r.remark !== undefined) {
    const out = REMARK_BUCKET_HELPERS.classifySingle(r.remark);
    return { remark: out.text, category: out.category };
  }
  if (r.remark_company || r.remark_sector || r.remark_macro) {
    // Legacy 3-col input — collapse into one remark + category. Prefer
    // company > sector > macro (matches the priority in updateRemarks()).
    const text = r.remark_company || r.remark_sector || r.remark_macro;
    const category = r.remark_company ? 'company' : r.remark_sector ? 'sector' : 'macro';
    return { remark: text, category };
  }
  return { remark: null, category: null };
}

async function readAllRows(start, end) {
  const p = getPool();
  // Pipeline refactor (migrate-v9): the legacy 3-column remark shape
  // (remark_company / remark_sector / remark_macro) was dropped from the
  // schema in the fresh-install shape. The single (remark, category) pair
  // carries everything the UI needs; legacy callers have been migrated.
  let sql, params;
  if (start && end) {
    sql = `SELECT date, close, "change" AS "change", volume, value,
                  "setIdx" AS "setIdx", "propIdx" AS "propIdx",
                  remark, category,
                  morning_brief, morning_watch, morning_remark, morning_weekly_at,
                  user_note
           FROM daily WHERE date BETWEEN $1 AND $2 ORDER BY date ASC`;
    params = [start, end];
  } else {
    sql = `SELECT date, close, "change" AS "change", volume, value,
                  "setIdx" AS "setIdx", "propIdx" AS "propIdx",
                  remark, category,
                  morning_brief, morning_watch, morning_remark, morning_weekly_at,
                  user_note
           FROM daily ORDER BY date ASC`;
    params = [];
  }
  const r = await p.query(sql, params);
  return r.rows;
}

async function metadata() {
  const p = getPool();
  const r = await p.query('SELECT COUNT(*)::int AS n, MIN(date) AS dmin, MAX(date) AS dmax FROM daily');
  const last = await p.query(
    'SELECT finished_at, ok, source, rows_added, rows_updated, error FROM fetch_log ORDER BY id DESC LIMIT 1'
  );
  const lastRow = last.rows[0];
  const n = r.rows[0].n;
  return {
    rowCount: n,
    dateMin: r.rows[0].dmin,
    dateMax: r.rows[0].dmax,
    lastFetched: lastRow?.finished_at || null,
    lastFetchOk: lastRow ? Boolean(lastRow.ok) : null,
    lastFetchSource: lastRow?.source || null,
    lastFetchError: lastRow?.error || null,
    status: n === 0 ? 'empty' : (lastRow?.ok ? 'ok' : 'degraded'),
  };
}

async function logFetchStart() {
  const r = await getPool().query(
    'INSERT INTO fetch_log (started_at, ok, source) VALUES ($1, 0, $2) RETURNING id',
    [new Date().toISOString(), 'pending']
  );
  return Number(r.rows[0].id);
}

async function logFetchFinish(id, ok, source, added, updated, error) {
  await getPool().query(
    `UPDATE fetch_log
     SET finished_at = $1, ok = $2, source = $3,
         rows_added = $4, rows_updated = $5, error = $6
     WHERE id = $7`,
    [new Date().toISOString(), ok ? 1 : 0, source, added || 0, updated || 0, error || null, id]
  );
}

async function getStoredDates() {
  const r = await getPool().query('SELECT date FROM daily');
  return new Set(r.rows.map(row => row.date));
}

// Update only the 3 remark columns for a single date. Used by the AI-remarks
// pipeline — the price pipeline never touches remark_* so writeRows can
// safely COALESCE them.
//
// Pipeline refactor: this function is now a shim that delegates to
// updateSingleRemark() with a macro → sector → company priority. Old callers
// keep working for one release, then we drop this shim and the 3 legacy
// columns.
async function updateRemarks(date, { company = null, sector = null, macro = null } = {}) {
  const text = macro || sector || company;
  const category = macro ? 'macro' : sector ? 'sector' : company ? 'company' : null;
  return updateSingleRemark(date, { category, text });
}

// Update only the single (remark, category) pair for a date. Used by the
// gemini-search.mjs 'gemini-company' pipeline. The price pipeline never
// touches these columns, so writeRows() can safely leave them alone.
async function updateSingleRemark(date, { category = null, text = null } = {}) {
  await getPool().query(
    `UPDATE daily
     SET remark   = $1,
         category = $2
     WHERE date = $3`,
    [text, category, date]
  );
}

// Append a remark line for a date WITHOUT clobbering the existing remark
// (which is already owned by the COMPANY pipeline). Used by the MACRO
// pipeline for severity=high items — so the chart gets a macro pin alongside
// the company pin.
//
// Concatenation uses E'\n' so multi-pin days render as separate lines in the
// tooltip. category is COALESCE — we only set it if daily.category is null
// (so COMPANY's explicit category isn't overwritten by a vague 'macro').
async function appendRemarkPin(date, text, category = null) {
  await getPool().query(
    `UPDATE daily
     SET remark   = COALESCE(remark || E'\n' || $1, $1),
         category = COALESCE(category, $2)
     WHERE date = $3`,
    [text, category, date]
  );
}

// Migrate-v7: User-remark popover on the Daily Price Table.
// Save a user's personal remark on a specific date's daily row.
// `note === ''` or null/whitespace → clears to NULL. The Gemini-generated
// `remark` column is NOT touched — both coexist on the same row.
async function setDailyRemark(date, note) {
  if (!date || typeof date !== 'string') {
    throw new Error('setDailyRemark: date (YYYY-MM-DD) required');
  }
  const trimmed = (note && typeof note === 'string') ? note.trim() : '';
  await getPool().query(
    `UPDATE daily SET user_note = $1 WHERE date = $2`,
    [trimmed || null, date]
  );
}

// =============================================================================
// Morning brief (Monday-only, gemini-search.mjs 'gemini-morning-brief' source)
//
// Stores 4 fields on the row matching `date`. The frontend renders the latest
// non-null brief (no need to query by a specific date).
// =============================================================================

async function updateMorningBrief(date, { lastWeek = null, thisWeek = null, tone = null, reason = null } = {}) {
  await getPool().query(
    `UPDATE daily
     SET morning_brief     = $1,
         morning_watch     = $2,
         morning_remark    = $3,
         morning_weekly_at = $4
     WHERE date = $5`,
    [lastWeek, thisWeek, tone, new Date().toISOString(), date]
  );
}

// Returns the latest non-null morning brief (one row). Ordered by
// morning_weekly_at DESC NULLS LAST so a row whose weekly_at was just
// refreshed wins over older weeks even if date is the same.
async function readMorningBrief() {
  const r = await getPool().query(
    `SELECT date, morning_brief, morning_watch, morning_remark, morning_weekly_at
     FROM daily
     WHERE morning_brief IS NOT NULL
     ORDER BY morning_weekly_at DESC NULLS LAST
     LIMIT 1`
  );
  return r.rows[0] || null;
}

// =============================================================================
// Daily news summary (gemini-search 'gemini-daily-summary' source)
//
// One AI digest per ICT date, written after the day's final news pull. Upsert
// so re-runs (manual refresh / backfill of a past date) regenerate cleanly.
// Source news_feed rows are NEVER modified by this path — the summary is
// additive.
// =============================================================================

async function upsertDailySummary(date, {
  digest = null, headline = null, tone = null, reason = null, bullets = null, sourceCount = null,
} = {}) {
  await getPool().query(
    `INSERT INTO news_daily_summary (date, digest, headline, tone, reason, bullets, source_count, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (date) DO UPDATE SET
       digest       = EXCLUDED.digest,
       headline     = EXCLUDED.headline,
       tone         = EXCLUDED.tone,
       reason       = EXCLUDED.reason,
       bullets      = EXCLUDED.bullets,
       source_count = EXCLUDED.source_count,
       generated_at = EXCLUDED.generated_at`,
    [date, digest, headline, tone, reason, bullets, sourceCount, new Date().toISOString()]
  );
}

// Latest digest, or a specific date when passed. Ordered by date DESC so the
// default returns the most recent day that has a digest.
async function readDailySummary(date = null) {
  const p = getPool();
  const sql = `SELECT date, digest, headline, tone, reason, bullets, source_count, generated_at
                 FROM news_daily_summary`;
  if (date) {
    const r = await p.query(sql + ' WHERE date = $1', [date]);
    return r.rows[0] || null;
  }
  const r = await p.query(sql + ' ORDER BY date DESC LIMIT 1');
  return r.rows[0] || null;
}

// All digests, ascending by date. Powers the chart "pin per day" + the Remark
// column: each day that has a digest gets the `headline` shown in the Remark
// cell (falling back to the first bullet client-side when there's none). One
// row per ICT date, so the set stays small.
async function readAllDailySummaries() {
  const r = await getPool().query(
    `SELECT date, digest, headline, tone, reason, source_count, generated_at
       FROM news_daily_summary
      ORDER BY date ASC`
  );
  return r.rows || [];
}

// All news_feed rows for one ICT date — the input the daily summary digests.
// hidden rows are excluded (user-dismissed). Capped at 500 to bound the prompt.
async function readNewsFeedForDate(date) {
  const p = getPool();
  const r = await p.query(
    `SELECT id, title, date, category, source_label, severity, impact_level, display_priority
       FROM news_feed
       WHERE date = $1 AND hidden = FALSE
       ORDER BY display_priority DESC, id DESC
       LIMIT 500`,
    [date]
  );
  return r.rows;
}

// Latest ICT date that has at least one non-hidden news_feed row. Used by
// runDailySummary to fall back when today has no news yet (quiet morning,
// weekend, holiday) — instead of returning "failed", the summary digests
// the most recent day with content. Returns null when the feed is empty.
async function readLatestNewsDate() {
  const p = getPool();
  const r = await p.query(
    `SELECT date FROM news_feed WHERE hidden = FALSE ORDER BY date DESC LIMIT 1`
  );
  return r.rows[0]?.date || null;
}

// ── peer_prices ────────────────────────────────────────────────────────────

// peers is an array of arrays: peers[i] is the price series for the i-th ticker.
async function writePeers(tickers, names, peers) {
  const p = getPool();
  const now = new Date().toISOString();
  let rows = 0;
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i];
      const name = names[i] || ticker.replace('.BK', '');
      const series = peers[i] || [];
      let prevClose = null;
      for (const row of series) {
        if (row.close == null) { prevClose = row.close; continue; }
        const change = prevClose != null ? ((row.close - prevClose) / prevClose) * 100 : null;
        await client.query(`
          INSERT INTO peer_prices (date, ticker, name, close, "change", fetched_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (date, ticker) DO UPDATE SET
            name = EXCLUDED.name,
            close = EXCLUDED.close,
            "change" = EXCLUDED."change",
            fetched_at = EXCLUDED.fetched_at
        `, [row.date, ticker, name, row.close, change, now]);
        rows++;
        prevClose = row.close;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { rows };
}

async function readLatestPeers() {
  const p = getPool();
  const latest = await p.query('SELECT MAX(date) AS d FROM peer_prices');
  const d = latest.rows[0]?.d;
  if (!d) return { date: null, rows: [] };
  const r = await p.query(
    'SELECT ticker, name, close, "change" AS "change" FROM peer_prices WHERE date = $1 ORDER BY ticker ASC',
    [d]
  );
  return { date: d, rows: r.rows };
}

// ── news_feed ──────────────────────────────────────────────────────────────

// Derived priority used by the unified-feed sort (mirrors
// index.html#priorityForItem). Range 0..150, fits SMALLINT.
//
//   severity: high=100 | medium=50 | low/null=25
//   impact:   positive=25 | negative=15 | neutral/null=5
//   pin:      show_pin=TRUE → +10
function priorityForItem(it) {
  if (!it) return 0;
  const sev = it.severity === 'high' ? 100
            : it.severity === 'medium' ? 50
            : 25;
  const imp = it.impact === 'positive' ? 25
            : it.impact === 'negative' ? 15
            : 5;
  const pin = it.show_pin ? 10 : 0;
  return sev + imp + pin;
}

// Multi-row INSERT with ON CONFLICT (title_hash) DO NOTHING. The unique index
// on title_hash is the second line of dedup; the in-memory Set in
// gemini-search.mjs is the first. The 14 columns mirror ensureSchema()'s
// news_feed shape, in order: title, date, category, source_url, source_label,
// title_hash, pipeline, impact, severity, show_pin, fetched_at,
// display_priority, summary, impact_level.
async function writeNewsItems(items) {
  if (!items || !items.length) return { inserted: 0 };
  const p = getPool();
  const now = new Date().toISOString();
  const values = [];
  const params = [];
  items.forEach((it, i) => {
    const base = i * 14;
    values.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13},$${base+14})`);
    params.push(
      it.title,
      it.date,
      it.category,
      it.source_url,
      it.source_label,
      it.title_hash,
      it.pipeline     ?? null,
      it.impact       ?? null,
      it.severity     ?? null,
      it.show_pin     ?? false,
      now,
      // RSS/Gemini sources that score relevance (rss-property) pre-compute
      // `display_priority` and pass it in directly. Sources that only know
      // severity/impact fall back to priorityForItem() which derives
      // 50/55/125 from those fields.
      (typeof it.display_priority === 'number' && it.display_priority > 0)
        ? it.display_priority
        : priorityForItem(it),
      it.summary      ?? null,
      it.impact_level ?? null,         // HIGH/MEDIUM/LOW impact magnitude
    );
  });
  const r = await p.query(`
    INSERT INTO news_feed (title, date, category, source_url, source_label, title_hash,
                           pipeline, impact, severity, show_pin,
                           fetched_at, display_priority, summary, impact_level)
    VALUES ${values.join(',')}
    ON CONFLICT (title_hash) DO NOTHING
  `, params);
  return { inserted: r.rowCount };
}

// Read recent news items, sorted severity-first then newest-first. Optional
// category/since filters (since is an ISO date string from `date` column).
// The composite index on (display_priority DESC, date DESC, id DESC) backs
// this sort — high-severity items surface first, same priority keeps date
// order, id tiebreaks identical timestamps deterministically.
async function readNewsFeed({ category = null, since = null, limit = 100 } = {}) {
  const p = getPool();
  // User-dismissed (hidden) rows are always excluded. The hide feature was
  // removed; the column/flag is kept so previously-hidden rows stay dismissed.
  const where = ['hidden = FALSE'];
  const params = [];
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  if (since)    { params.push(since);    where.push(`date >= $${params.length}`); }
  params.push(Math.min(limit || 100, 500));
  const sql = `SELECT id, title, date, category, source_url, source_label,
                      pipeline, impact, severity, show_pin, display_priority, summary,
                      impact_level, user_note, chart_marked
               FROM news_feed
               WHERE ${where.join(' AND ')}
               ORDER BY display_priority DESC, date DESC, id DESC
               LIMIT $${params.length}`;
  const r = await p.query(sql, params);
  return r.rows;
}

// Set/clear the user_note for a single row by id. Empty / null / whitespace
// clears the note. Caller just awaits — return value is discarded.
async function setNewsNote(id, note) {
  if (!Number.isFinite(parseInt(id, 10))) {
    throw new Error('setNewsNote: id must be an integer');
  }
  const trimmed = (note && typeof note === 'string') ? note.trim() : '';
  await getPool().query(
    `UPDATE news_feed SET user_note = $1 WHERE id = $2`,
    [trimmed || null, id]
  );
}

// Set/clear the chart "mark" for a single row by id (POST /api/news/:id/mark).
// Any feed row can be marked — no pipeline guard (unlike deleteNewsItem). The
// dashboard chart reads chart_marked rows to place user pins, replacing the
// digest-driven Event Pins on that chart only (Price History keeps digest pins).
async function setNewsMark(id, marked) {
  if (!Number.isFinite(parseInt(id, 10))) {
    throw new Error('setNewsMark: id must be an integer');
  }
  await getPool().query(
    `UPDATE news_feed SET chart_marked = $1 WHERE id = $2`,
    [!!marked, id]
  );
}

// Manually-added news (POST /api/news). Builds the full news_feed row shape and
// reuses writeNewsItems() so dedup (title_hash unique index), display_priority
// derivation, and indexing all happen for free. pipeline='manual' tags the row so
// the frontend can show a "เพิ่มเอง" badge and the DELETE guard below can
// restrict removal to user-added rows only.
//
// title_hash = sha1(normalizeHeadline(title)) — SAME formula as the RSS and
// Gemini pipelines, so a manually-added row dedupes against pipeline rows
// that pull the same headline from a different source. (Earlier this used
// `sha1(title|url)` which let the same story slip in twice — once from the
// user, once from a pipeline pull — because the hashes differed.)
// `category` is resolved by the caller (user pick or classifyCategory); MACRO is
// the defensive fallback so the NOT NULL column is never violated.
async function insertManualNews({ title, source_url, category, severity, summary } = {}) {
  const todayICT = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  let hostname = 'เพิ่มเอง';
  try { hostname = new URL(source_url).hostname || hostname; } catch {}
  const normTitle = normalizeHeadline(title) || `${String(title).trim()}|${source_url}`;
  const { inserted } = await writeNewsItems([{
    title,
    date: todayICT,
    category: category || 'MACRO',
    source_url,
    source_label: hostname,
    title_hash: sha1(normTitle),
    pipeline: 'manual',
    impact: null,
    severity: severity || null,
    show_pin: false,
    summary: summary || null,
  }]);
  return { inserted };
}

// Delete a single news row — but ONLY when it was user-added (pipeline='manual').
// The WHERE guard stops a stray DELETE from removing a pipeline-sourced row even
// if someone hits the endpoint with its id. Returns { deleted } (0 = not found or
// not deletable).
async function deleteNewsItem(id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) throw new Error('deleteNewsItem: id must be an integer');
  const r = await getPool().query(
    `DELETE FROM news_feed WHERE id = $1 AND pipeline = 'manual'`,
    [n]
  );
  return { deleted: r.rowCount };
}

// Aggregate status for the unified-feed header. Reads from `fetch_log` (last
// run per Gemini sub-pipeline) and counts the news_feed table for the badge.
//
// Used by GET /api/news/status — added in step 4 of the unified-feed rebuild.
// Returns:
//   {
//     lastRuns: {
//       company: { source, started_at, finished_at, ok, rows_added, error } | null,
//       sector:  ...,
//       macro:   ...,
//       brief:   ...
//     },
//     counts:  { total, high, high_priority },
//     fetchedAt: <now ISO>
//   }
//
// "high_priority" is display_priority >= 75 (high severity OR positive impact
// + medium severity), the bar the unified feed renders as a pin.
async function readNewsStatus() {
  const p = getPool();
  // Include RSS pipelines alongside Gemini ones — earlier this list missed
  // rss-property and rss-extended, so the dashboard's Pipeline Status card
  // only showed 5 of the 7 active sources.
  const sources = [
    'rss-property',
    'rss-extended',
    'gemini-company',
    'gemini-sector',
    'gemini-macro',
    'gemini-morning-brief',
    'gemini-daily-summary',
  ];
  const lastRuns = {};
  // 7 simple queries — fetch_log is small (append-only). Could be combined
  // into one LATERAL but readability wins here.
  for (const source of sources) {
    const r = await p.query(
      `SELECT source, started_at, finished_at, ok, rows_added, error
       FROM fetch_log
       WHERE source = $1
       ORDER BY id DESC LIMIT 1`,
      [source]
    );
    // Stable display keys: strip prefixes so the frontend doesn't have to
    // know about internal naming. gemini-morning-brief → 'brief' (matches
    // the frontend's existing lookup; previously the API returned 'morning'
    // which caused the brief row to always render as 'never run').
    let key = source
      .replace(/^gemini-/, '')
      .replace(/^rss-/, 'rss-')
      .replace(/-brief$/, '');
    if (source === 'gemini-morning-brief') key = 'brief';
    if (source === 'gemini-daily-summary') key = 'daily-summary';
    lastRuns[key] = r.rows[0] || null;
  }
  const c = await p.query(`
    SELECT
      COUNT(*)                                                  AS total,
      COUNT(*) FILTER (WHERE severity = 'high')                 AS high,
      COUNT(*) FILTER (WHERE display_priority >= 75)            AS high_priority,
      COUNT(*) FILTER (WHERE SUBSTR(fetched_at, 1, 10) = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD')) AS today
    FROM news_feed
  `);
  return {
    lastRuns,
    counts: {
      total:         Number(c.rows[0]?.total || 0),
      high:          Number(c.rows[0]?.high || 0),
      high_priority: Number(c.rows[0]?.high_priority || 0),
      today:         Number(c.rows[0]?.today || 0),
    },
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  openDb,
  ensureSchema,
  closeDb,
  // daily
  writeRows,
  readAllRows,
  metadata,
  logFetchStart,
  logFetchFinish,
  getStoredDates,
  updateRemarks,        // legacy 3-col shim → updateSingleRemark (drop next release)
  updateSingleRemark,   // v2 — COMPANY pipeline writes here
  appendRemarkPin,      // v3 — MACRO pipeline appends high-severity pins here
  updateMorningBrief,   // v3 — Monday weekly brief writer
  readMorningBrief,     // Monday weekly brief reader
  upsertDailySummary,   // v10 — per-day AI digest writer
  readDailySummary,     // v10 — per-day AI digest reader
  readAllDailySummaries,// v10 — every digest, for chart pins + Remark column
  readNewsFeedForDate,  // v10 — news rows for one date (summary input)
  readLatestNewsDate,   // v11 — latest date with news (daily-summary fallback)
  setDailyRemark,       // user note writer on daily.price table popover
  // peer_prices
  writePeers,
  readLatestPeers,
  // news_feed
  priorityForItem,      // derived priority, used by writeNewsItems
  writeNewsItems,
  readNewsFeed,
  readNewsStatus,       // GET /api/news/status payload
  setNewsNote,          // v6 — user_note writer
  setNewsMark,          // POST /api/news/:id/mark — dashboard chart pin toggle
  insertManualNews,     // POST /api/news — user-added news
  deleteNewsItem,       // DELETE /api/news/:id — manual rows only
};