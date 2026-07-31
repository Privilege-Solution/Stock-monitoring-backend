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
import { bingNewsRssUrl, extractPublisherUrl, extractSourceName, normalizeHeadline, isHomepageUrl, deepenHomepageUrl, mapLimit } from './news-rss-helpers.mjs';

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
  { q: 'ต่างชาติ ซื้อ คอนโด ไทย', category: 'sector_data',  pipeline: 'sector' },
  { q: 'ดอกเบี้ย ธปท. 2569',     category: 'interest_rate', pipeline: 'macro' },
  { q: 'ค่าเงินบาท USD',         category: 'macro_fx',     pipeline: 'macro' },
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
function scoreItem(title) {
  const t = title.toLowerCase();
  // Sum the HIGH keyword boosts FIRST. The DROP scan used to run before this
  // and `return 0` immediately, which meant the ASW boost was never even
  // computed — so an ASW-direct headline that happened to name an unrelated
  // ticker ("ASW จับมือ SCB ปล่อยสินเชื่อโครงการ") was killed outright. We need
  // to know whether this is ASW news BEFORE deciding to drop it.
  let score = 0;
  let aswDirect = false;
  for (const { kw, boost, type } of HIGH_KEYWORDS) {
    if (t.includes(kw.toLowerCase())) {
      score += boost;
      if (type === 'asw') aswDirect = true;
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
  const score = scoreItem(headline);
  if (score === 0) return null;        // hard drop — no row at all
  const displayPriority = Math.min(50 + score, 125);

  return {
    title: headline,
    // Convert pubDate to ICT (UTC+7) before slicing — without this, items
    // published between 00:00-07:00 ICT get the PREVIOUS day's UTC date.
    date: new Date(date.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10),
    // Classify through the shared taxonomy so rss-property rows emit the same
    // 7 keys (COMPANY/COMPETITOR/RATES/GOV_POLICY/POLITICS/INDUSTRY/MACRO) the
    // frontend filters on — previously this wrote the legacy query hint
    // (sector_data / interest_rate / peer_news …) which matched no chip.
    category: classifyCategory(headline, query.category),
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
  const seen = new Set();
  const unique = all.filter(it => {
    if (seen.has(it.title_hash)) return false;
    seen.add(it.title_hash);
    return true;
  });

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
  const dropped = valid.filter(it => isHomepageUrl(it.source_url));
  const deepened = valid.filter(it => !isHomepageUrl(it.source_url));
  if (dropped.length) {
    console.log(`[rss-property] dropped ${dropped.length} items (no deep URL found)`);
  }
  console.log(`[rss-property] parsed=${all.length} unique=${unique.length} with_url=${deepened.length} dropped_no_url=${unique.length - valid.length} dropped_homepage=${dropped.length}`);

  if (!deepened.length) return { ok: true, fetched: 0, inserted: 0 };

  const { inserted } = await db.writeNewsItems(deepened);
  console.log(`[rss-property] inserted=${inserted}`);
  return { ok: true, fetched: valid.length, inserted };
}

// scoreItem is exported for unit testing — the DROP/boost interaction is the
// part of this file most prone to silent false-positive drops.
export { run, scoreItem };
export default { run };
