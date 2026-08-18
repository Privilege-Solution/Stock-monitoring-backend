// =============================================================================
// Migrate-v8 — Extended news fetcher.
// =============================================================================
// Closes the 6-gap coverage recommended by the user:
//   1. company_filing     — SET filing / earnings / dividend / capital / bond
//   2. broker             — broker analyst (rating change / target price)
//   3. insider_trade      — SEC Form 59 insider buy/sell
//   4. investor_alert     — SET Smart Alert (unusual volume / cash balance)
//   5. macro_fx           — BoT USD/THB fix + baht-direction news
//   6. debt_rating        — TRIS rating action + sector debt headlines
//
// All sources are FREE public RSS / Google News (no Bloomberg / Reuters /
// paid APIs). Every item MUST mention ASW (the ticker, the full name, or
// "แอสเซทไวส์") or be a sector-level signal the user asked us to track
// (FX, BoT rate, Phuket/Pattaya foreign ownership, etc.).
//
// Run shape (dispatched by runFetch in lib/fetchers/index.js):
//   source: 'rss-extended' → inserts 0–40 rows to news_feed
//
// Taxonomy v2 (migrate-v9)
// -----------------------
// The legacy `category` values above are KEPT in the QUERY catalogue as a
// private hint (used by parseItem for severity scoring and to pick a sensible
// fallback when the title doesn't match any pattern). The DB column itself
// now stores the new 6-way vocabulary: COMPANY / RATES / GOV_POLICY /
// POLITICS / INDUSTRY / MACRO. `classifyCategory()` runs the title-pattern
// priority from migrate-v9.js so RSS rows land in the same buckets as
// Gemini output and migrated legacy data.
//
// Each row also carries `impact_level` (HIGH / MEDIUM / LOW) — distinct from
// the legacy `impact` column (positive/negative/neutral for sentiment). The
// mapping is severity-driven: high→HIGH, low→LOW, otherwise MEDIUM. The
// legacy `impact` field stays as 'neutral' for now since sentiment is
// separate from impact magnitude.
// =============================================================================

import { createHash } from 'node:crypto';
import db from '../../db.js';
import {
  impactLevelFromSeverity, headlineMentionsAsw,
} from '../news-taxonomy.mjs';
import { bingNewsRssUrl, extractPublisherUrl, extractSourceName, normalizeHeadline, isHomepageUrl, deepenHomepageUrl, mapLimit, expandRowsByStock } from './news-rss-helpers.mjs';
import { vetRowUrls } from '../news-url-guard.mjs';

const TAG = 'rss-extended';
// URLs already claimed by a headline in this process. Module scope: the cron
// runs each batch in a fresh process, so this never goes stale.
const RUN_SEEN_URLS = new Map();

// Max simultaneous Bing requests — see mapLimit() in news-rss-helpers.mjs.
const BING_CONCURRENCY = 4;

