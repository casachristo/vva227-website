import { describe, it, expect } from 'vitest';
import {
  parseIssue,
  parseIssueStrict,
  groupIssuesByYear,
  currency,
  ordinal,
  mapUrl,
  addressLine,
} from '../../src/lib/format';

describe('ordinal', () => {
  // ---- The bug this function exists to fix ----
  it('uses "nd" for 22, not "th"', () => {
    // The chapter was the 22nd largest VVA chapter in 2020. Naive `${n}th`
    // rendered "22th" in the five-year table on /give/impact.
    expect(ordinal(22)).toBe('22nd');
  });

  // ---- Happy path ----
  it('handles the ranks the chapter has actually held', () => {
    expect(ordinal(17)).toBe('17th');
    expect(ordinal(18)).toBe('18th');
    expect(ordinal(21)).toBe('21st');
    expect(ordinal(23)).toBe('23rd');
  });

  // ---- Edge cases: the teens exception ----
  it('uses "th" for 11, 12 and 13 despite their last digits', () => {
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
  });

  it('applies the teens exception only within each century', () => {
    expect(ordinal(111)).toBe('111th');
    expect(ordinal(112)).toBe('112th');
    expect(ordinal(121)).toBe('121st');
    expect(ordinal(122)).toBe('122nd');
  });

  it('handles single digits and zero', () => {
    expect(ordinal(0)).toBe('0th');
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
  });

  // ---- Sad path ----
  it('throws on negative numbers', () => {
    expect(() => ordinal(-1)).toThrow(/ordinal\(\) requires a non-negative integer/);
  });

  it('throws on non-integers rather than rendering "17.5th"', () => {
    expect(() => ordinal(17.5)).toThrow(/ordinal\(\) requires a non-negative integer/);
    expect(() => ordinal(NaN)).toThrow(/ordinal\(\) requires a non-negative integer/);
  });
});

describe('parseIssue', () => {
  // ---- Happy path ----
  it('derives year, month and a human label from a YYYYMM filename', () => {
    expect(parseIssue('The_Journey_202411.pdf')).toEqual({
      file: 'The_Journey_202411.pdf',
      year: 2024,
      month: 11,
      label: 'November 2024',
    });
  });

  it('labels January and December correctly at the array boundaries', () => {
    expect(parseIssue('The_Journey_201701.pdf')?.label).toBe('January 2017');
    expect(parseIssue('The_Journey_202012.pdf')?.label).toBe('December 2020');
  });

  // ---- Sad path ----
  it('returns null for a filename with no date stamp', () => {
    expect(parseIssue('The_Journey.pdf')).toBeNull();
    expect(parseIssue('board-minutes.pdf')).toBeNull();
  });

  it('returns null rather than guessing when the month is out of range', () => {
    // 202413 and 202400 are corrupt stamps. Silently coercing them would put a
    // wrong date in the archive, which is the exact defect being fixed.
    expect(parseIssue('The_Journey_202413.pdf')).toBeNull();
    expect(parseIssue('The_Journey_202400.pdf')).toBeNull();
  });

  it('rejects years before the chapter existed', () => {
    expect(parseIssue('The_Journey_198401.pdf')).toBeNull();
  });

  it('returns null for non-string input instead of throwing', () => {
    expect(parseIssue(undefined as unknown as string)).toBeNull();
    expect(parseIssue(null as unknown as string)).toBeNull();
    expect(parseIssue(42 as unknown as string)).toBeNull();
  });

  // ---- Edge cases ----
  it('accepts the chapter founding year as the lower boundary', () => {
    expect(parseIssue('x_198507.pdf')?.year).toBe(1985);
  });

  it('handles an empty string', () => {
    expect(parseIssue('')).toBeNull();
  });
});

describe('parseIssueStrict', () => {
  it('returns the issue when the filename parses', () => {
    expect(parseIssueStrict('The_Journey_202301.pdf').label).toBe('January 2023');
  });

  it('throws naming the offending filename so a build failure is actionable', () => {
    expect(() => parseIssueStrict('nonsense.pdf')).toThrow(
      /Unparseable newsletter filename: "nonsense\.pdf".*YYYYMM/,
    );
  });
});

