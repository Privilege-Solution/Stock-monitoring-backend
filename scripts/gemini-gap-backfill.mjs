// =============================================================================
// Month-by-month gap backfill for BOTH stocks, aimed at what the earlier
// backfills never asked about (disasters, market shocks, policy, competitors,
// FX for TITLE). Before July 2026 there was no daily fetching, and the old
// one-off backfills asked for 3–8 stories per quarter or year with no disaster
// angle — so e.g. the 28 Mar 2025 earthquake was never collected.
//
// EVIDENCE RULE — everything stored comes from a real article, never from the
// model's own text:
//   • The model is only a finder. Its stated URL is ignored: the first version
//     of this script trusted it when its host appeared in the grounding, and a
//     check against the pages found 28 of 74 links dead (invented paths on real
//     sites) and 19 pointing at a different, often years-older, article.
//   • Candidate links come from the search grounding: each story block is
//     matched to the groundingSupports whose cited sentences it contains, and
//     those supports name the groundingChunks (Google redirect URIs) behind
//     them. Each candidate is followed to the real article page.
//   • A candidate is accepted only if the page declares a publish date
//     (article:published_time / JSON-LD datePublished / <time> / meta) inside
//     the run's window (--from … --to, +2 days of spill-over), and the page's own
//     headline is about the same story as the block. The STORED date, title
//     and URL are the page's — the model's are discarded.
//   • No acceptable candidate → the story is not written.
// Category/impact still come from the model's block (validated per stock;
// the stock's name in the real headline wins; disasters are MACRO).
//
// PINS follow the live rule: the company angle pins every row; other angles
// pin HIGH rows (show_pin left unset → writeNewsItems derives it).
//
// Rows carry pipeline 'gemini-gap', so a run can be audited or rolled back:
//   DELETE FROM news_feed WHERE pipeline = 'gemini-gap' AND fetched_at >= '<run start>';
//
// Run:
//   node scripts/gemini-gap-backfill.mjs                                  # dry run, Mar–May 2025, both stocks
//   node scripts/gemini-gap-backfill.mjs --apply
//   node scripts/gemini-gap-backfill.mjs --apply --stock=TITLE --from=2024-09 --to=2024-11
// =============================================================================

import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', 'backend', '.env'), quiet: true });

const { default: db } = await import('../backend/db.js');
const { categoriesForStock, classifyCategory, headlineMentionsAsw, headlineMentionsTitleStock, headlineIsDisaster } =
  await import('../backend/lib/news-taxonomy.mjs');
const { normalizeHeadline } = await import('../backend/lib/fetchers/news-rss-helpers.mjs');
const { vetRowUrls } = await import('../backend/lib/news-url-guard.mjs');

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const APPLY = process.argv.includes('--apply');
const STOCKS = (arg('stock', 'ASW,TITLE')).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const FROM = arg('from', '2025-03');
const TO = arg('to', '2025-05');
const MAX_ROUNDS = Number(arg('rounds', '2'));
const CONCURRENCY = Number(arg('concurrency', '3'));
const MAX_CANDIDATES = 4;          // chunks tried per story
const TITLE_MATCH_MIN = 0.35;      // share of the page headline found in the story block
const PIPELINE = 'gemini-gap';

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!process.env.GEMINI_API_KEY) { console.error('[gap] GEMINI_API_KEY not set.'); process.exit(1); }
if (!/^\d{4}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}$/.test(TO) || FROM > TO) { console.error('[gap] --from/--to must be YYYY-MM, from ≤ to'); process.exit(1); }

// ── months ───────────────────────────────────────────────────────────────────
const THAI_MONTH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
                    'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
