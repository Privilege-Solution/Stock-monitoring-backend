'use strict';

// Tavily-based fetcher for short daily "headline" remarks.
//
// For each query we get the top result.title from Tavily's /search endpoint
// (news topic, last 24 hours) and write it as `daily.remark` for the most
// recent trading day. The remark is intentionally a one-liner — the dashboard
// surfaces it under the price chart, so brevity beats completeness.
//
// Env: TAVILY_KEY
// Run shape (consumed by runFetch in lib/fetchers/index.js):
//   { date, remark, queriesRun, headlines }

import db from '../../db.js';

const TAVILY_KEY = process.env.TAVILY_KEY || '';
const TAVILY_URL = 'https://api.tavily.com/search';

// Three parallel queries cover: company-specific, sector-wide, macro.
const QUERIES = [
  {
    tag: 'company',
    q: '"AssetWise" OR "ASW" OR "แอสเซทไวส์" Thailand property developer news',
  },
  {
    tag: 'sector',
    q: 'Bangkok condominium presale Thai developer AP LH SPALI QH news',
  },
  {
    tag: 'macro',
    q: 'Bank of Thailand interest rate housing loan policy real estate',
  },
];

async function tavilySearch(query, { days = 1, maxResults = 3 } = {}) {
  const res = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_KEY,
      query,
      search_depth: 'basic',
      topic: 'news',
      days,
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Tavily ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.results || [];
}

function pickHeadline(results) {
  if (!results.length) return null;
  const top = results[0];
  const title = (top.title || '').trim();
  if (!title) return null;
  return title.length > 200 ? title.slice(0, 197) + '…' : title;
}

// Build a single short remark string from the headlines we got.
// Priority: company > sector > macro. We prepend the tag so the dashboard
// reader knows the source bucket. If only macro returns, that's still fine.
function composeRemark(headlines) {
  const usable = headlines.filter(h => h.headline);
  if (!usable.length) return null;
  // Prefer company first, then sector, then macro (priority order, not query order).
  const order = ['company', 'sector', 'macro'];
  const top = order
    .map(tag => usable.find(h => h.tag === tag))
    .find(Boolean) || usable[0];
  return `[${top.tag}] ${top.headline}`;
}

async function run({ sinceDate } = {}) {
  if (!TAVILY_KEY) throw new Error('TAVILY_KEY not set');

  // Pick the latest trading day that has prices — that's where the remark
  // belongs. sinceDate override is supported for back-filling historical days.
  const meta = await db.metadata();
  const date = sinceDate || meta.dateMax;
  if (!date) throw new Error('no trading day found to attach remark to');

  // Fire all three queries in parallel; failure of one does not block others.
  const headlines = await Promise.all(QUERIES.map(async ({ tag, q }) => {
    try {
      const results = await tavilySearch(q, { days: 1, maxResults: 3 });
      const headline = pickHeadline(results);
      return { tag, headline, ok: Boolean(headline) };
    } catch (e) {
      console.warn(`[ai-remarks] ${tag} query failed: ${e.message || e}`);
      return { tag, headline: null, ok: false, error: String(e.message || e) };
    }
  }));

  const remark = composeRemark(headlines);
  if (remark) {
    await db.updateRemark(date, remark);
    console.log(`[ai-remarks] wrote remark for ${date}: ${remark}`);
  } else {
    console.warn(`[ai-remarks] no headlines for ${date}; remark left unchanged`);
  }

  return { date, remark, queriesRun: QUERIES.length, headlines };
}

export { run, tavilySearch, QUERIES };
export default { run };