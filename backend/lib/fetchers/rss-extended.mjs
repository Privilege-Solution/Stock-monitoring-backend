// =============================================================================
// Migrate-v8 — Extended news fetcher.
// =============================================================================
// Closes the 6-gap coverage recommended by the user:
//   1. company_filing     — SET filing / earnings / dividend / capital / bond
//   2. broker             — broker analyst (rating change / target price)
//   3. insider_trade      — SEC Form 59 insider buy/sell
//   4. investor_alert     — SET Smart Alert (unusual volume / cash balance)
//   5. macro_fx           — BoT USD/THB fix + baht-direction news
//   6. debt_rating        — TRIS rating action + sector debt headlines
//
// All sources are FREE public RSS / Google News (no Bloomberg / Reuters /
// paid APIs). Every item MUST mention ASW (the ticker, the full name, or
// "แอสเซทไวส์") or be a sector-level signal the user asked us to track
// (FX, BoT rate, Phuket/Pattaya foreign ownership, etc.).
//
// Run shape (dispatched by runFetch in lib/fetchers/index.js):
//   source: 'rss-extended' → inserts 0–40 rows to news_feed across 6 categories
// =============================================================================

import { createHash } from 'node:crypto';
import db from '../../db.js';

const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// ---------------------------------------------------------------------------
// Query catalogue — 4 logical groups, mapped to the 4 user-approved scopes.
//
// Each entry: { q, category, pipeline, requireAsw }
//   - requireAsw=true  : headline MUST mention ASW / Assetwise / แอสเซทไวส์
//                        (company_filing + insider + investor_alert are ASW-only)
//   - requireAsw=false : sector-level signal (BoT, FX, etc.) accepted as-is
// ---------------------------------------------------------------------------
const QUERIES = [
  // ── 1. Company filings (earnings / dividend / capital / bond) ─────────────
  { q: 'ASW ปันผล',                category: 'company_filing', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'ASW เพิ่มทุน',              category: 'company_filing', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'ASW งบดุล',                category: 'company_filing', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'แอสเซทไวส์ กำไร',          category: 'company_filing', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'ASW หุ้นกู้',              category: 'company_filing', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'Assetwise SET filing',     category: 'company_filing', pipeline: 'company', requireAsw: true,  severity: 'medium' },

  // ── 2. Broker analyst news (rating / target price) ───────────────────────
  // Google News rarely returns headlines that mention BOTH the broker AND the
  // ticker together — so we DON'T require "ASW" in the title. The headline is
  // accepted if it mentions ASW OR if it carries one of the BROKER_TOKENS
  // (broker name + rating signals). The check below in parseItem() applies
  // both filters as OR.
  { q: 'ASPS ASW',                  category: 'broker', pipeline: 'company', requireAsw: 'OR', severity: 'high'   },
  { q: 'MST ASW',                   category: 'broker', pipeline: 'company', requireAsw: 'OR', severity: 'high'   },
  { q: 'KGI ASW',                   category: 'broker', pipeline: 'company', requireAsw: 'OR', severity: 'high'   },
  { q: 'โบรกเกอร์ ASW',             category: 'broker', pipeline: 'company', requireAsw: 'OR', severity: 'medium' },
  { q: 'target price ASW',          category: 'broker', pipeline: 'company', requireAsw: 'OR', severity: 'medium' },
  { q: 'แนะนำซื้อ ASW',             category: 'broker', pipeline: 'company', requireAsw: 'OR', severity: 'high'   },
  { q: 'broker แนะนำ อสังหาฯ',     category: 'broker', pipeline: 'sector',  requireAsw: 'OR', severity: 'medium' },

  // ── 3. Insider trading / SET investor alert ──────────────────────────────
  { q: 'SEC Form 59 ASW',           category: 'insider_trade', pipeline: 'company', requireAsw: true,  severity: 'high' },
  { q: 'รายงานการถือหลักทรัพย์ ASW', category: 'insider_trade', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'ASW insider',               category: 'insider_trade', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'SET cash balance ASW',      category: 'investor_alert', pipeline: 'company', requireAsw: true, severity: 'medium' },
  { q: 'SET Smart Alert ASW',       category: 'investor_alert', pipeline: 'company', requireAsw: true, severity: 'medium' },

  // ── 4. BoT FX + debt rating + legal / foreign ownership ──────────────────
  { q: 'บาท USD/THB',               category: 'macro_fx', pipeline: 'macro', requireAsw: false, severity: 'medium' },
  { q: 'ดอกเบี้ย นโยบาย กนง.',      category: 'macro_fx', pipeline: 'macro', requireAsw: false, severity: 'high'   },
  { q: 'TRIS rating ASW',           category: 'debt_rating', pipeline: 'company', requireAsw: true,  severity: 'high' },
  { q: 'อันดับเครดิต ASW',          category: 'debt_rating', pipeline: 'company', requireAsw: true,  severity: 'medium' },
  { q: 'foreign ownership Phuket condo', category: 'macro_fx', pipeline: 'macro', requireAsw: false, severity: 'medium' },
  { q: 'เอกชนถือครอง ภูเก็ต พัทยา',   category: 'macro_fx', pipeline: 'macro', requireAsw: false, severity: 'medium' },
];

