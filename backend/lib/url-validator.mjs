// =============================================================================
// Central URL validator. Every news fetcher and the manual-add endpoint go
// through this module, so there is ONE definition of "is this link real".
//
// Split into two layers, because they cost very different amounts:
//
//   classifyUrlOffline(url, {sourceLabel})  — pure, no network, microseconds.
//       Scheme, redirector/tracker hosts, homepage shape, SSRF targets, and
//       label/hostname agreement. Safe to run on every item in a cron batch.
//
//   validateUrl(url, {...})                 — one bounded HTTP request.
//       Runs the offline pass first and short-circuits on a verdict, then
//       fetches to separate a live article from a 404, a bot-block, and a
//       soft-404. Costs a round trip, so callers rate-limit it.
//
// STATUS VOCABULARY (stored in news_feed.source_url_status):
//   valid        fetched, 2xx, and the page looks like the article
//   dead         404 / 410, or a confident soft-404
//   blocked      401 / 403 — the site refuses BOTS. Says nothing about whether
//                the article exists; a reader in a browser very likely sees it.
//                Never conflate with dead.
//   rate_limited 429 — we were throttled. Retry later, decide nothing now.
//   homepage     resolves to a site root / section index, not an article
//   mismatch     the link does not belong to the story or the stated publisher
//   timeout      the request did not finish inside the budget
//   unsafe       SSRF target, non-http(s) scheme, or a known redirector
//   unknown      5xx, DNS/network error, or anything we cannot judge.
//                THE DEFAULT ON DOUBT — a single network blip must never
//                promote a link to `dead`.
//
// Nothing here deletes or rewrites data. The validator reports; callers decide.
// =============================================================================

import { isIP } from 'node:net';
import { labelMatchesHost, publisherForHost } from './publisher-hosts.mjs';

export const STATUS = Object.freeze({
  VALID: 'valid',
  DEAD: 'dead',
  BLOCKED: 'blocked',
  RATE_LIMITED: 'rate_limited',
  HOMEPAGE: 'homepage',
  MISMATCH: 'mismatch',
  TIMEOUT: 'timeout',
  UNSAFE: 'unsafe',
  UNKNOWN: 'unknown',
  UNCHECKED: 'unchecked',
});

// Statuses a link may still be offered to the reader under. `blocked` is here
// on purpose: the page exists, our crawler just is not welcome. See the note
// in the STATUS block.
export const CLICKABLE_STATUSES = new Set([
  STATUS.VALID, STATUS.BLOCKED, STATUS.RATE_LIMITED, STATUS.UNKNOWN, STATUS.UNCHECKED,
]);

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_REDIRECTS = 5;
// Only the <head> and the first screenful of markup are needed for soft-404
// detection. Reading further is bandwidth spent to learn nothing, and an
// unbounded read is a memory risk on a page that streams megabytes.
const DEFAULT_MAX_BYTES = 96 * 1024;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// --- redirectors and trackers -------------------------------------------------
// These are never article URLs. Google's expire (97 rows in this DB proved it);
// Bing's apiclick is a click tracker; news.google.com is a JS reader page.
const REDIRECTOR_PATTERNS = [
  /vertexaisearch\.cloud\.google\.com/i,
  /grounding-api-redirect/i,
  /news\.google\.com/i,
  /bing\.com\/news\/apiclick/i,
  /\/url\?(?:.*&)?(?:q|url)=/i,          // google.com/url?q=... redirector
  /googleusercontent\.com/i,
  /doubleclick\.net/i,
  /googleadservices\.com/i,
];

const REDIRECTOR_HOSTS = new Set([
  'vertexaisearch.cloud.google.com',
  'news.google.com',
  'www.bing.com',
  'bing.com',
  'r.search.yahoo.com',
  't.co',
  'lnkd.in',
]);

// --- SSRF ---------------------------------------------------------------------
// Hostnames that must never be fetched, plus the IP ranges behind them. The
// literal-IP checks matter because an attacker-supplied (or model-hallucinated)
// URL can name an address directly and skip any name-based block list.
const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata', 'metadata.google.internal', 'metadata.goog',
  'instance-data', 'instance-data.ec2.internal',
]);

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain'];

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;                          // 0.0.0.0/8 "this network"
  if (a === 10) return true;                         // private
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local + AWS/GCP metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;  // private
  if (a === 192 && b === 168) return true;           // private
  if (a === 192 && b === 0) return true;             // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true;                         // multicast + reserved + broadcast
  return false;
}

