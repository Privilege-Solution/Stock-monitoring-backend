'use strict';

const { PEER_TICKERS } = require('../prop-basket');

// Offline / test fetcher: generates a deterministic series so the UI keeps
// working when the network is down or for tests.

function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 0xffffffff);
}

function makeSeries(symbol, days = 600, base = 100) {
  const out = [];
  let price = base;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    const seed = hash01(symbol + d.toISOString().slice(0, 10));
    const pct = (seed - 0.5) * 0.04; // ±2% per day
    price = Math.max(0.5, price * (1 + pct));
    out.push({
      date: d.toISOString().slice(0, 10),
      close: Number(price.toFixed(2)),
      volume: Math.floor(50 + seed * 450),
    });
  }
  return out;
}

async function fetchAll({ sinceDate } = {}) {
  return {
    asw: makeSeries('ASW.BK', 600, 8.5),
    set: makeSeries('^SET.BK', 600, 1400),
    peers: PEER_TICKERS.map(s => makeSeries(s, 600, 10 + hash01(s) * 80)),
  };
}

module.exports = { fetchAll };