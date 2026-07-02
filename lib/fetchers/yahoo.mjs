// Direct Yahoo Finance public chart API. No auth / no crumb needed.
// Endpoint: https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
// Reference: https://github.com/ranaroussi/yfinance/blob/main/yfinance/base.py
//            (Yahoo's public chart API is the same data source yfinance uses)

export const SYMBOLS = {
  asw: 'ASW.BK',
  set: '^SET.BK',
  peers: ['AP.BK','LH.BK','QH.BK','SIRI.BK','SPALI.BK','NOBLE.BK','ORI.BK','ANAN.BK','LPN.BK','WHA.BK'],
};

const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';

async function fetchOne(symbol, period1, period2) {
  const url = CHART_URL + encodeURIComponent(symbol)
    + '?period1=' + period1 + '&period2=' + period2
    + '&interval=1d&includeAdjustedClose=true&events=history';
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Yahoo ${symbol} HTTP ${res.status}: ${body.slice(0, 200)}`);
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
    });
  }
  return rows;
}

export async function fetchAll({ sinceDate } = {}) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = sinceDate
    ? Math.floor(new Date(sinceDate + 'T00:00:00Z').getTime() / 1000)
    : period2 - 60 * 60 * 24 * 365 * 5; // 5 years default

  // Sequential with small jitter to avoid Yahoo rate-limit (429).
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const asw = await fetchOne(SYMBOLS.asw, period1, period2);
  await sleep(150);
  const setSeries = await fetchOne(SYMBOLS.set, period1, period2);
  await sleep(150);
  const peers = [];
  for (const p of SYMBOLS.peers) {
    peers.push(await fetchOne(p, period1, period2));
    await sleep(150);
  }
  return { asw, set: setSeries, peers };
}