const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// ---------------------------------------------------------------------------
// Query catalogue — 4 logical groups, mapped to the 4 user-approved scopes.
//
// Each entry: { q, category (legacy hint), pipeline, requireAsw, severity }
//   - requireAsw=true  : headline MUST mention ASW / Assetwise / แอสเซทไวส์
//                        (company_filing + insider + investor_alert are ASW-only)
//   - requireAsw=false : sector-level signal (BoT, FX, etc.) accepted as-is
//   - requireAsw='OR'  : headline must mention ASW OR a broker keyword
// ---------------------------------------------------------------------------
const QUERIES = [
  // ── 1. Company filings (earnings / dividend / capital / bond) ─────────────
  { q: 'ASW ปันผล',                category: 'company_filing', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'ASW เพิ่มทุน',              category: 'company_filing', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'ASW งบดุล',                category: 'company_filing', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'แอสเซทไวส์ กำไร',          category: 'company_filing', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'ASW หุ้นกู้',              category: 'company_filing', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'Assetwise SET filing',     category: 'company_filing', pipeline: 'company', requireAsw: true,  severity: 'medium' },

  // ── 2. Broker analyst news (rating / target price) ───────────────────────
  // Google News rarely returns headlines that mention BOTH the broker AND the
  // ticker together — so we DON'T require "ASW" in the title. The headline is
  // accepted if it mentions ASW OR if it carries one of the BROKER_TOKENS
  // (broker name + rating signals). The check below in parseItem() applies
  // both filters as OR.
  { q: 'ASPS ASW',                  category: 'broker', pipeline: 'company', requireAsw: 'OR', severity: 'high'   },
  { q: 'MST ASW',                   category: 'broker', pipeline: 'company', requireAsw: 'OR', severity: 'high'   },
  { q: 'KGI ASW',                   category: 'broker', pipeline: 'company', requireAsw: 'OR', severity: 'high'   },
  { q: 'โบรกเกอร์ ASW',             category: 'broker', pipeline: 'company', requireAsw: 'OR', severity: 'medium' },
  { q: 'target price ASW',          category: 'broker', pipeline: 'company', requireAsw: 'OR', severity: 'medium' },
  { q: 'แนะนำซื้อ ASW',             category: 'broker', pipeline: 'company', requireAsw: 'OR', severity: 'high'   },
  { q: 'broker แนะนำ อสังหาฯ',     category: 'broker', pipeline: 'sector',  requireAsw: 'OR', severity: 'medium' },

  // ── 3. Insider trading / SET investor alert ──────────────────────────────
  { q: 'SEC Form 59 ASW',           category: 'insider_trade', pipeline: 'company', requireAsw: true,  severity: 'high' },
  { q: 'รายงานการถือหลักทรัพย์ ASW', category: 'insider_trade', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'ASW insider',               category: 'insider_trade', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'SET cash balance ASW',      category: 'investor_alert', pipeline: 'company', requireAsw: true, severity: 'medium' },
  { q: 'SET Smart Alert ASW',       category: 'investor_alert', pipeline: 'company', requireAsw: true, severity: 'medium' },

  // ── 4. BoT FX + debt rating + legal / foreign ownership ──────────────────
  { q: 'บาท USD/THB',               category: 'macro_fx', pipeline: 'macro', requireAsw: false, severity: 'medium', stocks: ['ASW', 'TITLE'] },
  { q: 'ดอกเบี้ย นโยบาย กนง.',      category: 'macro_fx', pipeline: 'macro', requireAsw: false, severity: 'high', stocks: ['ASW', 'TITLE'] },
  { q: 'TRIS rating ASW',           category: 'debt_rating', pipeline: 'company', requireAsw: true,  severity: 'high' },
  { q: 'อันดับเครดิต ASW',          category: 'debt_rating', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'foreign ownership Phuket condo', category: 'macro_fx', pipeline: 'macro', requireAsw: false, severity: 'medium', stocks: ['ASW', 'TITLE'] },
  { q: 'เอกชนถือครอง ภูเก็ต พัทยา',   category: 'macro_fx', pipeline: 'macro', requireAsw: false, severity: 'medium', stocks: ['ASW', 'TITLE'] },
];

// Broker signals — require at least one of these to land in the broker
// bucket. Without these tokens a matched headline ("ASW ลุยตลาดภูเก็ต")
// would be misrouted to broker instead of peer_news / company_filing.
//
// Split in two because the two scripts need different matching, and both had
// bugs that made the requireAsw:'OR' gate far too permissive:
//   - The bare Thai words 'แนะนำ' ("recommend") and 'อันดับ' ("rank") matched
//     any headline containing them. "ธปท. แนะนำประชาชนระวังหนี้ครัวเรือน"
//     passed the OR gate of `{ q:'แนะนำซื้อ ASW', severity:'high' }` and then
//     inherited that QUERY row's severity/show_pin — a household-debt PSA
//     landed at display_priority 115, pinned on the price chart and top of the
//     feed. Only the specific forms survive (แนะนำซื้อ / แนะนำขาย / แนะนำถือ,
//     and อันดับเครดิต for the credit-rating sense of 'อันดับ').
//   - Latin broker tickers were matched with t.includes(), so bare 'LH' hit
//     inside any word containing those letters. They now use word boundaries.
const BROKER_TOKENS_THAI = [
  'โบรกเกอร์', 'บลจ.', 'บล.', 'บริษัทหลักทรัพย์',
  'ราคาเป้า', 'เรทหุ้น',
  'แนะนำซื้อ', 'แนะนำขาย', 'แนะนำถือ',
  'อันดับเครดิต', 'ราคาพาร์',
  'นายหน้า', 'โบรก', 'วิเคราะห์หุ้น', 'คาดกำไร', 'ประเมินหุ้น',
];
const BROKER_TOKENS_LATIN = [
  'ASPS', 'MST', 'KGI', 'KTBST', 'LH', 'JPM', 'target price', 'Rating',
];
// Lookaround boundaries so 'LH' / 'MST' can't match inside a longer word.
const BROKER_LATIN_RE = new RegExp(
  '(?<![A-Za-z])(' +
  BROKER_TOKENS_LATIN.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
  ')(?![A-Za-z])',
  'i',
);

