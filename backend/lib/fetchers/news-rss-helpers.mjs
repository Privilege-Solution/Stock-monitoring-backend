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

// Normalize a headline for dedup. Strips Google News' trailing " - Source"
// suffix, lowercases, collapses whitespace, removes punctuation that
// publishers vary on (quotes, brackets, em-dashes). Keeps Thai characters
// intact — Thai has no inter-word spaces so we can't tokenize, but the
// normalization still collapses cosmetically-different variants of the
// same headline ("TRIS Rating ASW BBB" vs "TRIS Rating ASW 'BBB'").
//
// Used as the seed for `title_hash` so duplicate coverage of the same story
// by different publishers collapses to one row in news_feed (DB unique
// index on title_hash).
export function normalizeHeadline(s) {
  return String(s || '')
    .replace(/\s*-\s*[^-]+$/, '')              // trailing " - Source"
    .toLowerCase()
    .replace(/[()[\]{}"'`.,!?;:]/g, '')         // strip common punctuation
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
// that just happens to mention "หุ้น" or "อสังหาฯ"). Returns the token
// we require the result title to contain, or '' if no specific token is
// required (in which case overlap score alone decides).
function requiredToken(title) {
  const checks = [
    [/ASW|Assetwise|แอสเซทไวส์|AssetWise/i, 'ASW'],
    [/\bAP\b.*Thailand|แอ็น\s*ไทยแลนด์/i, 'AP'],
    [/\bLH\b|แลนด์แอนด์เฮ้าส์/i, 'LH'],
    [/\bORN\b|นาวี่\s*แอสเซท/i, 'ORN'],
    [/SPALI|ศุภาลัย/i, 'SPALI'],
    [/SIRI|แสนสิริ/i, 'SIRI'],
    [/NOBLE|โนเบล/i, 'NOBLE'],
    [/\bORI\b|ออริจิ้น/i, 'ORI'],
    [/\bQH\b|ควอลิตี้เฮ้าส์/i, 'QH'],
    [/PRUK|พฤกษา/i, 'PRUK'],
    [/PROUD|พรู๊ด/i, 'PROUD'],
    [/\bPS\b\s*Property|เพอร์เฟค|Perfect/i, 'PF'],
    [/SENA|เซนา/i, 'SENA'],
    [/\bBTS\b|บีทีเอส/i, 'BTS'],
    [/ANAN|อนันดา/i, 'ANAN'],
    [/\bLPN\b|แอล\.พี\.เอ็น|ลาดพร้าว\s*เน็ท/i, 'LPN'],
    [/PROUD|พรู๊ด/i, 'PROUD'],
    [/\bSPF\b|ศรีสวัสดิ์/i, 'SPF'],
    [/\bAF\b|อาร์เอฟ/i, 'RF'],
    [/\bDRE\b|ดิแอสเซท/i, 'DRE'],
    [/\bRML\b|ราชมงคล\s*พร็อพเพอร์ตี้/i, 'RML'],
    [/\bB\*M\b|แบม/i, 'BM'],
    [/\bLALIN\b|ลลิล\s*พร็อพเพอร์ตี้/i, 'LALIN'],
    [/\bMBK\b|เอ็มบีเค/i, 'MBK'],
    [/\bS\b&P\b|ศุภกิจ\s*พร็อพเพอร์ตี้/i, 'SP'],
    [/\bSTEC\b|สิงหะ\s*พร็อพเพอร์ตี้/i, 'STEC'],
    [/\bCHAN\b|ชน/i, 'CHAN'],
    [/\bRABBIT\b|แรบบิท/i, 'RABBIT'],
    [/\bROJANA\b|โรจนะ/i, 'ROJANA'],
    [/TRIS|ทริส/i, 'TRIS'],
    [/ธปท|BOT\b/i, 'ธปท'],
    [/กนง/i, 'กนง'],
    [/Fed|เฟด/i, 'Fed'],
  ];
  for (const [re, tok] of checks) if (re.test(title)) return tok;
  return '';
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
  const req = requiredToken(headline);

  // Pass 1: search the raw headline.
  let results = await bingNewsSearch(headline, UA);
  // Pass 2: if empty, try headline + source_label (e.g. "...kaohoon").
  if (!results.length && sourceLabel) {
    results = await bingNewsSearch(`${headline} ${sourceLabel}`, UA);
  }

  for (const r of results) {
    const rNorm = normalizeHeadline(r.title);
    // Required token must appear in result title (prevents FPT-instead-of-ASW).
    if (req && !rNorm.includes(req.toLowerCase())) continue;
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
    if (overlap >= 0.6 || (req && sharedKw >= 3)) {
      return r.url;
    }
  }
  return null;
}

// Internal: hit Bing News RSS and decode each result into {title, url}.
// Used by deepenHomepageUrl above.
async function bingNewsSearch(query, ua) {
  try {
    const res = await fetch(
      'https://www.bing.com/news/search?q=' + encodeURIComponent(query) + '&format=rss',
      { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(12_000) },
    );
    if (!res.ok) return [];
    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    return items.map(it => {
      const title = (it.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]?.trim() || '';
      const link = (it.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1]?.trim() || '';
      return { title, url: extractPublisherUrl(link) };
    }).filter(x => x.url);
  } catch { return []; }
}
