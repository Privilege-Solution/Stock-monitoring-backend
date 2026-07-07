'use strict';

// =============================================================================
// Recovery script — re-classify ALL rows of news_feed using title-pattern
// priority (the same rules migrate-v9.js encodes, but run unconditionally so
// earlier half-finished migrations don't leave rows stuck at MACRO).
//
// Run shape: node backend/migrate-v9-recovery.js
// Idempotent: re-running produces the same distribution.
//
// Rules (priority order — first match wins):
//   a) ASW name in title          → COMPANY
//   b) BoT rate-decision keywords → RATES  (กนง., ดอกเบี้ยนโยบาย, อัตราดอกเบี้ย)
//   c) Housing-policy keywords    → GOV_POLICY  (LTV, ค่าโอน, ค่าจดจำนอง, สมาคมบ้านจัดสรร, มาตรการอสังหาฯ)
//   d) Legacy sector_policy hint  → GOV_POLICY
//   e) Legacy interest_rate hint  → RATES
//   f) Legacy political hint      → POLITICS
//   g) Legacy sector_data / peer_news hint → INDUSTRY
//   h) catch-all                  → MACRO
// =============================================================================

require('dotenv').config();

const { Pool } = require('pg');

const PG_URL = process.env.DATABASE_URL;
if (!PG_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({
  connectionString: PG_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const RECLASSIFY_SQL = `
  UPDATE news_feed
     SET category = CASE
       WHEN title ~* 'ASW|Assetwise|แอสเซทไวส์|แอสเสทไวส์'                            THEN 'COMPANY'
       WHEN title ~* 'กนง\.|ดอกเบี้ยนโยบาย|อัตราดอกเบี้ย'                              THEN 'RATES'
       WHEN title ~* 'LTV|ค่าโอน|ค่าจดจำนอง|สมาคมบ้านจัดสรร|มาตรการอสังหาฯ'             THEN 'GOV_POLICY'
       WHEN category = 'sector_policy'                                                THEN 'GOV_POLICY'
       WHEN category = 'interest_rate'                                                THEN 'RATES'
       WHEN category = 'political'                                                    THEN 'POLITICS'
       WHEN category IN ('sector_data', 'peer_news')                                  THEN 'INDUSTRY'
       ELSE                                                                                'MACRO'
     END
`;

// Post-pass 1 — promote MACRO rows that are clearly GOV_POLICY (housing fee
// cuts, LTV rules, registration fee measures). The main CASE only matches
// a tight housing-policy regex; this catches variants like "ลดค่าธรรมเนียม
// โอน" or "ค่าธรรมเนียมจดทะเบียนสิทธิ" that land in MACRO by accident.
const PROMOTE_TO_GOV_POLICY = `
  UPDATE news_feed
     SET category = 'GOV_POLICY'
   WHERE category = 'MACRO'
     AND title ~* 'ลดค่าธรรมเนียม.*(โอน|จดจำนอง|จดทะเบียน|อสังหาฯ|ที่อยู่อาศัย)|ค่าธรรมเนียม.*(โอน|จดจำนอง|จดทะเบียน).*(อสังหาฯ|ที่อยู่อาศัย)|มาตรการ.*อสังหาฯ|มาตรการกระตุ้นอสังหาฯ'
`;

// Post-pass 2 — promote MACRO rows that are INDUSTRY (RE market trends,
// sector commentary, peer comparison without a specific policy measure).
// The main CASE only matches tightly; this broadens the net to anything
// RE-related that didn't trigger a GOV_POLICY/RATES/COMPANY rule.
const PROMOTE_TO_INDUSTRY = `
  UPDATE news_feed
     SET category = 'INDUSTRY'
   WHERE category = 'MACRO'
     AND title ~* 'อสังหา|ที่อยู่อาศัย|คอนโด|บ้านจัดสรร'
`;

async function main() {
  console.log('[recovery] pass 1: title-pattern priority CASE');
  const r1 = await pool.query(RECLASSIFY_SQL);
  console.log(`[recovery] pass 1 updated ${r1.rowCount} rows`);

  console.log('[recovery] pass 2: promote MACRO → GOV_POLICY (housing measures)');
  const r2 = await pool.query(PROMOTE_TO_GOV_POLICY);
  console.log(`[recovery] pass 2 updated ${r2.rowCount} rows`);

  console.log('[recovery] pass 3: promote MACRO → INDUSTRY (RE sector trends)');
  const r3 = await pool.query(PROMOTE_TO_INDUSTRY);
  console.log(`[recovery] pass 3 updated ${r3.rowCount} rows`);

  const dist = await pool.query(`
    SELECT category, COUNT(*) AS n
      FROM news_feed
     GROUP BY category
     ORDER BY n DESC
  `);
  console.log('[recovery] AFTER category distribution:');
  for (const row of dist.rows) console.log(`  ${row.category || '∅'}: ${row.n}`);

  const imp = await pool.query(`
    SELECT category, impact_level, COUNT(*) AS n
      FROM news_feed
     GROUP BY category, impact_level
     ORDER BY category, impact_level
  `);
  console.log('[recovery] category × impact_level:');
  for (const row of imp.rows) console.log(`  ${row.category.padEnd(12)}${(row.impact_level || '∅').padEnd(8)}${row.n}`);

  await pool.end();
}

main().catch(e => { console.error('[recovery] FAILED:', e); process.exit(1); });