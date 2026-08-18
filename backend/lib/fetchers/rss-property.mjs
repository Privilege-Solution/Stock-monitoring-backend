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
import { impactLevelFromSeverity } from '../news-taxonomy.mjs';
import { bingNewsRssUrl, extractPublisherUrl, extractSourceName, normalizeHeadline, isHomepageUrl, deepenHomepageUrl, mapLimit, expandRowsByStock } from './news-rss-helpers.mjs';
import { vetRowUrls } from '../news-url-guard.mjs';

const TAG = 'rss-property';
// URLs already claimed by a headline in this process. Module scope: the cron
// runs each batch in a fresh process, so this never goes stale.
const RUN_SEEN_URLS = new Map();

// Max simultaneous Bing requests. Bing throttles an unbounded fan-out (25
// queries at once, then every deepen search at once) and a throttled response
// is silent — see mapLimit() in news-rss-helpers.mjs.
const BING_CONCURRENCY = 4;

const QUERIES = [
  // ── ASW direct ──────────────────────────────────────────────────────────
  { q: 'แอสเซทไวส์+ASW',       category: 'peer_news', pipeline: 'sector' },
  { q: 'Assetwise ข่าว',       category: 'peer_news', pipeline: 'sector' },

  // ── Per-competitor tickers ──────────────────────────────────────────────
  // One query per major peer so each competitor surfaces its own news
  // stream (instead of relying on the broad "อสังหาริมทรัพย์ ไทย" query
  // which mostly returns ASW + generic sector pieces).
  { q: 'AP Thailand แอ็น ไทยแลนด์', category: 'peer_news', pipeline: 'sector' },
  { q: 'LH แลนด์แอนด์เฮ้าส์',     category: 'peer_news', pipeline: 'sector' },
  { q: 'SPALI ศุภาลัย ข่าว',       category: 'peer_news', pipeline: 'sector' },
  { q: 'SIRI แสนสิริ ข่าว',        category: 'peer_news', pipeline: 'sector' },
  { q: 'NOBLE โนเบล ไทย',         category: 'peer_news', pipeline: 'sector' },
  { q: 'ORI ออริจิ้น โพรเพอร์ตี้',   category: 'peer_news', pipeline: 'sector' },
  { q: 'QH ควอลิตี้เฮ้าส์ ข่าว',    category: 'peer_news', pipeline: 'sector' },
  { q: 'PRUK พฤกษา ข่าว',          category: 'peer_news', pipeline: 'sector' },
  { q: 'PROUD พรู๊ด รีล เอสเตท',  category: 'peer_news', pipeline: 'sector' },
  { q: 'ANAN อนันดา ดีเวลลอปเมนต์', category: 'peer_news', pipeline: 'sector' },

  // ── Sector-wide + macro ────────────────────────────────────────────────
  { q: 'อสังหาริมทรัพย์+ไทย',  category: 'sector_data',  pipeline: 'sector' },
  { q: 'ครม.+อสังหาริมทรัพย์', category: 'sector_policy', pipeline: 'sector' },
  { q: 'ครม.+ที่อยู่อาศัย',     category: 'sector_policy', pipeline: 'sector' },
  { q: 'ธนาคารแห่งประเทศไทย+ดอกเบี้ย', category: 'interest_rate', pipeline: 'macro' },
  { q: 'กนง.+ดอกเบี้ย',         category: 'interest_rate', pipeline: 'macro' },
  { q: 'เศรษฐกิจไทย+GDP+เงินเฟ้อ', category: 'economic_data', pipeline: 'macro' },
  { q: 'บ้าน+คอนโด+กรุงเทพ',    category: 'sector_data',  pipeline: 'sector' },

  // ── Sector metrics / industry data ─────────────────────────────────────
  { q: 'REIC ดัชนี อสังหา',     category: 'sector_data',  pipeline: 'sector' },
  { q: 'presale โอน คอนโด ไทย',  category: 'sector_data',  pipeline: 'sector' },
  { q: 'ค่าโอน จดจำนอง 0.01%',   category: 'sector_policy', pipeline: 'sector' },
  { q: 'LTV สินเชื่อบ้าน 2569',  category: 'sector_policy', pipeline: 'sector' },
  { q: 'ต่างชาติ ซื้อ คอนโด ไทย', category: 'sector_data',  pipeline: 'sector', stocks: ['ASW', 'TITLE'] },
  { q: 'ดอกเบี้ย ธปท. 2569',     category: 'interest_rate', pipeline: 'macro' },
  { q: 'ค่าเงินบาท USD',         category: 'macro_fx',     pipeline: 'macro', stocks: ['ASW', 'TITLE'] },

  // ── TITLE (ร่มโพธิ์ — Phuket, foreign-buyer demand) — migrate-v13 ────────
  // baseScore: these targeted queries are their own relevance filter; without
  // it a tourism headline with no property keyword dies in scoreItem()'s
  // hard-drop. All land at severity 'medium' (rss-property default), so none
  // of them can pin the TITLE chart — pins come from the Gemini pipelines.
  // Deliberately NO broad war/oil queries here: unfiltered daily war volume
  // would flood the feed; GEOPOLITICS/OIL enter via gemini-title-drivers.
  { q: 'TITLE ร่มโพธิ์',            category: 'peer_news',      pipeline: 'title-company', stocks: ['TITLE'], baseScore: 30 },
  { q: 'ร่มโพธิ์ พร็อพเพอร์ตี้',      category: 'peer_news',      pipeline: 'title-company', stocks: ['TITLE'], baseScore: 30 },
  { q: 'เดอะ ไทเทิล ภูเก็ต',         category: 'peer_news',      pipeline: 'title-company', stocks: ['TITLE'], baseScore: 30 },
  { q: 'อสังหาริมทรัพย์ ภูเก็ต',      category: 'phuket_sector',  pipeline: 'title-sector',  stocks: ['TITLE'], baseScore: 15 },
  { q: 'คอนโด ภูเก็ต ต่างชาติ',       category: 'foreign_demand', pipeline: 'title-sector',  stocks: ['TITLE'], baseScore: 20 },
  { q: 'วิลล่า ภูเก็ต',              category: 'phuket_sector',  pipeline: 'title-sector',  stocks: ['TITLE'], baseScore: 15 },
  { q: 'นักท่องเที่ยว ภูเก็ต',        category: 'tourism',        pipeline: 'title-macro',   stocks: ['TITLE'], baseScore: 25 },
  { q: 'เที่ยวบิน ภูเก็ต รัสเซีย',     category: 'tourism',        pipeline: 'title-macro',   stocks: ['TITLE'], baseScore: 25 },
  { q: 'วีซ่า นักท่องเที่ยว ไทย',      category: 'tourism',        pipeline: 'title-macro',   stocks: ['TITLE'], baseScore: 25 },
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
// Split into two lists because they need different match strategies:
//   - DROP_WORDS_LATIN: short English tickers / fragments that MUST be matched
//     on word boundaries — substring matching would catch unrelated words
//     ('OR' inside 'reform', 'NT' inside 'government', 'TU' inside 'status',
//     'TOP' inside 'stop'). Earlier the substring scan silently dropped many
//     legitimate ASW headlines containing these substrings.
//   - DROP_WORDS_THAI: full Thai words where word boundaries aren't a concern
//     (Thai doesn't use spaces) — substring matching is correct.
//
// DROP_WORDS_LATIN is matched CASE-SENSITIVELY. The regex used to carry the
// 'i' flag, which made short SET tickers collide with ordinary English words
// and hard-dropped perfectly good headlines:
//   "Global demand lifts Thai condo market"      → \bGLOBAL\b
//   "Pattaya Bay condo project by AssetWise"     → \bBAY\b
//   "ASW aims for top spot among Bangkok devs"   → \bTOP\b
//   "True cost of owning a Bangkok condo"        → \bTRUE\b
// Real headlines write SET tickers in uppercase ("หุ้น TRUE", "PTT ประกาศ"),
// so case-sensitivity costs nothing and removes the whole false-positive class.
// The handful of entries that are genuinely mixed-case brand names (KBank,
// Krungsri, cardX, Bitcoin, Crypto) live in DROP_WORDS_LATIN_CI below and keep
// case-insensitive matching.
const DROP_WORDS_LATIN = [
  // Thai banks (abbreviations + 4-letter SET tickers)
  'BAY', 'KBANK', 'SCB', 'KTB', 'TTB', 'TISCO', 'KKP',
  'KTC', 'AEONTS',
  // Energy + petrochem
  'PTT', 'PTTEP', 'TOP', 'BANPU', 'BCP', 'IRPC', 'ESSO', 'SPRC', 'GPSC',
  // Telecom
  'AIS', 'DTAC', 'TRUE', 'INTUCH', 'JAS', 'NT',
  // Food + agribusiness
  'CPF', 'CPALL', 'OISHI', 'TU', 'MINT', 'STA',
  // Retail + commerce
  'HMPRO', 'MAKRO', 'CRC', 'RS', 'COM7', 'BJC', 'GLOBAL',
  // Health / hospital
  'BDMS', 'BH', 'CHG',
  // Materials / industrial
  'SCC', 'TOA',
];
// Mixed-case brand names — these are never written in another case in the
// wild AND are long/distinctive enough that a case-insensitive match can't
// collide with an English word, so they keep the 'i' flag.
const DROP_WORDS_LATIN_CI = [
  'KBank', 'Krungsri', 'cardX', 'Bitcoin', 'Crypto',
];
const DROP_WORDS_THAI = [
  // Thai bank names (no abbreviations — those are in LATIN list)
  'กสิกรไทย', 'กรุงศรี', 'กรุงไทย', 'ไทยพาณิชย์', 'ทหารไทยธนชาต',
  // Consumer finance
  'บัตรเครดิต', 'สินเชื่อส่วนบุคคล', 'สินเชื่อรายย่อย',
  // Energy
  'น้ำมัน', 'ปิโตรเคมี', 'โรงกลั่น', 'ก๊าซธรรมชาติ', 'LNG',
  // Telecom
  'โทรคมนาคม',
  // Food
  'อาหารแช่แข็ง', 'อาหารสัตว์',
  // Retail
  'ค้าปลีก', 'ห้างสรรพสินค้า',
  // Health
  'โรงพยาบาล',
  // Materials
  'น้ำตาล', 'เหล็ก', 'ปูนซิเมนต์',
  // Other unrelated
  'ทองคำ', 'คริปโต', 'กองทุนรวม', 'ประกันภัย',
];

// Short tickers OR / ORI / etc. need a word-boundary match — 'OR' was the
// worst offender (matches 'for', 'report', 'reform', etc). `\b` in JS regex
// works on ASCII word chars; safer here than the t.includes() substring scan
// we used to do. NOTE: no 'i' flag — see the DROP_WORDS_LATIN comment above.
const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DROP_LATIN_RE = new RegExp(
  '\\b(' + DROP_WORDS_LATIN.map(escapeRe).join('|') + ')\\b'
);
const DROP_LATIN_CI_RE = new RegExp(
  '\\b(' + DROP_WORDS_LATIN_CI.map(escapeRe).join('|') + ')\\b',
  'i'
);

// High-relevance keywords — adds to the score. "ASW" matches all three
// ASW-related forms and is the only ticker-name with 50+ bonus points.
const HIGH_KEYWORDS = [
  // ASW direct (50+ bonus in scoring function)
  { kw: 'ASW',            boost: 50, type: 'asw' },
  { kw: 'Assetwise',      boost: 50, type: 'asw' },
  { kw: 'แอสเซทไวส์',     boost: 50, type: 'asw' },
  // TITLE (ร่มโพธิ์) direct — the subsidiary this app also monitors
  // (migrate-v13). Thai names only: scoreItem matches lowercased substrings,
  // and the bare English word "title" would boost every headline carrying it.
  { kw: 'ร่มโพธิ์',        boost: 50, type: 'title' },
  { kw: 'rhom bho',       boost: 50, type: 'title' },
  { kw: 'เดอะ ไทเทิล',    boost: 40, type: 'title' },
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
  // 'ภาวะเศรษฐกิจ' was listed TWICE, so a generic macro headline collected 20
  // instead of 10 and its display_priority was inflated above real sector news.
  { kw: 'ภาวะเศรษฐกิจ',   boost: 10, type: 'macro' },
  // REIC / sector data
  { kw: 'REIC',           boost: 25, type: 'sector' },
  { kw: 'ดัชนีความเชื่อมั่น', boost: 10, type: 'sector' },
];

// Score a headline. Returns 0 → drop, > 0 → keep, with higher = more relevant.
// `display_priority` = 50 + min(score, 75) → range [50, 125]. So an ASW
// headline can reach 100+ (high priority in the unified feed), while a
// generic sector headline sits at 60-70.
function scoreItem(title, baseScore = 0) {
  const t = title.toLowerCase();
  // Sum the HIGH keyword boosts FIRST. The DROP scan used to run before this
  // and `return 0` immediately, which meant the ASW boost was never even
  // computed — so an ASW-direct headline that happened to name an unrelated
  // ticker ("ASW จับมือ SCB ปล่อยสินเชื่อโครงการ") was killed outright. We need
  // to know whether this is ASW news BEFORE deciding to drop it.
  // baseScore (migrate-v13): targeted queries — e.g. the TITLE tourism set —
  // ARE the relevance filter; their matches must not die for lacking a
  // property keyword. Query-level, so broad queries keep the 0 floor.
  let score = baseScore;
  let aswDirect = false;
  for (const { kw, boost, type } of HIGH_KEYWORDS) {
    if (t.includes(kw.toLowerCase())) {
      score += boost;
      if (type === 'asw' || type === 'title') aswDirect = true;
    }
  }
  // Hard drop — any DROP keyword kills the item, UNLESS it is ASW-direct.
  // ASW is the whole point of the feed; no off-sector keyword outranks it.
  // Latin tickers use word-boundary regexes (case-sensitive for the uppercase
  // SET tickers) so they don't match unrelated English words.
  if (!aswDirect) {
    if (DROP_LATIN_RE.test(title)) return 0;
    if (DROP_LATIN_CI_RE.test(title)) return 0;
    for (const kw of DROP_WORDS_THAI) {
      if (t.includes(kw.toLowerCase())) return 0;
    }
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
  // Strip trailing " - <Latin publisher>" suffix (Google News / Bing
  // sometimes append the source name to the title). Only fires when the
  // suffix is Latin-only — preserves hyphen-separated Thai content like
  // "ASW - แนะนำซื้อ". See normalizeHeadline() for the same pattern.
  const headline = title.replace(/\s+-\s+[^-\u0E00-\u0E7F]+$/, '').trim();
  if (!headline) return null;

  const link = (itemXml.match(/<link\/?>([^<]+)/) || itemXml.match(/<link>([^<]+)<\/link>/) || [])[1] || '';
  const pubDate = (itemXml.match(/<pubDate>([^<]+)/) || [])[1] || '';
  const publisherUrl = extractPublisherUrl(link);
  const sourceName = cleanTitle(extractSourceName(itemXml));
  const guid = (itemXml.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || publisherUrl || link;

  const date = pubDate ? new Date(pubDate) : null;
  if (!date || isNaN(date.getTime())) return null;

  // Use the NORMALIZED headline as the dedup key — not guid/link. Two
  // publishers covering the same story (e.g. "TRIS upgrades ASW") will then
  // hash to the same value, the DB unique index on title_hash will reject
  // the second insert, and the feed shows one row per real-world story
  // instead of N copies. Falls back to guid if the headline is empty
  // (defensive — parseItem already null-filters empty titles upstream).
  const titleHash = sha1(normalizeHeadline(headline) || guid || link);

  // Relevance scoring — DROP keywords (banks, energy, etc.) get 0 and are
  // filtered later. ASW direct = 50+, real estate = 25+, BoT rate = 20+,
  // macro = 10+. display_priority = 50 + score, capped at 125 so ASW news
  // sits at top of the unified feed (above generic sector noise).
  const score = scoreItem(headline, query.baseScore || 0);
  if (score === 0) return null;        // hard drop — no row at all
  const displayPriority = Math.min(50 + score, 125);

  return {
    title: headline,
    // Convert pubDate to ICT (UTC+7) before slicing — without this, items
    // published between 00:00-07:00 ICT get the PREVIOUS day's UTC date.
    date: new Date(date.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10),
    // Category is assigned per stock at expandRowsByStock() time — the same
    // headline can legitimately file under MACRO for ASW and FX for TITLE.
    // _hint carries the query's legacy category as the classifier fallback.
    _hint: query.category,
    _stocks: query.stocks || ['ASW'],
    source_url: publisherUrl,         // real publisher article URL (decoded from Bing link)
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
  const url = bingNewsRssUrl(query.q);
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
    // Print the stack when there is one. This catch is broad enough to swallow
    // a programming error (a TypeError inside parseItem() applies to EVERY
    // item of EVERY query), which then presented as "0 items" plus one opaque
    // line — indistinguishable from Bing simply having no results.
    console.log(`[rss-property] ${query.q} → ERR ${e.message}`);
    if (e && e.stack) console.log(e.stack);
    return [];
  }
}

async function run({ sinceDate, maxAgeDays = 7 } = {}) {
  console.log(`[rss-property] fetching ${QUERIES.length} queries (maxAge=${maxAgeDays}d, concurrency=${BING_CONCURRENCY})`);
  // Concurrency-capped, not Promise.all — 25 simultaneous Bing hits get
  // throttled and a throttled response is silently indistinguishable from an
  // empty result set. See mapLimit() in news-rss-helpers.mjs.
  const all = (await mapLimit(QUERIES, BING_CONCURRENCY, q => fetchQuery(q, maxAgeDays))).flat();

  // Dedupe by title_hash (guid-based) across all queries — Google News can
  // surface the same article in multiple query results.
  const seen = new Map(); // title_hash → kept item
  const unique = [];
  for (const it of all) {
    const kept = seen.get(it.title_hash);
    if (kept) {
      // Same story via two queries — union the stock tags so the second
      // query's panel isn't silently starved of the row.
      kept._stocks = [...new Set([...(kept._stocks || ['ASW']), ...(it._stocks || ['ASW'])])];
      continue;
    }
    seen.set(it.title_hash, it);
    unique.push(it);
  }

  // Require a non-empty source_url — same valid-link rule as the unified feed
  // filter. Drops the rare <item> with a missing <link>.
  const valid = unique.filter(it => it.source_url && it.source_url.length > 0);

  // Auto-deepen: when Bing returned only the publisher's homepage (no
  // article path), search Bing again with the headline to find the real
  // article URL. Drops items where no deep URL can be found — better to
  // lose one row than store a homepage link the user can't read.
  const homepages = valid.filter(it => isHomepageUrl(it.source_url));
  if (homepages.length) {
    console.log(`[rss-property] deepening ${homepages.length} homepage URLs...`);
    // Also concurrency-capped: each deepen is up to 2 more Bing requests, so
    // an unbounded fan-out here was the heavier of the two throttling risks.
    await mapLimit(homepages, BING_CONCURRENCY, async (it) => {
      const deep = await deepenHomepageUrl(it.title, it.source_label);
      if (deep) it.source_url = deep;
    });
  }
  // Central gate — one definition of "is this link real", shared with the
  // Gemini pipelines and the manual-add endpoint. Beyond the homepage check
  // this catches redirector/tracker hosts, SSRF targets, a source_label that
  // names a different publisher than the hostname, and a URL already bound to
  // an unrelated headline (106 URLs in the live table are shared across 374
  // rows; deepenHomepageUrl above is one of the two ways that happened).
  const vetted = vetRowUrls(valid, { seenUrls: RUN_SEEN_URLS, tag: TAG });
  // An RSS item is a headline plus a link and nothing else — no summary, no
  // impact, no category of its own. With the link gone there is not enough
  // left to be worth a row, so these are still dropped here. That is NOT true
  // of the Gemini pipelines, whose rows keep summary/category/impact/date from
  // the article text; those keep the row and clear only the URL.
  const dropped = vetted.rows.filter(it => !it.source_url);
  const deepened = vetted.rows.filter(it => it.source_url);
  if (dropped.length) {
    console.log(`[rss-property] dropped ${dropped.length} items (no verifiable article URL)`);
  }
  console.log(`[rss-property] parsed=${all.length} unique=${unique.length} with_url=${deepened.length} dropped_no_url=${unique.length - valid.length} dropped_homepage=${dropped.length}`);

  if (!deepened.length) return { ok: true, fetched: 0, inserted: 0 };

  // Per-stock expansion + write (migrate-v13): category assigned per stock,
  // TITLE severity capped at medium (pin guardrail) inside the helper.
  const byStock = expandRowsByStock(deepened);
  let inserted = 0;
  for (const [stock, rows] of Object.entries(byStock)) {
    const r = await db.writeNewsItems(stock, rows);
    console.log(`[rss-property] ${stock}: inserted=${r.inserted}`);
    inserted += r.inserted;
  }
  return { ok: true, fetched: valid.length, inserted };
}

// scoreItem is exported for unit testing — the DROP/boost interaction is the
// part of this file most prone to silent false-positive drops.
export { run, scoreItem };
export default { run };
