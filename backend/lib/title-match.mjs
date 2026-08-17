// =============================================================================
// Does the page at this URL actually carry THIS headline?
//
// The audit found ~350 rows where the link opens fine (HTTP 200, real article
// path, right publisher) but the page is a DIFFERENT story — a ครม. headline
// pointing at a ก.ล.ต. article, or at a Nissan one. No status-code or
// path-shape check can see that; only comparing the headline to the page's own
// title can.
//
// THREE THINGS MAKE THIS HARDER THAN A STRING COMPARE
//
//   1. Thai has no inter-word spaces. Token overlap — the usual approach, and
//      the one news-rss-helpers.mjs uses — degenerates: a whole Thai clause
//      becomes one "token" and two headlines about the same event share
//      nothing. Similarity here is therefore character n-gram based (Dice over
//      character bigrams), which needs no word boundaries at all.
//
//   2. Publishers rewrite headlines. The stored headline came from Gemini or
//      an RSS summary and the page's <title> is the outlet's own wording, plus
//      a " - ชื่อเว็บ" suffix. Two texts describing one event routinely share
//      only 40% of their characters, so a naive threshold flags real matches.
//      Entities and numbers carry the signal: ASW, กนง., 0.01%, 7 ล้าน, 2570.
//
//   3. Some pages have no usable title at all. MSN returns "MSN"; many Thai
//      sites return only the site name. That is NOT evidence the link is
//      wrong, and calling it a mismatch would strip working links. It gets its
//      own verdict — `unknown` — which never hides a link automatically.
//
// The output is deliberately three-way (plus unknown) rather than a boolean,
// because the actions differ: high → safe to hide the link, medium → a human
// looks, unknown → leave it alone.
// =============================================================================

import { HOST_ALIASES } from './publisher-hosts.mjs';

const THAI = '฀-๿';

// --- page title extraction ----------------------------------------------------

// Only the head matters; callers pass a bounded slice anyway.
const attr = (tag, name) => {
  const re = new RegExp(`<meta[^>]+${name}=["']([^"']{1,400})["'][^>]*>`, 'i');
  const m = tag.match(re);
  return m ? m[1] : null;
};

function metaContent(html, key) {
  // Both attribute orders occur in the wild:
  //   <meta property="og:title" content="...">
  //   <meta content="..." property="og:title">
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']{1,400})["']`, 'i'));
  if (a) return a[1];
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']{1,400})["'][^>]*(?:property|name)=["']${key}["']`, 'i'));
  return b ? b[1] : null;
}

// JSON-LD headline. Publishers nest NewsArticle inside @graph or an array, so
// walk the parsed object rather than regexing for "headline".
function jsonLdHeadline(html) {
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const body = b.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    let parsed;
    try { parsed = JSON.parse(body); } catch { continue; }
    const found = walkForHeadline(parsed, 0);
    if (found) return found;
  }
  return null;
}

function walkForHeadline(node, depth) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = walkForHeadline(n, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof node !== 'object') return null;
  if (typeof node.headline === 'string' && node.headline.trim()) return node.headline.trim();
  if (typeof node.name === 'string' && /Article|NewsArticle|BlogPosting/i.test(String(node['@type'] || ''))) {
    return node.name.trim();
  }
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement']) {
    if (node[k]) { const r = walkForHeadline(node[k], depth + 1); if (r) return r; }
  }
  return null;
}

const decodeEntities = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch { return ' '; } });

const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Best available title for the page, and where it came from.
 * Order is by reliability: the OpenGraph/Twitter/JSON-LD fields are authored
 * for the article, while <title> often carries site branding and <h1> is
 * sometimes a section label.
 *
 * @returns {{title: string|null, source: string|null}}
 */
export function extractPageTitle(html) {
  const head = String(html || '').slice(0, 200_000);
  const candidates = [
    ['og:title', metaContent(head, 'og:title')],
    ['twitter:title', metaContent(head, 'twitter:title')],
    ['json-ld', jsonLdHeadline(head)],
    ['title', (head.match(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i) || [])[1]],
    ['h1', (head.match(/<h1[^>]*>([\s\S]{0,400}?)<\/h1>/i) || [])[1]],
  ];
  for (const [source, raw] of candidates) {
    const t = stripTags(raw);
    if (t) return { title: t, source };
  }
  return { title: null, source: null };
}

// --- generic / site-name titles -----------------------------------------------

