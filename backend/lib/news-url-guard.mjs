// =============================================================================
// The single gate every ingestion path runs its rows through before writing.
//
// It answers two different questions that were previously conflated:
//
//   1. Is this URL fetchable and safe?          → url-validator.mjs
//   2. Does this URL belong to THIS story?      → here
//
// (2) is the one nothing checked. Measured on the live table: 106 URLs are
// bound to more than one distinct headline across 374 rows —
// `https://www.line.me/` labels 24 unrelated stories, and
// `https://aio.panphol.com/stock/ASW/dividend` labels 14. Two causes:
//
//   a. Fabricated homepages. resolveGroundedUrl() used to build
//      `https://www.<host>/` from a hostname. That is a constant per publisher,
//      so every story from that publisher collided onto one string. Fixed at
//      the source; this module is the backstop.
//   b. deepenHomepageUrl() searches Bing per headline and returns the best
//      match. When several stories fail to find their own article, they can all
//      land on the same "best" result — nothing told the second caller that the
//      URL was already spoken for.
//
// URL uniqueness ALONE is the wrong rule, and this module deliberately does not
// use it: legitimate duplicate coverage exists (an outlet's live-updated page,
// a story pulled twice by two pipelines). The test is semantic — the same URL
// may serve two rows only when the two headlines are actually the same story.
// =============================================================================

import { classifyUrlOffline, STATUS } from './url-validator.mjs';
import { labelMatchesHost, publisherForHost } from './publisher-hosts.mjs';

// Tokens shared between two headlines, ignoring the noise words Thai business
// copy repeats constantly. Latin/numeric tokens are the reliable signal —
// Thai has no inter-word spaces, so whole Thai phrases become one token.
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'ที่', 'และ', 'ของ',
  'ใน', 'เป็น', 'ให้', 'จาก', 'กับ', 'ไทย', 'ข่าว', 'หุ้น', 'บริษัท',
]);

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[()[\]{}"'`.,!?;:]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP.has(t));
}

/**
 * Are these two headlines plausibly the same story?
 *
 * Deliberately permissive — the caller uses this to decide whether sharing one
 * URL is defensible, and a false "different" merely costs a link, while a false
 * "same" reproduces the bug this module exists to stop. So the bar is real
 * overlap, not a coincidence of one shared word.
 */
export function sameStory(headlineA, headlineB) {
  const a = tokens(headlineA);
  const b = tokens(headlineB);
  if (!a.length || !b.length) return false;
  const setB = new Set(b);
  const shared = a.filter(t => setB.has(t)).length;
  // Jaccard-ish against the SHORTER headline, so a long headline and its
  // truncated twin still count as one story.
  const ratio = shared / Math.min(a.length, b.length);
  return ratio >= 0.6 && shared >= 2;
}

/**
 * Vet a batch of rows before they are written.
 *
 * Mutates nothing in place; returns a NEW array of rows plus a report. Each row
 * gains:
 *   source_url            — cleared when the link cannot be defended
 *   source_url_status     — one of url-validator's STATUS values
 *   source_url_validation_reason
 *   url_verified          — true only for a link that survived every check
 *
 * The ROW ITSELF IS NEVER DROPPED. A story with no defensible link is still a
 * story; the reader loses a click-through, not the news.
 *
 * @param rows  news_feed-shaped rows: { title, source_url, source_label, ... }
 * @param opts.seenUrls  Map<url, headline> of URLs already claimed. Pass the
 *                       same Map across a whole run to catch cross-pipeline
 *                       collisions; omit for a standalone batch.
 * @param opts.log       sink for human-readable rejections (default console.log)
 */
