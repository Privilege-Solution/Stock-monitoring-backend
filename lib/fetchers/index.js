'use strict';

const db = require('../../db');
const { fetchAll: mockFetch } = require('./mock');
const { computePropBasket, joinByDate, PEER_TICKERS } = require('../prop-basket');

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

const PEER_NAMES = {
  'AP.BK': 'AP Thailand',
  'LH.BK': 'Land & Houses',
  'QH.BK': 'Quality Houses',
  'SIRI.BK': 'Siri Vanachroen',
  'SPALI.BK': 'Supalai',
  'NOBLE.BK': 'Noble Development',
  'ORI.BK': 'Origin Property',
  'ANAN.BK': 'Ananda Development',
  'LPN.BK': 'L.P.N. Development',
  'WHA.BK': 'WHA Corporation',
};

// Dispatch by source. 'yahoo' (default) and 'mock' return price rows in the
// same shape (so they flow through joinByDate + writeRows); 'gemini-*'
// sources are side-channels — they persist via db.updateSingleRemark /
// db.appendRemarkPin / db.writeNewsItems / db.updateMorningBrief inside the
// fetcher and return metadata for the caller (cron logs,
// /api/remarks/refresh, /api/news/refresh, /api/morning-brief/refresh).
//
// Default `sinceDate`: when caller doesn't supply one and we're fetching
// prices, default to a 7-day window before the latest stored date so a
// missed daily cron self-heals next run. gemini-* sources use today instead
// (Gemini re-searches "today" each call).
async function runFetch({ source = 'yahoo', sinceDate } = {}) {
  if (source.startsWith('gemini-')) {
    const m = await loadGemini();
    return await m.run({ source, sinceDate });
  }

  if (!sinceDate) {
    const meta = await db.metadata();
    if (meta.dateMax) {
      const d = new Date(meta.dateMax + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 7);
      sinceDate = d.toISOString().slice(0, 10);
    }
  }

  let asw, set, peers;
  if (source === 'mock') {
    ({ asw, set, peers } = await mockFetch({ sinceDate }));
  } else {
    const yahoo = await loadYahoo();
    ({ asw, set, peers } = await yahoo.fetchAll({ sinceDate }));
  }
  const propSeries = computePropBasket(peers);
  const rows = joinByDate(asw, set, propSeries);

  // Persist individual peer prices for the peer-snapshot table on the frontend.
  // Skip when using mock (no real peer data).
  let peersWritten = 0;
  if (source === 'yahoo') {
    const names = PEER_TICKERS.map(t => PEER_NAMES[t] || t.replace('.BK', ''));
    const result = await db.writePeers(PEER_TICKERS, names, peers);
    peersWritten = result.rows;
  }

  return { rows, source, peersWritten };
}

// Lightweight live-ticker fetch — touches only ASW via Yahoo 1-min interval.
// Does NOT touch peers/SET/PROP and does NOT persist to `daily` table.
// Returns { price, ts, prevClose } where prevClose is yesterday's EOD close
// (read from DB so the KPI can compute change% against the last settled
// close rather than against another intraday tick).
async function runIntraday() {
  const yahoo = await loadYahoo();
  const tick = await yahoo.fetchIntraday({ windowMinutes: 5 });
  if (!tick) return { price: null, ts: null, prevClose: null };

  // Read the latest EOD close from DB (skip the row equal to today —
  // today's row in `daily` may already be partial during market hours, but
  // we want yesterday's settled close as the reference).
  const meta = await db.metadata();
  const todayISO = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const rows = await db.readAllRows(null, null);
  // The row with the largest date strictly less than today is "prev close".
  const settled = rows
    .filter(r => r.date < todayISO && r.close != null)
    .sort((a, b) => a.date.localeCompare(b.date))
    .pop();

  return {
    price: tick.price,
    ts: tick.ts * 1000, // unix ms for client convenience
    prevClose: settled ? settled.close : null,
  };
}

module.exports = { runFetch, runIntraday };