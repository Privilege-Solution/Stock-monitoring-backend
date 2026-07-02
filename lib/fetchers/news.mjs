// NewsAPI.org /v2/everything client.
// Reference: https://newsapi.org/docs/endpoints/everything
//
// We run one query per "tag" — a tag is either a Thai RE peer ticker (matched
// against company name) or a sector keyword. Each result row is tagged with
// the query that produced it, then `db.writeNews` dedupes across queries via
// the (url, published_at) unique index.
//
// Free/dev tier notes:
//   - Hard cap of 100 req/day, 1 req/sec.
//   - /v2/everything on the dev plan only returns articles >24h old and from
//     a restricted source list. For an MVP dashboard this is fine — we want
//     a rolling 7-day window anyway.
//   - API key is read from NEWSAPI_KEY; missing key throws a clear error so
//     the cron doesn't silently burn retries.

const NEWSAPI_KEY = process.env.NEWSAPI_KEY || '';
const BASE = 'https://newsapi.org/v2/everything';
const UA = 'asw-monitor/1.1 (news fetcher)';

// One query per tag. Use OR-quoted exact phrases for company names so we
// don't get "AP" as a news wire. The peer list comes from yahoo.mjs so we
// don't drift from the source of truth.
const COMPANY_QUERIES = [
  { tag: 'asw',    q: '"Asset Wise"' },
  { tag: 'ap',     q: '"AP Thailand"' },
  { tag: 'lh',     q: '"Land and Houses" OR "Land & Houses"' },
  { tag: 'qh',     q: '"Quality Houses"' },
  { tag: 'siri',   q: 'Siri Vanachroen OR "Sansiri"' },
  { tag: 'spali',  q: 'Supalai' },
  { tag: 'noble',  q: '"Noble Development"' },
  { tag: 'ori',    q: '"Origin Property"' },
  { tag: 'anan',   q: '"Ananda Development"' },
  { tag: 'lpn',    q: '"L.P.N. Development" OR LPN' },
  { tag: 'wha',    q: '"WHA Corporation"' },
];

// Sector-level queries — broader net, used for the "อสังหาฯ" tab.
const SECTOR_QUERIES = [
  { tag: 'prop-th', q: '"Thai property" OR "Thailand real estate"' },
  { tag: 'prop-bkk', q: '"Bangkok condo" OR "Bangkok condominium"' },
];

export const ALL_QUERIES = [...COMPANY_QUERIES, ...SECTOR_QUERIES];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchOne(tag, q, { from, to, pageSize = 50 } = {}) {
  const params = new URLSearchParams({
    q,
    language: 'en',
    sortBy: 'publishedAt',
    pageSize: String(pageSize),
  });
  if (from) params.set('from', from);
  if (to)   params.set('to',   to);

  const url = `${BASE}?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'X-Api-Key': NEWSAPI_KEY,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`NewsAPI ${tag} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.status && json.status !== 'ok') {
    throw new Error(`NewsAPI ${tag} error: ${json.code || ''} ${json.message || ''}`.trim());
  }
  const articles = json.articles || [];
  return articles
    .filter(a => a && a.title && a.title !== '[Removed]' && a.url)
    .map(a => ({
      publishedAt: a.publishedAt,
      title:       a.title,
      description: a.description || null,
      url:         a.url,
      source:      a.source,           // { id, name }
      queryTag:    tag,
    }));
}

export async function fetchAll({ sinceDate, lookbackDays = 7 } = {}) {
  if (!NEWSAPI_KEY) {
    throw new Error('NEWSAPI_KEY not set — register at newsapi.org and export it before running the news fetcher');
  }

  // Build the from/to window. NewsAPI 'from' is ISO 8601, optional 'to' too.
  // Default to a rolling window of `lookbackDays` so we always overlap the
  // last cron run. If the caller passes sinceDate (e.g. after a manual
  // refresh), honour it.
  const now = new Date();
  const fromDate = sinceDate
    ? new Date(sinceDate + 'T00:00:00Z')
    : new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const from = fromDate.toISOString().slice(0, 19); // strip ms, keep Z
  // NewsAPI rejects 'to' in the future, so cap at "now".
  const to = now.toISOString().slice(0, 19);

  const all = [];
  // Sequential with a small sleep so we stay under NewsAPI's 1 req/sec limit
  // even when many tags fire.
  for (const { tag, q } of ALL_QUERIES) {
    try {
      const rows = await fetchOne(tag, q, { from, to, pageSize: 50 });
      all.push(...rows);
      console.log(`[news] ${tag} → ${rows.length} articles`);
    } catch (e) {
      // Don't abort the whole batch on one tag failing — log and continue.
      console.error(`[news] ${tag} failed: ${e.message || e}`);
    }
    await sleep(250);
  }
  return all;
}