// =============================================================================
// Thai property news fetcher via Google News RSS.
//
// Gemini grounded search is unreliable for current news (the model often
// returns hallucinated or out-of-date articles, especially on quiet days).
// Google News RSS gives us real, recent, deduplicated coverage from the
// major Thai outlets — no API key, no JS rendering, no anti-bot.
//
// What this does:
//   1. Fire 6 queries in parallel: อสังหาฯ / ครม. / กนง. / เศรษฐกิจไทย /
//      developer tickers (AP, LH, SPALI) / ที่ดิน
//   2. Parse each RSS <item> into { title, link, pubDate, sourceName,
//      sourceUrl }
//   3. Filter to last N days (default 7) so the feed never goes stale
//   4. Dedupe by guid (Google News' stable id) — re-running is idempotent
//   5. Insert into news_feed via db.writeNewsItems()
//
// Note: <link> is a Google News redirect (`https://news.google.com/rss/...`)
// not the publisher's canonical URL. The redirect opens the real article in
// the user's browser (Google's reader page is JS-rendered, but the redirect
// is server-side). Acceptable as "valid link" — clicking works.
//
// Run shape:
//   source: 'rss-property'  → inserts 0-100 rows to news_feed
// =============================================================================

import db from '../../db.js';
import { classifyCategory, impactLevelFromSeverity } from '../news-taxonomy.mjs';

const QUERIES = [
  { q: 'อสังหาริมทรัพย์+ไทย',  category: 'sector_data',  pipeline: 'sector' },
  { q: 'ครม.+อสังหาริมทรัพย์', category: 'sector_policy', pipeline: 'sector' },
  { q: 'ครม.+ที่อยู่อาศัย',     category: 'sector_policy', pipeline: 'sector' },
  { q: 'ธนาคารแห่งประเทศไทย+ดอกเบี้ย', category: 'interest_rate', pipeline: 'macro' },
  { q: 'กนง.+ดอกเบี้ย',         category: 'interest_rate', pipeline: 'macro' },
  { q: 'เศรษฐกิจไทย+GDP+เงินเฟ้อ', category: 'economic_data', pipeline: 'macro' },
  { q: 'แอสเซทไวส์+ASW',       category: 'peer_news', pipeline: 'sector' },
  { q: 'บ้าน+คอนโด+กรุงเทพ',    category: 'sector_data',  pipeline: 'sector' },
];

const { createHash } = await import('node:crypto');
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// =============================================================================
// Relevance scoring — we track ASW (Assetwise), the Thai real estate sector,
// and macro factors that move it (BoT rate, GDP, inflation). We explicitly
// DROP news about unrelated sectors (banks, consumer finance, energy, telco,
// food, retail) so the unified feed never gets flooded with bank/CPALL noise.
//
// Matching is case-insensitive substring against the cleaned headline. Each
// DROP keyword kills the item outright (relevance = 0 → not inserted). Each
// HIGH keyword adds points. scoreItem() returns 0 if a DROP keyword matches.
// =============================================================================

// Hard-drop: banks, consumer finance, energy, telco, food, retail, gold/crypto.
const DROP_KEYWORDS = [
  // Thai banks (full names + abbreviations + 4-letter SET tickers)
  'BAY', 'KBank', 'KBANK', 'SCB', 'KTB', 'TTB', 'TISCO', 'KKP',
  'กสิกรไทย', 'กรุงศรี', 'กรุงไทย', 'ไทยพาณิชย์', 'ทหารไทยธนชาต',
  // Consumer finance / credit cards / personal loans
  'KTC', 'AEONTS', 'Krungsri', 'cardX', 'บัตรเครดิต', 'สินเชื่อส่วนบุคคล', 'สินเชื่อรายย่อย',
  // Energy + petrochem
  'PTT', 'PTTEP', 'TOP', 'BANPU', 'BCP', 'IRPC', 'ESSO', 'SPRC', 'GPSC', 'OR',
  'น้ำมัน', 'ปิโตรเคมี', 'โรงกลั่น', 'ก๊าซธรรมชาติ', 'LNG',
  // Telecom
  'AIS', 'DTAC', 'TRUE', 'INTUCH', 'JAS', 'NT', 'โทรคมนาคม',
  // Food + agribusiness
  'CPF', 'CPALL', 'OISHI', 'TU', 'MINT', 'STA', 'อาหารแช่แข็ง', 'อาหารสัตว์',
  // Retail + commerce
  'HMPRO', 'MAKRO', 'CRC', 'RS', 'COM7', 'BJC', 'GLOBAL', 'ค้าปลีก', 'ห้างสรรพสินค้า',
  // Health / hospital
  'BDMS', 'BH', 'CHG', 'โรงพยาบาล',
  // Materials / industrial
  'SCC', 'TOA', 'น้ำตาล', 'เหล็ก', 'ปูนซิเมนต์',
  // Other unrelated
  'ทองคำ', 'Bitcoin', 'Crypto', 'คริปโต', 'กองทุนรวม', 'ประกันภัย',
];