function isPrivateIPv6(ip) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::1' || s === '::') return true;                    // loopback / unspecified
  if (s.startsWith('fe80')) return true;                         // link-local
  if (/^f[cd]/.test(s)) return true;                             // unique-local fc00::/7
  if (s.startsWith('ff')) return true;                           // multicast
  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible — judge the embedded v4.
  const v4 = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) return isPrivateIPv4(v4[1]);
  return false;
}

// Is this hostname unsafe to fetch? Name-based checks plus literal IPs.
//
// NOTE ON SCOPE: this blocks hostnames that ARE addresses or obviously-internal
// names. It does not resolve DNS, so a public name pointing at 127.0.0.1 (DNS
// rebinding) is not caught here — that needs a resolve-then-pin fetch agent and
// is out of scope for a news-link checker whose inputs are publisher domains.
// Documented rather than silently assumed safe.
export function isUnsafeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (BLOCKED_HOST_SUFFIXES.some(sfx => h.endsWith(sfx))) return true;
  const kind = isIP(h);
  if (kind === 4) return isPrivateIPv4(h);
  if (kind === 6) return isPrivateIPv6(h);
  // Bracketed IPv6 arrives with brackets already stripped above; a name that
  // still looks like an IPv6 literal is judged too.
  if (h.includes(':')) return isPrivateIPv6(h);
  return false;
}

// --- homepage / article-path shape --------------------------------------------

// Path segments that mark a site root or a section index rather than one story.
const SECTION_ONLY = new Set([
  '', 'th', 'en', 'home', 'index', 'index.html', 'index.php', 'main',
  'news', 'ข่าว', 'category', 'categories', 'tag', 'tags', 'topic', 'topics',
  'search', 'archive', 'archives', 'latest', 'all', 'rss', 'feed', 'amp',
  'business', 'economy', 'economic', 'finance', 'stock', 'stocks',
  'newsroom', 'press-releases', 'press', 'pr', 'blog', 'article', 'articles',
]);

