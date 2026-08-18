// =============================================================================
// Shared helpers for RSS news fetchers (rss-property, rss-extended).
//
// Switched from Google News RSS to Bing News RSS because Google News' <link>
// is a redirect (`news.google.com/rss/articles/...`) that 404s over time, and
// its <source url="..."> only carries the publisher's root domain — never the
// deep article URL. Bing wraps the real publisher URL inside its redirect
// link's `url=` query parameter, so we can decode it directly with no extra
// HTTP hop. Bing also exposes the publisher name via a `<News:Source>` element
// (note the namespace prefix) instead of the standard `<source>`.
// =============================================================================

// Build the Bing News RSS search URL. `format=rss` is what makes Bing return
// the RSS feed instead of the HTML results page. Bing's RSS endpoint accepts
// the same q= queries Google News did, so the existing query catalogue in
// rss-property.mjs / rss-extended.mjs works unchanged.
export function bingNewsRssUrl(query) {
  return 'https://www.bing.com/news/search?q=' + encodeURIComponent(query) +
    '&format=rss';
}

// Decode the handful of XML entities that appear in RSS <link> values. Bing's
// apiclick.aspx URLs are full of `&amp;` separators; without decoding, the
// `url=` extraction regex below sees `&amp;url=` and misses the publisher URL.
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Reject URLs that we know will 404 or are internal redirects:
//   - news.google.com/rss/articles/... — Google News redirects (expire → 404)
//   - vertexaisearch.cloud.google.com — Gemini internal redirect (same problem)
//   - bing.com/news/apiclick.aspx — Bing's own wrapper (won't 404 but is not
//     a usable article URL; better to drop the item than store Bing's tracker)
//   - *.google.com redirector hosts
function isUsableArticleUrl(u) {
  if (!u || typeof u !== 'string') return false;
  if (!/^https?:\/\//.test(u)) return false;
  if (u.includes('news.google.com')) return false;
  if (u.includes('vertexaisearch.cloud.google.com')) return false;
  if (u.includes('grounding-api-redirect')) return false;
  if (u.includes('bing.com/news/apiclick')) return false;
  try {
    const h = new URL(u).hostname;
    if (h === 'news.google.com' || h.endsWith('.google.com')) return false;
    if (h === 'www.bing.com' || h === 'bing.com') return false;
  } catch { return false; }
  return true;
}

// Extract the real publisher article URL from a Bing News RSS <link>.
//
// Bing links look like:
//   http://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&tid=...&url=https%3a%2f%2fwww.ryt9.com%2fs%2fiq10%2f12791300&c=...&mkt=en-ww
//
// The publisher URL is URL-encoded inside the `url=` parameter. Decode it and
// return. If the link isn't a Bing apiclick URL (e.g. a future source hands us
// a real URL directly), return it as-is after entity-decoding. Returns '' for
// known-bad URLs (Google News redirects, Bing wrappers, etc.) so the caller
// can drop the item rather than store a guaranteed-to-404 link.
export function extractPublisherUrl(link) {
  if (!link) return '';
  const decoded = decodeXmlEntities(link);
  const m = decoded.match(/[?&]url=([^&]+)/);
  if (m) {
    try {
      const publisher = decodeURIComponent(m[1]);
      if (isUsableArticleUrl(publisher)) return publisher;
    } catch {
      // fall through — malformed encoding, try the raw link
    }
  }
  // If we couldn't extract a url= param, only return the raw link if it's
  // itself a usable article URL (not Bing's wrapper or a Google News redirect).
  if (isUsableArticleUrl(decoded)) return decoded;
  return '';
}

// Extract the publisher display name. Bing uses `<News:Source>NAME</News:Source>`
// (capitalised, namespaced). Google News uses `<source url="...">NAME</source>`.
// Try Bing first, then fall back to the Google form so the helper works for
// either feed without the caller needing to know which one it parsed.
export function extractSourceName(itemXml) {
  const bing = (itemXml.match(/<News:Source>([\s\S]*?)<\/News:Source>/) || [])[1];
  if (bing && bing.trim()) return bing.trim();
  const google = (itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1];
  return google ? google.trim() : '';
}

// Normalize a date string from Gemini or RSS to ensure the year is CE
// (Common Era), not BE (Buddhist Era). Gemini occasionally returns Thai
// Buddhist-era years (e.g. "2568-07-14" instead of "2025-07-14") which
// causes the frontend to display "14/7/11" (year 3111 BE via th-TH locale).
//
// Detects BE years by checking if the year > 2100 and subtracts 543.
// Also handles 2-digit years > 70 (interpreted as 1970+) — unlikely but safe.
export function normalizeDateYear(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return dateStr;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  let year = parseInt(m[1], 10);
  // BE → CE conversion (Buddhist Era = CE + 543)
  if (year > 2100) year -= 543;
  return `${year}-${m[2]}-${m[3]}${dateStr.slice(10)}`;
}

// Normalize a headline for dedup. Strips a trailing " - <Latin publisher>"
// suffix (e.g. "ASW ปันผล - Marketeer Online" → "ASW ปันผล"), lowercases,
// collapses whitespace, removes ASCII punctuation that publishers vary on.
//
// IMPORTANT: the suffix-strip regex only fires when the suffix contains NO
// Thai characters (`\u0E00-\u0E7F` is the Thai Unicode block). An earlier
// version used `\s*-\s*[^-]+$` which greedily stripped everything after the
// last hyphen — that truncated headlines like "ASW - แนะนำซื้อ" to "ASW"
// and corrupted both the stored title and the dedup hash.
//
// Used as the seed for `title_hash` so duplicate coverage of the same story
// by different publishers collapses to one row in news_feed (DB unique
// index on title_hash).
export function normalizeHeadline(s) {
  return String(s || '')
    .replace(/\s+-\s+[^-\u0E00-\u0E7F]+$/, '')   // trailing " - <Latin publisher>"
    .toLowerCase()
    .replace(/[()[\]{}"'`.,!?;:]/g, '')            // strip common ASCII punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// Detect homepage-style URLs (no path after the host). These are a sign
// that Bing indexed the publisher but didn't have the article's deep URL
// — the fetcher should try to find the real article via a follow-up Bing
// search before storing the homepage.
export function isHomepageUrl(u) {
  if (!u || typeof u !== 'string') return false;
  if (!isUsableArticleUrl(u)) return false;
  try {
    const p = new URL(u).pathname;
    return !p || p === '/' || p === '';
  } catch { return false; }
}

// Distinctive-token overlap score between an original headline and a Bing
// result title. Returns 0..1 — 1.0 means every original 4+ char token
// appears in the result title. Used to decide if a Bing search result is
// really the same story as our DB row.
function headlineOverlap(origNorm, resultNorm) {
  const origTokens = origNorm.split(' ').filter(w => w.length >= 4);
  if (!origTokens.length) return 0;
  const hits = origTokens.filter(t => resultNorm.includes(t)).length;
  return hits / origTokens.length;
}

// Some headlines must carry a company/keyword token to count as a real
// match (prevents matching an ASW headline against an unrelated article
// that just happens to mention "หุ้น" or "อสังหาฯ"). Returns the LIST of
// aliases for the detected company — ANY ONE of which qualifies a result
// title — or [] when no specific token is required (in which case overlap
// score alone decides).
//
// WHY a list: this used to return a single LATIN token ('ASW', 'SPALI',
// 'TRIS', 'Fed') and deepenHomepageUrl() then did
// `if (!rNorm.includes(req.toLowerCase())) continue;`. Thai publishers write
// the company name in THAI, so the result title never contained the Latin
// ticker and EVERY Thai-language ASW/peer item was dropped:
//   requiredToken('แอสเซทไวส์ ออกหุ้นกู้ 920 ล้านบาท')          -> 'ASW'
//   normalizeHeadline('แอสเซทไวส์ เสนอขายหุ้นกู้ชุดใหม่').includes('asw')
//                                                              -> false
// i.e. exactly the ASW news this product exists to track. Each row now pairs
// the DETECTOR regex with every spelling that identifies the same company, so
// the gate still rejects results about a DIFFERENT company (an SPALI article
// contains neither 'asw' nor 'แอสเซทไวส์') while accepting the Thai spelling.
export function requiredAliases(title) {
  const checks = [
    [/ASW|Assetwise|แอสเซทไวส์|แอสเสทไวส์/i,   ['ASW', 'Assetwise', 'แอสเซทไวส์', 'แอสเสทไวส์']],
    [/\bAP\b.*Thailand|เอพี\s*ไทยแลนด์|แอ็น\s*ไทยแลนด์/i, ['AP', 'เอพี', 'แอ็น']],
    [/\bLH\b|แลนด์แอนด์เฮ้าส์/i,               ['LH', 'แลนด์แอนด์เฮ้าส์', 'แลนด์ แอนด์ เฮ้าส์']],
    [/\bORN\b|นาวี่\s*แอสเซท/i,                ['ORN', 'นาวี่']],
    [/SPALI|ศุภาลัย/i,                          ['SPALI', 'ศุภาลัย']],
    [/SIRI|แสนสิริ/i,                           ['SIRI', 'แสนสิริ']],
    [/NOBLE|โนเบล|โนเบิล/i,                     ['NOBLE', 'โนเบล', 'โนเบิล']],
    [/\bORI\b|ออริจิ้น/i,                       ['ORI', 'ออริจิ้น']],
    [/\bQH\b|ควอลิตี้เฮ้าส์|ควอลิตี้เฮาส์/i,    ['QH', 'ควอลิตี้เฮ้าส์', 'ควอลิตี้เฮาส์']],
    [/PRUK|พฤกษา/i,                             ['PRUK', 'PSH', 'พฤกษา']],
    [/PROUD|พรู๊ด/i,                            ['PROUD', 'พรู๊ด']],
    [/\bPS\b\s*Property|เพอร์เฟค|Perfect/i,     ['PF', 'เพอร์เฟค', 'Perfect']],
    [/SENA|เซนา/i,                              ['SENA', 'เซนา']],
    [/\bBTS\b|บีทีเอส/i,                        ['BTS', 'บีทีเอส']],
    [/ANAN|อนันดา/i,                            ['ANAN', 'อนันดา']],
    [/\bLPN\b|แอล\.พี\.เอ็น|ลาดพร้าว\s*เน็ท/i,  ['LPN', 'แอล.พี.เอ็น', 'แอลพีเอ็น']],
    [/\bSPF\b|ศรีสวัสดิ์/i,                     ['SPF', 'ศรีสวัสดิ์']],
    [/\bAF\b|อาร์เอฟ/i,                         ['RF', 'AF', 'อาร์เอฟ']],
    [/\bDRE\b|ดิแอสเซท/i,                       ['DRE', 'ดิแอสเซท']],
    [/\bRML\b|ราชมงคล\s*พร็อพเพอร์ตี้/i,        ['RML', 'ราชมงคล']],
    [/\bB\*M\b|แบม/i,                           ['BM', 'แบม']],
    [/\bLALIN\b|ลลิล\s*พร็อพเพอร์ตี้/i,         ['LALIN', 'ลลิล']],
    [/\bMBK\b|เอ็มบีเค/i,                       ['MBK', 'เอ็มบีเค']],
    [/\bS\b&P\b|ศุภกิจ\s*พร็อพเพอร์ตี้/i,       ['SP', 'ศุภกิจ']],
    [/\bSTEC\b|สิงหะ\s*พร็อพเพอร์ตี้/i,         ['STEC', 'สิงหะ']],
    [/\bCHAN\b|ชน/i,                            ['CHAN', 'ชน']],
    [/\bRABBIT\b|แรบบิท/i,                      ['RABBIT', 'แรบบิท']],
    [/\bROJANA\b|โรจนะ/i,                       ['ROJANA', 'โรจนะ']],
    [/TRIS|ทริส/i,                              ['TRIS', 'ทริส']],
    [/ธปท|BOT\b/i,                              ['ธปท', 'BOT', 'ธนาคารแห่งประเทศไทย']],
    [/กนง/i,                                    ['กนง']],
    [/Fed|เฟด/i,                                ['Fed', 'เฟด']],
  ];
  for (const [re, aliases] of checks) if (re.test(title)) return aliases;
  return [];
}

// Distinctive Latin/numeric keyword extractor — pulls English letters,
// digits, % and $ out of a normalized title. Thai has no inter-word spaces
// so token-overlap matching fails on Thai-heavy headlines, but Latin/numeric
// tokens always have space boundaries. If two headlines share 3+ such
// keywords AND the required company ticker, they're almost certainly the
// same story even when the Thai phrasing differs.
//
// (We tried "shared numbers ≥ 2" before but it broke on cases like
// "4.26 พันลบ" vs "4,261 ลบ" — the underlying fact is the same but the
// rounded values differ. Latin keywords like ORN, Backlog, 20% are more
// stable across publishers.)
function distinctiveKeywords(s) {
  const tokens = s.match(/[a-z][a-z0-9]*|\d+(?:[.,]\d+)*\s*[%$]?/gi) || [];
  return tokens.filter(t => {
    const bare = t.replace(/[.,%$]/g, '').toLowerCase();
    return bare.length >= 2
      && !['the', 'and', 'for', 'with', 'that', 'this', 'from',
           '2569', '2568', '2567', '69', '68', '67', '66'].includes(bare);
  });
}

// Try to find the real article URL for a headline whose Bing result only
// had the publisher's homepage. Searches Bing News RSS with the headline
// and returns the first result whose title strongly matches (≥60% token
// overlap AND contains the required company token, if any).
//
// Returns: a deep article URL (string), or null if no good match. Caller
// should DROP the item when this returns null — better to lose one news
// row than store a homepage link that goes nowhere useful.
export async function deepenHomepageUrl(headline, sourceLabel) {
  if (!headline) return null;
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
  const origNorm = normalizeHeadline(headline);
  const req = requiredAliases(headline);        // [] when nothing is required

  // Pass 1: search the raw headline.
  let results = await bingNewsSearch(headline, UA);
  // Pass 2: if empty, try headline + source_label (e.g. "...kaohoon").
  if (!results.length && sourceLabel) {
    results = await bingNewsSearch(`${headline} ${sourceLabel}`, UA);
  }

  for (const r of results) {
    const rNorm = normalizeHeadline(r.title);
    // One of the required aliases must appear in the result title (prevents
    // FPT-instead-of-ASW). ANY alias counts — Latin ticker OR Thai spelling —
    // because a Thai publisher's headline carries only the Thai name.
    if (req.length && !req.some(a => rNorm.includes(a.toLowerCase()))) continue;
    if (!isUsableArticleUrl(r.url) || isHomepageUrl(r.url)) continue;
    // Match if EITHER:
    //   (a) Token overlap ≥ 0.6 — works well for English / mixed headlines
    //   (b) Required company token present AND ≥ 3 distinctive Latin/numeric
    //       keywords shared — needed for Thai-heavy headlines where token
    //       overlap is unreliable (Thai has no inter-word spaces so the
    //       entire Thai phrase becomes one long "token"). Latin keywords
    //       like ORN, Backlog, 20% are stable across publishers.
    const overlap = headlineOverlap(origNorm, rNorm);
    const origKw = new Set(distinctiveKeywords(origNorm));
    const sharedKw = distinctiveKeywords(rNorm).filter(k => origKw.has(k.toLowerCase())).length;
    if (overlap >= 0.6 || (req.length && sharedKw >= 3)) {
      return r.url;
    }
  }
  return null;
}

// Run `fn` over `items` with at most `limit` calls in flight at a time, and
// return the results in INPUT order (same contract as Promise.all).
//
// WHY: both RSS fetchers used a bare `Promise.all`, which fired all 25 query
// fetches simultaneously and then every homepage-deepen search simultaneously
// (up to 2 more Bing requests each). Bing throttles that hard, and a throttled
// response is INVISIBLE downstream — bingNewsSearch() returns [],
// deepenHomepageUrl() returns null, and the item is dropped as "no deep URL
// found" with nothing in the log pointing at rate limiting. Capping the fan-out
// keeps us under Bing's threshold; a 25-query batch still finishes in ~7 rounds.
export async function mapLimit(items, limit, fn) {
  const list = Array.from(items);
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  };
  const width = Math.max(1, Math.min(limit, list.length));
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

// Internal: hit Bing News RSS and decode each result into {title, url}.
// Used by deepenHomepageUrl above.
async function bingNewsSearch(query, ua) {
  try {
    const res = await fetch(
      'https://www.bing.com/news/search?q=' + encodeURIComponent(query) + '&format=rss',
      { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(12_000) },
    );
    if (!res.ok) {
      // LOG, don't swallow: a Bing 429 used to be indistinguishable from
      // "no results" — the caller just dropped the item. The status code is
      // the only signal that we're being throttled rather than genuinely
      // finding nothing, so it has to reach the Railway log.
      console.log(`[bing-search] "${String(query).slice(0, 60)}" → HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    return items.map(it => {
      const title = (it.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]?.trim() || '';
      const link = (it.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1]?.trim() || '';
      return { title, url: extractPublisherUrl(link) };
    }).filter(x => x.url);
  } catch (e) {
    // Same reasoning as the !res.ok branch — a network timeout must not look
    // like an empty result set.
    console.log(`[bing-search] "${String(query).slice(0, 60)}" → ERR ${e.message}`);
    return [];
  }
}


// =============================================================================
// migrate-v13: expand stock-neutral RSS rows into per-stock news_feed rows.
//
// A QUERY row may serve several stocks (`stocks: ['ASW','TITLE']`); the item
// is fetched/vetted ONCE, then copied per stock here with:
//   - a per-stock category (the same headline files under MACRO for ASW but
//     FX for TITLE — classifyCategory dispatches on the stock)
//   - the TITLE pin guardrail: RSS relevance is query-level, not vetted per
//     headline, so a TITLE copy is never allowed severity 'high' (which
//     writeNewsItems auto-pins onto the chart). Driver pins come only from
//     the LLM-filtered gemini-title pipelines.
// Scratch fields (_stocks, _hint) are stripped from the emitted rows.
// =============================================================================
import { classifyCategory, impactLevelFromSeverity } from '../news-taxonomy.mjs';

export function expandRowsByStock(rows) {
  const byStock = {};
  for (const it of rows) {
    const stocks = it._stocks && it._stocks.length ? it._stocks : ['ASW'];
    for (const stock of stocks) {
      const { _stocks, _hint, ...row } = it;
      row.category = classifyCategory(it.title, _hint, stock);
      if (stock === 'TITLE' && row.severity === 'high') {
        row.severity = 'medium';
        row.show_pin = false;
        row.impact_level = impactLevelFromSeverity('medium');
      }
      (byStock[stock] = byStock[stock] || []).push(row);
    }
  }
  return byStock;
}