// Titles that identify the SITE rather than a story. Matching is on the whole
// (trimmed) title, never a substring, so "MSN" is caught but a headline that
// happens to contain "msn" is not.
// Publisher display names, imported so a title that is ONLY the outlet's name
// is recognised as uninformative for ANY outlet we know, not just the handful
// hard-coded below.
const PUBLISHER_NAMES = new Set(
  Object.values(HOST_ALIASES).flat().map(a => a.toLowerCase()));

const GENERIC_EXACT = new Set([
  'msn', 'msn.com', 'home', 'homepage', 'หน้าแรก', 'news', 'ข่าว',
  'untitled', 'document', 'loading', 'กำลังโหลด', 'redirecting',
]);

// Strip the publisher suffix publishers append: "หัวข่าว - ฐานเศรษฐกิจ",
// "headline | Bangkok Post". Only the LAST segment, and only when it is short
// enough to be a site name rather than part of the headline.
export function stripSiteSuffix(title) {
  // Drop a dangling separator first: "บ้านเมือง -" is the site name with an
  // empty suffix, and without this it survives as a 10-character "headline"
  // and gets compared against the real one.
  const t = String(title || '').trim().replace(/[\s|｜\-–—:]+$/, '').replace(/^[\s|｜\-–—:]+/, '');
  // The separator must be SPACED (" - ", " — ") or a pipe. An unspaced hyphen
  // is compound-word punctuation, not a suffix boundary: Thai headlines are
  // full of them ("ลดค่าโอน-จดจำนอง", "แนวราบ-คอนโด") and cutting there removes
  // half the headline — including, in the real case that caught this, the
  // percentage and the deadline year that identify the story.
  const m = t.match(/^(.*?)(?:\s+[\-–—]\s+|\s*[|｜]\s*)([^|｜]{2,40})$/);
  if (!m) return t;
  // Keep the suffix if what remains is too short to be a headline — that means
  // we cut in the wrong place (e.g. a headline that is itself hyphenated).
  return m[1].trim().length >= 8 ? m[1].trim() : t;
}

/**
 * Is this title uninformative — the site's name, a placeholder, or nothing
 * left after the suffix strip? Such a page tells us nothing either way.
 */
export function isGenericTitle(title, host = '') {
  const t = String(title || '').trim();
  if (!t) return true;
  const stripped = stripSiteSuffix(t);
  const low = t.toLowerCase();
  const lowStripped = stripped.toLowerCase();
  if (GENERIC_EXACT.has(low) || GENERIC_EXACT.has(lowStripped)) return true;
  // "bangkokbiznews" / "Bangkok Biz News" as the entire title.
  const hostWord = String(host || '').toLowerCase().replace(/^www\./, '').split('.')[0];
  if (hostWord && low.replace(/[^a-z0-9]/g, '') === hostWord.replace(/[^a-z0-9]/g, '')) return true;
  // The entire title is a publisher's name ("บ้านเมือง", "Bangkok Post"),
  // possibly with a dangling separator the strip above removed.
  if (PUBLISHER_NAMES.has(low) || PUBLISHER_NAMES.has(lowStripped)) return true;
  // Nothing survives the suffix strip → the title was only branding.
  if (!stripSiteSuffix(t)) return true;
  // Very short non-Thai titles carry no story ("MSN", "SET", "Home").
  if (t.length <= 4 && !new RegExp(`[${THAI}]`).test(t)) return true;
  return false;
}

// --- similarity ----------------------------------------------------------------

// Normalize for comparison: lowercase, drop ASCII punctuation and spacing,
// keep Thai and alphanumerics. Whitespace is REMOVED rather than used as a
// separator — the whole point is not to depend on word boundaries Thai lacks.
export function normalizeForCompare(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[​﻿]/g, '')
    .replace(new RegExp(`[^a-z0-9${THAI}]`, 'g'), '');
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/**
 * Sørensen–Dice over character bigrams: 0..1, and language-agnostic because it
 * never asks where a word starts.
 */
export function diceSimilarity(a, b) {
  const A = normalizeForCompare(a), B = normalizeForCompare(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length < 2 || B.length < 2) return A === B ? 1 : 0;
  const ga = bigrams(A), gb = bigrams(B);
  let shared = 0, total = 0;
  for (const [g, n] of ga) { total += n; if (gb.has(g)) shared += Math.min(n, gb.get(g)); }
  for (const [, n] of gb) total += n;
  return (2 * shared) / total;
}

