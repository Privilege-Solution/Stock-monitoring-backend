// =============================================================================
// Act on what scripts/audit-news-urls.mjs found. DRY-RUN BY DEFAULT.
//
//   node scripts/remediate-news-urls.mjs --help
//   node scripts/remediate-news-urls.mjs --status dead            # preview
//   node scripts/remediate-news-urls.mjs --status dead --apply    # write
//
// This is the only script in the repo that may change news_feed. It is
// deliberately separate from the audit so that "how bad is it?" can never
// mutate anything, and so the tool that can is one you reach for on purpose.
//
// WHAT IT MAY DO
//   record     write the validation verdict into the migrate-v11/v12 columns
//   hide-link  additionally blank source_url, for statuses that PROVE the link
//              is not this article. The news row itself always stays.
//   delete     ONLY with --delete-ids=1,2,3 or --delete-fingerprint=FP, and
//              only after printing every row it would remove.
//
// WHAT IT WILL NEVER DO
//   - Delete anything from a status filter. "--status dead --apply" hides
//     links; it cannot remove rows, however many times it is run.
//   - Touch blocked / rate_limited / timeout / network_error / unknown /
//     title_unknown / title_mismatch_medium. Those mean "we could not tell",
//     and taking a link away on a guess is worse than leaving a doubtful one.
//   - Hide a title_mismatch_high link without --include-title-mismatch. That
//     verdict comes from comparing two pieces of text, and text comparison
//     deserves a human before it costs a reader a working link.
//
// SAFETY
//   Every --apply run: exports the affected rows to JSON first, runs inside a
//   transaction, counts the rows it actually changed, and ROLLS BACK if that
//   count differs from the preview. A concurrent cron insert that widened the
//   match aborts the run rather than silently doing more than was shown.
//
// FLAGS
//   --status NAME[,NAME]        which verdicts to act on (required unless
//                               --delete-ids / --delete-fingerprint)
//   --from-audit=FILE           take verdicts from an audit --output file
//                               instead of re-fetching every page
//   --hide-links                blank source_url as well as recording status
//   --include-title-mismatch    allow title_mismatch_high in --hide-links
//   --delete-ids=1,2,3          delete exactly these rows, after preview
//   --delete-fingerprint=FP     delete the duplicates of one policy-event
//                               cluster, keeping the canonical row
//   --limit=N                   cap rows touched
//   --concurrency=N             HTTP checks when not using --from-audit
//   --backup-dir=DIR            where the JSON export goes (default scripts/)
//   --apply                     actually write. Without it, nothing happens.
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import {
  STATUS, PROVEN_WRONG_STATUSES, TRANSIENT_STATUSES,
  createValidationCache, mapLimit, canonicalizeUrl,
} from '../backend/lib/url-validator.mjs';
import { groupByEvent, eventFingerprint } from '../backend/lib/event-fingerprint.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env'), quiet: true });

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d = null) => {
  const i = argv.findIndex(x => x === `--${f}` || x.startsWith(`--${f}=`));
  if (i === -1) return d;
  const a = argv[i];
  const eq = a.indexOf('=');
  if (eq !== -1) return a.slice(eq + 1);
  const next = argv[i + 1];
  return (next && !next.startsWith('--')) ? next : true;
};
const num = (f, d) => { const v = parseInt(val(f), 10); return Number.isFinite(v) ? v : d; };

if (has('help') || !argv.length) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const APPLY        = has('apply');
const HIDE_LINKS   = has('hide-links');
const INCLUDE_TITLE = has('include-title-mismatch');
const LIMIT        = num('limit', null);
const CONCURRENCY  = Math.max(1, Math.min(num('concurrency', 6), 16));
const FROM_AUDIT   = val('from-audit', null);
const BACKUP_DIR   = val('backup-dir', __dirname);
const DELETE_IDS   = val('delete-ids', null);
const DELETE_FP    = val('delete-fingerprint', null);
const STATUSES     = String(val('status', '') || '').split(',').map(s => s.trim()).filter(Boolean);