// Filing-side keywords — tighter than requireAsw alone. Makes sure that
// "ASW ลุย..." (peer news) doesn't drift into company_filing.
const FILING_TOKENS = [
  'งบดุล', 'งบการเงิน', 'ปันผล', 'หุ้นกู้', 'เพิ่มทุน', 'ลดทุน',
  'รายงานประจำปี', 'แบบ 56-1', 'รายได้', 'กำไรสุทธิ', 'อัตราส่วน',
  'D/E', 'Debt-to-Equity', 'กระแสเงินสด', 'ประชุมผู้ถือหุ้น',
  'กองทุนรวม', 'X-Report', 'F4-1', 'F4-2', 'XB-1', 'แบบแสดงรายการ',
];

// ----------------------------------------------------------------------------
// Taxonomy-v2 classifier — now lives in the shared `news-taxonomy.mjs` module
// (imported above) so rss-property, rss-extended and gemini-search all emit
// the same 7 keys (incl. the new COMPETITOR bucket). The query's legacy
// `category` is passed as the `hint` fallback for generic titles.
// ----------------------------------------------------------------------------

function headlineMentionsBroker(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  // Thai: substring is correct (no word boundaries in the script).
  if (BROKER_TOKENS_THAI.some(kw => t.includes(kw.toLowerCase()))) return true;
  // Latin: word-boundary regex (see BROKER_LATIN_RE).
  return BROKER_LATIN_RE.test(title);
}

function headlineMentionsFiling(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return FILING_TOKENS.some(kw => t.includes(kw.toLowerCase()));
}

function cleanTitle(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

function parseItem(itemXml, q) {
  const titleRaw = (itemXml.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  // Strip trailing " - <Latin publisher>" only — preserves hyphen-separated
  // Thai content. See normalizeHeadline() for the same pattern.
  const title = cleanTitle(titleRaw).replace(/\s+-\s+[^-\u0E00-\u0E7F]+$/, '').trim();
  if (!title) return null;

  const link = (itemXml.match(/<link\/?>([^<]+)/) || itemXml.match(/<link>([^<]+)<\/link>/) || [])[1] || '';
  const publisherUrl = extractPublisherUrl(link);
  const pubDate = (itemXml.match(/<pubDate>([^<]+)/) || [])[1] || '';
  const sourceName = cleanTitle(extractSourceName(itemXml));
  const guid = (itemXml.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || publisherUrl || link;

  const d = pubDate ? new Date(pubDate) : null;
  if (!d || isNaN(d.getTime())) return null;

  // Pre-filter: category-specific token gates before accepting the headline.
  //   - requireAsw === true  → headline MUST mention ASW / Assetwise / แอสเซทไวส์
  //   - requireAsw === 'OR'  → headline must mention ASW OR a broker keyword
  //                            (used for broker queries — broker headlines
  //                             often drop the ticker and only name the broker)
  //   - requireAsw === false → accept whatever Google News returns (macro FX,
  //                            foreign-ownership, etc. — sector-level signal)
  // Company_filing intentionally has no extra gate beyond ASW — any ASW
  // mention is treated as company news.
  const mentionsAsw = headlineMentionsAsw(title);
  if (q.requireAsw === true && !mentionsAsw) return null;
  if (q.requireAsw === 'OR'
      && !(mentionsAsw || headlineMentionsBroker(title))) return null;

  // Category is assigned per stock at expandRowsByStock() time (the same
  // headline can file under MACRO for ASW and FX for TITLE); the query's
  // legacy `category` rides along as the classifier's hint fallback.

  // Severity/show_pin come from the QUERY row, which describes what the query
  // is FOR — not what this particular headline actually says. On an 'OR' query
  // a headline can qualify on the broker token ALONE and never mention the
  // company, so stamping it with the query's severity:'high' + show_pin gave
  // an unrelated headline display_priority 115 and pinned it to the chart.
  // Only honour 'high' on an 'OR' query when the ASW/company condition is what
  // matched. requireAsw:true rows always mention ASW (checked above) and
  // requireAsw:false rows are deliberate sector-level signals (the กนง. policy
  // -rate query is high-severity by design), so both keep their configured value.
  const severity = (q.requireAsw === 'OR' && q.severity === 'high' && !mentionsAsw)
    ? 'medium'
    : (q.severity || 'medium');
  const impact_level = impactLevelFromSeverity(severity);

  return {
    title,
    // Convert pubDate to ICT (UTC+7) — see rss-property.mjs for rationale.
    date: new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10),
    _hint: q.category,               // classifier fallback, per-stock at expansion
    _stocks: q.stocks || ['ASW'],
    source_url: publisherUrl,         // real publisher article URL (decoded from Bing link)
    source_label: sourceName || 'Google News',
    // Dedup by normalized headline (not guid/link) so different publishers
    // covering the same story collapse into one row. See rss-property.mjs
    // for the rationale.
    title_hash: sha1(normalizeHeadline(title) || guid || link),
    pipeline: q.pipeline,
    impact: 'neutral',               // legacy sentiment column — RSS items don't score this
    severity,                        // content-aware (see above), not blindly q.severity
    show_pin: severity === 'high',
    summary: null,
    impact_level,                    // taxonomy-v2 key
  };
}

async function fetchQuery(q, maxAgeDays) {
  const url = bingNewsRssUrl(q.q);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) {
      console.log(`[rss-extended] ${q.q} → HTTP ${r.status}`);
      return [];
    }
    const t = await r.text();
    const items = t.match(/<item>[\s\S]*?<\/item>/g) || [];
    const cutoff = Date.now() - maxAgeDays * 86400_000;
    return items
      .map(x => parseItem(x, q))
      .filter(Boolean)
      .filter(it => new Date(it.date + 'T00:00:00Z').getTime() >= cutoff);
  } catch (e) {
    // Print the stack when there is one — this catch is broad enough to hide a
    // programming error (a TypeError in parseItem() fails every item of every
    // query), which otherwise reads as "0 items" with one opaque line.
    console.log(`[rss-extended] ${q.q} → ERR ${e.message}`);
    if (e && e.stack) console.log(e.stack);
    return [];
  }
}

