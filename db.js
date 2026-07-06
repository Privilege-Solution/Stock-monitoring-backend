'use strict';

// Postgres-only DB layer. Reads/writes go through a pg.Pool connected to the
// Supabase DATABASE_URL. All public functions are async — callers (server.js,
// fetchers/index.js) await them.
//
// Schema (auto-created by migrate.js):
//   daily          — one row per trading day, PRIMARY KEY date
//                    remark split into 3 category columns (company/sector/macro)
//   peer_prices    — one row per (date, ticker)
//   fetch_log      — append-only fetch audit trail, SERIAL id

const { Pool } = require('pg');

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

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set in environment');
  }
  const cfg = parsePgUrl(process.env.DATABASE_URL);
  pool = new Pool({
    ...cfg,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
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

// ── daily ──────────────────────────────────────────────────────────────────

// Upsert by date. The COALESCE on each remark column preserves existing AI
// remarks when the incoming row has none — the 3 remark columns are owned
// by the AI-remarks pipeline, not by the price pipeline.
//
// Accepts both the new shape ({remark_company, remark_sector, remark_macro})
// and the legacy shape ({remark}); legacy single-text remarks are bucketed
// by classifyBucket() so seed data (sample_data.js) keeps working after the
// schema split.
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
  // timeout risk even at ~1.2k rows. COALESCE on remark_* preserves existing
  // AI remarks when the incoming price row carries none.
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const base = i * 11;
    const rm = normalizeRemarks(r);
    values.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11})`);
    params.push(
      r.date,
      r.close ?? null,
      r.change ?? null,
      r.volume ?? null,
      r.value ?? null,
      r.setIdx ?? null,
      r.propIdx ?? null,
      rm.company,
      rm.sector,
      rm.macro,
      now,
    );
  });

  await p.query(`
    INSERT INTO daily (date, close, "change", volume, value, "setIdx", "propIdx",
                       remark_company, remark_sector, remark_macro, fetched_at)
    VALUES ${values.join(',')}
    ON CONFLICT (date) DO UPDATE SET
      close          = EXCLUDED.close,
      "change"       = EXCLUDED."change",
      volume         = EXCLUDED.volume,
      value          = EXCLUDED.value,
      "setIdx"       = EXCLUDED."setIdx",
      "propIdx"      = EXCLUDED."propIdx",
      remark_company = COALESCE(EXCLUDED.remark_company, daily.remark_company),
      remark_sector  = COALESCE(EXCLUDED.remark_sector,  daily.remark_sector),
      remark_macro   = COALESCE(EXCLUDED.remark_macro,   daily.remark_macro),
      fetched_at     = EXCLUDED.fetched_at
  `, params);

  return { added, updated };
}

// Map a single-row object to {company, sector, macro} strings. Accepts both
// the new 3-column shape and the legacy {remark} single-text shape so the
// SQLite seed path (sample_data.js) keeps working without rewriting 595 rows.
function normalizeRemarks(r) {
  if (r.remark_company !== undefined || r.remark_sector !== undefined || r.remark_macro !== undefined) {
    return {
      company: r.remark_company ?? null,
      sector:  r.remark_sector  ?? null,
      macro:   r.remark_macro   ?? null,
    };
  }
  if (r.remark) return REMARK_BUCKET_HELPERS.classifyBucket(r.remark);
  return { company: null, sector: null, macro: null };
}

async function readAllRows(start, end) {
  const p = getPool();
  // Pipeline refactor: read the new 2-column remark shape (remark, category)
  // plus the morning-brief columns added in migrate-v3. The legacy 3 columns
  // (remark_company/sector/macro) are KEPT in the SELECT for one release so
  // the offline / sample_data.js fallback path and any external consumers
  // keep working. They will be dropped in a follow-up.
  let sql, params;
  if (start && end) {
    sql = `SELECT date, close, "change" AS "change", volume, value,
                  "setIdx" AS "setIdx", "propIdx" AS "propIdx",
                  remark, category,
                  morning_brief, morning_watch, morning_remark, morning_weekly_at,
                  remark_company, remark_sector, remark_macro
           FROM daily WHERE date BETWEEN $1 AND $2 ORDER BY date ASC`;
    params = [start, end];
  } else {
    sql = `SELECT date, close, "change" AS "change", volume, value,
                  "setIdx" AS "setIdx", "propIdx" AS "propIdx",
                  remark, category,
                  morning_brief, morning_watch, morning_remark, morning_weekly_at,
                  remark_company, remark_sector, remark_macro
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

// Multi-row INSERT with ON CONFLICT (title_hash) DO NOTHING. The unique index
// on title_hash (created by migrate-v2.js) is the second line of dedup; the
// in-memory Set in gemini-search.mjs is the first.
//
// Pipeline refactor (migrate-v3): added 4 columns — pipeline, impact,
// severity, show_pin — populated from Gemini's parseAIResult() output. The
// 7-column insert became an 11-column insert; older items without those keys
// (manual INSERTs, legacy data) get NULL/FALSE defaults and still parse fine.
async function writeNewsItems(items) {
  if (!items || !items.length) return { inserted: 0 };
  const p = getPool();
  const now = new Date().toISOString();
  const values = [];
  const params = [];
  items.forEach((it, i) => {
    const base = i * 11;
    values.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11})`);
    params.push(
      it.title,
      it.date,
      it.category,
      it.source_url,
      it.source_label,
      it.title_hash,
      it.pipeline   ?? null,
      it.impact     ?? null,
      it.severity   ?? null,
      it.show_pin   ?? false,
      now,
    );
  });
  const r = await p.query(`
    INSERT INTO news_feed (title, date, category, source_url, source_label, title_hash,
                           pipeline, impact, severity, show_pin,
                           fetched_at)
    VALUES ${values.join(',')}
    ON CONFLICT (title_hash) DO NOTHING
  `, params);
  return { inserted: r.rowCount };
}

// Read recent news items, newest first. Optional category/since filters
// (since is an ISO timestamp string — pass the value from `date` column).
async function readNewsFeed({ category = null, since = null, limit = 100 } = {}) {
  const p = getPool();
  const where = [];
  const params = [];
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  if (since)    { params.push(since);    where.push(`date >= $${params.length}`); }
  params.push(Math.min(limit || 100, 500));
  const sql = `SELECT id, title, date, category, source_url, source_label, fetched_at
               FROM news_feed
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY date DESC
               LIMIT $${params.length}`;
  const r = await p.query(sql, params);
  return r.rows;
}

module.exports = {
  openDb,
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
  readMorningBrief,     // v3 — Monday weekly brief reader
  // peer_prices
  writePeers,
  readLatestPeers,
  // news_feed
  writeNewsItems,
  readNewsFeed,
};