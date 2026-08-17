// =============================================================================
// Audit the links already in news_feed. READ-ONLY BY DEFAULT.
//
//   node scripts/audit-news-urls.mjs
//
// A plain run reads rows, checks each URL over HTTP, prints a report, and
// writes NOTHING. --apply records the verdict in the migrate-v11 columns.
//
// WHAT IT WILL NEVER DO
//   - DELETE a news row. A broken link is a fact about the link, not a reason
//     to destroy the headline, summary, date and category attached to it.
//   - Rewrite source_url. Even under --apply, the URL is left exactly as
//     found; only validation metadata is written. Clearing a URL needs the
//     separate, explicit --clear-broken, and even that touches only the
//     statuses that PROVE the link is not this article.
//   - Treat a 403 as a dead link. 401/403 mean the publisher blocks crawlers;
//     8 of 60 sampled links are this and at least one was confirmed by hand to
//     load correctly in a browser. They are reported as `blocked`.
//   - Treat a timeout, a 5xx or a DNS failure as dead. Those are `unknown`.
//
// FLAGS
//   --limit=N          cap the number of rows examined (default: all)
//   --concurrency=N    simultaneous HTTP checks (default 6)
//   --category=NAME    restrict to one taxonomy category
//   --since=YYYY-MM-DD restrict to rows dated on/after this
//   --status=NAME      re-check only rows already at this status
//   --json[=FILE]      emit machine-readable results (stdout, or a file)
//   --apply            write validation metadata (never source_url, never rows)
//   --clear-broken     with --apply: additionally blank source_url for the
//                      statuses that prove the link is wrong
//                      (dead / homepage / mismatch / unsafe). Off by default.
//
// EXAMPLES
//   node scripts/audit-news-urls.mjs --limit=50
//   node scripts/audit-news-urls.mjs --since=2026-08-01 --json=/tmp/audit.json
//   node scripts/audit-news-urls.mjs --apply --limit=200
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { STATUS, createValidationCache, mapLimit, classifyUrlOffline } from '../backend/lib/url-validator.mjs';
import { sameStory } from '../backend/lib/news-url-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env'), quiet: true });

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const a = argv.find(x => x === `--${f}` || x.startsWith(`--${f}=`));
  if (!a) return d;
  const eq = a.indexOf('=');
  return eq === -1 ? true : a.slice(eq + 1);
};
const num = (f, d) => { const v = parseInt(val(f), 10); return Number.isFinite(v) ? v : d; };

const APPLY        = has('--apply');
const CLEAR_BROKEN = has('--clear-broken');
const LIMIT        = num('limit', null);
const CONCURRENCY  = Math.max(1, Math.min(num('concurrency', 6), 16));
const CATEGORY     = val('category', null);
const SINCE        = val('since', null);
const ONLY_STATUS  = val('status', null);
const JSON_OUT     = val('json', null);

if (SINCE && !/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) {
  console.error('--since must be YYYY-MM-DD');
  process.exit(1);
}
if (CLEAR_BROKEN && !APPLY) {
  console.error('--clear-broken requires --apply (it is a write). Refusing.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set in environment');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (() => {
    try {
      const u = new URL(process.env.DATABASE_URL);
      if (u.hostname.endsWith('.railway.internal') || u.hostname === 'localhost') return false;
    } catch { /* default to SSL on */ }
    return { rejectUnauthorized: false };
  })(),
  max: Math.min(CONCURRENCY, 8),
});

// Statuses that PROVE the stored link is not this article. Only these are
// eligible for --clear-broken. Everything else means "could not determine".
const PROVEN_WRONG = new Set([STATUS.DEAD, STATUS.HOMEPAGE, STATUS.MISMATCH, STATUS.UNSAFE]);

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

