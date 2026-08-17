// Tests for the central URL validator.
//
// NO REAL NETWORK. Every HTTP case runs against a local node:http server bound
// to 127.0.0.1 on an ephemeral port. The SSRF cases assert on classification
// only and never issue a request.
//
// Run:  npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  STATUS, validateUrl, validateUrlWithRetry, classifyUrlOffline, isHomepageLike,
  isUnsafeHost, detectSoft404, createValidationCache, canonicalizeUrl,
  PROVEN_WRONG_STATUSES, TRANSIENT_STATUSES, CLICKABLE_STATUSES,
} from '../url-validator.mjs';
import { labelMatchesHost } from '../publisher-hosts.mjs';

// --- mock publisher ----------------------------------------------------------

let server, origin;

const page = (title, body = '<p>เนื้อข่าว</p>') =>
  `<html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const html = (code, content) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
      res.end(content);
    };
    switch (true) {
      case p === '/news/1234567':
        return html(200, page('ASW เสนอขายหุ้นกู้ 920 ล้านบาท'));
      case p === '/news/404000':
        return html(404, page('Page not found'));
      case p === '/news/410000':
        return html(410, page('Gone'));
      case p === '/news/403000':
        return html(403, page('Forbidden'));
      case p === '/news/429000':
        return html(429, page('Too many requests'));
      case p === '/news/500000':
        return html(500, page('Internal error'));
      // 200 OK but the page says "not found" — a soft 404.
      case p === '/news/soft404-900001':
        return html(200, page('404 Not Found'));
      case p === '/news/softthai-900002':
        return html(200, page('ไม่พบหน้าที่ต้องการ'));
      // Redirect chains
      case p === '/news/redirect-one-900003':
        res.writeHead(302, { location: '/news/1234567' }); return res.end();
      case p === '/news/redirect-loop-900004':
        res.writeHead(302, { location: '/news/redirect-loop-900004' }); return res.end();
      // Article removed → bounced to the site root (200 on a non-article path)
      case p === '/news/redirect-home-900005':
        res.writeHead(302, { location: '/' }); return res.end();
      case p === '/':
        return html(200, page('หน้าแรก'));
      // A publisher redirecting into a private address — must not be followed
      case p === '/news/redirect-ssrf-900006':
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end();
      case p === '/news/redirect-lo-900007':
        res.writeHead(302, { location: 'http://127.0.0.1:1/secret' }); return res.end();
      case p === '/news/slow-900008':
        return setTimeout(() => html(200, page('late')), 3000);
      case p === '/news/huge-900009':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<html><head><title>ข่าวจริง ยาวมาก</title></head><body>');
        // Far more than the read cap, to prove the reader stops early.
        for (let i = 0; i < 4000; i++) res.write('<p>บรรทัดข่าวยาว ๆ เพื่อทดสอบขนาด</p>');
        return res.end('</body></html>');
      default:
        return html(404, page('Page not found'));
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

// The mock listens on 127.0.0.1, which the SSRF guard blocks — correctly, and
// we do NOT want to disable that guard to run the HTTP tests, because then the
// tests would no longer exercise the code path production uses.
//
// So the URL under test names a public-looking host and the injected fetch
// rewrites only the origin onto the mock. Every offline check (scheme, SSRF,
// redirector, homepage, label) runs against the real public hostname exactly as
// it would in production; only the socket goes somewhere local. Redirect hops
// are rewritten the same way, so an ABSOLUTE Location to a private address is
// still judged as itself — which is what the SSRF-redirect tests rely on.
const MOCK = 'https://mock-publisher.example.com';
const toMock = (url, opts) => globalThis.fetch(String(url).replace(MOCK, origin), opts);
const httpOpts = (extra = {}) => ({ fetchImpl: toMock, ...extra });

// --- scheme / protocol -------------------------------------------------------

test('rejects non-http(s) schemes as unsafe', () => {
  for (const u of ['javascript:alert(1)', 'data:text/html,<h1>x', 'file:///etc/passwd',
                   'ftp://example.com/a/b/c-d-e', 'chrome://settings']) {
    assert.equal(classifyUrlOffline(u).status, STATUS.UNSAFE, u);
  }
});

test('rejects a url carrying credentials', () => {
  const r = classifyUrlOffline('https://user:pw@example.com/news/1234567');
  assert.equal(r.status, STATUS.UNSAFE);
  assert.match(r.reason, /credential/);
});

test('rejects unparseable input as unsafe, empty input as unchecked', () => {
  assert.equal(classifyUrlOffline('not a url').status, STATUS.UNSAFE);
  assert.equal(classifyUrlOffline('').status, STATUS.UNCHECKED);
  assert.equal(classifyUrlOffline(null).status, STATUS.UNCHECKED);
});

// --- redirectors and trackers ------------------------------------------------

test('rejects Vertex grounding redirects', () => {
  const r = classifyUrlOffline('https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ');
  assert.equal(r.status, STATUS.UNSAFE);
});

test('rejects Google News redirects', () => {
  assert.equal(
    classifyUrlOffline('https://news.google.com/rss/articles/CBMiK2h0dHBz').status,
    STATUS.UNSAFE);
});

test('rejects Bing news click trackers', () => {
  assert.equal(
    classifyUrlOffline('https://www.bing.com/news/apiclick.aspx?ref=FexRss&url=https%3a%2f%2fa.co%2fb').status,
    STATUS.UNSAFE);
});

test('rejects google.com/url redirectors and ad trackers', () => {
  assert.equal(classifyUrlOffline('https://www.google.com/url?q=https://a.co/news/1234567').status, STATUS.UNSAFE);
  assert.equal(classifyUrlOffline('https://doubleclick.net/news/1234567').status, STATUS.UNSAFE);
});

// --- homepage / article path -------------------------------------------------

test('flags site roots and section indexes as homepage', () => {
  for (const u of ['https://www.bangkokbiznews.com/', 'https://www.thansettakij.com',
                   'https://www.set.or.th/th', 'https://siamrath.co.th/home',
                   'https://investor.assetwise.co.th/th/newsroom/press-releases',
                   'https://www.terrabkk.com/en/news/tag/AP-8281/2']) {
    assert.equal(classifyUrlOffline(u).status, STATUS.HOMEPAGE, u);
    assert.equal(isHomepageLike(u), true, u);
  }
});

test('accepts real article paths', () => {
  for (const u of ['https://www.bangkokbiznews.com/business/1234567',
                   'https://www.thaitabloid.com/2026/08/03/set-august-3-2569/',
                   'https://www.thansettakij.com/real-estate/599958',
                   'https://thestandard.co/cabinet-extends-property-fee-reduction/',
                   'https://www.hoonsmart.com/archives/301077',
                   'https://example.com/news?newsid=884412']) {
    assert.equal(classifyUrlOffline(u).status, null, u);
    assert.equal(isHomepageLike(u), false, u);
  }
});

test('accepts a percent-encoded Thai article slug', () => {
  const u = 'https://thinkofliving.com/%E0%B8%82%E0%B9%88%E0%B8%B2%E0%B8%A7/asset-wise-%E0%B8%81%E0%B8%A7%E0%B8%B2%E0%B8%94-909080/';
  assert.equal(classifyUrlOffline(u).status, null);
});

// --- SSRF --------------------------------------------------------------------

test('blocks loopback, private, link-local and metadata hosts', () => {
  for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0',
                   '10.0.0.5', '172.16.4.4', '172.31.255.1', '192.168.1.1',
                   '169.254.169.254', '100.64.0.1', '224.0.0.1',
                   'metadata.google.internal', 'instance-data',
                   'foo.internal', 'bar.local', 'db.localhost']) {
    assert.equal(isUnsafeHost(h), true, h);
  }
});

test('blocks IPv6 loopback, link-local, ULA and v4-mapped private', () => {
  for (const h of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1',
                   'ff02::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
    assert.equal(isUnsafeHost(h), true, h);
  }
});

test('allows ordinary public hosts', () => {
  for (const h of ['bangkokbiznews.com', 'www.set.or.th', '8.8.8.8', '203.0.113.9']) {
    assert.equal(isUnsafeHost(h), false, h);
  }
});

test('a url naming a private address classifies unsafe without any request', () => {
  for (const u of ['http://169.254.169.254/latest/meta-data/iam/x',
                   'http://127.0.0.1:8080/news/1234567',
                   'http://[::1]/news/1234567',
                   'http://10.0.0.1/news/1234567']) {
    assert.equal(classifyUrlOffline(u).status, STATUS.UNSAFE, u);
  }
});

// --- HTTP status mapping -----------------------------------------------------

test('2xx article → valid', async () => {
  const r = await validateUrl(`${MOCK}/news/1234567`, httpOpts());
  assert.equal(r.status, STATUS.VALID);
  assert.equal(r.httpStatus, 200);
});

test('404 → dead', async () => {
  const r = await validateUrl(`${MOCK}/news/404000`, httpOpts());
  assert.equal(r.status, STATUS.DEAD);
  assert.equal(r.httpStatus, 404);
});

test('410 → dead', async () => {
  const r = await validateUrl(`${MOCK}/news/410000`, httpOpts());
  assert.equal(r.status, STATUS.DEAD);
  assert.equal(r.httpStatus, 410);
});

test('403 → blocked, NOT dead', async () => {
  const r = await validateUrl(`${MOCK}/news/403000`, httpOpts());
  assert.equal(r.status, STATUS.BLOCKED);
  assert.notEqual(r.status, STATUS.DEAD);
  assert.match(r.reason, /bot block/);
});

test('429 → rate_limited', async () => {
  const r = await validateUrl(`${MOCK}/news/429000`, httpOpts());
  assert.equal(r.status, STATUS.RATE_LIMITED);
});

test('500 → unknown, never dead', async () => {
  const r = await validateUrl(`${MOCK}/news/500000`, httpOpts());
  assert.equal(r.status, STATUS.UNKNOWN);
  assert.notEqual(r.status, STATUS.DEAD);
});

test('timeout → timeout, never dead', async () => {
  const r = await validateUrl(`${MOCK}/news/slow-900008`, httpOpts({ timeoutMs: 300 }));
  assert.equal(r.status, STATUS.TIMEOUT);
  assert.notEqual(r.status, STATUS.DEAD);
});

test('a network error is network_error, never dead', async () => {
  // Split out of `unknown` so the audit can retry exactly the failures worth
  // retrying. The load-bearing assertion is the second one.
  const boom = () => Promise.reject(Object.assign(new Error('ECONNRESET'), { name: 'TypeError' }));
  const r = await validateUrl('https://a.co/news/1234567', { fetchImpl: boom });
  assert.equal(r.status, STATUS.NETWORK_ERROR);
  assert.notEqual(r.status, STATUS.DEAD);
  assert.ok(TRANSIENT_STATUSES.has(r.status), 'must be retryable');
});

// --- redirects ---------------------------------------------------------------

test('follows a redirect to the real article', async () => {
  const r = await validateUrl(`${MOCK}/news/redirect-one-900003`, httpOpts());
  assert.equal(r.status, STATUS.VALID);
  assert.equal(r.redirects, 1);
  assert.match(r.finalUrl, /\/news\/1234567$/);
});

test('bounds the redirect chain instead of looping forever', async () => {
  const r = await validateUrl(`${MOCK}/news/redirect-loop-900004`, httpOpts({ maxRedirects: 3 }));
  assert.equal(r.status, STATUS.UNKNOWN);
  assert.match(r.reason, /exceeded 3 redirects/);
});

test('a redirect into a metadata address is refused, not followed', async () => {
  const r = await validateUrl(`${MOCK}/news/redirect-ssrf-900006`, httpOpts());
  assert.equal(r.status, STATUS.UNSAFE);
  assert.match(r.reason, /redirect to unsafe target/);
});

test('a redirect into loopback is refused', async () => {
  const r = await validateUrl(`${MOCK}/news/redirect-lo-900007`, httpOpts());
  assert.equal(r.status, STATUS.UNSAFE);
});

test('an article that bounces to the site root is homepage, not valid', async () => {
  const r = await validateUrl(`${MOCK}/news/redirect-home-900005`, httpOpts());
  assert.equal(r.status, STATUS.HOMEPAGE);
});

// --- soft-404 ----------------------------------------------------------------

test('200 with a not-found title is soft_404', async () => {
  // Its own status now: a 200 that lies is operationally different from a
  // publisher that correctly returns 404, even though both mean "gone".
  const r = await validateUrl(`${MOCK}/news/soft404-900001`, httpOpts());
  assert.equal(r.status, STATUS.SOFT_404);
  assert.match(r.reason, /soft-404/);
  assert.ok(PROVEN_WRONG_STATUSES.has(r.status), 'still proof the link is wrong');
});

test('200 with a Thai not-found title is soft_404', async () => {
  const r = await validateUrl(`${MOCK}/news/softthai-900002`, httpOpts());
  assert.equal(r.status, STATUS.SOFT_404);
});

test('soft-404 detection does not fire on a real article', () => {
  const html = '<html><head><title>ASW กำไรโต 20%</title></head><body><h1>ASW กำไรโต 20%</h1>' +
               '<p>บทความกล่าวถึงข้อผิดพลาด 404 ของระบบเว็บไซต์คู่แข่ง</p></body></html>';
  const r = detectSoft404(html, 'https://a.co/news/1234567');
  assert.equal(r.soft404, false, 'body mentioning 404 must not trigger');
});

test('soft-404 ignores a not-found phrase that appears only in the body', () => {
  const html = page('ข่าวเศรษฐกิจไทยวันนี้', '<p>page not found คือข้อความที่ผู้ใช้พบ</p>');
  assert.equal(detectSoft404(html, 'https://a.co/news/1234567').soft404, false);
});

// --- body cap ----------------------------------------------------------------

test('stops reading a huge page and still classifies it', async () => {
  const r = await validateUrl(`${MOCK}/news/huge-900009`, httpOpts({ maxBytes: 4096 }));
  assert.equal(r.status, STATUS.VALID);
});

// --- label / hostname relationship -------------------------------------------

test('Thai label matches its Latin hostname via the alias table', () => {
  assert.equal(labelMatchesHost('กรุงเทพธุรกิจ', 'www.bangkokbiznews.com'), 'match');
  assert.equal(labelMatchesHost('สยามรัฐ', 'siamrath.co.th'), 'match');
  assert.equal(labelMatchesHost('ฐานเศรษฐกิจ', 'www.thansettakij.com'), 'match');
  assert.equal(labelMatchesHost('แนวหน้า', 'naewna.com'), 'match');
});

test('a label naming a DIFFERENT known publisher is a mismatch', () => {
  assert.equal(labelMatchesHost('กรุงเทพธุรกิจ', 'siamrath.co.th'), 'mismatch');
  assert.equal(labelMatchesHost('แนวหน้า', 'thansettakij.com'), 'mismatch');
});

test('an unlisted host is unknown, never mismatch', () => {
  // Guards against the table's incompleteness being reported as a data error.
  assert.equal(labelMatchesHost('สำนักข่าวเล็ก', 'some-unlisted-outlet.co.th'), 'unknown');
});

test('"X on MSN" syndication is not a mismatch', () => {
  assert.equal(labelMatchesHost('กรุงเทพธุรกิจ on MSN', 'www.msn.com'), 'syndicated');
  assert.equal(labelMatchesHost('ประชาชาติธุรกิจ on MSN', 'msn.com'), 'syndicated');
});

test('a subdomain resolves to its parent publisher entry', () => {
  assert.equal(labelMatchesHost('AssetWise', 'investor.assetwise.co.th'), 'match');
});

test('validateUrl reports mismatch when the label names another publisher', async () => {
  const r = await validateUrl('https://siamrath.co.th/news/1234567',
    { sourceLabel: 'กรุงเทพธุรกิจ', fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.equal(r.status, STATUS.MISMATCH);
});

// --- per-run cache -----------------------------------------------------------

test('the run cache checks one url only once', async () => {
  let calls = 0;
  const counting = (u, o) => { calls++; return toMock(u, o); };
  const cache = createValidationCache({ fetchImpl: counting });
  const url = `${MOCK}/news/1234567`;
  const [a, b] = await Promise.all([cache.validate(url), cache.validate(url)]);
  assert.equal(a.status, STATUS.VALID);
  assert.equal(b.status, STATUS.VALID);
  assert.equal(calls, 1, 'second lookup must be served from the memo');
});

test('punctuation and "&" differences are not a mismatch', () => {
  // Real false positive from the first audit run: the ampersand and the spaces
  // were the ONLY difference from the hostname, and it was reported as a wrong
  // publisher. A false accusation here trains the operator to ignore the check.
  assert.equal(labelMatchesHost('Money & Banking Magazine', 'www.moneyandbanking.co.th'), 'match');
  assert.equal(labelMatchesHost('Think of Living', 'thinkofliving.com'), 'match');
  assert.equal(labelMatchesHost('THE STANDARD', 'thestandard.co'), 'match');
});

test('a real cross-publisher mismatch is still caught', () => {
  // Also from the live table: a ไทยรัฐ label on a posttoday.com URL.
  assert.equal(labelMatchesHost('ไทยรัฐ', 'www.posttoday.com'), 'mismatch');
});

test('sameStory separates unrelated headlines that shared one URL', async () => {
  const { sameStory } = await import('../news-url-guard.mjs');
  // Both were bound to https://www.naewna.com/economy/836791 in the live table.
  assert.equal(sameStory(
    'แสนสิริรุกตลาดแนวราบครึ่งปีหลัง 69 จัดแคมเปญลดค่าใช้จ่าย',
    'SC ครึ่งปีแรก 69 กำไรโต 48% เตรียมเปิด 5 โครงการใหม่'), false);
  // The same story truncated differently must still collapse to one.
  assert.equal(sameStory(
    'ASW เสนอขายหุ้นกู้ 2 ชุด ดอกเบี้ย 5.45-5.95% เปิดจอง 3-5 ก.ค.',
    'ASW เสนอขายหุ้นกู้ 2 ชุด ดอกเบี้ย 5.45-5.95%'), true);
});

// --- article-path shapes found in the live table -----------------------------
// Every URL below was classified `homepage` by the first version of the path
// heuristic and would have had its link stripped. They are all real articles.
test('accepts opaque per-article ids used by real publishers', () => {
  for (const u of [
    'https://www.msn.com/th-th/money/general/%E0%B8%AD%E0%B8%AA%E0%B8%B1%E0%B8%87/ar-AA28LXoK',
    'https://today.line.me/th/v2/article/LPR0w3L',
    'https://today.line.me/th/v2/article/OpX9QxY',
    'https://www.khaosod.co.th/pr-news/news_10339948',
    'https://www.innnews.co.th/news/news_478394/',
  ]) {
    assert.equal(classifyUrlOffline(u).status, null, u);
  }
});

test('accepts a slug typeset in non-ASCII unicode', () => {
  // AssetWise publishes some slugs in mathematical-bold characters; an
  // [a-z]-anchored slug rule rejected its own newsroom.
  assert.equal(classifyUrlOffline('https://assetwise.co.th/news/𝐀𝐬𝐬𝐞𝐭𝐖𝐢𝐬𝐞-𝐢𝐧-𝐅𝐨𝐜𝐮𝐬/').status, null);
});

test('still rejects section indexes that the broadened rules could over-accept', () => {
  for (const u of [
    'https://assetwise.co.th/investor-relations/documents/',
    'https://www.set.or.th/th/market/news-and-alert/opportunity-day/company-presentation',
    'https://www.bangkokbiznews.com/',
    'https://www.thansettakij.com/business',
    'https://today.line.me/th/v2/',
  ]) {
    assert.equal(classifyUrlOffline(u).status, STATUS.HOMEPAGE, u);
  }
});

test('a paginated tag/category listing is not an article', () => {
  for (const u of [
    'https://www.terrabkk.com/en/news/tag/AP-8281/2',
    'https://www.bangkokbiznews.com/category/business/3',
    'https://example.co.th/topic/property/page/5',
    'https://example.co.th/search/asw',
  ]) {
    assert.equal(classifyUrlOffline(u).status, STATUS.HOMEPAGE, u);
  }
});

test('a real article filed under a category path still passes', () => {
  for (const u of [
    'https://example.co.th/category/business/2026/08/03/asw-bond-offering',
    'https://example.co.th/tag/property/asw-reports-record-quarter-2569',
  ]) {
    assert.equal(classifyUrlOffline(u).status, null, u);
  }
});

// --- multi-source labels and press-release wires ------------------------------
test('a label crediting several outlets matches if ANY one fits the host', () => {
  assert.equal(labelMatchesHost('กรุงเทพธุรกิจ, THE STANDARD WEALTH', 'www.bangkokbiznews.com'), 'match');
  assert.equal(labelMatchesHost('Forbes Thailand / Brand Buffet / REIC', 'www.reic.or.th'), 'match');
  assert.equal(labelMatchesHost('มติชน และ ประชาชาติธุรกิจ', 'matichon.co.th'), 'match');
});

test('a multi-source label with no matching outlet is still a mismatch', () => {
  assert.equal(labelMatchesHost('กรุงเทพธุรกิจ, ไทยรัฐ', 'siamrath.co.th'), 'mismatch');
});

test('press-release wires carry other organizations by design', () => {
  // ThaiPR/RYT9 republish central-bank and company releases verbatim, so the
  // issuing body's name on those hosts is correct, not a mispairing.
  assert.equal(labelMatchesHost('ธนาคารแห่งประเทศไทย (BOT)', 'www.thaipr.net'), 'syndicated');
  assert.equal(labelMatchesHost('NESDC', 'thaipr.net'), 'syndicated');
});

test('leaked markdown emphasis in a label does not break matching', () => {
  assert.equal(labelMatchesHost('** กรุงเทพธุรกิจ', 'www.bangkokbiznews.com'), 'match');
});

test('genuine cross-publisher mispairings survive all of the above', () => {
  // Every one of these is in the live table today.
  assert.equal(labelMatchesHost('Kaohoon.com', 'thinkofliving.com'), 'mismatch');
  assert.equal(labelMatchesHost('Bangkok Post', 'www.nationthailand.com'), 'mismatch');
  assert.equal(labelMatchesHost('RYT9', 'www.naewna.com'), 'mismatch');
  assert.equal(labelMatchesHost('ประชาชาติธุรกิจ', 'mgronline.com'), 'mismatch');
});