describe('groupIssuesByYear', () => {
  // ---- Happy path ----
  it('groups issues by year, newest year and newest month first', () => {
    const result = groupIssuesByYear([
      'The_Journey_202301.pdf',
      'The_Journey_202411.pdf',
      'The_Journey_202403.pdf',
    ]);

    expect(result.map((g) => g.year)).toEqual([2024, 2023]);
    expect(result[0].issues.map((i) => i.month)).toEqual([11, 3]);
    expect(result[1].issues.map((i) => i.label)).toEqual(['January 2023']);
  });

  // ---- The defect this function exists to fix ----
  it('drops duplicate issues for the same month', () => {
    // The legacy archive listed 53 entries for 50 unique files: November 2022,
    // May 2022 and January 2019 each appeared twice.
    const result = groupIssuesByYear([
      'The_Journey_202211.pdf',
      'The_Journey_202211.pdf',
      'The_Journey_202205.pdf',
      'The_Journey_202205.pdf',
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].issues).toHaveLength(2);
    expect(result[0].issues.map((i) => i.label)).toEqual(['November 2022', 'May 2022']);
  });

  // ---- Sad path ----
  it('skips unparseable filenames rather than failing the whole archive', () => {
    const result = groupIssuesByYear(['The_Journey_202401.pdf', 'junk.pdf', 'The_Journey_209913.pdf']);
    expect(result).toHaveLength(1);
    expect(result[0].issues).toHaveLength(1);
  });

  // ---- Edge cases ----
  it('returns an empty array for empty input', () => {
    expect(groupIssuesByYear([])).toEqual([]);
  });

  it('returns an empty array when nothing parses', () => {
    expect(groupIssuesByYear(['a.pdf', 'b.pdf'])).toEqual([]);
  });
});

describe('currency', () => {
  it('formats whole dollars with thousands separators', () => {
    expect(currency(39700)).toBe('$39,700');
    expect(currency(33068)).toBe('$33,068');
  });

  it('rounds to whole dollars — the chapter never publishes cents', () => {
    expect(currency(784.49)).toBe('$784');
    expect(currency(784.5)).toBe('$785');
  });

  it('handles zero and small values', () => {
    expect(currency(0)).toBe('$0');
    expect(currency(250)).toBe('$250');
  });

  it('throws on NaN rather than rendering "$NaN" to a donor', () => {
    expect(() => currency(NaN)).toThrow(/currency\(\) requires a finite number/);
  });

  it('throws on Infinity', () => {
    expect(() => currency(Infinity)).toThrow(/currency\(\) requires a finite number/);
  });
});

describe('mapUrl', () => {
  it('builds an encoded Google Maps search URL', () => {
    const url = mapUrl('American Legion Post 177, 3939 Oak St, Fairfax, VA');
    expect(url).toBe(
      'https://www.google.com/maps/search/?api=1&query=American%20Legion%20Post%20177%2C%203939%20Oak%20St%2C%20Fairfax%2C%20VA',
    );
  });

  it('trims surrounding whitespace before encoding', () => {
    expect(mapUrl('  Fairfax, VA  ')).toBe('https://www.google.com/maps/search/?api=1&query=Fairfax%2C%20VA');
  });

  it('throws on an empty or whitespace-only address', () => {
    expect(() => mapUrl('')).toThrow(/mapUrl\(\) requires a non-empty address/);
    expect(() => mapUrl('   ')).toThrow(/mapUrl\(\) requires a non-empty address/);
  });
});

describe('addressLine', () => {
  it('joins parts with commas', () => {
    expect(addressLine(['P.O. Box 5653', 'Arlington', 'VA 22205'])).toBe('P.O. Box 5653, Arlington, VA 22205');
  });

  it('skips null, undefined and blank parts instead of emitting empty segments', () => {
    expect(addressLine(['P.O. Box 5653', null, undefined, '  ', 'Arlington'])).toBe('P.O. Box 5653, Arlington');
  });

  it('trims each part', () => {
    expect(addressLine([' A ', ' B '])).toBe('A, B');
  });

  it('returns an empty string when nothing survives filtering', () => {
    expect(addressLine([null, undefined, ''])).toBe('');
  });
});
