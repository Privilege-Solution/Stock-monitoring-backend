// Headline ↔ page-title matching, canonicalization, and policy-event dedup.
//
// NO REAL NETWORK. The HTTP cases use a local node:http server; everything
// else is pure functions.
//
// The named cases below are REAL rows from news_feed, not invented ones —
// a ครม. headline pointing at a ก.ล.ต. article, one pointing at a Nissan
// article, a ฐานเศรษฐกิจ link that redirects to the site root, MSN answering
// with its own name, and the three cabinet rows that are one decision.
//
// Run:  npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  extractPageTitle, compareHeadlineToTitle, isGenericTitle, stripSiteSuffix,
  diceSimilarity, entitiesIn, numbersIn, TITLE_VERDICT,
} from '../title-match.mjs';
import { eventFingerprint, groupByEvent } from '../event-fingerprint.mjs';
import { STATUS, canonicalizeUrl, validateUrl, validateUrlWithRetry } from '../url-validator.mjs';

// --- title extraction ----------------------------------------------------------

test('prefers og:title over <title>', () => {
  const html = `<html><head>
    <title>หัวข้อจาก title - ฐานเศรษฐกิจ</title>
    <meta property="og:title" content="หัวข้อจาก og:title">
  </head><body><h1>หัวข้อจาก h1</h1></body></html>`;
  const r = extractPageTitle(html);
  assert.equal(r.title, 'หัวข้อจาก og:title');
  assert.equal(r.source, 'og:title');
});

test('reads og:title with the attributes in either order', () => {
  const html = `<html><head><meta content="สลับลำดับ attribute" property="og:title"></head></html>`;
  assert.equal(extractPageTitle(html).title, 'สลับลำดับ attribute');
});

test('falls back to twitter:title, then JSON-LD, then <title>, then h1', () => {
  assert.equal(extractPageTitle(
    `<meta name="twitter:title" content="จาก twitter"><title>จาก title</title>`).title, 'จาก twitter');
  assert.equal(extractPageTitle(
    `<script type="application/ld+json">{"@type":"NewsArticle","headline":"จาก ld"}</script><title>จาก title</title>`).title, 'จาก ld');
  assert.equal(extractPageTitle(`<title>จาก title</title><h1>จาก h1</h1>`).title, 'จาก title');
  assert.equal(extractPageTitle(`<h1>จาก h1</h1>`).title, 'จาก h1');
});

test('finds a JSON-LD headline nested inside @graph', () => {
  const html = `<script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"WebSite","name":"ฐานเศรษฐกิจ"},
      {"@type":"NewsArticle","headline":"ครม. ไฟเขียวลดค่าโอน 0.01%"}]}</script>`;
  assert.equal(extractPageTitle(html).title, 'ครม. ไฟเขียวลดค่าโอน 0.01%');
});

test('decodes HTML entities in the title', () => {
  assert.equal(extractPageTitle(`<title>ASW &amp; SPALI &quot;โต&quot;</title>`).title, 'ASW & SPALI "โต"');
});

// --- generic titles -------------------------------------------------------------

test('MSN answering with its own name is generic, not a mismatch', () => {
  assert.equal(isGenericTitle('MSN', 'msn.com'), true);
  const r = compareHeadlineToTitle('ASW เสนอขายหุ้นกู้ 920 ล้านบาท', 'MSN', { host: 'www.msn.com' });
  assert.equal(r.verdict, TITLE_VERDICT.UNKNOWN);
  assert.notEqual(r.verdict, TITLE_VERDICT.MISMATCH_HIGH);
});

test('a title that is only the publisher name is generic', () => {
  // "บ้านเมือง -" — a real page whose title is the outlet plus a dangling dash.
  for (const [t, h] of [['บ้านเมือง -', 'banmuang.co.th'], ['Bangkok Post', 'bangkokpost.com'],
                        ['ฐานเศรษฐกิจ', 'thansettakij.com'], ['หน้าแรก', 'siamrath.co.th']]) {
    assert.equal(isGenericTitle(t, h), true, t);
  }
});

test('a real headline is not generic', () => {
  assert.equal(isGenericTitle('ครม. ไฟเขียวลดค่าโอน-จดจำนอง 0.01% ถึงกลางปี 70', 'thansettakij.com'), false);
});