export function vetRowUrls(rows, { seenUrls = new Map(), tag = 'guard', log = console.log } = {}) {
  const report = {
    kept: 0, cleared: 0,
    byReason: { homepage: 0, unsafe: 0, mismatch: 0, collision: 0, empty: 0 },
  };

  const out = rows.map((row) => {
    const r = { ...row };
    const url = typeof r.source_url === 'string' ? r.source_url.trim() : '';

    if (!url) {
      report.byReason.empty++;
      return { ...r, source_url: '', url_verified: false, source_url_status: STATUS.UNCHECKED, source_url_validation_reason: 'no url supplied' };
    }

    // Offline gate: scheme, SSRF, redirectors/trackers, article-path shape, and
    // label/hostname agreement. No network — this runs on every row, always.
    const verdict = classifyUrlOffline(url, { sourceLabel: r.source_label });
    if (verdict.status && verdict.status !== STATUS.UNCHECKED) {
      const bucket = verdict.status === STATUS.HOMEPAGE ? 'homepage'
                   : verdict.status === STATUS.MISMATCH ? 'mismatch' : 'unsafe';
      report.byReason[bucket]++;
      report.cleared++;
      log(`[${tag}] url cleared (${verdict.status}): ${verdict.reason} — "${String(r.title).slice(0, 46)}"`);
      return { ...r, source_url: '', url_verified: false, source_url_status: verdict.status, source_url_validation_reason: verdict.reason };
    }

    // Collision: is this URL already carrying a DIFFERENT story?
    const claimedBy = seenUrls.get(url);
    if (claimedBy != null && !sameStory(claimedBy, r.title)) {
      report.byReason.collision++;
      report.cleared++;
      log(`[${tag}] url cleared (collision): already bound to "${String(claimedBy).slice(0, 40)}" — "${String(r.title).slice(0, 40)}"`);
      return {
        ...r, source_url: '', url_verified: false,
        source_url_status: STATUS.MISMATCH,
        source_url_validation_reason: `url already bound to a different headline: "${String(claimedBy).slice(0, 80)}"`,
      };
    }

    if (claimedBy == null) seenUrls.set(url, r.title);
    report.kept++;
    // Offline-clean is NOT proof the page exists — that needs a fetch, which the
    // audit script does out of band. Status stays 'unchecked' so nothing later
    // reads a promise we have not kept.
    return {
      ...r, source_url: url, url_verified: false,
      source_url_status: STATUS.UNCHECKED,
      source_url_validation_reason: 'passed offline checks; not fetched',
    };
  });

  const { homepage, unsafe, mismatch, collision } = report.byReason;
  if (report.cleared) {
    log(`[${tag}] ${report.cleared} url(s) cleared — homepage:${homepage} unsafe:${unsafe} mismatch:${mismatch} collision:${collision}. Rows kept, links dropped.`);
  }
  return { rows: out, report };
}

/**
 * Optional online pass: fetch each surviving URL once and record the verdict.
 * Separated from vetRowUrls so the cheap check can run unconditionally and the
 * expensive one only where the caller can afford the round trips.
 */
export async function verifyRowUrls(rows, { validator, concurrency = 4, tag = 'guard', log = console.log } = {}) {
  const { mapLimit } = await import('./url-validator.mjs');
  const targets = rows.filter(r => r.source_url);
  if (!targets.length) return rows;

  await mapLimit(targets, concurrency, async (r) => {
    const v = await validator.validate(r.source_url, { sourceLabel: r.source_label });
    r.source_url_status = v.status;
    r.source_url_http_status = v.httpStatus ?? null;
    r.source_url_final = v.finalUrl ?? null;
    r.source_url_validation_reason = v.reason ?? null;
    r.source_url_checked_at = new Date().toISOString();
    r.url_verified = v.status === STATUS.VALID;

    // Only statuses that PROVE the link is not the article clear it. `blocked`,
    // `rate_limited`, `timeout` and `unknown` all mean "we could not tell" —
    // treating those as dead would delete good links every time a publisher
    // rate-limits us or a DNS lookup hiccups.
    if ([STATUS.UNSAFE, STATUS.HOMEPAGE, STATUS.MISMATCH, STATUS.DEAD].includes(v.status)) {
      log(`[${tag}] url cleared after fetch (${v.status}): ${v.reason} — "${String(r.title).slice(0, 44)}"`);
      r.source_url = '';
      r.url_verified = false;
    }
  });
  return rows;
}

export default { vetRowUrls, verifyRowUrls, sameStory };
