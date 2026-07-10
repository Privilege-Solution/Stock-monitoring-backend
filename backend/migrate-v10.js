'use strict';

// =============================================================================
// Forward migration v10 — COMPETITOR category + consistent taxonomy.
//
// Background
// ----------
// Two issues this migration fixes in the existing news_feed rows:
//
//   1. rss-property.mjs historically wrote the legacy query hint
//      (sector_data / interest_rate / peer_news / economic_data / sector_policy)
//      straight into `category` — it never ran classifyCategory. Those rows
//      matched none of the 6 taxonomy chips and only showed under "ทั้งหมด".
//      rss-property now routes through the shared classifier (same one
//      rss-extended + Gemini use), so this pass re-derives every row's
//      category from its title pattern — converging the whole table to the
//      7-way vocabulary.
//
//   2. A new COMPETITOR bucket splits rival-developer news out of INDUSTRY
//      (LH / AP / SPALI / SIRI / NOBLE / ORI / ANAN / LPN / WHA / QH).
//
// The 7-way vocabulary (mirrors backend/lib/news-taxonomy.mjs):
//   COMPANY    — names ASW / Assetwise / แอสเซทไวส์ (wins over topic)
//   COMPETITOR — names a rival developer, not ASW
//   RATES      — กนง. / policy-rate headlines
//   GOV_POLICY — housing-specific government measures (LTV, ค่าโอน-จดจำนอง)
//   POLITICS   — general political news (not housing-specific)
//   INDUSTRY   — RE market trends / supply-demand (no specific company/policy)
//   MACRO      — broad economic indicators (GDP/CPI/FX/trade)
//
// Approach: one unconditional CASE pass (title-pattern priority, identical to
// the JS classifier order) so the whole table converges in a single UPDATE,
// idempotent on re-run. Competitor matching uses the Thai developer names
// (safe, low false-positive) — bare 2-letter English tickers are deliberately
// excluded to avoid colliding with e.g. LH Securities the broker. Also
// re-backfills impact_level from severity for any rows still NULL.
// =============================================================================

require('dotenv').config();

const { Pool } = require('pg');

const PG_URL = process.env.DATABASE_URL;

if (!PG_URL) {
  console.error('[migrate-v10] ERROR: DATABASE_URL not set');
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

// Competitor Thai-name alternation for the CASE. Kept in sync with
// COMPETITOR_TOKENS in backend/lib/news-taxonomy.mjs (Thai names only — the
// SQL backfill does not match bare English tickers, see header).
const COMPETITOR_RE = [
  'แลนด์แอนด์เฮ้าส์', 'แลนด์ แอนด์ เฮ้าส์',
  'เอพี', 'ศุภาลัย', 'สิริ เวนเชอร์', 'สิริวงศ์พร็อพเพอร์ตี้',
  'โนเบิล', 'ออริจิ้น', 'อนันดา',
  'แอล.พี.เอ็น', 'แอลพีเอ็น', 'ควอลิตี้เฮาส์', 'ดับบลิวเอชเอ',
].join('|');

async function main() {
  const cfg = parsePgUrl(PG_URL);
  console.log(`[migrate-v10] connecting as user="${cfg.user}" db="${cfg.database}" host="${cfg.host}:${cfg.port}"`);
  const pool = new Pool(cfg);

  try {
    // Ensure the v10 summary table exists too (harmless if ensureSchema already
    // made it on boot; lets this script run standalone against a fresh DB).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS news_daily_summary (
        date         TEXT PRIMARY KEY,
        digest       TEXT,
        tone         TEXT,
        reason       TEXT,
        bullets      JSONB,
        source_count INTEGER,
        generated_at TEXT NOT NULL
      )
    `);
    console.log('[migrate-v10] news_daily_summary table ensured');

    const before = await pool.query(`
      SELECT category, COUNT(*) AS n FROM news_feed GROUP BY category ORDER BY n DESC
    `);
    console.log('[migrate-v10] BEFORE category distribution:');
    for (const r of before.rows) console.log(`  ${r.category || '∅'}: ${r.n}`);

    // Single CASE pass — title-pattern priority identical to
    // classifyCategory() in news-taxonomy.mjs. Runs over every row so legacy
    // rss-property categories are corrected AND competitor rows are split out
    // of INDUSTRY in one shot.
    await pool.query({
      text: `
        UPDATE news_feed
           SET category = CASE
             WHEN title ~* 'ASW|Assetwise|แอสเซทไวส์|แอสเสทไวส์'                              THEN 'COMPANY'
             WHEN title ~* 'กนง\\.|ดอกเบี้ยนโยบาย|อัตราดอกเบี้ย'                                THEN 'RATES'
             WHEN title ~* 'LTV|ค่าโอน|ค่าจดจำนอง|สมาคมบ้านจัดสรร|มาตรการอสังหาฯ'                THEN 'GOV_POLICY'
             WHEN title ~* 'ลดค่าธรรมเนียม.*(โอน|จดจำนอง|จดทะเบียน|อสังหาฯ|ที่อยู่อาศัย)
                         |ค่าธรรมเนียม.*(โอน|จดจำนอง|จดทะเบียน).*(อสังหาฯ|ที่อยู่อาศัย)
                         |มาตรการกระตุ้นอสังหาฯ'                                            THEN 'GOV_POLICY'
             WHEN title ~* $1                                                                  THEN 'COMPETITOR'
             WHEN category = 'sector_policy'                                                  THEN 'GOV_POLICY'
             WHEN category = 'interest_rate'                                                 THEN 'RATES'
             WHEN category = 'political'                                                     THEN 'POLITICS'
             WHEN category IN ('sector_data', 'peer_news')                                   THEN 'INDUSTRY'
             WHEN title ~* 'อสังหา|ที่อยู่อาศัย|คอนโด|บ้านจัดสรร'                                THEN 'INDUSTRY'
             ELSE                                                                                  'MACRO'
           END
      `,
      values: [COMPETITOR_RE],
    });
    console.log('[migrate-v10] CASE re-classification done');

    // Re-backfill impact_level for any rows still NULL (rss-property rows
    // written before the impact_level fix, etc.).
    await pool.query(`
      UPDATE news_feed
         SET impact_level = CASE
           WHEN severity = 'high' THEN 'HIGH'
           WHEN severity = 'low'  THEN 'LOW'
           ELSE                        'MEDIUM'
         END
       WHERE impact_level IS NULL
    `);
    console.log('[migrate-v10] impact_level NULLs backfilled');

    const after = await pool.query(`
      SELECT category, COUNT(*) AS n FROM news_feed GROUP BY category ORDER BY n DESC
    `);
    console.log('[migrate-v10] AFTER category distribution:');
    for (const r of after.rows) console.log(`  ${r.category || '∅'}: ${r.n}`);

    const nulls = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE category IS NULL)       AS null_cat,
             COUNT(*) FILTER (WHERE impact_level IS NULL)   AS null_imp
        FROM news_feed
    `);
    console.log('[migrate-v10] nulls after migration:', nulls.rows[0]);

    console.log('[migrate-v10] done');
  } catch (e) {
    console.error('[migrate-v10] FAILED:', e.message || e);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
