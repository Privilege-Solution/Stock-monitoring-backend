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

let newsModule = null;
async function loadNews() {
  if (!newsModule) {
    newsModule = await import('./news.mjs');
  }
  return newsModule;
}

let aiRemarksModule = null;
async function loadAiRemarks() {
  if (!aiRemarksModule) {
    aiRemarksModule = await import('./ai-remarks.mjs');
  }
  return aiRemarksModule;
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
// same shape (so they flow through joinByDate + writeRows); 'news' and
// 'ai-remarks' are side-channels that return side metadata — caller must
// use `db.writeNews` / `db.updateRemark` directly (or call runFetch which
// handles persistence for these sources itself).
async function runFetch({ source = 'yahoo', sinceDate } = {}) {
  if (source === 'news') {
    const news = await loadNews();
    const articles = await news.fetchAll({ sinceDate });
    const { added, scanned } = await db.writeNews(articles);
    return { rows: [], source, newsAdded: added, newsScanned: scanned };
  }

  if (source === 'ai-remarks') {
    const ai = await loadAiRemarks();
    return await ai.run({ sinceDate }); // { date, remark, queriesRun }
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

module.exports = { runFetch };