import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadPages, readPublicFile } from '../helpers/dist';
import { schemaSql } from '../helpers/d1';
import { runTracker } from '../helpers/tracker-harness';
import { RETENTION_DAYS, RETENTION_MONTHS, SALT_PERIOD_DAYS } from '../../src/data/analytics';
import { pruneCutoff } from '../../src/lib/beacon';

/**
 * INVARIANT — the privacy page describes what the visit log actually keeps.
 *
 * The owner's standing rule is that the policy follows the feature. Before the
 * visit log, /privacy said the site collected nothing and ran no analytics;
 * that sentence would have stayed true-looking forever, because nothing tied
 * it to the code. These assertions tie it:
 *
 *   - every column of every table the migrations create has a named
 *     disclosure on the built page, so a column added without one fails;
 *   - no column could hold an IP address or a browser string;
 *   - the retention period on the page is the one the collector enforces;
 *   - the "changes every day" claim holds only while the salt period is a day;
 *   - the code is promised to be irreversible and unlinkable only as far as
 *     one fixed secret allows;
 *   - the opt-out the page describes is the one the SHIPPED beacon honours;
 *   - the old "collects nothing" claims are gone.
 *
 * TIER JUSTIFICATION: no single module holds both halves. The schema lives in
 * migrations/, the retention in the registry, the opt-out in dist/b.js and the
 * promise in dist/privacy.html. Only a check across the whole build can see a
 * column, a period or a signal drift away from the sentence describing it.
 */

/**
 * Each stored column, and the words on /privacy that disclose it. Explicit on
 * purpose: a new column must be added here, with the sentence that describes
 * it to a reader, or the first test fails.
 */
const DISCLOSURES: Record<string, string> = {
  'views.view': 'a random number for that one page view',
  'views.site': 'Which page you looked at on this website',
  'views.visitor': 'A visitor code that changes every day',
  'views.path': 'Which page you looked at',
  'views.referrer': 'If you came from another page of this website, the record shows which page that was',
  'views.country': 'Your approximate location: city, state and country',
  'views.city': 'Your approximate location: city, state and country',
  'views.region': 'Your approximate location: city, state and country',
  'views.asn': 'the number that identifies its network',
  'views.as_org': 'The name of your internet provider',
  'views.viewport_w': 'The size of your browser window',
  'views.viewport_h': 'The size of your browser window',
  'views.engaged_ms': 'How long the page was open and visible on your screen',
  'views.ts': 'The date and time of the visit',
  // wrangler's bookkeeping, created by the setup script: migration file names.
  'd1_migrations.id': '',
  'd1_migrations.name': '',
  'd1_migrations.applied_at': '',
};

/** Tables that hold nothing about a visitor, and why. */
const NOT_ABOUT_VISITORS: Record<string, string> = {
  d1_migrations: 'which schema files have been applied; created by tools/setup-analytics.mjs and by wrangler',
};

/** Column names that would hold what the page says is not kept. */
const FORBIDDEN_COLUMN = /(^|_)(ip|ips|ip_?addr(ess)?|addr(ess)?|user_?agent|ua|lat|lon|lng|latitude|longitude|postal|zip|postcode|cookie|email)($|_)/i;

const privacy = loadPages().find((p) => p.route === '/privacy');
const text = (privacy?.text ?? '').replace(/\s+/g, ' ');

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/** docs/analytics.md, which tells the owner what /privacy tells a visitor. */
const doc = read('docs/analytics.md').replace(/\s+/g, ' ');

/** The collector's source: its handler and the logic it runs. */
const collector = ['functions/api/e.ts', 'src/lib/beacon.ts'].map(read).join('\n');

/**
 * Whether each day's key is forgotten: a salt table in the schema that the
 * collector deletes from. Today there is none. The hash takes one BEACON_SALT,
 * written once by the setup script and never changed, and only the date in it
 * moves.
 */
function forgetsDailyKeys(schema: string, collectorSource: string): boolean {
  const tables = [...schema.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w*salt\w*)/gi)].map((m) => m[1]);
  return tables.some((table) => new RegExp(`DELETE FROM ${table}\\b`, 'i').test(collectorSource));
}

/** Words that say the code cannot be undone, and words that say nobody at all could link it. */
const IRREVERSIBLE = /cannot be (?:turned back|traced back|reversed)|not reversible|irreversible/i;
const NOBODY = /the chapter included|even by us|by anyone/i;

