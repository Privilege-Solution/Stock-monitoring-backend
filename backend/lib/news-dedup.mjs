// =============================================================================
// Content-level duplicate detection for news_feed.
//
// The unique index on title_hash catches only EXACT normalized-headline
// repeats. Outlets word the same story differently, and the same outlet
// truncates its own headline at different lengths, so it lets near-duplicates
// straight through. Measured on production (546 rows since 2026-05-01): ~500
// near-duplicate pairs inside 48-hour windows. Real examples, all distinct
// title_hashes:
//
//   "เงินเฟ้อ ก.ค. 69 เพิ่ม 1.95% สูงขึ้น 4 เดือนติด แต่เริ่มชะลอ"      (ไทยพีบีเอส)
//   "เงินเฟ้อ ก.ค.69 เพิ่ม 1.95% สูงขึ้น 4 เดือนติด แต่เริ่มชะลอลง…"   (ไทยโพสต์)
//
//   "ASW ตุนยอดขายครึ่งปีแรก 11,847 ล้านบาท ทะลุ 64% ของเป้าพรีเซล…"
//   "'ASW'อวดยอดพรีเซลครึ่งปีแรก11,847ล้าน"
//
//   "แอสเซทไวส์ เปิดประตูสู่ชีวิตเอเชี่ยนสไตล์ ผ่านโครงการใหม่ Atmoz De Sol…"
//   "ASW เปิดประตูสู่ชีวิตเอเชี่ยนสไตล์ ผ่านโครงการใหม่ Atmoz De Sol…"
//
// APPROACH: character 3-gram similarity. Thai has no inter-word spacing, so
// word tokenization is unreliable and n-grams are the workable primitive; they
// also survive the Thai-vs-Latin company-name swap in the third example, since
// the rest of the headline is shared.
//
// Two measures, because they fail in opposite directions:
//   jaccard     — symmetric, but punishes the length mismatch that truncation
//                 creates (the ASW presale pair scores only 0.25)
//   containment — intersection over the SMALLER side, so a truncated headline
//                 contained in a fuller one scores ~1.0 regardless of length
//
// Containment alone is not safe: a very short headline can be incidentally
// contained in a longer unrelated one, so it is gated on a minimum length. And
// two headlines quoting DIFFERENT figures are almost always different stories,
// so disjoint numeric anchors veto a containment match.
//
// Thresholds were swept against production data. At (con>=0.75, jac>=0.55) the
// weakest-scoring flagged pairs were all genuine duplicates, and the strongest
// unflagged pairs — four outlets on the same ครม. transfer-fee resolution,
// clustered at con≈0.78 — are caught. Loosening further (con>=0.65) started
// matching unrelated SET filings that shared only boilerplate.
// =============================================================================

const NGRAM = 3;

// Default window. The user-facing requirement is 24-48h; 48 is the safe end
// because Thai outlets routinely republish the previous evening's story the
// next morning, and a story filed at 23:50 must still match one at 00:10.
export const DEDUP_WINDOW_HOURS = 48;

export const DEDUP_THRESHOLDS = {
  containment: 0.62,
  jaccard: 0.50,
  minShingleChars: 20,   // below this a containment match is not trustworthy
  // Two headlines "share their figures" when their number sets overlap at least
  // this much. Below it they are quoting different numbers and are treated as
  // different stories. See numbersConflict() for why a plain intersection test
  // is not enough.
  numberOverlap: 0.5,
};

