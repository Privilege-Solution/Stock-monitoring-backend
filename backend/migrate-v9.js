'use strict';

// =============================================================================
// Forward migration v9 — News taxonomy v2 (6 user-facing categories +
// impact_level).
//
// Background
// ----------
// The news pipeline was migrated to a new ASW-centric taxonomy on 2026-07-06:
//
//   1. COMPANY     — anything that names ASW / AssetWise / แอสเซทไวส์
//                    (earnings, presales, transfers, dividends, bond, insider,
//                    management statements, SET alerts). Wins over every other
//                    tag per the disambiguation rules in the spec.
//   2. RATES       — Bank of Thailand (กนง.) policy-rate decisions/meetings,
//                    rate forecasts from banks/economists. Headline's main
//                    subject must be the rate decision itself.
//   3. GOV_POLICY  — government/regulatory measures SPECIFIC to real estate:
//                    LTV rules, transfer/mortgage fee cuts, foreign ownership
//                    rules, housing stimulus. NOT general rate/political news.
//   4. POLITICS    — general political events that could indirectly affect
//                    the economy or policy environment. NOT housing-specific.
//   5. INDUSTRY    — real-estate market trends, competitor project launches,
//                    industry association statements, supply/demand data.
//                    NOT specific to ASW and NOT a government policy.
//   6. MACRO       — broad economic indicators unrelated to housing: GDP,
//                    inflation, FX, employment, trade.
//
// Plus a second axis on each row:
//   impact_level  HIGH | MEDIUM | LOW   (how much the item moves ASW)
//
// Changes
// -------
//   * Add `impact_level TEXT` to `news_feed` (nullable; new rows fill it).
//   * Re-classify the existing `category` column from the legacy 13-value
//     vocabulary (company_filing / broker / sector_policy / ... / global / ...)
//     to the new 6-value vocabulary above. Done in place via 3 SQL passes:
//       (1) CASE expression with title-pattern priority (ASW-name first)
//       (2) promote MACRO rows that are actually GOV_POLICY (housing measures
//           that didn't match the CASE's tight regex)
//       (3) promote MACRO rows that are actually INDUSTRY (RE market trends
//           that didn't match anything else)
//   * Backfill `impact_level` from existing `severity` (high→HIGH, low→LOW,
//     otherwise MEDIUM). Keeps the old severity column untouched.
//
// Idempotent: ADD COLUMN IF NOT EXISTS; the 3 passes are unconditional so a
// re-run converges to the same distribution. The CASE covers already-
// classified rows because it uses title patterns (not legacy category values)
// for the first 3 rules.
// =============================================================================

require('dotenv').config();

const { Pool } = require('pg');

const PG_URL = process.env.DATABASE_URL;

if (!PG_URL) {
  console.error('[migrate-v9] ERROR: DATABASE_URL not set');
  process.exit(1);
}

function parsePgUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    ssl: { rejectUnauthorized: false },
    max: 2,
  };
}