test('strips the publisher suffix but keeps a hyphenated headline', () => {
  assert.equal(stripSiteSuffix('ครม. ไฟเขียวลดค่าโอน 0.01% - ฐานเศรษฐกิจ'), 'ครม. ไฟเขียวลดค่าโอน 0.01%');
  assert.equal(stripSiteSuffix('ASW โชว์กำไร | Bangkok Post'), 'ASW โชว์กำไร');
  // Too short after the cut → the separator was part of the headline.
  assert.equal(stripSiteSuffix('ASW - แนะนำซื้อ'), 'ASW - แนะนำซื้อ');
});

// --- the real mispairings --------------------------------------------------------

test('ครม. headline pointing at a ก.ล.ต. article is a high mismatch', () => {
  const r = compareHeadlineToTitle(
    'ครม. ไฟเขียวขยายมาตรการลดค่าโอน-จดจำนอง 0.01% ถึงกลางปี 70',
    'ก.ล.ต. กล่าวโทษอดีตผู้บริหารบริษัทจดทะเบียน กรณีทุจริต - ข่าวหุ้น',
    { host: 'kaohoon.com' });
  assert.equal(r.verdict, TITLE_VERDICT.MISMATCH_HIGH);
});

test('ครม. headline pointing at a Nissan article is a high mismatch', () => {
  const r = compareHeadlineToTitle(
    'ครม. อนุมัติมาตรการกระตุ้นอสังหาริมทรัพย์',
    'Nissan ประกาศปิดโรงงานในไทย ย้ายฐานการผลิตไปญี่ปุ่น',
    { host: 'thansettakij.com' });
  assert.equal(r.verdict, TITLE_VERDICT.MISMATCH_HIGH);
});

test('a property headline pointing at a Mother\'s Day article is a high mismatch', () => {
  // Live row: ศุภาลัย earnings linked to a royal-announcement page.
  const r = compareHeadlineToTitle(
    'ศุภาลัยกำไร Q2/69 พุ่ง 36% เร่งเปิด 19 โครงการครึ่งปีหลัง',
    'สมเด็จพระบรมราชชนนีพันปีหลวง พระราชทานคำขวัญ วันแม่แห่งชาติ ประจำปี 2569',
    { host: 'siamrath.co.th' });
  assert.equal(r.verdict, TITLE_VERDICT.MISMATCH_HIGH);
});

test('the same story reworded by the publisher still matches', () => {
  // Different verb, different word order, publisher suffix — one story.
  const r = compareHeadlineToTitle(
    'ครม. ไฟเขียวลดค่าโอน-จดจำนอง 0.01% ถึงกลางปี 70',
    'รัฐบาลอนุมัติต่ออายุมาตรการลดค่าธรรมเนียมโอนและจดจำนอง เหลือ 0.01% ถึงกลางปี 2570 - ฐานเศรษฐกิจ',
    { host: 'thansettakij.com' });
  assert.equal(r.verdict, TITLE_VERDICT.MATCH, r.reason);
});

test('a shared ticker and number rescue a heavily reworded headline', () => {
  const r = compareHeadlineToTitle(
    'ASW เสนอขายหุ้นกู้ 2 ชุด ดอกเบี้ย 5.45-5.95%',
    'แอสเซทไวส์ เดินหน้าธุรกิจ เตรียมขายหุ้นกู้ ชูดอกเบี้ย 5.45-5.95% ต่อปี เปิดจอง 3-5 ก.ค. - มติชน',
    { host: 'matichon.co.th' });
  assert.equal(r.verdict, TITLE_VERDICT.MATCH, r.reason);
});

test('partial overlap lands in medium, not high', () => {
  const r = compareHeadlineToTitle(
    'กนง. คงดอกเบี้ยนโยบาย 1.00% ต่อปี',
    'ธปท. เผยภาวะเศรษฐกิจไทยเดือนกรกฎาคม ยังฟื้นตัวช้า',
    { host: 'bot.or.th' });
  assert.ok([TITLE_VERDICT.MISMATCH_MEDIUM, TITLE_VERDICT.MISMATCH_HIGH].includes(r.verdict));
});

// --- similarity primitives -------------------------------------------------------

test('dice similarity works on Thai without word boundaries', () => {
  assert.ok(diceSimilarity('ลดค่าโอนจดจำนอง', 'ลดค่าโอนจดจำนอง') === 1);
  assert.ok(diceSimilarity('ลดค่าโอน-จดจำนอง 0.01%', 'ลดค่าโอนและจดจำนอง 0.01%') > 0.6);
  assert.ok(diceSimilarity('ครม. อนุมัติงบประมาณ', 'Nissan ปิดโรงงาน') < 0.15);
});

