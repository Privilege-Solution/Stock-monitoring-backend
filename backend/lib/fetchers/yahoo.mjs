// Direct Yahoo Finance public chart API. No auth / no crumb needed.
// Endpoint: https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
// Reference: https://github.com/ranaroussi/yfinance/blob/main/yfinance/base.py
//            (Yahoo's public chart API is the same data source yfinance uses)

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PEER_TICKERS } = require('../prop-basket.js');

export const SYMBOLS = {
  asw: 'ASW.BK',
  set: '^SET.BK',
};

const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';

// Exponential-backoff retry for transient errors (429, 5xx, network timeout).
// Skips retry on 4xx (except 429) since those are permanent client errors.
// Throws the final error if all attempts fail; error carries `.status` and
// `.symbol` so the caller's logger can attribute failures.
async function withRetry(fn, { retries = 3, baseMs = 500, factor = 2, jitter = true, label = 'yahoo' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const status = e.status;
      if (status && status >= 400 && status < 500 && status !== 429) {
        // Permanent client error (400/401/403/404) — no point retrying
        throw e;
      }
      if (attempt === retries) break;
      const delay = baseMs * Math.pow(factor, attempt - 1);
      const wait = jitter ? delay * (0.5 + Math.random()) : delay;
      console.warn(`[${label}] attempt ${attempt}/${retries} failed (${status || 'no-status'}${e.symbol ? ' ' + e.symbol : ''}); retry in ${Math.round(wait)}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// Low-level fetch: returns the raw {rows, meta} object. `meta` carries
// fields like regularMarketPrice/regularMarketTime that Yahoo always
// populates regardless of interval — useful as a fallback when the candle
// array is empty (off-hours, weekend, just-listed ticker, etc.).
async function fetchRaw(symbol, period1, period2, interval = '1d') {
  const url = CHART_URL + encodeURIComponent(symbol)
    + '?period1=' + period1 + '&period2=' + period2
    + '&interval=' + interval + '&includeAdjustedClose=true&events=history';
  // 15s timeout so a hung Yahoo socket doesn't stall the fetch forever. The
  // resulting TimeoutError has no `.status`, so withRetry() treats it as
  // retryable (only 4xx short-circuits) — matching the retry comment's intent.
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Yahoo ${symbol} HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    err.symbol = symbol;
    throw err;
  }
  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) {
    const err = json.chart?.error || json;
    throw new Error(`Yahoo ${symbol} no data: ` + JSON.stringify(err).slice(0, 200));
  }
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];
  const closes = q.close || [];
  const vols = q.volume || [];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const close = adj[i] != null ? adj[i] : closes[i];
    if (close == null) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    rows.push({
      date,
      close,
      volume: vols[i] != null ? vols[i] : 0,
      _ts: ts[i], // unix seconds — needed by fetchIntraday() to pick latest candle
    });
  }
  return { rows, meta: result.meta || {} };
}

// Public historical fetcher: returns rows only (for fetchAll).
async function fetchOne(symbol, period1, period2, interval = '1d') {
  const { rows } = await fetchRaw(symbol, period1, period2, interval);
  return rows;
}

export async function fetchAll({ sinceDate } = {}) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = sinceDate
    ? Math.floor(new Date(sinceDate + 'T00:00:00Z').getTime() / 1000)
    : period2 - 60 * 60 * 24 * 365 * 5; // 5 years default

  // Sequential with small jitter to avoid Yahoo rate-limit (429).
  // Each call also goes through withRetry() so a single 429/5xx doesn't
  // fail the whole batch.
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const asw = await withRetry(() => fetchOne(SYMBOLS.asw, period1, period2));
  await sleep(150);
  const setSeries = await withRetry(() => fetchOne(SYMBOLS.set, period1, period2));
  await sleep(150);
  // Peers are supplementary (they only feed the PROP basket + peer snapshot).
  // A single delisted/renamed ticker returning a permanent 404 must NOT abort
  // the whole fetch and lose ASW + SET + the other peers — so isolate each in
  // its own try/catch and substitute an empty series on failure.
  //
  // PEER_TICKERS (single source of truth in ../prop-basket.js) includes ASW.BK
  // so it appears in the peer-snapshot table. Reuse the already-fetched `asw`
  // series instead of refetching — keeps the peers array index-aligned with
  // PEER_TICKERS and avoids a redundant Yahoo call.
  const peers = [];
  for (const p of PEER_TICKERS) {
    if (p === SYMBOLS.asw) { peers.push(asw); continue; }
    try {
      peers.push(await withRetry(() => fetchOne(p, period1, period2)));
    } catch (e) {
      console.warn(`[yahoo] peer ${p} failed, using empty series:`, e.message || e);
      peers.push([]);
    }
    await sleep(150);
  }
  return { asw, set: setSeries, peers };
}

// Fetch the latest 1-min ASW partial candle for live ticker display.
// `windowMinutes` limits how far back to look (default 60 — enough to catch
// the most recent partial during market hours without pulling hours of data).
//
// Returns null only when the market is genuinely closed (no candles AND
// no fresh regularMarketPrice). Otherwise:
//
//   1. Prefers the latest 1-min candle (most accurate, real-time)
//   2. Falls back to `meta.regularMarketPrice` when Yahoo's free tier
//      returns the meta block but no candle array. Yahoo frequently gates
//      intraday candles behind crumb/auth for free-tier callers, so the
//      candle path often returns empty even during active market hours.
//      The meta fallback is 15-min delayed (SET free-tier feed) but that's
//      better than a blank KPI card.
//
// The returned `source` field ('candle' or 'meta-fallback') lets the
// dashboard annotate the delay if desired.
export async function fetchIntraday({ windowMinutes = 60 } = {}) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - windowMinutes * 60;
  const { rows, meta } = await fetchRaw(SYMBOLS.asw, period1, period2, '1m');

  // Path 1: real 1-min candle.
  if (rows.length) {
    const latest = rows.slice().sort((a, b) => b._ts - a._ts)[0];
    return {
      ts: latest._ts,
      price: latest.close,
      source: 'candle',
    };
  }

  // Path 2: meta fallback. Yahoo's free tier frequently gates intraday
  // candles behind crumb/auth, returning only the meta block. Accept the
  // meta's regularMarketPrice as long as the trade is from "recently":
  //
  //   - Within the last 24 hours: accept and flag whether it's from today
  //     (Live) or yesterday (Pending — market may have just opened without
  //     a trade tick yet). The frontend uses this flag to label the row.
  //   - Older than 24h: reject (genuinely stale — weekend, holiday, halt).
  //
  // Previously we required regularMarketTime's ICT date to match today's
  // ICT date, which was too strict — between 10:00 ICT market open and
  // the first trade, Yahoo still reports yesterday's last trade and the
  // dashboard KPI showed "—" instead of the price.
  const rmt = meta?.regularMarketTime;
  const rmp = meta?.regularMarketPrice;
  if (typeof rmt === 'number' && typeof rmp === 'number') {
    const ageSec = period2 - rmt;
    if (ageSec <= 24 * 3600) {
      const todayICT = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
      const rmtDateICT = new Date(rmt * 1000 + 7 * 3600 * 1000).toISOString().slice(0, 10);
      return {
        ts: rmt,
        price: rmp,
        source: rmtDateICT === todayICT ? 'meta-fallback' : 'meta-pending',
      };
    }
  }

  return null;
}