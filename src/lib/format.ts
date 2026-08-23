/**
 * Pure formatting helpers. No I/O, no framework imports — every function here
 * is directly unit-testable without mocks.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export interface Issue {
  /** Original filename, e.g. "The_Journey_202411.pdf" */
  file: string;
  year: number;
  /** 1-12 */
  month: number;
  /** Human label, e.g. "November 2024" */
  label: string;
}

/**
 * Turn "The_Journey_202411.pdf" into a dated issue.
 *
 * The legacy site showed raw filenames to visitors. Deriving the label from the
 * filename means the archive can never disagree with its own labels.
 *
 * @returns null when the filename carries no parseable YYYYMM stamp.
 */
export function parseIssue(file: string): Issue | null {
  if (typeof file !== 'string') return null;

  const match = file.match(/(\d{4})(\d{2})/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);

  // A stamp like 202413 or 202400 is corrupt data, not a date we should guess at.
  if (month < 1 || month > 12) return null;
  // The chapter was founded in 1985; anything before that is a parse artifact.
  if (year < 1985 || year > 2100) return null;

  return { file, year, month, label: `${MONTHS[month - 1]} ${year}` };
}

/**
 * Strict variant for build-time data where a bad filename is a defect that
 * should stop the build rather than silently vanish from the archive.
 */
export function parseIssueStrict(file: string): Issue {
  const issue = parseIssue(file);
  if (!issue) {
    throw new Error(`Unparseable newsletter filename: "${file}" (expected a YYYYMM stamp)`);
  }
  return issue;
}

/**
 * Group issues newest-first into year buckets, dropping duplicates.
 *
 * The legacy archive listed 53 entries for 50 unique files — November 2022,
 * May 2022 and January 2019 each appeared twice.
 */
export function groupIssuesByYear(files: readonly string[]): Array<{ year: number; issues: Issue[] }> {
  const seen = new Set<string>();
  const byYear = new Map<number, Issue[]>();

  for (const file of files) {
    const issue = parseIssue(file);
    if (!issue) continue;

    const key = `${issue.year}-${issue.month}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const bucket = byYear.get(issue.year);
    if (bucket) bucket.push(issue);
    else byYear.set(issue.year, [issue]);
  }

  return [...byYear.entries()]
    .map(([year, issues]) => ({
      year,
      issues: issues.sort((a, b) => b.month - a.month),
    }))
    .sort((a, b) => b.year - a.year);
}

/**
 * English ordinal suffix: 17 -> "17th", 22 -> "22nd", 1 -> "1st".
 *
 * Naively appending "th" is wrong for 1, 2, 3 and their compounds, which
 * matters here because the chapter's national ranking has been 22nd, 18th and
 * 17th across the years reported.
 */
export function ordinal(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`ordinal() requires a non-negative integer, received: ${n}`);
  }
  const lastTwo = n % 100;
  // 11th, 12th, 13th are the exceptions to the last-digit rule.
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Whole-dollar formatting. The chapter never publishes cents. */
export function currency(amount: number): string {
  if (!Number.isFinite(amount)) {
    throw new Error(`currency() requires a finite number, received: ${amount}`);
  }
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

/**
 * Build a Google Maps search URL from a plain address string.
 * Used so the meeting venue is one tap away on a phone — the legacy site
 * printed "Click for Directions with Google Maps" as plain text with no link.
 */
export function mapUrl(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('mapUrl() requires a non-empty address');
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(trimmed)}`;
}

/** Join address parts, skipping blanks, for a single-line display. */
export function addressLine(parts: ReadonlyArray<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim())
    .join(', ');
}