test('entity and number extraction folds BE/CE years and Thai magnitudes', () => {
  assert.ok(numbersIn('ถึงกลางปี 70').has('yr:2027'));
  assert.ok(numbersIn('ถึงกลางปี 2570').has('yr:2027'));
  assert.ok(numbersIn('ลดเหลือ 0.01%').has('pct:0.01'));
  assert.ok(numbersIn('มูลค่า 7 ล้านบาท').has('amt:7'));
  assert.ok(entitiesIn('ครม. มีมติ').size > 0);
  assert.ok(entitiesIn('ASW รายงานกำไร').size > 0);
});

// --- canonicalization -------------------------------------------------------------

test('canonicalization strips fragment, tracking params and trailing slash', () => {
  assert.equal(canonicalizeUrl('https://WWW.Example.COM/news/123/#section'), 'https://www.example.com/news/123');
  assert.equal(canonicalizeUrl('https://a.co/news/1?utm_source=x&utm_medium=y&id=7'), 'https://a.co/news/1?id=7');
  assert.equal(canonicalizeUrl('https://a.co/news/1?fbclid=abc'), 'https://a.co/news/1');
  assert.equal(canonicalizeUrl('https://a.co:443/news/1'), 'https://a.co/news/1');
  assert.equal(canonicalizeUrl('https://a.co//news//1//'), 'https://a.co/news/1');
});

test('canonicalization sorts remaining params so order does not create a duplicate', () => {
  assert.equal(canonicalizeUrl('https://a.co/n?b=2&a=1'), canonicalizeUrl('https://a.co/n?a=1&b=2'));
});

test('canonicalization leaves the root path and does not invent https', () => {
  assert.equal(canonicalizeUrl('http://a.co/'), 'http://a.co/');
  assert.ok(canonicalizeUrl('http://a.co/news/1').startsWith('http://'));
});

test('canonicalization returns unparseable input unchanged', () => {
  assert.equal(canonicalizeUrl('not a url'), 'not a url');
  assert.equal(canonicalizeUrl(''), '');
});

// --- policy-event dedup ------------------------------------------------------------

test('one cabinet decision reported three ways shares a fingerprint', () => {
  const fps = [
    'รัฐต่ออายุลดค่าโอน-จดจำนอง และผ่อนคลาย LTV ถึงกลางปี 70',
    'รัฐขยายมาตรการลดค่าโอน-จดจำนองถึงกลางปี 70',
    'รัฐขยายมาตรการลดค่าโอน-จำนองถึงกลางปี 70',
  ].map(eventFingerprint);
  assert.equal(new Set(fps).size, 1, `expected one fingerprint, got ${JSON.stringify(fps)}`);
});

test('later stages of the same measure are NOT duplicates', () => {
  const announce = eventFingerprint('รัฐขยายมาตรการลดค่าโอน-จดจำนองถึงกลางปี 70');
  const gazette  = eventFingerprint('ราชกิจจาฯ ประกาศ ลดค่าโอน-จำนอง "บ้าน-คอนโด" ไม่เกิน 7 ล้าน');
  const inForce  = eventFingerprint('กรมที่ดิน พร้อมให้บริการ ลดค่าโอน– จำนอง0.01% ถึง30 มิ.ย.70');
  const explain  = eventFingerprint('สูตรคำนวณ ค่าโอน-จำนอง 0.01% ซื้อบ้าน - คอนโด 7 ล้านบาท');
  assert.equal(new Set([announce, gazette, inForce, explain]).size, 4);
});

test('a revising verb makes it a new development, not a repeat', () => {
  const orig = eventFingerprint('ครม. อนุมัติลดค่าโอน-จดจำนอง 0.01% ถึงกลางปี 70');
  const rev  = eventFingerprint('ครม. ปรับเงื่อนไขลดค่าโอน-จดจำนอง 0.01% ถึงกลางปี 70');
  assert.notEqual(orig, rev);
});

test('a measure expiring is not the measure being announced', () => {
  assert.notEqual(
    eventFingerprint('"มาตรการ LTV 2565 ใหม่" ช่วยคนจะซื้อบ้านอย่างไร?'),
    eventFingerprint('มาตรการผ่อนคลาย LTV สิ้นสุดลง ณ สิ้นปี 2565'));
});

test('different institutions commenting are separate items', () => {
  assert.notEqual(
    eventFingerprint('ธปท. ชี้ต่ออายุลดค่าโอน-จดจำนอง-LTV ช่วยประคองอสังหาฯ'),
    eventFingerprint('ธอส. มองตลาดพ้นจุดต่ำสุด ลดค่าโอน-จดจำนอง หนุนกำลังซื้อ'));
});