/**
 * Sentences that promise more than one fixed secret allows: that the code
 * cannot be undone, with no "without" to say what it takes, or that nobody,
 * the chapter included, could use it to link one day's visitor to the next.
 */
function overclaims(words: string): string[] {
  return words.split(/(?<=[.!?]) /).filter((s) => NOBODY.test(s) || (IRREVERSIBLE.test(s) && !/\bwithout\b/i.test(s)));
}

/** Every `table.column` in a schema, visitor tables and bookkeeping alike. */
function columnsOf(sql: string): string[] {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sql);
    // The setup script adds wrangler's bookkeeping table; it is part of the database too.
    db.exec('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    return tables.flatMap(({ name }) => (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((c) => `${name}.${c.name}`));
  } finally {
    db.close();
  }
}

/** Columns with no disclosure, and disclosures for columns that no longer exist. */
function disclosureGaps(columns: string[]) {
  const undisclosed = columns.filter((c) => !(c in DISCLOSURES));
  const stale = Object.keys(DISCLOSURES).filter((c) => !columns.includes(c));
  const unsaid = columns.filter((c) => c in DISCLOSURES && DISCLOSURES[c] && !text.includes(DISCLOSURES[c]));
  const unexplained = columns.filter((c) => c in DISCLOSURES && !DISCLOSURES[c] && !(c.split('.')[0] in NOT_ABOUT_VISITORS));
  return { undisclosed, stale, unsaid, unexplained };
}

