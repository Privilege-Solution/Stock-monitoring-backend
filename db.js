'use strict';

// Postgres-only DB layer. Reads/writes go through a pg.Pool connected to the
// Supabase DATABASE_URL. All public functions are async — callers (server.js,
// fetchers/index.js) await them.
//
// Schema (auto-created by migrate.js):
//   daily          — one row per trading day, PRIMARY KEY date
//   peer_prices    — one row per (date, ticker)
//   fetch_log      — append-only fetch audit trail, SERIAL id
//   news_articles  — NewsAPI articles, UNIQUE(url, published_at)

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

// Upsert by date. The COALESCE on remark preserves the existing remark when
// the incoming row has no remark — daily.remark is owned by the AI-remarks
// pipeline, not by the price pipeline.
async function writeRows(rows) {
  const p = getPool();
  const now = new Date().toISOString();
  let added = 0, updated = 0;
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const exists = await client.query('SELECT 1 FROM daily WHERE date = $1', [r.date]);
      const wasNew = exists.rowCount === 0;
      await client.query(`
        INSERT INTO daily (date, close, "change", volume, value, "setIdx", "propIdx", remark, fetched_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (date) DO UPDATE SET
          close      = EXCLUDED.close,
          "change"   = EXCLUDED."change",
          volume     = EXCLUDED.volume,
          value      = EXCLUDED.value,
          "setIdx"   = EXCLUDED."setIdx",
          "propIdx"  = EXCLUDED."propIdx",
          remark     = COALESCE(EXCLUDED.remark, daily.remark),
          fetched_at = EXCLUDED.fetched_at
      `, [
        r.date,
        r.close ?? null,
        r.change ?? null,
        r.volume ?? null,
        r.value ?? null,
        r.setIdx ?? null,
        r.propIdx ?? null,
        r.remark ?? null,
        now,
      ]);
      if (wasNew) added++; else updated++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { added, updated };
}

async function readAllRows(start, end) {
  const p = getPool();
  let sql, params;
  if (start && end) {
    sql = `SELECT date, close, "change" AS "change", volume, value,
                  "setIdx" AS "setIdx", "propIdx" AS "propIdx", remark
           FROM daily WHERE date BETWEEN $1 AND $2 ORDER BY date ASC`;
    params = [start, end];
  } else {
    sql = `SELECT date, close, "change" AS "change", volume, value,
                  "setIdx" AS "setIdx", "propIdx" AS "propIdx", remark
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

// Update only daily.remark for a single date. Used by the AI-remarks pipeline.
async function updateRemark(date, remark) {
  await getPool().query(
    'UPDATE daily SET remark = $1 WHERE date = $2',
    [remark, date]
  );
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

// ── news_articles ──────────────────────────────────────────────────────────

async function writeNews(articles) {
  const p = getPool();
  const now = new Date().toISOString();
  let added = 0;
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    for (const a of articles) {
      const pub = a.publishedAt || a.published_at;
      const url = a.url || '';
      const r = await client.query(`
        INSERT INTO news_articles (published_at, title, description, url, source_name, query_tag, fetched_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (url, published_at) DO NOTHING
      `, [
        pub || '',
        a.title || '',
        a.description || null,
        url,
        (a.source && (a.source.name || a.source)) || null,
        a.queryTag || a.query_tag || null,
        now,
      ]);
      if (r.rowCount > 0) added++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { added, scanned: articles.length };
}

async function readNews({ from, tag, limit = 200 } = {}) {
  const p = getPool();
  const where = [];
  const params = [];
  if (from) { params.push(from); where.push(`published_at >= $${params.length}`); }
  if (tag)  { params.push(tag);  where.push(`query_tag = $${params.length}`); }
  params.push(limit);
  const sql = `
    SELECT published_at, title, description, url, source_name, query_tag
    FROM news_articles
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY published_at DESC
    LIMIT $${params.length}
  `;
  const r = await p.query(sql, params);
  return r.rows;
}

async function newsMetadata() {
  const r = await getPool().query(`
    SELECT COUNT(*)::int AS n,
           MIN(published_at) AS pmin,
           MAX(published_at) AS pmax,
           MAX(fetched_at)   AS last_fetched
    FROM news_articles
  `);
  const row = r.rows[0];
  return {
    rowCount: row.n || 0,
    oldestArticle: row.pmin || null,
    newestArticle: row.pmax || null,
    lastFetched:   row.last_fetched || null,
  };
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
  updateRemark,
  // peer_prices
  writePeers,
  readLatestPeers,
  // news_articles
  writeNews,
  readNews,
  newsMetadata,
};