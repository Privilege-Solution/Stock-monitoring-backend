// Recompute title_hash for every news_feed row using the new normalized-
// headline algorithm. After this runs, the DB unique index on title_hash
// will properly collapse duplicates and the fetcher's new title_hash logic
// will dedup against existing rows on re-pull.
//
// Two-pass:
//   1. DELETE duplicates that arise from the recomputation (keep the row
//      with highest display_priority / earliest id as tiebreaker).
//   2. UPDATE remaining rows to set title_hash = sha1(normalizeHeadline(title)).
//
// Run:
//   node scripts/recompute-title-hash.mjs            # dry-run
//   node scripts/recompute-title-hash.mjs --apply    # commit

import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHeadline } from '../backend/lib/fetchers/news-rss-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env') });

const APPLY = process.argv.includes('--apply');
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (() => {
    const u = new URL(process.env.DATABASE_URL);
    if (u.hostname.includes('.railway.internal') || u.hostname === 'localhost') return false;
    return { rejectUnauthorized: false };
  })(),
});

const { rows } = await pool.query(`
  SELECT id, title, source_url, source_label, display_priority
  FROM news_feed
  ORDER BY display_priority DESC NULLS LAST, id ASC
`);
console.log(`[recompute] ${rows.length} rows to process`);
console.log(`[recompute] mode: ${APPLY ? 'APPLY' : 'DRY-RUN (--apply to commit)'}\n`);

// Group by new hash. First-seen wins (rows are pre-sorted by priority desc).
// Rest are duplicates → mark for deletion.
const seenHashes = new Set();
const survivors = [];
const dupesToDelete = [];
for (const r of rows) {
  const h = sha1(normalizeHeadline(r.title) || `${r.title}|${r.source_label || ''}|${r.source_url || ''}`);
  if (seenHashes.has(h)) {
    dupesToDelete.push({ id: r.id, title: r.title, hash: h });
  } else {
    seenHashes.add(h);
    survivors.push({ ...r, newHash: h });
  }
}

console.log(`[recompute] survivors: ${survivors.length}`);
console.log(`[recompute] duplicates to delete: ${dupesToDelete.length}`);
for (const d of dupesToDelete.slice(0, 25)) {
  console.log(`  #${d.id}  "${d.title.slice(0, 65)}"`);
}
if (dupesToDelete.length > 25) console.log(`  ... and ${dupesToDelete.length - 25} more`);

if (!APPLY) {
  console.log('\n[recompute] dry-run only — re-run with --apply to commit');
  await pool.end();
  process.exit(0);
}

// Pass 1: delete duplicates
if (dupesToDelete.length) {
  const ids = dupesToDelete.map(d => d.id);
  const r = await pool.query('DELETE FROM news_feed WHERE id = ANY($1::int[]) RETURNING id', [ids]);
  console.log(`\n[recompute] deleted ${r.rowCount} duplicate rows`);
}

// Pass 2: update surviving rows' title_hash. Each unique hash now maps to
// exactly one row, so no UNIQUE-constraint conflict.
let updated = 0;
for (const r of survivors) {
  await pool.query('UPDATE news_feed SET title_hash = $1 WHERE id = $2', [r.newHash, r.id]);
  updated++;
}
console.log(`[recompute] updated title_hash on ${updated} surviving rows`);

// Final verification — query for any remaining duplicates by new hash.
const { rows: check } = await pool.query(`
  SELECT title_hash, count(*)::int as n
  FROM news_feed
  GROUP BY title_hash
  HAVING count(*) > 1
`);
console.log(`\n[recompute] remaining duplicate-hash groups: ${check.length}`);
await pool.end();
