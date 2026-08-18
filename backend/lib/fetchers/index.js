'use strict';

const db = require('../../db');
const { fetchAll: mockFetch } = require('./mock');
const { computePropBasket, joinByDate, PEER_TICKERS, PEER_NAMES } = require('../prop-basket');
const { STOCKS, STOCK_KEYS, DEFAULT_STOCK, assertStock } = require('../stocks.js');

let yahooModule = null;
async function loadYahoo() {
  if (!yahooModule) {
    yahooModule = await import('./yahoo.mjs');
  }
  return yahooModule;
}

let geminiModule = null;
async function loadGemini() {
  if (!geminiModule) {
    geminiModule = await import('./gemini-search.mjs');
  }
  return geminiModule;
}

let rssModule = null;
async function loadRss() {
  if (!rssModule) {
    rssModule = await import('./rss-property.mjs');
  }
  return rssModule;
}

// Migrate-v8 — extended news (SET filings, broker, insider, investor_alert,
// macro_fx, debt_rating). All categories share one Google News RSS round
// trip; logical separation lives inside rss-extended.mjs.
let rssExtendedModule = null;
async function loadRssExtended() {
  if (!rssExtendedModule) {
    rssExtendedModule = await import('./rss-extended.mjs');
  }
  return rssExtendedModule;
}

// PEER_NAMES is now imported from ../prop-basket (single source of truth).

// Dispatch by source. 'yahoo' (default) and 'mock' return price rows in the
// same shape (so they flow through joinByDate + writeRows); 'gemini-*'
// sources are side-channels — they persist via db.updateSingleRemark /
// db.appendRemarkPin / db.writeNewsItems / db.updateMorningBrief inside the
// fetcher and return metadata for the caller (cron logs,
// /api/remarks/refresh, /api/news/refresh, /api/morning-brief/refresh).
//
// Yahoo calls inside yahoo.mjs use retry + exponential backoff so a single
// 429/5xx doesn't fail the whole batch. (Earlier experiment with a Stooq
// CSV fallback was abandoned — Stooq now serves a Cloudflare JS challenge
// to non-browser clients. See git history for stooq.mjs.)
//
// Default `sinceDate`: when caller doesn't supply one and we're fetching
// prices, default to a 7-day window before the latest stored date so a
// missed daily cron self-heals next run. gemini-* sources use today instead
// (Gemini re-searches "today" each call).
// IMPORTANT: maxAgeDays must be forwarded to rss-property / rss-extended.
// Earlier the signature was `{ source, sinceDate }` which silently dropped
// maxAgeDays — the cron's `maxAgeDays: 2` was ignored and fetchers fell
// back to their internal default (7 days). Manual refresh via
// `/api/news/rss-refresh?maxAgeDays=N` was also broken the same way.
async function runFetch({ source = 'yahoo', sinceDate, maxAgeDays } = {}) {
  if (source.startsWith('gemini-')) {
    const m = await loadGemini();
    return await m.run({ source, sinceDate });
  }

  if (source === 'rss-property') {
    const m = await loadRss();
    return await m.run({ sinceDate, maxAgeDays });
  }

  if (source === 'rss-extended') {
    const m = await loadRssExtended();
    return await m.run({ sinceDate, maxAgeDays });
  }

  // Price sources delegate to the combined multi-stock run (migrate-v13).
  return runDailyPrices({ sinceDate, source });
}