// Strip everything that is not the story itself before comparing.
//
// The `DATE:[...] SOURCE:[...] SUMMARY:[...]` scaffolding appears verbatim in
// some stored titles where a parser kept the whole structured block. Two such
// rows share that boilerplate and score as similar while describing completely
// different events (a warrant exercise vs an AGM resolution) — the only false
// positive the threshold sweep produced. Removing the scaffolding removes it.
export function normalizeForDedup(s) {
  return String(s || '')
    .replace(/\b(?:DATE|SOURCE|SUMMARY|CATEGORY|IMPACT_LEVEL|HEADLINE|URL)\s*:\s*/gi, ' ')
    .replace(/\s+-\s+[^-฀-๿]+$/, '')   // trailing " - <Latin publisher>"
    .toLowerCase()
    .replace(/[()[\]{}"'`.,!?;:*–—\-_/\\|]/g, ' ')
    .replace(/\s+/g, '')                          // Thai has no word spacing
    .trim();
}

export function shingleSet(s, n = NGRAM) {
  const t = normalizeForDedup(s);
  const out = new Set();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Intersection over the smaller set — the measure that survives truncation.
export function containment(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  return inter / small.size;
}

// Figures quoted in a headline ("11,847", "1.95", "0.50"). Two headlines that
// each quote numbers but share none are almost certainly different stories —
// two different quarters' results, two different projects' values.
export function numericAnchors(s) {
  return new Set(
    [...String(s || '').matchAll(/\d[\d,]*(?:\.\d+)?/g)].map(m => m[0].replace(/,/g, ''))
  );
}

// Precompute once per item; comparing N new items against M recent rows is
// N*M comparisons and re-shingling inside the loop is the expensive part.
export function prepareForDedup(title) {
  return {
    shingles: shingleSet(title),
    numbers: numericAnchors(title),
    length: normalizeForDedup(title).length,
  };
}

// Do the two headlines quote materially DIFFERENT figures?
//
// "Do they share at least one number?" is too weak: a Thai headline carries the
// Buddhist year, so
//     "ASW รายงานผลประกอบการ Q1/69 รายได้ 2,162 ล้านบาท"   {1, 69, 2162}
//     "ASW รายงานผลประกอบการ Q2/69 รายได้ 3,410 ล้านบาท"   {2, 69, 3410}
// share "69" and would pass, despite being different quarters with different
// revenue — a false positive this module measurably produced.
//
// Overlap across the whole set separates them: 1/5 = 0.2 here, versus 0.5 for
// "11,847 / 64%" against "11,847" (a truncation of the same story).
export function numbersConflict(a, b, thresholds = DEDUP_THRESHOLDS) {
  if (!a.numbers.size || !b.numbers.size) return false;   // nothing to compare
  return jaccard(a.numbers, b.numbers) < thresholds.numberOverlap;
}

// Do these two prepared headlines describe the same story?
// Returns { duplicate, containment, jaccard, reason }.
export function comparePrepared(a, b, thresholds = DEDUP_THRESHOLDS) {
  const con = containment(a.shingles, b.shingles);
  const jac = jaccard(a.shingles, b.shingles);

  // The figure check vetoes BOTH paths. It originally guarded only the
  // containment path, which let two quarters' results through at jac=0.62 —
  // near-identical wording is exactly when the numbers are the only thing
  // distinguishing two stories, so that is the case where the veto matters most.
  if (numbersConflict(a, b, thresholds)) {
    return { duplicate: false, containment: con, jaccard: jac, reason: null };
  }

  if (jac >= thresholds.jaccard) {
    return { duplicate: true, containment: con, jaccard: jac, reason: 'jaccard' };
  }
  if (
    con >= thresholds.containment &&
    Math.min(a.length, b.length) >= thresholds.minShingleChars
  ) {
    return { duplicate: true, containment: con, jaccard: jac, reason: 'containment' };
  }
  return { duplicate: false, containment: con, jaccard: jac, reason: null };
}

// Convenience wrapper for raw strings (tests, one-off checks).
export function isDuplicateHeadline(titleA, titleB, thresholds = DEDUP_THRESHOLDS) {
  return comparePrepared(prepareForDedup(titleA), prepareForDedup(titleB), thresholds);
}

// Is `date` within the window of `otherDate`? Both are 'YYYY-MM-DD'; news_feed
// stores an ICT date, not a timestamp, so the comparison is day-granular.
export function withinWindow(dateA, dateB, hours = DEDUP_WINDOW_HOURS) {
  if (!dateA || !dateB) return false;
  const a = new Date(dateA + 'T00:00:00').getTime();
  const b = new Date(dateB + 'T00:00:00').getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= hours * 3600 * 1000;
}

// Find the first row in `candidates` that duplicates `item`.
// `item`      : { title, date }
// `candidates`: [{ id, title, date, prepared? }]
// Returns { match, score } or null.
export function findDuplicate(item, candidates, thresholds = DEDUP_THRESHOLDS) {
  if (!item || !item.title) return null;
  const prepared = item.prepared || prepareForDedup(item.title);
  for (const cand of candidates) {
    if (!cand || !cand.title) continue;
    if (!withinWindow(item.date, cand.date)) continue;
    const candPrepared = cand.prepared || prepareForDedup(cand.title);
    const score = comparePrepared(prepared, candPrepared, thresholds);
    if (score.duplicate) return { match: cand, score };
  }
  return null;
}