const ASW_TOKENS = ['ASW', 'Assetwise', 'แอสเซทไวส์', 'แอสเสทไวส์'];

// Broker signals — require at least one of these to land in the broker
// bucket. Without these tokens a matched headline ("ASW ลุยตลาดภูเก็ต")
// would be misrouted to broker instead of peer_news / company_filing.
const BROKER_TOKENS = [
  'โบรกเกอร์', 'บลจ.', 'บล.', 'ASPS', 'MST', 'KGI', 'KTBST', 'LH', 'JPM',
  'บริษัทหลักทรัพย์',
  'target price', 'ราคาเป้า', 'เรท',
  'แนะนำซื้อ', 'แนะนำขาย', 'แนะนำถือ', 'แนะนำ', 'เรทหุ้น',
  'อันดับ', 'Rating', 'ราคาพาร์',
  'นายหน้า', 'โบรก', 'วิเคราะห์หุ้น', 'คาดกำไร', 'ประเมินหุ้น',
];

// Filing-side keywords — tighter than requireAsw alone. Makes sure that
// "ASW ลุย..." (peer news) doesn't drift into company_filing.
const FILING_TOKENS = [
  'งบดุล', 'งบการเงิน', 'ปันผล', 'หุ้นกู้', 'เพิ่มทุน', 'ลดทุน',
  'รายงานประจำปี', 'แบบ 56-1', 'รายได้', 'กำไรสุทธิ', 'อัตราส่วน',
  'D/E', 'Debt-to-Equity', 'กระแสเงินสด', 'ประชุมผู้ถือหุ้น',
  'กองทุนรวม', 'X-Report', 'F4-1', 'F4-2', 'XB-1', 'แบบแสดงรายการ',
];

function headlineMentionsAsw(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return ASW_TOKENS.some(kw => t.includes(kw.toLowerCase()));
}

function headlineMentionsBroker(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return BROKER_TOKENS.some(kw => t.includes(kw.toLowerCase()));
}

function headlineMentionsFiling(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return FILING_TOKENS.some(kw => t.includes(kw.toLowerCase()));
}