function months() {
  const out = [];
  let [y, m] = FROM.split('-').map(Number);
  const [ty, tm] = TO.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mm = String(m).padStart(2, '0');
    out.push({ key: `${y}-${mm}`, label: `${THAI_MONTH[m - 1]} ${y + 543} (${y}-${mm})`,
               from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` });
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// ── angles ───────────────────────────────────────────────────────────────────
const FORMAT = (cats) => `
CATEGORY ที่ใช้ได้: ${cats.join(' | ')}

ตอบเป็นบล็อกละข่าว คั่นด้วย --- รูปแบบนี้เท่านั้น:
CATEGORY: [หนึ่งค่าจากรายการด้านบน]
HEADLINE: [พาดหัวข่าวจริงภาษาไทย]
DATE: [YYYY-MM-DD วันที่เกิดเหตุการณ์]
SOURCE: [ชื่อสำนักข่าว]
IMPACT_LEVEL: [HIGH | MEDIUM | LOW]
SUMMARY: [สรุป 1-2 ประโยค จากเนื้อข่าวที่ค้นเจอ]
---
ห้ามแต่งข่าวขึ้นเอง เอาเฉพาะข่าวที่ค้นเจอจริงและเกิดขึ้นในเดือนนี้เท่านั้น
ตอบได้สูงสุด 8 ข่าว เรียงจากสำคัญที่สุด ถ้าไม่มีข่าวในช่วงนี้ ตอบ NONE`;

const ANGLES = {
  ASW: {
    company: (p) => `ค้นหาข่าวบริษัท แอสเซทไวส์ (AssetWise, หุ้น ASW) ช่วง ${p.label}
ค้นหา: ผลประกอบการ/กำไร, ยอดขาย-presale-โอนกรรมสิทธิ์, เปิดโครงการใหม่, หุ้นกู้/ปันผล/เพิ่มทุน,
ราคาหุ้น ASW เคลื่อนไหวแรง, บทวิเคราะห์โบรกเกอร์, ผู้บริหารให้สัมภาษณ์, ผลกระทบต่อโครงการของบริษัท
HIGH = กระทบมูลค่าหุ้นโดยตรง (งบ ปันผล เพิ่มทุน ยอดขายเปลี่ยนแรง เหตุการณ์ที่กระทบโครงการ)${FORMAT(['COMPANY'])}`,
    competitor: (p) => `ค้นหาข่าว developer อสังหาฯ คู่แข่งของ AssetWise ช่วง ${p.label}
(LH, AP, ศุภาลัย SPALI, แสนสิริ SIRI, โนเบิล NOBLE, ออริจิ้น ORI, อนันดา ANAN, LPN, ควอลิตี้เฮาส์ QH, พฤกษา PRUK)
ค้นหา: ผลประกอบการ, ยอดขาย/presale, เปิดโครงการ, หุ้นกู้/ผิดนัดชำระ, กลยุทธ์ปีนี้, บทวิเคราะห์หุ้นกลุ่มอสังหาฯ
HIGH = คู่แข่งรายใหญ่ผิดนัด/ขาดทุนหนัก หรือเปลี่ยนเกมตลาด${FORMAT(['COMPETITOR', 'INDUSTRY'])}`,
    policy: (p) => `ค้นหาข่าวนโยบายรัฐและดอกเบี้ยที่กระทบตลาดที่อยู่อาศัยไทย ช่วง ${p.label}
ค้นหา: มาตรการ LTV, ลดค่าโอน-จดจำนอง, มาตรการกระตุ้นอสังหาฯ, กฎต่างชาติถือครองคอนโด,
มติ กนง./อัตราดอกเบี้ยนโยบาย, ดอกเบี้ยสินเชื่อบ้าน, สินเชื่อถูกปฏิเสธ
HIGH = มาตรการหรือมติที่เปลี่ยนต้นทุน/กำลังซื้อทันที${FORMAT(['GOV_POLICY', 'RATES', 'POLITICS'])}`,
    macro: (p) => `ค้นหาเหตุการณ์มหภาคที่กระทบตลาดหุ้นไทยและตลาดที่อยู่อาศัย ช่วง ${p.label}
ค้นหาทุกหัวข้อนี้:
- ภัยพิบัติ: แผ่นดินไหว (รวมที่รู้สึกได้ในกรุงเทพฯ) อาคารถล่ม น้ำท่วม พายุ — และผลกระทบต่อคอนโด/ความเชื่อมั่นผู้ซื้อ
- ตลาดหุ้นไทยผันผวนแรง: SET ร่วง/พุ่งแรง, Circuit Breaker, ต่างชาติขายสุทธิหนัก
- ช็อกเศรษฐกิจโลก: ภาษีนำเข้าสหรัฐฯ / สงครามการค้า / วิกฤตการเงิน ที่กระทบไทย
- เศรษฐกิจไทย: GDP ส่งออก เงินเฟ้อ ท่องเที่ยว ค่าเงินบาทผันผวนแรง
- การเมืองไทยที่กระทบเสถียรภาพ
HIGH = ภัยพิบัติที่กระทบกรุงเทพฯ/ที่อยู่อาศัย, SET ร่วงแรง, ช็อกที่กระทบไทยทันที${FORMAT(['MACRO', 'POLITICS', 'INDUSTRY'])}`,
  },
  TITLE: {
    company: (p) => `ค้นหาข่าวบริษัท "ร่มโพธิ์ พร็อพเพอร์ตี้" (หุ้น TITLE) และโครงการแบรนด์ "THE TITLE" ในภูเก็ต ช่วง ${p.label}
ค้นหา: ผลประกอบการ, ยอดขาย-presale-โอน, เปิดโครงการ, ร่วมทุนโรงแรม, หุ้นกู้/ปันผล, บทวิเคราะห์โบรกเกอร์
ระวัง: "title deed"/โฉนด ไม่ใช่บริษัทนี้ และข่าวของ AssetWise (บริษัทแม่) ไม่ใช่ข่าว TITLE เว้นแต่พาดหัวพูดถึง TITLE${FORMAT(['COMPANY'])}`,
    phuket: (p) => `ค้นหาข่าวตลาดอสังหาริมทรัพย์ภูเก็ตและ developer รายอื่นในภูเก็ต ช่วง ${p.label}
ค้นหา: ยอดโอนคอนโด-วิลล่าภูเก็ต, สัดส่วนผู้ซื้อต่างชาติ, supply ใหม่, ราคาเฉลี่ย, รายงานที่ปรึกษาอสังหาฯ${FORMAT(['INDUSTRY', 'COMPETITOR'])}`,
    tourism: (p) => `ค้นหาข่าวการท่องเที่ยวภูเก็ตและการเดินทางเข้าไทย ช่วง ${p.label}
ค้นหา: จำนวนนักท่องเที่ยว, เที่ยวบินตรงเข้าภูเก็ต (รัสเซีย จีน), นโยบายวีซ่า, สนามบินภูเก็ต${FORMAT(['TOURISM'])}`,
    fx: (p) => `ค้นหาข่าวค่าเงินและความผันผวนที่กระทบผู้ซื้ออสังหาฯ ต่างชาติในภูเก็ต ช่วง ${p.label}
ค้นหา: เงินบาทแข็ง/อ่อนค่า (เทียบดอลลาร์ รูเบิล หยวน) โดยเฉพาะวันที่แตะระดับสูง/ต่ำสุดในรอบหลายเดือนหรือเปลี่ยนแรง,
ค่าเงินรูเบิล/หยวน, ธปท. ดูแลค่าเงิน, เงินทุนต่างชาติไหลเข้า-ออก, กฎการโอนเงินระหว่างประเทศ/SWIFT${FORMAT(['FX'])}`,
    world: (p) => `ค้นหาเหตุการณ์โลกที่กระทบกำลังซื้อของผู้ซื้อรัสเซีย/จีนที่ซื้ออสังหาฯ ในภูเก็ต ช่วง ${p.label}
ค้นหา: สงครามรัสเซีย-ยูเครน, มาตรการคว่ำบาตร, การเจรจาหยุดยิง → GEOPOLITICS; ราคาน้ำมันดิบเคลื่อนไหวแรง → OIL${FORMAT(['GEOPOLITICS', 'OIL'])}`,
    policy: (p) => `ค้นหาข่าวนโยบายรัฐไทยที่กระทบการถือครองอสังหาฯ ของชาวต่างชาติ และดอกเบี้ย ช่วง ${p.label}
ค้นหา: โควตาต่างชาติในคอนโด, นอมินี, leasehold, ลดค่าโอน-จดจำนอง, LTV, มติ กนง.${FORMAT(['GOV_POLICY', 'RATES'])}`,
    macro: (p) => `ค้นหาเหตุการณ์มหภาคที่กระทบภูเก็ตและตลาดหุ้นไทย ช่วง ${p.label}
ค้นหา: ภัยพิบัติในภูเก็ต/อันดามัน/ไทย (แผ่นดินไหว สึนามิ น้ำท่วม พายุ), ตลาดหุ้นไทยผันผวนแรง,
ช็อกเศรษฐกิจโลก (ภาษีนำเข้าสหรัฐฯ), เศรษฐกิจและการเมืองไทย
HIGH = ภัยพิบัติที่กระทบภูเก็ตหรือการเดินทางเข้าไทย, ช็อกที่กระทบตลาดทันที${FORMAT(['MACRO'])}`,
  },
};

// ── Gemini ───────────────────────────────────────────────────────────────────
async function gemini(prompt) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
    tools: [{ google_search: {} }],
  };
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(`${ENDPOINT}?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
      });
      if (r.status === 429) { const w = 15_000 * attempt; process.stdout.write(`[429 wait ${w / 1000}s]`); await sleep(w); continue; }
      if (!r.ok) { if (r.status >= 500) throw new Error(`HTTP ${r.status}`); return { err: `HTTP ${r.status}` }; }
      const j = await r.json();
      const cand = j.candidates?.[0];
      const gm = cand?.groundingMetadata || {};
      return {
        text: (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('\n'),
        chunks: (gm.groundingChunks || []).map(c => ({ uri: c.web?.uri || '', host: String(c.web?.title || '').toLowerCase() })),
        supports: (gm.groundingSupports || []).map(s => ({ text: String(s.segment?.text || '').trim(), idx: s.groundingChunkIndices || [] })),
      };
    } catch (e) {
      if (attempt === 4) return { err: e.message };
      await sleep(3000 * attempt);
    }
  }
  return { err: 'exhausted' };
}