// Does the path identify ONE article? An article URL carries something
// story-specific: a numeric id, a date, a slug of several words, or a long
// percent-encoded Thai slug.
function looksLikeArticlePath(pathname, search) {
  // Checked FIRST, before any path reasoning: some CMSes carry the whole
  // article identity in the query and leave the path a bare section
  // ("/news?newsid=884412"). Judging the path alone calls that a section index.
  if (search && /(?:^|[?&])(?:id|newsid|news_id|p|aid|articleid)=\d{3,}/i.test(search)) return true;

  const segs = decodeURIComponent(pathname || '/').split('/').filter(Boolean);
  if (!segs.length) return false;

  const last = segs[segs.length - 1].toLowerCase();
  const prev = segs.length > 1 ? segs[segs.length - 2].toLowerCase() : '';
  const meaningful = segs.filter(s => !SECTION_ONLY.has(s.toLowerCase()));
  if (!meaningful.length) return false;

  // A listing marker beats every id rule below. "/en/news/tag/AP-8281/2" is a
  // paginated TAG index, and the "8281" in the tag name would otherwise read as
  // an article id. A marker only disqualifies the URL when nothing after it
  // looks like an article, so "/category/business/2026/08/03/some-slug" — a
  // real article filed under a category — still passes.
  const LISTING = new Set(['tag', 'tags', 'topic', 'topics', 'category', 'categories',
                           'search', 'author', 'page', 'archive', 'archives']);
  const markerAt = segs.findIndex(s => LISTING.has(s.toLowerCase()));
  if (markerAt >= 0) {
    const after = segs.slice(markerAt + 1);
    const articleAfterMarker =
      /\/\d{4}\/\d{1,2}\/\d{1,2}\//.test('/' + after.join('/') + '/') ||
      after.some(s => s.split(/[-_]/).filter(Boolean).length >= 3) ||
      after.some(s => /\d{6,}/.test(s));
    // A trailing bare number is a page cursor, never an article.
    const paginated = /^\d{1,4}$/.test(last);
    if (!articleAfterMarker || paginated) return false;
  }

  // A run of 4+ digits anywhere in a segment is an article id. Matching the
  // RUN rather than the whole segment is what catches the separator styles
  // publishers actually use: "news_10339948" (Khaosod, INN) and "news-478394"
  // as well as a bare "1234567".
  if (segs.some(s => /\d{4,}/.test(s))) return true;

  // A date path: /2026/08/03/...
  if (/\/\d{4}\/\d{1,2}\/\d{1,2}\//.test('/' + segs.join('/') + '/')) return true;

  // A slug: three or more separator-joined parts. Script-agnostic on purpose —
  // an earlier `[a-z฀-๿]` version rejected AssetWise's own
  // "/news/𝐀𝐬𝐬𝐞𝐭𝐖𝐢𝐬𝐞-𝐢𝐧-𝐅𝐨𝐜𝐮𝐬/" because the publisher typeset the slug in
  // mathematical-bold Unicode.
  if (last.split(/[-_]/).filter(Boolean).length >= 3) return true;
  if (/[-_]\d{3,}$/.test(last)) return true;

  // Opaque per-article ids. Two shapes seen in this feed:
  //   MSN       /th-th/money/general/<thai-slug>/ar-AA28LXoK
  //   LINE Today /th/v2/article/LPR0w3L
  // Both are short, meaningless strings that no rule above can match, and both
  // ARE the article. Anchored to an id-bearing parent segment, or to a mixed
  // letter+digit token, so an ordinary section word ("business") never matches.
  if (/^ar-[a-z0-9]{6,}$/i.test(last)) return true;
  if (['article', 'articles', 'story', 'detail', 'view', 'post', 'p', 'a', 'ar', 'content']
        .includes(prev) && last.length >= 5) return true;
  if (last.length >= 6 && last.length <= 24 && /^[a-z0-9]+$/i.test(last)
      && /[a-z]/i.test(last) && /\d/.test(last)) return true;

  // Thai slugs survive decodeURIComponent above; a long Thai last segment is
  // a headline slug, not a section name.
  if (/[฀-๿]/.test(last) && last.length >= 12) return true;

  return false;
}

// Public: is this a site root or a section index (no single-article path)?
export function isHomepageLike(url) {
  try {
    const u = new URL(String(url));
    return !looksLikeArticlePath(u.pathname, u.search);
  } catch { return false; }
}

// --- offline classification ---------------------------------------------------

/**
 * Pure, network-free verdict. Returns { status, reason, host } — status is
 * null when nothing offline disqualifies the URL and an HTTP check is needed.
 */
export function classifyUrlOffline(rawUrl, { sourceLabel = null } = {}) {
  const s = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!s) return { status: STATUS.UNCHECKED, reason: 'empty url', host: null };

  let u;
  try { u = new URL(s); } catch {
    return { status: STATUS.UNSAFE, reason: 'unparseable url', host: null };
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { status: STATUS.UNSAFE, reason: `scheme ${u.protocol} not allowed`, host: u.hostname };
  }
  // Credentials in the URL are an exfiltration/phishing shape, never a news link.
  if (u.username || u.password) {
    return { status: STATUS.UNSAFE, reason: 'url carries credentials', host: u.hostname };
  }
  if (isUnsafeHost(u.hostname)) {
    return { status: STATUS.UNSAFE, reason: `blocked host ${u.hostname}`, host: u.hostname };
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (REDIRECTOR_HOSTS.has(u.hostname.toLowerCase()) || REDIRECTOR_HOSTS.has(host)) {
    return { status: STATUS.UNSAFE, reason: `redirector host ${host}`, host };
  }
  if (REDIRECTOR_PATTERNS.some(re => re.test(s))) {
    return { status: STATUS.UNSAFE, reason: 'redirector/tracker url', host };
  }
  if (!looksLikeArticlePath(u.pathname, u.search)) {
    return { status: STATUS.HOMEPAGE, reason: 'no article path', host };
  }
  if (sourceLabel) {
    const rel = labelMatchesHost(sourceLabel, u.hostname);
    if (rel === 'mismatch') {
      return {
        status: STATUS.MISMATCH,
        reason: `label "${sourceLabel}" does not match ${host} (${publisherForHost(host) || 'unknown publisher'})`,
        host,
      };
    }
  }
  return { status: null, reason: null, host };
}

// --- soft-404 -----------------------------------------------------------------

// Phrases that mean "this page is not the article". Kept tight on purpose: a
// business story can legitimately contain the digits "404", and Thai news about
// errors can contain "ไม่พบ". Matching is therefore anchored to the TITLE and
// the first heading, never to free body text.
const NOT_FOUND_PHRASES = [
  'page not found', 'not found', '404 error', 'error 404', '404 not found',
  'page cannot be found', "page doesn't exist", 'page does not exist',
  'no longer available', 'content unavailable', 'page removed',
  'ไม่พบหน้าที่ต้องการ', 'ไม่พบหน้าเว็บ', 'ไม่พบข้อมูล', 'ไม่พบบทความ',
  'ขออภัย ไม่พบ', 'หน้าที่คุณค้นหาไม่พบ', 'ไม่พบหน้านี้',
];

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Decide whether a 2xx response is really a "not found" page dressed as 200.
 * Looks ONLY at bounded, high-signal fields — final URL, <title>, og:title,
 * and the first <h1>. Returns { soft404, reason }.
 */
export function detectSoft404(html, finalUrl) {
  const head = String(html || '').slice(0, DEFAULT_MAX_BYTES);

  const title = stripTags((head.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i) || [])[1] || '');
  const ogTitle = (head.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']{0,300})["']/i) || [])[1]
    || (head.match(/<meta[^>]+content=["']([^"']{0,300})["'][^>]+property=["']og:title["']/i) || [])[1]
    || '';
  const h1 = stripTags((head.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i) || [])[1] || '');

  const fields = [title, ogTitle, h1].map(f => f.toLowerCase()).filter(Boolean);
  for (const f of fields) {
    for (const p of NOT_FOUND_PHRASES) {
      if (f.includes(p.toLowerCase())) return { soft404: true, reason: `not-found phrase in title/heading: "${p}"` };
    }
  }

  // A publisher that redirects a dead article to its own root or an /error path
  // returns 200 on a page that is not the story.
  try {
    const fu = new URL(String(finalUrl || ''));
    if (/^\/(404|error|not-?found)(\/|$)/i.test(fu.pathname)) {
      return { soft404: true, reason: `redirected to ${fu.pathname}` };
    }
    if (!looksLikeArticlePath(fu.pathname, fu.search)) {
      return { soft404: true, reason: 'redirected to a non-article path' };
    }
  } catch { /* no usable final url — fall through */ }

  return { soft404: false, reason: null };
}

// --- bounded fetch ------------------------------------------------------------

// Read at most `maxBytes` of the body, then abort. Avoids pulling a whole
// article (or a streaming page) to read its <title>.
async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total >= maxBytes) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return Buffer.concat(chunks.map(Buffer.from)).slice(0, maxBytes).toString('utf8');
}