// =============================================================================
// ONE combined daily price run for every stock in STOCKS (migrate-v13).
//
// Deliberately NOT a per-stock loop over the old fetch path — that would
// refetch SET + all 20 peers once per stock (≈21 wasted Yahoo calls/day) and
// write peer_prices twice. Instead:
//   1. sinceDate is computed PER STOCK from per-stock metadata (ASW:
//      dateMax−7d self-heal window; TITLE's first run: dateMax=null → the
//      5-year default inside yahoo.fetchAll).
//   2. Shared series (SET + peers, which feed setIdx/propIdx on EVERY stock's
//      rows) are fetched ONCE over the WIDER of the windows — a one-time 5y
//      cost on TITLE's first run, converging to 7d after.
//   3. Each non-ASW stock's own series is one extra chart call.
//   4. joinByDate runs per stock; the caller writes rows per stock with its
//      own fetch_log entry.
//
// mock stays ASW-only (no real peer/TITLE data in the fixture).
// =============================================================================
async function runDailyPrices({ sinceDate, source = 'yahoo' } = {}) {
  // Per-stock incremental windows.
  const sinceByStock = {};
  for (const stock of STOCK_KEYS) {
    if (sinceDate) { sinceByStock[stock] = sinceDate; continue; }
    const meta = await db.metadata(stock);
    if (meta.dateMax) {
      const d = new Date(meta.dateMax + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 7);
      sinceByStock[stock] = d.toISOString().slice(0, 10);
    } else {
      // Empty DB for this stock → backfill from its IPO. The old behaviour
      // (null → yahoo's 5-year default) predates multi-stock and silently cut
      // TITLE's 2017-2021 mai-era history off; 5y stays the last-resort
      // fallback for a stock with no ipoDate on record.
      sinceByStock[stock] = STOCKS[stock].ipoDate || null;
    }
  }
  // Shared window = the widest any stock needs (null = 5y default wins).
  const sharedSince = Object.values(sinceByStock).some(v => v == null)
    ? null
    : Object.values(sinceByStock).sort()[0];

  if (source === 'mock') {
    const { asw, set, peers } = await mockFetch({ sinceDate: sharedSince || undefined });
    const propSeries = computePropBasket(peers);
    return { perStock: { ASW: joinByDate(asw, set, propSeries) }, source, peersWritten: 0 };
  }

  const yahoo = await loadYahoo();
  const { asw, set, peers } = await yahoo.fetchAll({ sinceDate: sharedSince || undefined });
  const propSeries = computePropBasket(peers);

  const perStock = {};
  for (const stock of STOCK_KEYS) {
    let series;
    if (STOCKS[stock].yahoo === yahoo.SYMBOLS.asw) {
      series = asw; // already fetched as part of the shared pull
    } else {
      // One extra chart call per additional stock (TITLE.BK). Isolated so a
      // failing extra symbol doesn't cost the ASW/SET/peer data.
      try {
        series = await yahoo.fetchSymbolDaily(STOCKS[stock].yahoo, { sinceDate: sinceByStock[stock] || sharedSince || undefined });
      } catch (e) {
        console.warn(`[fetchers] ${stock} (${STOCKS[stock].yahoo}) daily fetch failed:`, e.message || e);
        series = null;
      }
    }
    if (series) perStock[stock] = joinByDate(series, set, propSeries);
  }

  const names = PEER_TICKERS.map(t => PEER_NAMES[t] || t.replace('.BK', ''));
  const result = await db.writePeers(PEER_TICKERS, names, peers);
  return { perStock, source, peersWritten: result.rows };
}

// Lightweight live-ticker fetch — touches only ASW via Yahoo 1-min interval.
// Does NOT touch peers/SET/PROP and does NOT persist to `daily` table.
// Returns { price, ts, prevClose } where prevClose is yesterday's EOD close
// (read from DB so the KPI can compute change% against the last settled
// close rather than against another intraday tick).
async function runIntraday(stock = DEFAULT_STOCK) {
  assertStock(stock, 'runIntraday');
  const yahoo = await loadYahoo();
  const tick = await yahoo.fetchIntraday({ symbol: STOCKS[stock].yahoo, windowMinutes: 5 });
  if (!tick) return { price: null, ts: null, prevClose: null };

  // Yesterday's settled close as the KPI reference — a single indexed query,
  // per stock. (Pre-v13 this loaded EVERY daily row and popped the max date,
  // which with two stocks in the table could hand ASW's KPI TITLE's close.)
  const todayISO = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const settled = await db.latestSettledClose(stock, todayISO);

  return {
    price: tick.price,
    ts: tick.ts * 1000, // unix ms for client convenience
    prevClose: settled ? settled.close : null,
    // Forward the Yahoo source flag so the frontend can distinguish
    // real-time ticks ('candle') from delayed meta ('meta-fallback') and
    // yesterday's-price-during-just-opened ('meta-pending').
    source: tick.source || null,
  };
}

module.exports = { runFetch, runDailyPrices, runIntraday };