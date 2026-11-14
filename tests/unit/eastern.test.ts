import { describe, it, expect } from 'vitest';
import { easternDayNumber, easternParts } from '../../src/lib/eastern';

/**
 * UNIT — Eastern dates, the one clock the visitor code and /stats share.
 *
 * TIER JUSTIFICATION: the collector and stats tiers each see a handful of
 * clock readings. Whether day numbers stay consecutive across both clock
 * changes, and what a value that is not a time turns into, needs the helper
 * called directly with chosen instants.
 */

const H = 3_600_000;

describe('easternParts', () => {
  it('gives the Eastern wall-clock date and time, digit by digit', () => {
    expect(easternParts(Date.UTC(2026, 9, 17, 16, 5))).toMatchObject({
      year: '2026',
      month: '10',
      day: '17',
      hour: '12',
      minute: '05',
    });
  });

  it('writes five past midnight as 00:05, never 24:05', () => {
    expect(easternParts(Date.UTC(2026, 9, 17, 4, 5))).toMatchObject({ day: '17', hour: '00', minute: '05' });
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['undefined', undefined],
    ['a word', 'soon'],
    ['beyond the Date range', 8.64e15 + 1],
  ])('is null for %s', (_label, ts) => {
    expect(easternParts(ts)).toBeNull();
  });
});

describe('easternDayNumber', () => {
  it('is 0 from midnight Eastern on 1 January 1970, and -1 the instant before', () => {
    expect(easternDayNumber(Date.UTC(1970, 0, 1, 5, 0))).toBe(0);
    expect(easternDayNumber(Date.UTC(1970, 0, 1, 5, 0) - 1)).toBe(-1);
  });

  it('goes up by one at each Eastern midnight across both clock changes and a month end', () => {
    // Eastern midnights from 7 to 10 March 2026 (clocks forward on the 8th)
    // and from 31 October to 3 November (clocks back on the 1st).
    for (const midnights of [
      [Date.UTC(2026, 2, 7, 5), Date.UTC(2026, 2, 8, 5), Date.UTC(2026, 2, 9, 4), Date.UTC(2026, 2, 10, 4)],
      [Date.UTC(2026, 9, 31, 4), Date.UTC(2026, 10, 1, 4), Date.UTC(2026, 10, 2, 5), Date.UTC(2026, 10, 3, 5)],
    ]) {
      const days = midnights.map((t) => easternDayNumber(t));
      expect(days.map((d) => d - days[0])).toEqual([0, 1, 2, 3]);
      for (const t of midnights) expect(easternDayNumber(t - 1)).toBe(easternDayNumber(t) - 1);
    }
  });

  it('is a whole number at every hour of a day', () => {
    const start = Date.UTC(2026, 9, 17, 4, 0);
    for (let t = start; t < start + 24 * H; t += H) {
      expect(Number.isInteger(easternDayNumber(t))).toBe(true);
      expect(easternDayNumber(t)).toBe(easternDayNumber(start));
    }
  });

  it('is NaN for anything that is not a time', () => {
    expect(easternDayNumber(Number.NaN)).toBeNaN();
    expect(easternDayNumber('soon')).toBeNaN();
    expect(easternDayNumber(null)).toBeNaN();
  });
});