// Statuses this script refuses to act on, whatever is asked. They all mean
// "we could not determine", and none of them is evidence against the link.
const NEVER_ACT = new Set([
  STATUS.BLOCKED, STATUS.RATE_LIMITED, STATUS.TIMEOUT, STATUS.NETWORK_ERROR,
  STATUS.UNKNOWN, STATUS.TITLE_UNKNOWN, STATUS.TITLE_MISMATCH_MEDIUM, STATUS.UNCHECKED,
]);

for (const s of STATUSES) {
  if (NEVER_ACT.has(s)) {
    console.error(`Refusing --status ${s}: that verdict means "could not determine", not "wrong".`);
    console.error('Acting on it would remove links from articles that are very likely fine.');
    process.exit(2);
  }
  if (!Object.values(STATUS).includes(s)) {
    console.error(`Unknown status "${s}". Known: ${Object.values(STATUS).join(', ')}`);
    process.exit(2);
  }
}
if (!STATUSES.length && !DELETE_IDS && !DELETE_FP) {
  console.error('Nothing to do. Pass --status NAME, --delete-ids=..., or --delete-fingerprint=...  (--help for detail)');
  process.exit(2);
}
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set in environment'); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (() => {
    try {
      const u = new URL(process.env.DATABASE_URL);
      if (u.hostname.endsWith('.railway.internal') || u.hostname === 'localhost') return false;
    } catch { /* default SSL on */ }
    return { rejectUnauthorized: false };
  })(),
  max: Math.min(CONCURRENCY, 8),
});

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const lpad = (s, n) => String(s).padStart(n);

function backup(name, rows) {
  const file = join(BACKUP_DIR, `backup-${name}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(rows, null, 2));
  console.log(`  backup → ${file}  (${rows.length} rows)`);
  return file;
}

// --- delete paths ---------------------------------------------------------------

async function deleteExplicit() {
  let ids = [];
  if (DELETE_IDS) {
    ids = String(DELETE_IDS).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
  } else {
    // Duplicates of ONE policy-event cluster. The canonical row is computed the
    // same way the audit reports it and is explicitly excluded.
    const { rows } = await pool.query(
      `SELECT id, title, date, source_url FROM news_feed WHERE hidden = FALSE`);
    const cluster = groupByEvent(rows).find(c => c.fingerprint === DELETE_FP);
    if (!cluster) {
      console.error(`No duplicate cluster with fingerprint "${DELETE_FP}".`);
      console.error('Run the audit to list current clusters:  node scripts/audit-news-urls.mjs');
      process.exitCode = 2; return;
    }
    console.log(`Cluster ${cluster.fingerprint}`);
    console.log(`  KEEP ${lpad(cluster.keep.id, 6)}  ${cluster.keep.date}  ${cluster.keep.title}`);
    ids = cluster.duplicates.map(d => d.id);
  }
  if (!ids.length) { console.log('No ids to delete.'); return; }

  const { rows: victims } = await pool.query(
    `SELECT id, date, title, source_url, source_label, category, pipeline, summary,
            show_pin, chart_marked, source_url_status
       FROM news_feed WHERE id = ANY($1::int[]) ORDER BY date, id`, [ids]);

  console.log(`\n=== WOULD DELETE ${victims.length} ROW(S) ===`);
  for (const v of victims) {
    console.log(`  ${lpad(v.id, 6)}  ${v.date}  ${String(v.title).slice(0, 66)}`);
    console.log(`          ${v.source_url ? v.source_url.slice(0, 74) : '(no link)'}`);
  }
  const missing = ids.filter(i => !victims.some(v => v.id === i));
  if (missing.length) console.log(`  (${missing.length} id(s) not found or already hidden: ${missing.join(',')})`);

  if (!APPLY) { console.log('\nDRY-RUN — pass --apply to delete these exact rows.'); return; }
  if (!victims.length) { console.log('\nNothing to delete.'); return; }

  backup('deleted-rows', victims);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`DELETE FROM news_feed WHERE id = ANY($1::int[])`, [victims.map(v => v.id)]);
    // The preview is the contract. If the DELETE touched a different number of
    // rows than we showed, something changed underneath us — abort.
    if (r.rowCount !== victims.length) {
      await client.query('ROLLBACK');
      console.error(`\nROLLED BACK: expected to delete ${victims.length}, statement affected ${r.rowCount}.`);
      process.exitCode = 1; return;
    }
    await client.query('COMMIT');
    console.log(`\n✓ deleted ${r.rowCount} row(s). Backup written above.`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\nROLLED BACK: ${e.message}`);
    process.exitCode = 1;
  } finally { client.release(); }
}

