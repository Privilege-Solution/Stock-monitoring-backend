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

function isWeekend(dateISO) {
  const d = new Date(dateISO + 'T00:00:00');
  const dow = d.getDay();
  return dow === 0 || dow === 6;
}

function isHoliday(dateISO) {
  return HOLIDAYS.has(dateISO);
}

function isTradingDay(dateISO) {
  return !isWeekend(dateISO) && !isHoliday(dateISO);
}

function expectedTradingDays(fromISO, toISO) {
  const out = [];
  const start = new Date(fromISO + 'T00:00:00');
  const end = new Date(toISO + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function classify(dateISO) {
  if (isWeekend(dateISO)) return 'weekend';
  if (isHoliday(dateISO)) return 'holiday';
  return 'gap';
}

function diffDays(fromISO, toISO) {
  const a = new Date(fromISO + 'T00:00:00');
  const b = new Date(toISO + 'T00:00:00');
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
};