test('a different deadline year is a different decision', () => {
  assert.notEqual(
    eventFingerprint('ครม. ต่ออายุลดค่าโอน-จดจำนอง ถึงกลางปี 2569'),
    eventFingerprint('ครม. ต่ออายุลดค่าโอน-จดจำนอง ถึงกลางปี 2570'));
});

test('a non-policy headline gets no fingerprint at all', () => {
  assert.equal(eventFingerprint('ASW โชว์กำไร Q2/69 โต 36%'), null);
  assert.equal(eventFingerprint(''), null);
});

test('groupByEvent keeps the earliest row and flags the rest', () => {
  const rows = [
    { id: 3, date: '2026-08-04', title: 'รัฐต่ออายุลดค่าโอน-จดจำนอง และผ่อนคลาย LTV ถึงกลางปี 70' },
    { id: 1, date: '2026-08-02', title: 'รัฐขยายมาตรการลดค่าโอน-จำนองถึงกลางปี 70' },
    { id: 2, date: '2026-08-04', title: 'รัฐขยายมาตรการลดค่าโอน-จดจำนองถึงกลางปี 70' },
  ];
  const [c] = groupByEvent(rows);
  assert.equal(c.keep.id, 1, 'the first report is the one that keeps its date');
  assert.equal(c.duplicates.length, 2);
});

test('the same measure a year apart does not merge', () => {
  const rows = [
    { id: 1, date: '2025-06-01', title: 'ครม. ต่ออายุลดค่าโอน-จดจำนอง 0.01%' },
    { id: 2, date: '2026-06-01', title: 'ครม. ต่ออายุลดค่าโอน-จดจำนอง 0.01%' },
  ];
  assert.equal(groupByEvent(rows, { windowDays: 14 }).length, 0);
});

// --- HTTP: title verdicts end to end ------------------------------------------------