describe('the privacy page', () => {
  it('was built', () => {
    expect(privacy, 'dist/privacy.html is missing; run the build first').toBeDefined();
    expect(text.length).toBeGreaterThan(1000);
  });

  it('discloses every column the visit log stores, in words a reader can find', () => {
    expect(disclosureGaps(columnsOf(schemaSql()))).toEqual({ undisclosed: [], stale: [], unsaid: [], unexplained: [] });
  });

  it('can actually fail: a column added without a disclosure is caught', () => {
    const gaps = disclosureGaps(columnsOf(`${schemaSql()}\nALTER TABLE views ADD COLUMN screen_dpi INTEGER;`));
    expect(gaps.undisclosed).toEqual(['views.screen_dpi']);
  });

  it('can actually fail: a disclosure missing from the page is caught', () => {
    const saved = DISCLOSURES['views.ts'];
    DISCLOSURES['views.ts'] = 'The exact second you blinked';
    try {
      expect(disclosureGaps(columnsOf(schemaSql())).unsaid).toEqual(['views.ts']);
    } finally {
      DISCLOSURES['views.ts'] = saved;
    }
  });

  it('keeps no column that could hold an IP address, a browser string, a precise place or an email', () => {
    const columns = columnsOf(schemaSql()).map((c) => c.split('.')[1]);
    expect(columns.filter((c) => FORBIDDEN_COLUMN.test(c))).toEqual([]);
    expect(text).toContain('Your IP address, the number that identifies your internet connection.');
    expect(text).toContain('it is never stored');
  });

  it('can actually fail: the forbidden-column pattern catches the usual names', () => {
    for (const name of ['ip', 'client_ip', 'ip_address', 'user_agent', 'ua', 'lat', 'longitude', 'postal_code', 'email']) {
      expect(FORBIDDEN_COLUMN.test(name), name).toBe(true);
    }
    for (const name of ['visitor', 'viewport_w', 'region', 'asn', 'as_org', 'path']) {
      expect(FORBIDDEN_COLUMN.test(name), name).toBe(false);
    }
  });

  it('states the retention period the collector enforces, as a whole number of months', () => {
    expect(Number.isInteger(RETENTION_MONTHS)).toBe(true);
    expect((RETENTION_MONTHS * 365) / 12).toBe(RETENTION_DAYS);
    // The collector prunes at exactly RETENTION_DAYS.
    const now = Date.UTC(2026, 9, 17);
    expect(now - pruneCutoff(now)).toBe(RETENTION_DAYS * 86_400_000);
    expect(text).toContain(`Records are kept for ${RETENTION_MONTHS} months.`);
    expect(text).toContain(`more than ${RETENTION_MONTHS} months old, it is deleted automatically`);
    // And no other period anywhere on the page.
    const periods = [...text.matchAll(/(\d+)\s+(months?|years?|days?)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(new Set(periods)).toEqual(new Set([`${RETENTION_MONTHS} months`]));
  });

  it('says the visitor code changes every day only while it does', () => {
    expect(SALT_PERIOD_DAYS, 'the salt period changed; rewrite "The daily visitor code" on /privacy').toBe(1);
    expect(text).toContain('the code changes every day');
    expect(text).toContain('A visitor code that changes every day');
  });

  it('says the rest of a record is kept as it is, and can still make a frequent visitor recognizable', () => {
    // Only the code changes daily. Place, provider and window size are stored
    // unchanged, and /stats shows place, network and phone-or-computer for
    // every visitor-day, so a regular reader from a small town stands out on
    // any day without the code's help.
    expect(text).toContain('The other details in a record, such as your town, your internet provider and the size of your browser window, are kept as they are');
    expect(text).toContain('someone who visits often from a small place may still be recognizable from them');
  });

  it('promises the visitor code cannot be undone or linked only as far as one fixed secret allows', () => {
    // Whoever holds BEACON_SALT can work an IPv4 address back out of a stored
    // code and recompute that visitor's code for any other day (the unit test
    // of visitorHash shows it). Until each day's key is forgotten, neither
    // the page nor the owner's documentation may say otherwise.
    const found = forgetsDailyKeys(schemaSql(), collector)
      ? []
      : [...overclaims(text).map((s) => `/privacy: ${s}`), ...overclaims(doc).map((s) => `docs/analytics.md: ${s}`)];
    expect(found).toEqual([]);
    expect(text).toContain('a secret key that only this website’s server holds');
    expect(text).toContain('Without that key, the code cannot be traced back to your internet connection');
    expect(text).toContain('the code by itself cannot link a visit on one day to a visit on another');
    expect(doc).toContain('cannot be reversed without the `BEACON_SALT` secret');
  });

  it('can actually fail: the old promise is caught, a qualified one is not, and only a forgotten daily key allows it', () => {
    const old =
      'The code cannot be turned back into your IP address. Because the date is part of it, the code changes every day, so it cannot be used by anyone, the chapter included, to tell that a visitor today and a visitor tomorrow were the same person.';
    expect(overclaims(old)).toHaveLength(2);
    expect(overclaims('It changes every day and cannot be reversed.')).toHaveLength(1);
    expect(overclaims('It cannot be reversed without the `BEACON_SALT` secret.')).toEqual([]);

    expect(forgetsDailyKeys(schemaSql(), collector)).toBe(false);
    const daily = `${schemaSql()}\nCREATE TABLE salts (day INTEGER PRIMARY KEY, value TEXT NOT NULL);`;
    expect(forgetsDailyKeys(daily, collector), 'a table nothing empties forgets nothing').toBe(false);
    expect(forgetsDailyKeys(daily, `${collector}\nDELETE FROM salts WHERE day < ?1`)).toBe(true);
  });

  it('describes the opt-out the shipped beacon honours: with either signal, nothing at all happens', () => {
    expect(text).toContain('Global Privacy Control');
    expect(text).toContain('Do Not Track');
    expect(text).toContain('no note is sent, and no record of your visit is made');

    const shipped = readPublicFile('b.js');
    for (const signal of [{ navigator: { globalPrivacyControl: true } }, { navigator: { doNotTrack: '1' } }, { window: { doNotTrack: '1' } }]) {
      const run = runTracker(shipped, signal);
      expect({ sent: run.sent, listeners: run.listeners, intervals: run.intervals }).toEqual({ sent: [], listeners: [], intervals: [] });
    }
    // Control: without a signal the same file does send, so the above is not a beacon that never sends.
    expect(runTracker(shipped).sent).toHaveLength(1);
  });

  it('no longer claims the site collects nothing or runs no analytics', () => {
    for (const claim of [/collects? nothing/i, /does not collect anything/i, /runs? no analytics/i, /\bno analytics\b/i, /not collect anything about you/i, /Nothing\. This site is a set of static files/]) {
      expect(text, String(claim)).not.toMatch(claim);
    }
    expect(text).toContain('this website counts visits to its pages');
  });

  it('carries the note that the chapter has not yet approved the counting', () => {
    const note = privacy!.$('aside.review').text().replace(/\s+/g, ' ');
    expect(note).toContain('has not been reviewed by the chapter');
    expect(note).toContain('The visit counting described above is new');
    expect(note).toContain('needs the chapter’s sign-off');
  });
});
