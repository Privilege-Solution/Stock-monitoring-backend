'use strict';

// Hardcoded SET (Stock Exchange of Thailand) holidays for 2025 + 2026.
// Extend yearly. Sources: SET official holiday calendar.
const HOLIDAYS = new Set([
  // 2025
  '2025-01-01','2025-02-12','2025-04-07','2025-04-14','2025-04-15','2025-04-16',
  '2025-05-01','2025-05-05','2025-05-12','2025-06-02','2025-07-28','2025-07-29',
  '2025-08-11','2025-08-12','2025-10-23','2025-12-05','2025-12-10','2025-12-31',
  // 2026
  '2026-01-01','2026-02-12','2026-04-06','2026-04-13','2026-04-14','2026-04-15',
  '2026-05-01','2026-05-04','2026-05-11','2026-06-01','2026-07-28','2026-07-29',
  '2026-08-10','2026-08-11','2026-10-23','2026-12-07','2026-12-10','2026-12-31',
]);

// All date math below parses with an explicit 'Z' and reads UTC fields. Parsing
// 'YYYY-MM-DDT00:00:00' without the Z yields LOCAL midnight, which then renders
// as the PREVIOUS day via toISOString() on any host east of UTC — i.e. every
// developer machine in Thailand. Production masked this because the container
// has no TZ set (defaults to UTC); adding `ENV TZ=Asia/Bangkok` would have
// silently shifted every date by one day.
function isWeekend(dateISO) {
  const d = new Date(dateISO + 'T00:00:00Z');
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

function isHoliday(dateISO) {
  return HOLIDAYS.has(dateISO);
}

function isTradingDay(dateISO) {
  return !isWeekend(dateISO) && !isHoliday(dateISO);
}

// Every SET trading day in [fromISO, toISO] — weekends and holidays EXCLUDED,
// as the name promises. It previously returned every calendar day, which broke
// /api/health two ways: the "expected" count was ~50% too high (365 vs 244 for
// a year), and the ~120 weekend/holiday entries per year flooded the caller's
// 200-row display cap so genuine data gaps were truncated away and reported as
// zero.
function expectedTradingDays(fromISO, toISO) {
  const out = [];
  const end = new Date(toISO + 'T00:00:00Z');
  for (let d = new Date(fromISO + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (isTradingDay(iso)) out.push(iso);
  }
  return out;
}

function classify(dateISO) {
  if (isWeekend(dateISO)) return 'weekend';
  if (isHoliday(dateISO)) return 'holiday';
  return 'gap';
}

// SET trading hours: 10:00–17:30 ICT (UTC+7), Mon–Fri excluding holidays.
// Thailand does not observe DST, so a fixed +7 offset is safe year-round.
function isMarketOpen(now = new Date()) {
  const ictMs = now.getTime() + 7 * 60 * 60 * 1000;
  const ict = new Date(ictMs);
  const dateISO = ict.toISOString().slice(0, 10);
  const dow = ict.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (HOLIDAYS.has(dateISO)) return false;
  const hour = ict.getUTCHours();
  const minute = ict.getUTCMinutes();
  const timeMin = hour * 60 + minute;
  return timeMin >= 10 * 60 && timeMin <= 17 * 60 + 30;
}

function diffDays(fromISO, toISO) {
  const a = new Date(fromISO + 'T00:00:00Z');
  const b = new Date(toISO + 'T00:00:00Z');
  return Math.floor((b - a) / 86400000);
}

module.exports = {
  HOLIDAYS,
  isWeekend,
  isHoliday,
  isTradingDay,
  expectedTradingDays,
  classify,
  diffDays,
  isMarketOpen,
};