let server, origin;
before(async () => {
  server = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const html = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    const doc = (t) => `<html><head><title>${t}</title><meta property="og:title" content="${t}"></head><body><h1>${t}</h1></body></html>`;
    switch (p) {
      case '/news/match-100001':    return html(200, doc('ครม. ไฟเขียวลดค่าโอน-จดจำนอง 0.01% ถึงกลางปี 2570'));
      case '/news/other-100002':    return html(200, doc('Nissan ประกาศปิดโรงงานในไทย'));
      case '/news/generic-100003':  return html(200, doc('MSN'));
      case '/news/tohome-100004':   res.writeHead(302, { location: '/' }); return res.end();
      case '/':                     return html(200, doc('ฐานเศรษฐกิจ'));
      case '/news/flaky-100005': {
        flaky++;
        if (flaky <= 2) { res.writeHead(503); return res.end('busy'); }
        return html(200, doc('ครม. ไฟเขียวลดค่าโอน-จดจำนอง 0.01% ถึงกลางปี 2570'));
      }
      default: return html(404, doc('Not found'));
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

let flaky = 0;
const MOCK = 'https://mock-publisher.example.com';
const opts = (extra = {}) => ({ fetchImpl: (u, o) => globalThis.fetch(String(u).replace(MOCK, origin), o), ...extra });
const HEADLINE = 'ครม. ไฟเขียวลดค่าโอน-จดจำนอง 0.01% ถึงกลางปี 70';

test('a page carrying our story is valid', async () => {
  const r = await validateUrl(`${MOCK}/news/match-100001`, opts({ headline: HEADLINE }));
  assert.equal(r.status, STATUS.VALID);
  assert.ok(r.matchScore > 0);
});

test('a page carrying a different story is title_mismatch_high', async () => {
  const r = await validateUrl(`${MOCK}/news/other-100002`, opts({ headline: HEADLINE }));
  assert.equal(r.status, STATUS.TITLE_MISMATCH_HIGH);
  assert.equal(r.pageTitle, 'Nissan ประกาศปิดโรงงานในไทย');
});

test('a generic page title is title_unknown, and stays clickable', async () => {
  const r = await validateUrl(`${MOCK}/news/generic-100003`, opts({ headline: HEADLINE }));
  assert.equal(r.status, STATUS.TITLE_UNKNOWN);
});

test('a link that redirects to the publisher homepage is homepage', async () => {
  const r = await validateUrl(`${MOCK}/news/tohome-100004`, opts({ headline: HEADLINE }));
  assert.equal(r.status, STATUS.HOMEPAGE);
});

test('without a headline the title check is skipped, not failed', async () => {
  const r = await validateUrl(`${MOCK}/news/other-100002`, opts());
  assert.equal(r.status, STATUS.VALID);
});

test('a transient 5xx is retried and then succeeds', async () => {
  flaky = 0;
  const r = await validateUrlWithRetry(`${MOCK}/news/flaky-100005`,
    opts({ headline: HEADLINE, retries: 3, retryBaseMs: 10 }));
  assert.equal(r.status, STATUS.VALID);
  assert.ok(r.attempts >= 3, `expected retries, got ${r.attempts}`);
});

test('retry gives up and reports the transient status, never dead', async () => {
  const always503 = () => Promise.resolve(new Response('busy', { status: 503 }));
  const r = await validateUrlWithRetry('https://a.co/news/1234567',
    { fetchImpl: always503, retries: 1, retryBaseMs: 10 });
  assert.equal(r.status, STATUS.UNKNOWN);
  assert.notEqual(r.status, STATUS.DEAD);
  assert.equal(r.attempts, 2);
});

test('an unspaced hyphen is compound punctuation, not a publisher suffix', () => {
  // This bug turned a CORRECT link into a reported mismatch: the headline was
  // cut at the hyphen in "ลดค่าโอน-จดจำนอง", discarding the percentage and the
  // deadline year — exactly the tokens that prove the two texts are one story.
  assert.equal(stripSiteSuffix('ครม. ไฟเขียวลดค่าโอน-จดจำนอง 0.01% ถึงกลางปี 70'),
                               'ครม. ไฟเขียวลดค่าโอน-จดจำนอง 0.01% ถึงกลางปี 70');
  assert.equal(stripSiteSuffix('แนวราบ-คอนโด ครึ่งปีหลัง 69'), 'แนวราบ-คอนโด ครึ่งปีหลัง 69');
  // A SPACED separator still cuts.
  assert.equal(stripSiteSuffix('ครม. ไฟเขียวลดค่าโอน 0.01% - ฐานเศรษฐกิจ'), 'ครม. ไฟเขียวลดค่าโอน 0.01%');
});

test('an abbreviation and its full name are one entity', () => {
  // Caught while about to hide 59 links: this pair is the SAME story — the
  // BOT's own page for the rate decision — and was scored a HIGH mismatch
  // purely because the headline says "กนง." and the page says the full name.
  // Demoting it to medium keeps the link and asks a human instead.
  const r = compareHeadlineToTitle(
    'กนง. มีมติลดอัตราดอกเบี้ยนโยบาย 0.25% เหลือ 2.00% ต่อปี',
    'ผลการประชุมคณะกรรมการนโยบายการเงิน ครั้งที่ 1/2568',
    { host: 'bot.or.th' });
  assert.notEqual(r.verdict, TITLE_VERDICT.MISMATCH_HIGH, r.reason);
  assert.ok(r.sharedEntities >= 1);
});

test('a warrant headline matches the warrant-holder page', () => {
  const r = compareHeadlineToTitle(
    '[ASW-W2 กำหนดการใช้สิทธิครั้งแรก ระหว่างวันที่ 17-21 เมษายน 2566]',
    'ข้อมูลสำหรับผู้ถือใบสำคัญแสดงสิทธิ',
    { host: 'assetwise.co.th' });
  assert.notEqual(r.verdict, TITLE_VERDICT.MISMATCH_HIGH, r.reason);
});

test('genuinely unrelated pages stay HIGH after the alias widening', () => {
  for (const [h, t] of [
    ['รัฐบาลเร่งแก้ผลกระทบรถไฟฟ้าสายสีม่วง', 'มาจริงคงโหด "ลิเวอร์พูล" เกือบได้ "แข้ง 4 พันล้าน"'],
    ['ตลาดอสังหาฯ ครึ่งปีแรก 69 โครงการใหม่ลด', 'คดี "แอชตัน อโศก" ล่าสุด "ศรีสุวรรณ" บี้ กทม.'],
    ['ศุภาลัยกำไร Q2/69 พุ่ง 36%', 'สมเด็จพระบรมราชชนนีพันปีหลวง พระราชทานคำขวัญ วันแม่แห่งชาติ'],
  ]) {
    assert.equal(compareHeadlineToTitle(h, t, { host: 'siamrath.co.th' }).verdict,
                 TITLE_VERDICT.MISMATCH_HIGH, h);
  }
});