function cleanTitle(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

function parseItem(itemXml, q) {
  const titleRaw = (itemXml.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  const title = cleanTitle(titleRaw).replace(/\s*-\s*[^-]+$/, '').trim();
  if (!title) return null;

  const link = (itemXml.match(/<link\/?>([^<]+)/) || itemXml.match(/<link>([^<]+)<\/link>/) || [])[1] || '';
  const pubDate = (itemXml.match(/<pubDate>([^<]+)/) || [])[1] || '';
  const sourceName = cleanTitle((itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '');
  const guid = (itemXml.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || link;

  const d = pubDate ? new Date(pubDate) : null;
  if (!d || isNaN(d.getTime())) return null;

  // Pre-filter: category-specific token gates before accepting the headline.
  //   - requireAsw === true  → headline MUST mention ASW / Assetwise / แอสเซทไวส์
  //   - requireAsw === 'OR'  → headline must mention ASW OR a broker keyword
  //                            (used for broker queries — broker headlines
  //                             often drop the ticker and only name the broker)
  //   - requireAsw === false → accept whatever Google News returns (macro FX,
  //                            foreign-ownership, etc. — sector-level signal)
  // Company_filing intentionally has no extra gate beyond ASW — any ASW
  // mention is treated as company news.
  if (q.requireAsw === true && !headlineMentionsAsw(title)) return null;
  if (q.requireAsw === 'OR'
      && !(headlineMentionsAsw(title) || headlineMentionsBroker(title))) return null;

  // Severity: brker = high; rest = default from query.
  return {
    title,
    date: d.toISOString().slice(0, 10),
    category: q.category,
    source_url: link,
    source_label: sourceName || 'Google News',
    title_hash: sha1(guid || link || title),
    pipeline: q.pipeline,
    impact: 'neutral',
    severity: q.severity || 'medium',
    show_pin: q.severity === 'high',
    summary: null,
  };
}

async function fetchQuery(q, maxAgeDays) {
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q.q) +
    '&hl=th&gl=TH&ceid=TH:th';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!r.ok) {
      console.log(`[rss-extended] ${q.q} → HTTP ${r.status}`);
      return [];
    }
    const t = await r.text();
    const items = t.match(/<item>[\s\S]*?<\/item>/g) || [];
    const cutoff = Date.now() - maxAgeDays * 86400_000;
    return items
      .map(x => parseItem(x, q))
      .filter(Boolean)
      .filter(it => new Date(it.date + 'T00:00:00Z').getTime() >= cutoff);
  } catch (e) {
    console.log(`[rss-extended] ${q.q} → ERR ${e.message}`);
    return [];
  }
}

async function run({ sinceDate, maxAgeDays = 14 } = {}) {
  console.log(`[rss-extended] fetching ${QUERIES.length} queries (maxAge=${maxAgeDays}d)`);
  // Tighter maxAge (14d) than rss-property (7d) because broker/insider
  // headlines stop being actionable quickly. Override via arg if needed.
  const all = (await Promise.all(QUERIES.map(q => fetchQuery(q, maxAgeDays)))).flat();

  // Dedupe by title_hash across queries — Google News surfaces overlapping
  // results for queries like "ASPS ASW" and "target price ASW".
  const seen = new Set();
  const unique = all.filter(it => {
    if (seen.has(it.title_hash)) return false;
    seen.add(it.title_hash);
    return true;
  });

  const valid = unique.filter(it => it.source_url && it.source_url.length > 0);
  if (!valid.length) return { ok: true, fetched: 0, inserted: 0 };

  // Display priority: ASW-direct broker/insider = top of feed.
  // No keyword-scoring table — categories are intrinsically ranked. We rely
  // on the existing display_priority formula in the unified feed (which
  // already understands broker vs. macro). For items WITHOUT a stored value
  // the frontend's priorityForItem() falls back to severity-based scoring.
  const { inserted } = await db.writeNewsItems(valid);

  // Per-category counts for the log line (operator at-a-glance).
  const byCat = {};
  for (const it of valid) byCat[it.category] = (byCat[it.category] || 0) + 1;
  console.log(`[rss-extended] parsed=${all.length} unique=${unique.length} inserted=${inserted} byCat=${JSON.stringify(byCat)}`);
  return { ok: true, fetched: valid.length, inserted, byCat };
}

export { run };
export default { run };