async function main() {
  const where = ['hidden = FALSE'];
  const params = [];
  if (CATEGORY)    { params.push(CATEGORY);   where.push(`category = $${params.length}`); }
  if (SINCE)       { params.push(SINCE);      where.push(`date >= $${params.length}`); }
  if (ONLY_STATUS) { params.push(ONLY_STATUS); where.push(`source_url_status = $${params.length}`); }

  // source_url_status may not exist yet if migrate-v11 has not run. Detect it
  // rather than crashing, so the audit still works as a pure read on an
  // un-migrated database.
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'news_feed' AND column_name LIKE 'source_url_%'`);
  const migrated = cols.some(c => c.column_name === 'source_url_status');
  if (!migrated) {
    if (ONLY_STATUS || APPLY) {
      console.error('news_feed has no source_url_status column — run:  node backend/migrate-v11.js --apply');
      process.exit(1);
    }
    console.log('note: migrate-v11 has not run; reporting only, no status column to compare against.\n');
    const i = where.findIndex(w => w.includes('source_url_status'));
    if (i >= 0) where.splice(i, 1);
  }

  const sel = migrated
    ? 'id, title, date, category, source_url, source_label, source_url_status'
    : `id, title, date, category, source_url, source_label, 'unchecked' AS source_url_status`;

  const { rows } = await pool.query(
    `SELECT ${sel} FROM news_feed WHERE ${where.join(' AND ')}
      ORDER BY date DESC, id DESC ${LIMIT ? `LIMIT ${LIMIT}` : ''}`, params);

  console.log(`[audit] rows in scope    : ${rows.length}${LIMIT ? ` (--limit=${LIMIT})` : ''}`);
  console.log(`[audit] mode             : ${APPLY ? 'APPLY (writes validation metadata only)' : 'DRY-RUN (read-only)'}`);
  if (APPLY) console.log(`[audit] clear broken urls: ${CLEAR_BROKEN ? 'YES (--clear-broken)' : 'no — source_url left untouched'}`);
  console.log(`[audit] concurrency      : ${CONCURRENCY}\n`);

  // --- BEFORE ---------------------------------------------------------------
  const before = {};
  for (const r of rows) before[r.source_url_status || 'unchecked'] = (before[r.source_url_status || 'unchecked'] || 0) + 1;

  // --- structural findings that need no network ------------------------------
  const empty = rows.filter(r => !r.source_url);
  // One URL carrying several genuinely different headlines. Uniqueness alone is
  // NOT the test — an outlet's live-updated page legitimately covers one
  // running story — so each group is compared semantically.
  const byUrl = new Map();
  for (const r of rows) {
    if (!r.source_url) continue;
    if (!byUrl.has(r.source_url)) byUrl.set(r.source_url, []);
    byUrl.get(r.source_url).push(r);
  }
  const collisions = [];
  for (const [url, group] of byUrl) {
    if (group.length < 2) continue;
    const distinct = [];
    for (const r of group) if (!distinct.some(d => sameStory(d.title, r.title))) distinct.push(r);
    if (distinct.length > 1) collisions.push({ url, rows: group.length, distinctStories: distinct.length, sample: distinct.slice(0, 3).map(r => r.title) });
  }
  collisions.sort((a, b) => b.distinctStories - a.distinctStories);

  // --- HTTP pass -------------------------------------------------------------
  const toCheck = rows.filter(r => r.source_url);
  const cache = createValidationCache({ timeoutMs: 8000, maxRedirects: 5 });
  const results = new Map();
  let done = 0;

  if (toCheck.length) {
    process.stdout.write(`[audit] checking ${toCheck.length} url(s)`);
    await mapLimit(toCheck, CONCURRENCY, async (r) => {
      const v = await cache.validate(r.source_url, { sourceLabel: r.source_label });
      results.set(r.id, v);
      if (++done % 25 === 0) process.stdout.write('.');
    });
    process.stdout.write('\n\n');
  }

  // --- report ---------------------------------------------------------------
  const tally = {};
  const bump = (k) => { tally[k] = (tally[k] || 0) + 1; };
  for (const r of rows) {
    if (!r.source_url) { bump('empty url'); continue; }
    const v = results.get(r.id);
    bump(v ? v.status : 'unknown');
  }
  // Sub-counts the operator asked to see broken out.
  const http = (code) => [...results.values()].filter(v => v.httpStatus === code).length;
  const softs = [...results.values()].filter(v => /soft-404/.test(v.reason || '')).length;
  const redirected = [...results.values()].filter(v => (v.redirects || 0) > 0).length;

  console.log('=== RESULT ===');
  const order = [STATUS.VALID, 'empty url', STATUS.HOMEPAGE, STATUS.DEAD, STATUS.BLOCKED,
                 STATUS.RATE_LIMITED, STATUS.TIMEOUT, STATUS.MISMATCH, STATUS.UNSAFE, STATUS.UNKNOWN];
  for (const k of order) if (tally[k]) console.log(`  ${pad(k, 14)} ${lpad(tally[k], 5)}`);
  for (const k of Object.keys(tally)) if (!order.includes(k)) console.log(`  ${pad(k, 14)} ${lpad(tally[k], 5)}`);
  console.log('  ' + '-'.repeat(20));
  console.log(`  ${pad('HTTP 404', 14)} ${lpad(http(404), 5)}`);
  console.log(`  ${pad('HTTP 410', 14)} ${lpad(http(410), 5)}`);
  console.log(`  ${pad('soft-404', 14)} ${lpad(softs, 5)}`);
  console.log(`  ${pad('redirected', 14)} ${lpad(redirected, 5)}`);
  console.log(`  ${pad('url collision', 14)} ${lpad(collisions.length, 5)}  (URLs serving >1 distinct story)`);

  if (collisions.length) {
    console.log('\n=== ONE URL, SEVERAL STORIES ===');
    for (const c of collisions.slice(0, 8)) {
      console.log(`  ${c.distinctStories} distinct stories across ${c.rows} rows — ${c.url.slice(0, 76)}`);
      for (const t of c.sample) console.log(`      · ${String(t).slice(0, 70)}`);
    }
    if (collisions.length > 8) console.log(`  ... and ${collisions.length - 8} more`);
  }

  const proven = rows.filter(r => results.get(r.id) && PROVEN_WRONG.has(results.get(r.id).status));
  if (proven.length) {
    console.log(`\n=== ${proven.length} LINK(S) PROVEN NOT TO BE THIS ARTICLE ===`);
    for (const r of proven.slice(0, 10)) {
      const v = results.get(r.id);
      console.log(`  ${lpad(r.id, 5)}  ${pad(v.status, 9)} ${String(v.reason || '').slice(0, 52)}`);
      console.log(`         "${String(r.title).slice(0, 64)}"`);
    }
    if (proven.length > 10) console.log(`  ... and ${proven.length - 10} more`);
  }

  if (JSON_OUT) {
    const payload = {
      generatedAt: new Date().toISOString(),
      scope: { limit: LIMIT, category: CATEGORY, since: SINCE, status: ONLY_STATUS, rows: rows.length },
      tally, collisions,
      rows: rows.map(r => {
        const v = results.get(r.id) || null;
        return {
          id: r.id, date: r.date, category: r.category, title: r.title,
          source_label: r.source_label, source_url: r.source_url,
          status: r.source_url ? (v ? v.status : STATUS.UNKNOWN) : STATUS.UNCHECKED,
          httpStatus: v?.httpStatus ?? null, finalUrl: v?.finalUrl ?? null,
          reason: v?.reason ?? null, redirects: v?.redirects ?? 0,
        };
      }),
    };
    const text = JSON.stringify(payload, null, 2);
    if (JSON_OUT === true) console.log('\n' + text);
    else { writeFileSync(JSON_OUT, text); console.log(`\n[audit] json → ${JSON_OUT}`); }
  }

  // --- apply -----------------------------------------------------------------
  if (!APPLY) {
    console.log('\n[audit] DRY-RUN — nothing was written.');
    console.log('[audit] to record these verdicts:  node scripts/audit-news-urls.mjs --apply');
    return;
  }

  const checkedAt = new Date().toISOString();
  let written = 0, cleared = 0;
  const BATCH = 100;
  const updates = rows.filter(r => results.has(r.id));

  // Batched transactions: a failure rolls back only the batch in flight, and a
  // partial run is safe to resume because every write is idempotent.
  for (let i = 0; i < updates.length; i += BATCH) {
    const slice = updates.slice(i, i + BATCH);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of slice) {
        const v = results.get(r.id);
        const clearThis = CLEAR_BROKEN && PROVEN_WRONG.has(v.status);
        await client.query(
          `UPDATE news_feed
              SET source_url_status = $1,
                  source_url_checked_at = $2,
                  source_url_http_status = $3,
                  source_url_final = $4,
                  source_url_validation_reason = $5,
                  url_verified = $6
                  ${clearThis ? ', source_url = \'\'' : ''}
            WHERE id = $7`,
          [v.status, checkedAt, v.httpStatus ?? null, v.finalUrl ?? null,
           v.reason ?? null, v.status === STATUS.VALID, r.id]);
        written++;
        if (clearThis) cleared++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[audit] batch ${i}-${i + slice.length} rolled back: ${e.message}`);
      throw e;
    } finally {
      client.release();
    }
  }

  // --- after ----------------------------------------------------------------
  const { rows: afterRows } = await pool.query(
    `SELECT source_url_status st, count(*) n FROM news_feed WHERE hidden = FALSE GROUP BY 1 ORDER BY n DESC`);
  console.log('\n=== BEFORE → AFTER (whole visible table) ===');
  for (const a of afterRows) {
    const b = before[a.st] ?? 0;
    console.log(`  ${pad(a.st, 14)} ${lpad(b, 5)} → ${lpad(a.n, 5)}`);
  }
  console.log(`\n[audit] wrote validation metadata for ${written} row(s).`);
  console.log(`[audit] source_url cleared on ${cleared} row(s)${CLEAR_BROKEN ? '' : ' (--clear-broken not passed)'}.`);
  console.log('[audit] no news row was deleted.');
}

main()
  .catch((e) => { console.error('[audit] fatal:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