// ── evidence: follow a grounding chunk to its article, read its own date/title ─
const DATE_PATTERNS = [
  /property=["']article:published_time["'][^>]*content=["']([^"']+)/i,
  /content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i,
  /"datePublished"\s*:\s*"([^"]+)"/i,
  /itemprop=["']datePublished["'][^>]*content=["']([^"']+)/i,
  /name=["'](?:pubdate|publishdate|publish-date|date|DC\.date\.issued|parsely-pub-date)["'][^>]*content=["']([^"']+)/i,
  /<time[^>]*datetime=["']([^"']+)/i,
];
const ictDay = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t + 7 * 3600e3).toISOString().slice(0, 10) : null; };
// Numeric entities in both forms — the first run stored "&#x27;แผ่นดินไหว&#x27;"
// because only the decimal form was handled.
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');
function pageTitle(html) {
  const m = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)/i)
         || html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i)
         || html.match(/<title[^>]*>([^<]+)/i);
  if (!m) return '';
  // Drop a trailing " - Site" / " | Site" brand suffix.
  return decode(m[1]).replace(/\s+[|\-–—]\s+[^|\-–—]{2,40}$/, '').replace(/\s+/g, ' ').trim();
}
const PAGE_CACHE = new Map();
async function openChunk(uri) {
  if (PAGE_CACHE.has(uri)) return PAGE_CACHE.get(uri);
  const p = (async () => {
    try {
      const r = await fetch(uri, { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': UA, 'Accept-Language': 'th,en' } });
      if (!r.ok) return { err: `HTTP ${r.status}` };
      if (/vertexaisearch|google\.com/.test(new URL(r.url).hostname)) return { err: 'redirect not resolved' };
      const html = (await r.text()).slice(0, 500_000);
      let date = null;
      for (const re of DATE_PATTERNS) { const m = html.match(re); if (m && (date = ictDay(m[1]))) break; }
      return { url: r.url, date, title: pageTitle(html) };
    } catch (e) { return { err: e.name === 'TimeoutError' ? 'timeout' : String(e.message).slice(0, 40) }; }
  })();
  PAGE_CACHE.set(uri, p);
  return p;
}

const grams = (s) => { s = String(s).toLowerCase().replace(/\s+/g, ''); const g = new Set(); for (let i = 0; i + 3 <= s.length; i++) g.add(s.slice(i, i + 3)); return g; };
// Share of the page headline's character 3-grams that occur in the story block.
function headlineInBlock(title, block) {
  const T = grams(title), B = grams(block);
  if (!T.size) return 0;
  let n = 0; for (const x of T) if (B.has(x)) n++;
  return n / T.size;
}

function settleCategory(stock, claimed, title) {
  if (stock === 'ASW' && (headlineMentionsAsw(title) || headlineMentionsTitleStock(title))) return 'COMPANY';
  if (stock === 'TITLE' && headlineMentionsTitleStock(title)) return 'COMPANY';
  if (headlineIsDisaster(title)) return 'MACRO';
  if (claimed === 'COMPANY') return classifyCategory(title, null, stock);
  return categoriesForStock(stock).includes(claimed) ? claimed : classifyCategory(title, null, stock);
}

// Story blocks + the grounding chunks cited by the sentences inside each block.
function parseBlocks(res) {
  if (!res.text || /^\s*NONE\s*$/.test(res.text)) return [];
  return res.text.split(/\n?---\n?/).filter(b => /HEADLINE:/.test(b)).map(block => {
    const get = k => (block.match(new RegExp(`${k}:\\s*(.+)`)) || [])[1]?.replace(/^\[|\]$/g, '').trim();
    const headline = (get('HEADLINE') || '').replace(/^["“]|["”]$/g, '').trim();
    if (!headline || headline.length < 8 || /^NONE$/i.test(headline)) return null;
    const votes = new Map();
    for (const s of res.supports) {
      if (s.text.length < 12 || !block.includes(s.text)) continue;
      for (const i of s.idx) votes.set(i, (votes.get(i) || 0) + 1);
    }
    const cands = [...votes.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => res.chunks[i]).filter(c => c && c.uri).slice(0, MAX_CANDIDATES);
    const imp = (get('IMPACT_LEVEL') || 'MEDIUM').toUpperCase();
    return {
      headline, block, cands,
      claimed: (get('CATEGORY') || '').toUpperCase().split(/[|,/\s]/)[0],
      impact: ['HIGH', 'MEDIUM', 'LOW'].includes(imp) ? imp : 'MEDIUM',
      summary: (get('SUMMARY') || '').trim() || null,
    };
  }).filter(Boolean);
}

// The first cited page that proves the story: dated inside the month, same story.
async function evidenceFor(b, month) {
  const reasons = [];
  if (!b.cands.length) return { reason: 'no citation' };
  for (const c of b.cands) {
    const p = await openChunk(c.uri);
    if (p.err) { reasons.push(p.err); continue; }
    if (!p.date) { reasons.push('page has no date'); continue; }
    // The stored date IS the page's, so a story the model put in the wrong
    // month is still correct data — accept it anywhere inside this run's
    // window (e.g. Q1 results the model placed in March but published 9 May).
    if (p.date < RUN_FROM || p.date > RUN_TO) { reasons.push(`page dated ${p.date}`); continue; }
    if (!p.title) { reasons.push('page has no title'); continue; }
    const m = headlineInBlock(p.title, b.block);
    if (m < TITLE_MATCH_MIN) { reasons.push(`other story (${m.toFixed(2)})`); continue; }
    return { page: p };
  }
  return { reason: reasons.join('; ') };
}

// ── run ──────────────────────────────────────────────────────────────────────
db.openDb();
const runStart = new Date();
const MONTHS = months();
const RUN_FROM = MONTHS[0].from;
const RUN_TO = addDays(MONTHS[MONTHS.length - 1].to, 2);
let calls = 0;
const totals = {};
console.log(`[gap] ${APPLY ? 'APPLY' : 'DRY RUN'} · ${STOCKS.join('+')} · ${MONTHS.map(m => m.key).join(', ')} · ≤${MAX_ROUNDS} rounds/angle · run start ${runStart.toISOString()}`);

for (const stock of STOCKS) {
  const angles = ANGLES[stock];
  if (!angles) { console.error(`[gap] unknown stock ${stock}`); continue; }
  totals[stock] = { stories: 0, proven: 0, inserted: 0, deduped: 0 };
  for (const month of MONTHS) {
    const existing = await db.readNewsFeed({ stock, since: addDays(month.from, -3), until: addDays(month.to, 3), limit: 2000 });
    const seenHash = new Set(existing.map(r => sha1(normalizeHeadline(r.title) || r.title)));
    const seenUrl = new Set(existing.map(r => r.source_url).filter(Boolean));
    const proven = [], rejected = [];

    const runAngle = async (angle) => {
      const mine = [];
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        let prompt = angles[angle](month);
        const already = [...existing.map(r => r.title), ...mine].slice(0, 15);
        if (already.length) prompt += `\n\nข่าวเหล่านี้มีอยู่แล้ว ห้ามตอบซ้ำ ให้หาข่าวอื่น:\n` + already.map(h => `- ${String(h).slice(0, 70)}`).join('\n');
        const res = await gemini(prompt);
        calls++;
        if (res.err) { console.log(`  ${stock} ${month.key} ${angle} r${round}: ERR ${res.err}`); break; }
        const blocks = parseBlocks(res);
        // Open the cited pages for all stories at once; dedup stays sequential.
        const evidence = await Promise.all(blocks.map(b => evidenceFor(b, month)));
        let fresh = 0;
        for (const [k, b] of blocks.entries()) {
          mine.push(b.headline);
          const ev = evidence[k];
          if (!ev.page) { rejected.push({ angle, headline: b.headline, reason: ev.reason }); continue; }
          const p = ev.page;
          const hash = sha1(normalizeHeadline(p.title) || p.title);
          if (seenHash.has(hash) || seenUrl.has(p.url)) continue;
          seenHash.add(hash); seenUrl.add(p.url);
          const category = settleCategory(stock, b.claimed, p.title);
          proven.push({
            title: p.title, date: p.date, category,
            source_url: p.url, source_label: hostOf(p.url),
            title_hash: hash, pipeline: PIPELINE, impact: null,
            severity: b.impact === 'HIGH' ? 'high' : b.impact === 'LOW' ? 'low' : 'medium',
            impact_level: b.impact, summary: b.summary,
            ...(angle === 'company' && category === 'COMPANY' ? { show_pin: true } : {}),
          });
          fresh++;
        }
        console.log(`  ${stock} ${month.key} ${angle.padEnd(10)} r${round}: ${blocks.length} found, +${fresh} proven`);
        if (!blocks.length) break;
      }
    };
    const queue = Object.keys(angles);
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) { const a = queue.shift(); try { await runAngle(a); } catch (e) { console.error(`  ! ${stock} ${month.key} ${a}: ${e.message}`); } }
    }));

    const { rows } = vetRowUrls(proven, { tag: 'gap', log: () => {} });
    const ok = rows.filter(r => r.source_url).sort((a, b) => a.date.localeCompare(b.date));
    totals[stock].stories += ok.length + rejected.length; totals[stock].proven += ok.length;
    console.log(`  → ${stock} ${month.key}: ${ok.length} proven, ${rejected.length} rejected`);
    for (const r of ok) console.log(`     ✓ ${r.date} [${r.category}|${r.impact_level}]${r.show_pin || r.severity === 'high' ? ' 📍' : ''} ${r.title.slice(0, 70)}  (${r.source_label})`);
    for (const r of rejected.slice(0, 12)) console.log(`     ✗ ${r.headline.slice(0, 50)} — ${r.reason}`);
    if (rejected.length > 12) console.log(`     … ${rejected.length - 12} more rejected`);

    if (APPLY && ok.length) {
      try {
        const { inserted, deduped } = await db.writeNewsItems(stock, ok);
        totals[stock].inserted += inserted; totals[stock].deduped += deduped;
        console.log(`     written: ${inserted} inserted, ${deduped} deduped`);
      } catch (e) { console.error(`  ! ${stock} ${month.key} write failed: ${e.message}`); }
    }
  }
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }

console.log(`\n[gap] ${calls} Gemini calls · ${JSON.stringify(totals)}`);
if (APPLY) console.log(`[gap] rollback: DELETE FROM news_feed WHERE pipeline = '${PIPELINE}' AND fetched_at >= '${runStart.toISOString()}';`);
await db.closeDb();