// High-relevance keywords — adds to the score. "ASW" matches all three
// ASW-related forms and is the only ticker-name with 50+ bonus points.
const HIGH_KEYWORDS = [
  // ASW direct (50+ bonus in scoring function)
  { kw: 'ASW',            boost: 50, type: 'asw' },
  { kw: 'Assetwise',      boost: 50, type: 'asw' },
  { kw: 'แอสเซทไวส์',     boost: 50, type: 'asw' },
  // Thai real estate / housing market (each 25)
  { kw: 'อสังหาริมทรัพย์', boost: 25, type: 'sector' },
  { kw: 'อสังหาฯ',         boost: 25, type: 'sector' },
  { kw: 'ที่อยู่อาศัย',    boost: 25, type: 'sector' },
  { kw: 'บ้านจัดสรร',     boost: 20, type: 'sector' },
  { kw: 'คอนโดมิเนียม',   boost: 25, type: 'sector' },
  { kw: 'คอนโด',          boost: 15, type: 'sector' },
  { kw: 'ทาวน์เฮาส์',     boost: 20, type: 'sector' },
  { kw: 'หมู่บ้าน',        boost: 10, type: 'sector' },
  { kw: 'ที่ดิน',          boost: 15, type: 'sector' },
  { kw: 'ดีเวลลอปเปอร์',   boost: 20, type: 'sector' },
  { kw: 'โครงการบ้าน',    boost: 15, type: 'sector' },
  { kw: 'ราคาบ้าน',        boost: 15, type: 'sector' },
  // Peer developers (each 20)
  { kw: 'แลนด์แอนด์เฮ้าส์', boost: 20, type: 'peer' },
  { kw: 'เอพี',             boost: 20, type: 'peer' },
  { kw: 'ศุภาลัย',         boost: 20, type: 'peer' },
  { kw: 'สิริ เวนเชอร์',   boost: 20, type: 'peer' },
  { kw: 'โนเบิล',         boost: 20, type: 'peer' },
  { kw: 'ออริจิ้น',       boost: 20, type: 'peer' },
  { kw: 'อนันดา',         boost: 20, type: 'peer' },
  { kw: 'แอล.พี.เอ็น',    boost: 20, type: 'peer' },
  { kw: 'ควอลิตี้เฮาส์',  boost: 20, type: 'peer' },
  { kw: 'ดับบลิวเอชเอ',   boost: 20, type: 'peer' },
  // BoT / interest rate / LTV (each 20)
  { kw: 'กนง.',           boost: 20, type: 'macro' },
  { kw: 'คณะกรรมการนโยบายการเงิน', boost: 25, type: 'macro' },
  { kw: 'ดอกเบี้ยนโยบาย', boost: 20, type: 'macro' },
  { kw: 'สินเชื่อบ้าน',   boost: 20, type: 'macro' },
  { kw: 'LTV',            boost: 25, type: 'macro' },
  { kw: 'อัตราดอกเบี้ย',  boost: 15, type: 'macro' },
  // Macro context (each 10)
  { kw: 'ครม.',           boost: 15, type: 'policy' },
  { kw: 'คณะรัฐมนตรี',    boost: 15, type: 'policy' },
  { kw: 'เงินเฟ้อ',       boost: 10, type: 'macro' },
  { kw: 'GDP',            boost: 10, type: 'macro' },
  { kw: 'ภาวะเศรษฐกิจ',   boost: 10, type: 'macro' },
  { kw: 'ภาวะเศรษฐกิจ',   boost: 10, type: 'macro' },
  // REIC / sector data
  { kw: 'REIC',           boost: 25, type: 'sector' },
  { kw: 'ดัชนีความเชื่อมั่น', boost: 10, type: 'sector' },
];

// Score a headline. Returns 0 → drop, > 0 → keep, with higher = more relevant.
// `display_priority` = 50 + min(score, 75) → range [50, 125]. So an ASW
// headline can reach 100+ (high priority in the unified feed), while a
// generic sector headline sits at 60-70.
function scoreItem(title) {
  const t = title.toLowerCase();
  // Hard drop first — any DROP keyword kills it.
  for (const kw of DROP_KEYWORDS) {
    if (t.includes(kw.toLowerCase())) return 0;
  }
  // Sum up HIGH keyword boosts.
  let score = 0;
  for (const { kw, boost } of HIGH_KEYWORDS) {
    if (t.includes(kw.toLowerCase())) score += boost;
  }
  return score;
}