/** Longest run of characters common to both, relative to the shorter string.
 *  Catches the case where a page title CONTAINS the headline verbatim. */
function containmentScore(a, b) {
  const A = normalizeForCompare(a), B = normalizeForCompare(b);
  if (!A || !B) return 0;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  if (long.includes(short)) return 1;
  // Longest common substring, capped so this stays cheap on long titles.
  const s = short.slice(0, 300), l = long.slice(0, 600);
  let best = 0;
  let prev = new Array(l.length + 1).fill(0);
  for (let i = 1; i <= s.length; i++) {
    const cur = new Array(l.length + 1).fill(0);
    for (let j = 1; j <= l.length; j++) {
      if (s[i - 1] === l[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    }
    prev = cur;
  }
  return best / short.length;
}

// --- entities and numbers -------------------------------------------------------

// Organisations, agencies and tickers whose presence in BOTH texts is strong
// evidence they discuss the same thing — and whose presence in only one is
// strong evidence they do not.
const ENTITY_PATTERNS = [
  /ครม\.?|คณะรัฐมนตรี/g, /กนง\.?/g, /ธปท\.?|ธนาคารแห่งประเทศไทย/g,
  /ก\.ล\.ต\.?/g, /ธอส\.?/g, /กรมที่ดิน/g, /ราชกิจจา\w*/g, /สศช\.?|สภาพัฒน์/g,
  /REIC|ศูนย์ข้อมูลอสังหาริมทรัพย์/gi, /BOI/g, /Fed|เฟด/g, /BOJ/g, /ECB/g,
  /\bASW\b|AssetWise|แอสเซทไวส์/gi, /\bSPALI\b|ศุภาลัย/gi, /\bAP\b|เอพี/g,
  /\bLH\b|แลนด์แอนด์เฮ้าส์/gi, /\bSIRI\b|แสนสิริ/gi, /\bORI\b|ออริจิ้น/gi,
  /\bNOBLE\b|โนเบิล/gi, /\bANAN\b|อนันดา/gi, /\bQH\b|ควอลิตี้/gi, /\bSC\b/g,
  /\bTRIS\b|ทริส/gi, /\bLTV\b/gi, /\bGDP\b/gi, /\bCPI\b/gi, /\bSET\b/g,
];

/** Canonical entity keys present in a text. */
export function entitiesIn(text) {
  const t = String(text || '');
  const found = new Set();
  for (const re of ENTITY_PATTERNS) {
    re.lastIndex = 0;
    const m = t.match(re);
    if (m) found.add(re.source);          // the pattern IS the canonical key
  }
  return found;
}

/**
 * Numbers that identify a story: rates, percentages, amounts, years. Buddhist
 * and Common Era are folded together, and the short Thai year form ("ปี 70")
 * is expanded, so "ถึงกลางปี 70" and "ถึงกลางปี 2570" produce the same key.
 */
export function numbersIn(text) {
  const t = String(text || '');
  const out = new Set();

  // Percentages and rates: 0.01%, 1.00%, 5.45-5.95%
  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) out.add('pct:' + m[1].replace(',', '.'));

  // Years: 2569 / 2570 (BE) and 69 / 70 (short BE) → one CE key.
  for (const m of t.matchAll(/\b(25[0-9]{2})\b/g)) out.add('yr:' + (parseInt(m[1], 10) - 543));
  for (const m of t.matchAll(/ปี\s*(\d{2})\b/g)) {
    const be = 2500 + parseInt(m[1], 10);
    out.add('yr:' + (be - 543));
  }
  for (const m of t.matchAll(/\b(20[0-9]{2})\b/g)) out.add('yr:' + m[1]);

  // Money with a Thai magnitude word. Normalised to millions so
  // "7 ล้าน" and "7 ล้านบาท" collapse, and "2 หมื่นล้าน" is distinguishable.
  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?)\s*(หมื่นล้าน|พันล้าน|ล้าน|แสน|หมื่น|พัน)/g)) {
    const mult = { 'หมื่นล้าน': 1e4, 'พันล้าน': 1e3, 'ล้าน': 1, 'แสน': 0.1, 'หมื่น': 0.01, 'พัน': 0.001 }[m[2]];
    out.add('amt:' + Math.round(parseFloat(m[1].replace(',', '')) * mult * 1000) / 1000);
  }

  // Bare large numbers (article ids excluded by requiring a separator or unit).
  for (const m of t.matchAll(/\b(\d{1,3}(?:,\d{3})+)\b/g)) out.add('num:' + m[1].replace(/,/g, ''));

  return out;
}

