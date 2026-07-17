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