// Strip HTML tags + decode common entities. Google News <title> wraps the
// headline + " - SourceName" with a hyphen separator; we keep just the
// headline.
function cleanTitle(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

// Parse one <item>...</item> block into a news_feed row. Returns null if
// the block is malformed or the date is unparseable.
function parseItem(itemXml, query) {
  const titleRaw = (itemXml.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  const title = cleanTitle(titleRaw);
  // Google News appends " - SourceName" to the title — strip it so the
  // headline is just the headline.
  const headline = title.replace(/\s*-\s*[^-]+$/, '').trim();
  if (!headline) return null;

  const link = (itemXml.match(/<link\/?>([^<]+)/) || itemXml.match(/<link>([^<]+)<\/link>/) || [])[1] || '';
  const pubDate = (itemXml.match(/<pubDate>([^<]+)/) || [])[1] || '';
  const sourceUrl = (itemXml.match(/<source[^>]*url="([^"]+)"/) || [])[1] || '';
  const sourceName = cleanTitle((itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '');
  const guid = (itemXml.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || link;

  const date = pubDate ? new Date(pubDate) : null;
  if (!date || isNaN(date.getTime())) return null;

  // Use guid as the title_hash seed — Google News guids are stable per story
  // and survive re-runs, so the same story re-fetched won't insert twice.
  // Falls back to the link or title if guid is missing.
  const hashSeed = guid || link || headline;
  const titleHash = sha1(hashSeed);

  // Relevance scoring — DROP keywords (banks, energy, etc.) get 0 and are
  // filtered later. ASW direct = 50+, real estate = 25+, BoT rate = 20+,
  // macro = 10+. display_priority = 50 + score, capped at 125 so ASW news
  // sits at top of the unified feed (above generic sector noise).
  const score = scoreItem(headline);
  if (score === 0) return null;        // hard drop — no row at all
  const displayPriority = Math.min(50 + score, 125);

  return {
    title: headline,
    date: date.toISOString().slice(0, 10),
    // Classify through the shared taxonomy so rss-property rows emit the same
    // 7 keys (COMPANY/COMPETITOR/RATES/GOV_POLICY/POLITICS/INDUSTRY/MACRO) the
    // frontend filters on — previously this wrote the legacy query hint
    // (sector_data / interest_rate / peer_news …) which matched no chip.
    category: classifyCategory(headline, query.category),
    source_url: link,                 // Google News redirect (valid link)
    source_label: sourceName || 'Google News',
    title_hash: titleHash,
    pipeline: query.pipeline,
    impact: 'neutral',                // RSS alone can't infer impact
    severity: 'medium',               // default; cron can re-classify later
    show_pin: false,
    summary: null,
    display_priority: displayPriority,
    impact_level: impactLevelFromSeverity('medium'),
  };
}

async function fetchQuery(query, maxAgeDays) {
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query.q) +
    '&hl=th&gl=TH&ceid=TH:th';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) {
      console.log(`[rss-property] ${query.q} → HTTP ${r.status}`);
      return [];
    }
    const t = await r.text();
    const items = t.match(/<item>[\s\S]*?<\/item>/g) || [];
    const cutoff = Date.now() - maxAgeDays * 86400_000;
    return items
      .map(x => parseItem(x, query))
      .filter(Boolean)
      .filter(it => new Date(it.date + 'T00:00:00Z').getTime() >= cutoff);
  } catch (e) {
    console.log(`[rss-property] ${query.q} → ERR ${e.message}`);
    return [];
  }
}

async function run({ sinceDate, maxAgeDays = 7 } = {}) {
  console.log(`[rss-property] fetching ${QUERIES.length} queries (maxAge=${maxAgeDays}d)`);
  const all = (await Promise.all(QUERIES.map(q => fetchQuery(q, maxAgeDays)))).flat();

  // Dedupe by title_hash (guid-based) across all queries — Google News can
  // surface the same article in multiple query results.
  const seen = new Set();
  const unique = all.filter(it => {
    if (seen.has(it.title_hash)) return false;
    seen.add(it.title_hash);
    return true;
  });

  // Require a non-empty source_url — same valid-link rule as the unified feed
  // filter. Drops the rare <item> with a missing <link>.
  const valid = unique.filter(it => it.source_url && it.source_url.length > 0);
  const dropped = unique.length - valid.length;
  console.log(`[rss-property] parsed=${all.length} unique=${unique.length} with_url=${valid.length} dropped_no_url=${dropped}`);

  if (!valid.length) return { ok: true, fetched: 0, inserted: 0 };

  const { inserted } = await db.writeNewsItems(valid);
  console.log(`[rss-property] inserted=${inserted}`);
  return { ok: true, fetched: valid.length, inserted };
}

export { run };
export default { run };