async function main() {
  const cfg = parsePgUrl(PG_URL);
  console.log(`[migrate-v9] connecting as user="${cfg.user}" db="${cfg.database}" host="${cfg.host}:${cfg.port}"`);
  const pool = new Pool(cfg);

  try {
    // 1. Add the new impact_level column.
    await pool.query(`
      ALTER TABLE news_feed
        ADD COLUMN IF NOT EXISTS impact_level TEXT
    `);
    console.log('[migrate-v9] news_feed.impact_level column ensured');

    // 2. Pre-update snapshot — for the log line at the end. Cheap on 100 rows.
    const before = await pool.query(`
      SELECT category, COUNT(*) AS n
        FROM news_feed
       GROUP BY category
       ORDER BY n DESC
    `);
    console.log('[migrate-v9] BEFORE category distribution:');
    for (const r of before.rows) console.log(`  ${r.category || '∅'}: ${r.n}`);

    // 3. Pass 1 — CASE priority. The first 3 rules use title patterns so they
    //    work even if a row was already classified by a previous run.
    //      a) ASW-name in title → COMPANY (overrides every other rule)
    //      b) BoT rate-decision keywords → RATES
    //      c) Housing-policy keywords → GOV_POLICY
    //      d) Legacy category hints as fallback:
    //         sector_policy → GOV_POLICY, interest_rate → RATES,
    //         political → POLITICS, sector_data / peer_news → INDUSTRY
    //      e) catch-all → MACRO  (FX/baht/employment + every legacy value
    //         not covered above: broker non-ASW, debt_rating, investor_alert,
    //         insider_trade, corporate, dividend, fundraise, project,
    //         insider, company, company_filing, economic_data, global,
    //         disaster)
    //
    //    The Thai name แอสเซทไวส์ has a couple of common spellings in the
    //    press (แอสเสทไวส์ with extra ส) — match both.
    await pool.query(`
      UPDATE news_feed
         SET category = CASE
           WHEN title ~* 'ASW|Assetwise|แอสเซทไวส์|แอสเสทไวส์'                              THEN 'COMPANY'
           WHEN title ~* 'กนง\.|ดอกเบี้ยนโยบาย|อัตราดอกเบี้ย'                                THEN 'RATES'
           WHEN title ~* 'LTV|ค่าโอน|ค่าจดจำนอง|สมาคมบ้านจัดสรร|มาตรการอสังหาฯ'                THEN 'GOV_POLICY'
           WHEN category = 'sector_policy'                                                  THEN 'GOV_POLICY'
           WHEN category = 'interest_rate'                                                 THEN 'RATES'
           WHEN category = 'political'                                                     THEN 'POLITICS'
           WHEN category IN ('sector_data', 'peer_news')                                   THEN 'INDUSTRY'
           ELSE                                                                                  'MACRO'
         END
    `);
    console.log('[migrate-v9] pass 1 (CASE priority) done');

    // 3b. Pass 2 — promote MACRO rows that are clearly GOV_POLICY. The CASE
    //     above matches a tight set of housing-policy keywords; this pass
    //     widens the net to "ลดค่าธรรมเนียมโอน-จดจำนอง", "ค่าธรรมเนียมจดทะเบียน
    //     สิทธิ", "มาตรการกระตุ้นอสังหาฯ" and similar variants that landed in
    //     MACRO by accident.
    await pool.query(`
      UPDATE news_feed
         SET category = 'GOV_POLICY'
       WHERE category = 'MACRO'
         AND title ~* 'ลดค่าธรรมเนียม.*(โอน|จดจำนอง|จดทะเบียน|อสังหาฯ|ที่อยู่อาศัย)
                     |ค่าธรรมเนียม.*(โอน|จดจำนอง|จดทะเบียน).*(อสังหาฯ|ที่อยู่อาศัย)
                     |มาตรการ.*อสังหาฯ
                     |มาตรการกระตุ้นอสังหาฯ'
    `);
    console.log('[migrate-v9] pass 2 (GOV_POLICY promotion) done');

    // 3c. Pass 3 — promote MACRO rows that are INDUSTRY (RE market trends,
    //     sector commentary, peer comparison without a specific policy
    //     measure). Anything mentioning อสังหาฯ / ที่อยู่อาศัย / คอนโด /
    //     บ้านจัดสรร that wasn't already GOV_POLICY above falls here.
    await pool.query(`
      UPDATE news_feed
         SET category = 'INDUSTRY'
       WHERE category = 'MACRO'
         AND title ~* 'อสังหา|ที่อยู่อาศัย|คอนโด|บ้านจัดสรร'
    `);
    console.log('[migrate-v9] pass 3 (INDUSTRY promotion) done');

    // 4. Backfill impact_level from existing severity. severity=high means
    //    the item materially affects ASW (HIGH impact), severity=low is
    //    background only (LOW impact), everything else is the regular
    //    sector/macro backdrop (MEDIUM impact).
    //
    //    Old rows without severity land at MEDIUM by default — that's the
    //    user-spec midpoint.
    await pool.query(`
      UPDATE news_feed
         SET impact_level = CASE
           WHEN severity = 'high'   THEN 'HIGH'
           WHEN severity = 'low'    THEN 'LOW'
           ELSE                          'MEDIUM'
         END
       WHERE impact_level IS NULL
    `);
    console.log('[migrate-v9] impact_level backfilled');

    // 5. Post-update snapshot + sanity checks.
    const after = await pool.query(`
      SELECT category, COUNT(*) AS n
        FROM news_feed
       GROUP BY category
       ORDER BY n DESC
    `);
    console.log('[migrate-v9] AFTER category distribution:');
    for (const r of after.rows) console.log(`  ${r.category || '∅'}: ${r.n}`);

    const imp = await pool.query(`
      SELECT impact_level, COUNT(*) AS n
        FROM news_feed
       GROUP BY impact_level
       ORDER BY n DESC
    `);
    console.log('[migrate-v9] impact_level distribution:');
    for (const r of imp.rows) console.log(`  ${r.impact_level || '∅'}: ${r.n}`);

    const cross = await pool.query(`
      SELECT category, impact_level, COUNT(*) AS n
        FROM news_feed
       GROUP BY category, impact_level
       ORDER BY category, impact_level
    `);
    console.log('[migrate-v9] category × impact_level:');
    for (const r of cross.rows) {
      console.log(`  ${(r.category || '∅').padEnd(12)}${(r.impact_level || '∅').padEnd(8)}${r.n}`);
    }

    // Sanity: any NULL category or impact_level left?
    const nulls = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE category IS NULL)       AS null_cat,
             COUNT(*) FILTER (WHERE impact_level IS NULL)   AS null_imp
        FROM news_feed
    `);
    console.log('[migrate-v9] nulls after migration:', nulls.rows[0]);

    // 6. Confirm the new column shape in information_schema.
    const cols = await pool.query(`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_name = 'news_feed'
         AND column_name IN ('category', 'impact_level')
       ORDER BY column_name
    `);
    console.log('[migrate-v9] relevant columns:', cols.rows);

    console.log('[migrate-v9] done');
  } catch (e) {
    console.error('[migrate-v9] FAILED:', e.message || e);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();