async function run({ sinceDate, maxAgeDays = 14 } = {}) {
  console.log(`[rss-extended] fetching ${QUERIES.length} queries (maxAge=${maxAgeDays}d, concurrency=${BING_CONCURRENCY})`);
  // Tighter maxAge (14d) than rss-property (7d) because broker/insider
  // headlines stop being actionable quickly. Override via arg if needed.
  // Concurrency-capped rather than Promise.all — Bing throttles a full-batch
  // fan-out and the resulting empty response is silent. See mapLimit().
  const all = (await mapLimit(QUERIES, BING_CONCURRENCY, q => fetchQuery(q, maxAgeDays))).flat();

  // Dedupe by title_hash across queries — Google News surfaces overlapping
  // results for queries like "ASPS ASW" and "target price ASW".
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

  const valid = unique.filter(it => it.source_url && it.source_url.length > 0);

  // Auto-deepen homepage URLs (Bing sometimes returns only the publisher's
  // root URL when it indexes a publisher but doesn't have the article).
  // Same logic as rss-property — see comment there for rationale.
  const homepages = valid.filter(it => isHomepageUrl(it.source_url));
  if (homepages.length) {
    console.log(`[rss-extended] deepening ${homepages.length} homepage URLs...`);
    // Capped too: each deepen costs up to 2 more Bing requests.
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
    console.log(`[rss-extended] dropped ${dropped.length} items (no verifiable article URL)`);
  }
  if (!deepened.length) return { ok: true, fetched: 0, inserted: 0 };

  // Display priority: ASW-direct broker/insider = top of feed.
  // No keyword-scoring table — categories are intrinsically ranked. We rely
  // on the existing display_priority formula in the unified feed (which
  // already understands broker vs. macro). For items WITHOUT a stored value
  // the frontend's priorityForItem() falls back to severity-based scoring.
  // Per-stock expansion + write (migrate-v13): category assigned per stock,
  // TITLE severity capped at medium (pin guardrail) inside the helper.
  const byStock = expandRowsByStock(deepened);
  let inserted = 0;
  const written = [];
  for (const [stock, rows] of Object.entries(byStock)) {
    const r = await db.writeNewsItems(stock, rows);
    console.log(`[rss-extended] ${stock}: inserted=${r.inserted}`);
    inserted += r.inserted;
    written.push(...rows);
  }

  // Per-category counts for the log line (operator at-a-glance). Uses the
  // NEW taxonomy keys so the log matches what the user sees in the UI.
  const byCat = {};
  for (const it of written) byCat[it.category] = (byCat[it.category] || 0) + 1;
  const byImpact = {};
  for (const it of written) byImpact[it.impact_level] = (byImpact[it.impact_level] || 0) + 1;
  console.log(`[rss-extended] parsed=${all.length} unique=${unique.length} deepened=${deepened.length} dropped_homepage=${dropped.length} inserted=${inserted} byCat=${JSON.stringify(byCat)} byImpact=${JSON.stringify(byImpact)}`);
  return { ok: true, fetched: deepened.length, inserted, byCat, byImpact };
}

// headlineMentionsBroker is exported for unit testing — it is the gate that
// decides whether a non-ASW headline may enter a broker query's results.
export { run, headlineMentionsBroker };
export default { run };