// --- status path -----------------------------------------------------------------

async function remediateByStatus() {
  // Verdicts come either from a previous audit run (cheap, reproducible) or
  // from re-checking now. Re-checking is the default because a stale verdict
  // should never be the basis for hiding a link.
  let verdicts = new Map();
  let rows;

  if (FROM_AUDIT) {
    if (!existsSync(FROM_AUDIT)) { console.error(`No such audit file: ${FROM_AUDIT}`); process.exitCode = 2; return; }
    const audit = JSON.parse(readFileSync(FROM_AUDIT, 'utf8'));
    console.log(`[remediate] verdicts from ${FROM_AUDIT} (generated ${audit.generatedAt})`);
    const wanted = new Set(STATUSES);
    const picked = (audit.rows || []).filter(r => wanted.has(r.status));
    const ids = picked.map(r => r.id);
    ({ rows } = await pool.query(
      `SELECT id, title, date, source_url, source_label, source_url_status
         FROM news_feed WHERE id = ANY($1::int[]) AND hidden = FALSE
         ORDER BY date DESC, id DESC ${LIMIT ? `LIMIT ${LIMIT}` : ''}`, [ids]));
    for (const p of picked) verdicts.set(p.id, p);
    // A row whose URL changed since the audit must not inherit that verdict.
    rows = rows.filter(r => {
      const v = verdicts.get(r.id);
      const same = v && canonicalizeUrl(v.source_url || '') === canonicalizeUrl(r.source_url || '');
      if (!same) console.log(`  skip ${r.id}: url changed since the audit`);
      return same;
    });
  } else {
    ({ rows } = await pool.query(
      `SELECT id, title, date, source_url, source_label, source_url_status
         FROM news_feed WHERE hidden = FALSE AND source_url <> '' AND source_url IS NOT NULL
         ORDER BY date DESC, id DESC ${LIMIT ? `LIMIT ${LIMIT}` : ''}`));
    console.log(`[remediate] re-checking ${rows.length} link(s) at concurrency ${CONCURRENCY}...`);
    const cache = createValidationCache({ timeoutMs: 8000, retry: true });
    await mapLimit(rows, CONCURRENCY, async (r) => {
      const v = await cache.validate(r.source_url, { sourceLabel: r.source_label, headline: r.title });
      verdicts.set(r.id, v);
    });
    const wanted = new Set(STATUSES);
    rows = rows.filter(r => wanted.has(verdicts.get(r.id)?.status));
  }

  // Guard rails applied AFTER the verdicts are in hand.
  const hideable = rows.filter(r => {
    const st = verdicts.get(r.id)?.status;
    if (!PROVEN_WRONG_STATUSES.has(st)) return false;
    if (st === STATUS.TITLE_MISMATCH_HIGH && !INCLUDE_TITLE) return false;
    return true;
  });

  console.log(`\n=== PLAN ===`);
  console.log(`  statuses selected : ${STATUSES.join(', ')}`);
  console.log(`  rows matched      : ${rows.length}`);
  console.log(`  record verdict    : ${rows.length}`);
  console.log(`  hide link         : ${HIDE_LINKS ? hideable.length : 0}${HIDE_LINKS ? '' : '  (--hide-links not passed)'}`);
  if (HIDE_LINKS && !INCLUDE_TITLE) {
    const held = rows.filter(r => verdicts.get(r.id)?.status === STATUS.TITLE_MISMATCH_HIGH).length;
    if (held) console.log(`  held back         : ${held} title_mismatch_high (needs --include-title-mismatch)`);
  }
  console.log(`  delete rows       : 0  (this path can never delete)`);

  for (const r of rows.slice(0, 10)) {
    const v = verdicts.get(r.id);
    console.log(`\n  ${lpad(r.id, 6)}  ${v.status}${v.matchScore != null ? `  score=${v.matchScore}` : ''}`);
    console.log(`          ours : ${String(r.title).slice(0, 68)}`);
    if (v.pageTitle) console.log(`          page : ${String(v.pageTitle).slice(0, 68)}`);
    console.log(`          ${String(v.reason || '').slice(0, 74)}`);
  }
  if (rows.length > 10) console.log(`\n  ... and ${rows.length - 10} more`);

  if (!APPLY) {
    console.log('\n[remediate] DRY-RUN — nothing written. Add --apply to commit.');
    return;
  }
  if (!rows.length) { console.log('\n[remediate] nothing matched; nothing to do.'); return; }

  const { rows: before } = await pool.query(
    `SELECT source_url_status st, count(*) n FROM news_feed WHERE hidden = FALSE GROUP BY 1`);

  backup('remediate', rows.map(r => ({
    id: r.id, title: r.title, source_url: r.source_url,
    source_url_status: r.source_url_status,
  })));

  const checkedAt = new Date().toISOString();
  const hideSet = new Set(HIDE_LINKS ? hideable.map(r => r.id) : []);
  let written = 0, hidden = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const v = verdicts.get(r.id);
      const hide = hideSet.has(r.id);
      const res = await client.query(
        `UPDATE news_feed
            SET source_url_status = $1,
                source_url_checked_at = $2,
                source_url_http_status = $3,
                source_url_final = $4,
                source_url_validation_reason = $5,
                source_url_title = $6,
                source_url_match_score = $7,
                source_url_check_attempts = COALESCE(source_url_check_attempts, 0) + $8,
                url_verified = $9
                ${hide ? ", source_url = ''" : ''}
          WHERE id = $10 AND hidden = FALSE`,
        [v.status, checkedAt, v.httpStatus ?? null, v.finalUrl ?? null,
         v.reason ?? null, v.pageTitle ?? null, v.matchScore ?? null,
         v.attempts ?? 1, v.status === STATUS.VALID, r.id]);
      written += res.rowCount;
      if (hide && res.rowCount) hidden++;
    }

    if (written !== rows.length) {
      await client.query('ROLLBACK');
      console.error(`\nROLLED BACK: planned ${rows.length} updates, statements affected ${written}.`);
      console.error('Something changed the table mid-run. Re-run the audit and try again.');
      process.exitCode = 1; return;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\nROLLED BACK: ${e.message}`);
    process.exitCode = 1; return;
  } finally { client.release(); }

  const { rows: after } = await pool.query(
    `SELECT source_url_status st, count(*) n FROM news_feed WHERE hidden = FALSE GROUP BY 1`);
  const b = Object.fromEntries(before.map(r => [r.st, +r.n]));
  const a = Object.fromEntries(after.map(r => [r.st, +r.n]));

  console.log('\n=== BEFORE → AFTER ===');
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if ((b[k] ?? 0) !== (a[k] ?? 0)) console.log(`  ${String(k).padEnd(22)} ${lpad(b[k] ?? 0, 5)} → ${lpad(a[k] ?? 0, 5)}`);
  }
  console.log(`\n✓ recorded ${written} verdict(s); blanked ${hidden} link(s); deleted 0 rows.`);
}

(async () => {
  console.log(`[remediate] mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);
  if (DELETE_IDS || DELETE_FP) await deleteExplicit();
  else await remediateByStatus();
})()
  .catch((e) => { console.error('[remediate] fatal:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