const inter = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

// --- verdict --------------------------------------------------------------------

export const TITLE_VERDICT = Object.freeze({
  MATCH: 'match',
  MISMATCH_HIGH: 'title_mismatch_high',
  MISMATCH_MEDIUM: 'title_mismatch_medium',
  UNKNOWN: 'title_unknown',
});

/**
 * Compare a stored headline against the page's own title.
 *
 * @param headline  the headline stored in news_feed
 * @param pageTitle the title extracted from the page (already suffix-stripped
 *                  by the caller, or not — this strips again defensively)
 * @param opts.host hostname, used to recognise site-name-only titles
 * @returns {{verdict, score, reason, sharedEntities, sharedNumbers, pageTitle}}
 */
export function compareHeadlineToTitle(headline, pageTitle, { host = '' } = {}) {
  const h = String(headline || '').trim();
  const rawT = String(pageTitle || '').trim();

  if (!h || !rawT) {
    return { verdict: TITLE_VERDICT.UNKNOWN, score: 0, reason: 'no title to compare', sharedEntities: 0, sharedNumbers: 0, pageTitle: rawT || null };
  }
  if (isGenericTitle(rawT, host)) {
    // MSN and friends. Says nothing about the link — must not hide it.
    return { verdict: TITLE_VERDICT.UNKNOWN, score: 0, reason: `page title is generic ("${rawT.slice(0, 40)}")`, sharedEntities: 0, sharedNumbers: 0, pageTitle: rawT };
  }

  const t = stripSiteSuffix(rawT);
  // Our stored headline is NOT a page title and carries no publisher suffix,
  // so it must not be run through the suffix stripper. Doing so truncated
  // "ครม. ไฟเขียวลดค่าโอน-จดจำนอง 0.01% ถึงกลางปี 70" to
  // "ครม. ไฟเขียวลดค่าโอน", dropping both numbers and turning a correct link
  // into a reported mismatch.
  const hClean = h;

  const dice = diceSimilarity(hClean, t);
  const contain = containmentScore(hClean, t);
  const score = Math.max(dice, contain);

  const hEnt = entitiesIn(hClean), tEnt = entitiesIn(t);
  const hNum = numbersIn(hClean), tNum = numbersIn(t);
  const sharedEntities = inter(hEnt, tEnt);
  const sharedNumbers = inter(hNum, tNum);

  const base = { score: Math.round(score * 1000) / 1000, sharedEntities, sharedNumbers, pageTitle: rawT };

  // Strong textual overlap settles it regardless of entities.
  if (score >= 0.55) return { ...base, verdict: TITLE_VERDICT.MATCH, reason: `similarity ${base.score}` };

  // Publishers rewrite headlines heavily, so moderate overlap PLUS a shared
  // entity or a shared identifying number is a match. This is the branch that
  // keeps "ครม. ไฟเขียวลดค่าโอน 0.01%" matched to
  // "รัฐบาลอนุมัติมาตรการลดค่าธรรมเนียมโอน เหลือ 0.01% - ฐานเศรษฐกิจ".
  if (score >= 0.3 && (sharedEntities >= 1 || sharedNumbers >= 1)) {
    return { ...base, verdict: TITLE_VERDICT.MATCH, reason: `similarity ${base.score} with ${sharedEntities} entity/${sharedNumbers} number in common` };
  }

  // Nothing in common at all — no entity, no number, negligible text overlap.
  // This is the ครม.-headline-pointing-at-a-Nissan-article case.
  if (score < 0.15 && sharedEntities === 0 && sharedNumbers === 0) {
    return { ...base, verdict: TITLE_VERDICT.MISMATCH_HIGH, reason: `no shared entity, number or text (similarity ${base.score})` };
  }

  // Something matches but not enough to be sure either way. Reported, never
  // acted on automatically.
  return { ...base, verdict: TITLE_VERDICT.MISMATCH_MEDIUM, reason: `weak overlap (similarity ${base.score}, ${sharedEntities} entity/${sharedNumbers} number)` };
}

export default {
  extractPageTitle, compareHeadlineToTitle, isGenericTitle, stripSiteSuffix,
  diceSimilarity, entitiesIn, numbersIn, normalizeForCompare, TITLE_VERDICT,
};
