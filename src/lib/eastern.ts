/**
 * Calendar dates and clock times in the chapter's time zone,
 * DISPLAY_TIME_ZONE.
 *
 * Shared by the collector, whose visitor code changes at midnight Eastern
 * time, and the stats page, which groups and labels visits by Eastern day.
 * One helper for both is what keeps "one code" and "one day on /stats" the
 * same day: when the code changed at UTC midnight, 8pm Eastern (7pm in
 * winter), one evening's reader was two visitors on the same day.
 *
 * Through Intl, not a fixed offset: Eastern time is UTC-5 in winter and UTC-4
 * in summer, and a hard-coded offset would put an hour of visits on the wrong
 * day for half the year. Workers ship full time-zone data, so this runs the
 * same there as in Node.
 */

import { DISPLAY_TIME_ZONE } from '../data/analytics';

const MS_PER_DAY = 86_400_000;

/**
 * Wall-clock parts in the display time zone.
 *
 * Built once at module load. hourCycle h23 rather than hour12:false, which
 * some engines render as "24:05" for five past midnight.
 */
const ET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Year, month, day, hour and minute in Eastern time, as digits; null for anything that is not a time. */
export function easternParts(ts: unknown): Record<string, string> | null {
  const n = Number(ts);
  if (ts === null || ts === undefined || !Number.isFinite(n)) return null;
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return null;
  return Object.fromEntries(ET_FORMAT.formatToParts(date).map((p) => [p.type, p.value]));
}

/**
 * Whole days from 1 January 1970 to the Eastern calendar date a timestamp
 * falls on: 0 from midnight Eastern that day, 1 from the next midnight, and
 * so on, one apiece whether the day had 23, 24 or 25 hours. NaN for anything
 * that is not a time.
 */
export function easternDayNumber(ts: unknown): number {
  const p = easternParts(ts);
  if (!p) return Number.NaN;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / MS_PER_DAY;
}
