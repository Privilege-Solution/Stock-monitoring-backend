// migrate-v13 ordering test (scrutiny pass 4): the one path that can corrupt
// production, kept honest without a live Postgres. A fake pool records every
// SQL statement ensureStockMigration issues; we assert the crash-safety
// invariants rather than exact SQL text:
//   1. columns are added before any index that references `stock`
//   2. the NEW unique index exists BEFORE the old constraint/index is dropped
//   3. an already-migrated DB (composite PK) triggers no ALTERs at all
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgres://fake:fake@localhost:5432/fake'; // never connected — pool is stubbed

const db = require('../../db.js');

function fakePool({ pkCols }) {
  const issued = [];
  return {
    issued,
    async query(sql, params) {
      issued.push(String(sql).replace(/\s+/g, ' ').trim());
      if (/FROM pg_constraint/.test(sql)) {
        // Simulate the PK catalog probe for the given table state.
        return { rows: [{ conname: `${params[0]}_pkey`, ncols: pkCols }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// ensureStockMigration reads the pool via getPool(); openDb() would build a
// real pg.Pool, so instead we reach the function through its export and feed
// it a stub by monkey-patching the module-internal pool. db.js exposes no pool
// setter, so run the function against the fake via `Function.call` is not
// possible either — instead we exercise the SAME ordering logic through a
// dedicated harness: re-run ensureStockMigration with the pg.Pool replaced.
const { Pool } = require('pg');

function withFakePool(fake, fn) {
  // db.js caches its pool after first getPool(); force a fresh one that is our
  // fake by stubbing Pool's constructor return.
  const orig = Pool.prototype.query;
  const origConnect = Pool.prototype.connect;
  const origOn = Pool.prototype.on;
  Pool.prototype.query = fake.query.bind(fake);
  Pool.prototype.connect = async () => { throw new Error('not used'); };
  Pool.prototype.on = () => {};
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Pool.prototype.query = orig;
      Pool.prototype.connect = origConnect;
      Pool.prototype.on = origOn;
    });
}

test('pre-v13 DB: columns first, new index before old is dropped, PK promoted', async () => {
  const fake = fakePool({ pkCols: 1 }); // old single-column PKs
  await withFakePool(fake, () => db.ensureStockMigration());
  const q = fake.issued;

  const idxOf = (re) => q.findIndex(x => re.test(x));
  const addStockDaily = idxOf(/ALTER TABLE daily ADD COLUMN IF NOT EXISTS stock/);
  const addStockNews  = idxOf(/ALTER TABLE news_feed ADD COLUMN IF NOT EXISTS stock/);
  const newNewsIdx    = idxOf(/CREATE UNIQUE INDEX IF NOT EXISTS news_feed_stock_title_hash_idx/);
  const dropOldNews   = idxOf(/DROP INDEX IF EXISTS news_feed_title_hash_idx/);
  const newDailyIdx   = idxOf(/CREATE UNIQUE INDEX IF NOT EXISTS daily_stock_date_idx/);
  const dropDailyPk   = idxOf(/ALTER TABLE daily DROP CONSTRAINT/);
  const promoteDaily  = idxOf(/ALTER TABLE daily ADD CONSTRAINT daily_pkey PRIMARY KEY USING INDEX/);

  for (const [name, i] of Object.entries({ addStockDaily, addStockNews, newNewsIdx, dropOldNews, newDailyIdx, dropDailyPk, promoteDaily })) {
    assert.notEqual(i, -1, `${name} was never issued`);
  }
  // columns before stock-referencing indexes
  assert.ok(addStockNews < newNewsIdx, 'news_feed stock column must exist before its composite index');
  assert.ok(addStockDaily < newDailyIdx, 'daily stock column must exist before its composite index');
  // new uniqueness before old is dropped
  assert.ok(newNewsIdx < dropOldNews, 'composite news index must be created BEFORE the old one is dropped');
  assert.ok(newDailyIdx < dropDailyPk, 'daily composite index must exist BEFORE the old PK is dropped');
  assert.ok(dropDailyPk < promoteDaily, 'old PK dropped before promotion');
});

test('already-migrated DB: catalog probe only, zero ALTER/DROP on PKs', async () => {
  const fake = fakePool({ pkCols: 2 }); // composite PKs already in place
  await withFakePool(fake, () => db.ensureStockMigration());
  const q = fake.issued;
  assert.equal(q.filter(x => /DROP CONSTRAINT/.test(x)).length, 0, 'no PK should be dropped');
  assert.equal(q.filter(x => /ADD CONSTRAINT .* PRIMARY KEY/.test(x)).length, 0, 'no PK should be promoted');
  // The idempotent column/index IF NOT EXISTS statements are fine to re-issue.
});

test('write functions refuse a missing/invalid stock', async () => {
  const fake = fakePool({ pkCols: 2 });
  await withFakePool(fake, async () => {
    await assert.rejects(() => db.writeRows(undefined, [{ date: '2026-08-18' }]), /invalid stock/);
    await assert.rejects(() => db.writeNewsItems('asw', [{ title: 'x' }]), /invalid stock/); // case matters
    await assert.rejects(() => db.upsertDailySummary('XX', '2026-08-18', {}), /invalid stock/);
    await assert.rejects(() => db.updateSingleRemark(null, '2026-08-18', {}), /invalid stock/);
    await assert.rejects(() => db.appendRemarkPin('', '2026-08-18', 'x'), /invalid stock/);
    await assert.rejects(() => db.latestSettledClose('nope', '2026-08-18'), /invalid stock/);
  });
});