/**
 * Full check: offline verdict, then one bounded HTTP request following at most
 * maxRedirects hops, re-validating the host at EVERY hop (a publisher redirect
 * into a private address must not be followed).
 *
 * @returns {Promise<{status, reason, httpStatus, finalUrl, host, redirects}>}
 */
export async function validateUrl(rawUrl, {
  sourceLabel = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  maxBytes = DEFAULT_MAX_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const offline = classifyUrlOffline(rawUrl, { sourceLabel });
  const base = { httpStatus: null, finalUrl: null, host: offline.host, redirects: 0 };
  if (offline.status) return { ...base, status: offline.status, reason: offline.reason };

  let current = String(rawUrl).trim();
  let redirects = 0;

  for (;;) {
    let res;
    try {
      res = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',            // hop by hop, so each Location is checked
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = e?.name || '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { ...base, status: STATUS.TIMEOUT, reason: `no response in ${timeoutMs}ms`, finalUrl: current, redirects };
      }
      // DNS failure, TLS error, connection reset. NOT dead — a transient
      // network fault must never be recorded as a removed article.
      return { ...base, status: STATUS.UNKNOWN, reason: `network error: ${String(e?.message || e).slice(0, 120)}`, finalUrl: current, redirects };
    }

    const code = res.status;

    if (code >= 300 && code < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { ...base, status: STATUS.UNKNOWN, reason: `${code} without Location`, httpStatus: code, finalUrl: current, redirects };
      if (redirects >= maxRedirects) {
        return { ...base, status: STATUS.UNKNOWN, reason: `exceeded ${maxRedirects} redirects`, httpStatus: code, finalUrl: current, redirects };
      }
      let next;
      try { next = new URL(loc, current).toString(); } catch {
        return { ...base, status: STATUS.UNKNOWN, reason: 'unparseable Location', httpStatus: code, finalUrl: current, redirects };
      }
      // Re-run the offline gate on the hop target: scheme, SSRF and redirector
      // checks all apply again. A 302 into http://169.254.169.254/ is the whole
      // reason this loop is manual instead of redirect:'follow'.
      const hop = classifyUrlOffline(next, {});
      if (hop.status === STATUS.UNSAFE) {
        return { ...base, status: STATUS.UNSAFE, reason: `redirect to unsafe target: ${hop.reason}`, httpStatus: code, finalUrl: next, redirects: redirects + 1 };
      }
      current = next;
      redirects++;
      continue;
    }

    if (code === 404 || code === 410) {
      return { ...base, status: STATUS.DEAD, reason: `HTTP ${code}`, httpStatus: code, finalUrl: current, redirects };
    }
    if (code === 401 || code === 403) {
      // The site refuses automated clients. Says nothing about the article.
      return { ...base, status: STATUS.BLOCKED, reason: `HTTP ${code} (bot block; not proof the page is gone)`, httpStatus: code, finalUrl: current, redirects };
    }
    if (code === 429) {
      return { ...base, status: STATUS.RATE_LIMITED, reason: 'HTTP 429', httpStatus: code, finalUrl: current, redirects };
    }
    if (code >= 500) {
      return { ...base, status: STATUS.UNKNOWN, reason: `HTTP ${code} (server error, retry later)`, httpStatus: code, finalUrl: current, redirects };
    }
    if (code < 200 || code >= 300) {
      return { ...base, status: STATUS.UNKNOWN, reason: `HTTP ${code}`, httpStatus: code, finalUrl: current, redirects };
    }

    // 2xx — is the page actually the article?
    const finalUrl = res.url || current;
    const finalHost = (() => { try { return new URL(finalUrl).hostname.toLowerCase().replace(/^www\./, ''); } catch { return offline.host; } })();

    let html = '';
    try { html = await readCapped(res, maxBytes); } catch { /* body unreadable — judge on url alone */ }

    const soft = detectSoft404(html, finalUrl);
    if (soft.soft404) {
      // Landing on a site root after a redirect is the classic "article gone,
      // bounced to home" shape. Report it as homepage rather than dead when the
      // status line itself was fine — the distinction matters to the operator.
      const st = isHomepageLike(finalUrl) ? STATUS.HOMEPAGE : STATUS.DEAD;
      return { ...base, status: st, reason: `soft-404: ${soft.reason}`, httpStatus: code, finalUrl, host: finalHost, redirects };
    }

    if (sourceLabel) {
      const rel = labelMatchesHost(sourceLabel, finalHost);
      if (rel === 'mismatch') {
        return {
          ...base, status: STATUS.MISMATCH,
          reason: `after redirect, label "${sourceLabel}" does not match ${finalHost}`,
          httpStatus: code, finalUrl, host: finalHost, redirects,
        };
      }
    }

    return { ...base, status: STATUS.VALID, reason: null, httpStatus: code, finalUrl, host: finalHost, redirects };
  }
}

// --- per-run cache + concurrency ----------------------------------------------

/**
 * A validator with a memo, so one cron batch never checks the same URL twice.
 * Scope it to a single run and let it fall out of scope — this is deliberately
 * NOT a long-lived cache, because link health changes over time.
 */
export function createValidationCache(opts = {}) {
  const memo = new Map();
  return {
    async validate(url, perCall = {}) {
      // sourceLabel participates in the key: the same URL under two different
      // labels can legitimately differ on the mismatch verdict.
      const key = `${url} ${perCall.sourceLabel || ''}`;
      if (memo.has(key)) return memo.get(key);
      const p = validateUrl(url, { ...opts, ...perCall });
      memo.set(key, p);
      return p;
    },
    get size() { return memo.size; },
  };
}

/** Run `fn` over `items` with at most `limit` in flight, results in input order. */
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
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length || 1)) }, worker));
  return out;
}

export default {
  STATUS, CLICKABLE_STATUSES, validateUrl, classifyUrlOffline,
  isHomepageLike, isUnsafeHost, detectSoft404, createValidationCache, mapLimit,
};
