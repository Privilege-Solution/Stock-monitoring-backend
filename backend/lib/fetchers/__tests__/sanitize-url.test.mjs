// Guards the URL cut at the DB write boundary. Every path into news_feed goes
// through writeNewsItems -> sanitizeSourceUrl, including the backfill scripts
// that bypass the Gemini parser entirely, so this is the last line of defence.
//
// Run:  npm test
// (`node --test <dir>` without a glob resolves the dir as a module on Node 22
// and fails before running anything — pass the files, as the npm script does.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import db from '../../../db.js';

const { sanitizeSourceUrl: s } = db;

test('a clean url is returned unchanged', () => {
  assert.equal(s('https://www.bangkokbiznews.com/business/1234'),
                 'https://www.bangkokbiznews.com/business/1234');
});

test('trailing Thai commentary is cut, not percent-encoded', () => {
  // new URL() ACCEPTS this and encodes the junk into the path, so a
  // parse-then-keep sanitizer would store a dead link with %E0%B8 noise.
  const out = s('https://www.thaitabloid.com/2026/08/03/set-august-3-2569/ (อ้างอิงจากข่าว)');
  assert.equal(out, 'https://www.thaitabloid.com/2026/08/03/set-august-3-2569/');
  assert.ok(!out.includes('%'), 'must not percent-encode the commentary');
});

test('a second slash-separated url is dropped', () => {
  assert.equal(s('https://www.thansettakij.com/real-estate/599958 / https://www.apthai.com/th/a'),
                 'https://www.thansettakij.com/real-estate/599958');
});

test('a comma-separated list keeps only the first url, comma trimmed', () => {
  assert.equal(s('https://www.reic.or.th/News/Detail/1169, https://www.thaipost.net/x'),
                 'https://www.reic.or.th/News/Detail/1169');
});

test('a legitimate trailing bracket survives when it was opened', () => {
  assert.equal(s('https://en.wikipedia.org/wiki/Bangkok_(disambiguation)'),
                 'https://en.wikipedia.org/wiki/Bangkok_(disambiguation)');
});

test('an unopened trailing bracket is stripped', () => {
  assert.equal(s('https://a.co/article)'), 'https://a.co/article');
});

test('vertex grounding redirects are still rejected', () => {
  assert.equal(s('https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ'), '');
});

test('non-http schemes and the NONE sentinel are rejected', () => {
  assert.equal(s('javascript:alert(1)'), '');
  assert.equal(s('NONE'), '');
  assert.equal(s(''), '');
  assert.equal(s(null), '');
});

test('prose with no url at all yields empty, not a bogus link', () => {
  assert.equal(s('ไม่พบแหล่งข่าว'), '');
});
