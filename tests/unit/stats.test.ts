import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import {
  AUTOMATED_LISTS,
  automatedExplanation,
  automatedReasonLabel,
  automatedReasonSql,
  buildStatsPageData,
  buildStatsSql,
  classifyReferrer,
  DEFAULT_DAYS,
  deviceOf,
  escapeHtml,
  etDay,
  formatCount,
  formatDuration,
  formatEt,
  formatNetwork,
  formatNetworkWithNumber,
  formatPlace,
  groupVisitorDays,
  isSiteHost,
  pageCsp,
  parseWindow,
  PEOPLE_ROW_LIMIT,
  renderStatsPage,
  setAsideTotals,
  sha256Base64,
  shortVisitor,
  statsCsp,
  STATS_STYLE,
  summarizeSources,
  TABLE_LIMIT,
  tallyPeople,
  WINDOWS,
  type AutomatedLists,
  type StatsPageData,
  type VisitRow,
} from '../../src/lib/stats';
import { ACCESS_JWT_HEADER, authorizeStats, createAccessGate } from '../../src/lib/stats-gate';
import { accessSetting } from '../../src/lib/access';
import { accessEnv, AUD, certsServer, claimsFor, createSigner, TEAM, type Signer } from '../helpers/access-jwt';
import { CRAWLER_NETWORKS, CRAWLER_WINDOWS, NOTHING_READ_COUNTRIES, NOTHING_READ_NETWORKS, SITE_HOSTS } from '../../src/data/analytics';

/**
 * UNIT — the stats page's pure pieces: windows, time zones, referrer
 * classification, visitor-day grouping, escaping and the CSP hash.
 *
 * TIER JUSTIFICATION: the feature and integration tiers can only produce what
 * the collector would store and what one clock reading gives. Daylight-saving
 * boundaries, a referrer the URL parser rejects, a row missing every optional
 * field, a hash that straddles Eastern midnight — those need the functions
 * called directly with hand-built rows.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 17, 16, 0); // 12:00 EDT
const params = (qs: string) => new URLSearchParams(qs);

const row = (over: Partial<VisitRow> = {}): VisitRow => ({
  view: '0000000000000001',
  visitor: 'a'.repeat(32),
  ts: NOW,
  path: '/',
  referrer: null,
  country: null,
  city: null,
  region: null,
  asn: null,
  as_org: null,
  viewport_w: null,
  engaged_ms: 0,
  ...over,
});

const STATS_SQL_KEYS = (sql: object) => Object.keys(sql);

const emptyPage = (over: Partial<StatsPageData> = {}): StatsPageData => ({
  days: 30,
  generatedAt: NOW,
  summary: { views: 0, visitors: 0, pages: 0, automated_visitors: 0, automated_views: 0 },
  visitors: [],
  pages: [],
  sources: [],
  locations: [],
  networks: [],
  automated: [],
  ...over,
});

describe('parseWindow', () => {
  it.each(WINDOWS.map((d) => [d]))('accepts the offered window of %i days', (days) => {
    expect(parseWindow(params(`days=${days}`), NOW)).toEqual({ days, since: NOW - days * DAY });
  });

  it.each([
    ['absent', ''],
    ['not a number', 'days=lots'],
    ['not on the list', 'days=45'],
    ['one under an offered window', 'days=6'],
    ['one over an offered window', 'days=8'],
    ['negative', 'days=-30'],
    ['zero', 'days=0'],
    ['absurd', 'days=999999999999'],
    ['scientific notation', 'days=1e9'],
    ['Infinity', 'days=Infinity'],
    ['injection-shaped', 'days=30;DROP TABLE views'],
  ])('falls back to the default when days is %s', (_label, qs) => {
    // An allowlist, not a clamp: the value becomes a bound timestamp, and
    // "30;DROP TABLE" must never be a number at all.
    expect(parseWindow(params(qs), NOW)).toEqual({ days: DEFAULT_DAYS, since: NOW - DEFAULT_DAYS * DAY });
  });

  it('survives having no query string object at all', () => {
    expect(parseWindow(null, NOW).days).toBe(DEFAULT_DAYS);
  });
});

describe('escapeHtml', () => {
  it.each([
    ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['" onmouseover="evil()', '&quot; onmouseover=&quot;evil()'],
    ["' onfocus='evil()", '&#39; onfocus=&#39;evil()'],
    ['a & b', 'a &amp; b'],
    ['&lt;already&gt;', '&amp;lt;already&amp;gt;'],
  ])('escapes %j', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it.each([
    ['null', null, ''],
    ['undefined', undefined, ''],
    ['a number', 42, '42'],
  ])('renders %s as a harmless string', (_label, value, expected) => {
    expect(escapeHtml(value)).toBe(expected);
  });
});

describe('formatDuration and formatCount', () => {
  it.each([
    [0, '0s'],
    [999, '1s'],
    [47_312, '47s'],
    [59_999, '1m'], // rounds to 60s, which is a minute — "60s" would be the bug
    [90_000, '1m 30s'],
    [3_599_000, '59m 59s'],
    [3_600_000, '1h'],
    [5_400_000, '1h 30m'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', NaN],
    ['a word', 'ages'],
    ['negative', -5000],
  ])('treats %s as zero rather than printing NaN or a negative', (_label, value) => {
    expect(formatDuration(value)).toBe('0s');
  });

  it.each([
    [3, '3'],
    [2.6, '3'],
    ['7', '7'],
    [null, '0'],
    [NaN, '0'],
    [Infinity, '0'],
  ])('formatCount(%j) is %j', (value, expected) => {
    expect(formatCount(value)).toBe(expected);
  });
});

describe('Eastern time', () => {
  it('formats a timestamp as Eastern wall-clock time', () => {
    expect(formatEt(NOW)).toBe('2026-10-17 12:00');
  });

  it('follows daylight saving rather than a fixed offset', () => {
    // 04:30 UTC is 00:30 EDT in October and 23:30 EST in January.
    expect(etDay(Date.UTC(2026, 9, 17, 4, 30))).toBe('2026-10-17');
    expect(etDay(Date.UTC(2026, 0, 17, 4, 30))).toBe('2026-01-16');
  });

  it('turns over at Eastern midnight, not UTC midnight', () => {
    const etMidnight = Date.UTC(2026, 9, 17, 4, 0); // 00:00 EDT
    expect(etDay(etMidnight - 1)).toBe('2026-10-16');
    expect(etDay(etMidnight)).toBe('2026-10-17');
    expect(formatEt(etMidnight)).toBe('2026-10-17 00:00');
  });

  it.each([
    ['NaN', NaN],
    ['null', null],
    ['a word', 'soon'],
    ['beyond the Date range', 8.64e15 + 1],
  ])('degrades instead of throwing on %s', (_label, ts) => {
    expect(formatEt(ts)).toBe('-');
    expect(etDay(ts)).toBe('unknown');
  });
});

describe('deviceOf, formatPlace, formatNetwork, shortVisitor', () => {
  it.each([
    [1920, 'desktop'],
    [700, 'desktop'],
    [699, 'mobile'],
    [375, 'mobile'],
  ])('calls a %ipx viewport %s', (w, expected) => {
    expect(deviceOf(w)).toBe(expected);
  });

  it.each([[null], [undefined], [0], [-1], [NaN], ['wide']])('leaves an unknown viewport unknown (%j)', (w) => {
    // Inventing "desktop" is worse than admitting the row does not say.
    expect(deviceOf(w)).toBe('-');
  });

  it.each([
    ['every part', { city: 'Fairfax', region: 'VA', country: 'US' }, 'Fairfax, VA, US'],
    ['only a country', { country: 'US' }, 'US'],
    ['no region', { city: 'Dublin', country: 'IE' }, 'Dublin, IE'],
    ['nothing', {}, '-'],
    ['nulls', { city: null, region: null, country: null }, '-'],
    ['blank strings', { city: '  ', region: '', country: 'US' }, 'US'],
    ['wrong types', { city: 12, region: {}, country: 'US' }, 'US'],
  ])('formats a place with %s', (_label, place, expected) => {
    expect(formatPlace(place)).toBe(expected);
  });

  it.each([
    ['a name', { as_org: 'Verizon Business', asn: 701 }, 'Verizon Business'],
    ['only a number', { as_org: null, asn: 701 }, 'AS701'],
    ['a blank name', { as_org: '   ', asn: 701 }, 'AS701'],
    ['neither', {}, '-'],
    ['ASN zero', { asn: 0 }, '-'],
    ['a non-numeric ASN', { asn: 'seven' }, '-'],
    ['an infinite ASN', { asn: Infinity }, '-'],
  ])('formats a network with %s', (_label, net, expected) => {
    expect(formatNetwork(net)).toBe(expected);
  });

  it.each([
    ['a name and a number', { as_org: 'Verizon Business', asn: 701 }, 'Verizon Business (AS701)'],
    ['only a number', { as_org: null, asn: 701 }, 'AS701'],
    ['only a name', { as_org: 'Verizon Business', asn: null }, 'Verizon Business'],
    ['a blank name', { as_org: '  ', asn: 701 }, 'AS701'],
    ['neither', {}, '-'],
    ['an infinite number', { as_org: 'X', asn: Infinity }, 'X'],
    ['a negative number', { as_org: 'X', asn: -1 }, 'X'],
  ])('formats a network with its number when it has %s', (_label, net, expected) => {
    expect(formatNetworkWithNumber(net)).toBe(expected);
  });

  it('shortens a visitor hash to six characters', () => {
    expect(shortVisitor('0123456789abcdef')).toBe('012345');
    expect(shortVisitor('abc')).toBe('abc');
    expect(shortVisitor(null)).toBe('');
  });
});

describe('isSiteHost and classifyReferrer', () => {
  it.each([
    'vva227.org',
    'www.vva227.org',
    'VVA227.ORG',
    'vva227.org.',
    'vva227-refresh-12g.pages.dev',
    'abc123.vva227-refresh-12g.pages.dev',
    'abc123.vva227-refresh.pages.dev',
    'localhost',
    '127.0.0.1',
  ])('treats %s as this site', (host) => {
    expect(isSiteHost(host)).toBe(true);
  });

  it.each([
    ['a lookalike suffix', 'vva227.org.evil.example'],
    ['a lookalike prefix', 'evilvva227.org'],
    ['an unlisted subdomain of the real domain', 'mail.vva227.org'],
    ['another pages.dev project', 'vva227-refresh-12gx.pages.dev'],
    ['a name ending in the suffix without a dot', 'xvva227-refresh-12g.pages.dev'],
    ['the bare suffix', '.vva227-refresh-12g.pages.dev'],
    ['empty', ''],
  ])('does not treat %s as this site', (_label, host) => {
    expect(isSiteHost(host)).toBe(false);
  });

  it('reads the registry rather than its own list', () => {
    expect(isSiteHost('example.org', ['example.org'])).toBe(true);
    expect(isSiteHost('vva227.org', ['example.org'])).toBe(false);
    expect(SITE_HOSTS.length).toBeGreaterThan(0);
  });

  it.each([
    ['nothing', null, { kind: 'direct' }],
    ['an empty string', '', { kind: 'direct' }],
    ['whitespace', '   ', { kind: 'direct' }],
    ['a search engine', 'https://www.google.com/', { kind: 'external', host: 'www.google.com' }],
    ['a deep link', 'https://www.facebook.com/VVA227/posts/1', { kind: 'external', host: 'www.facebook.com' }],
    ['an Android app', 'android-app://com.google.android.gm/', { kind: 'external', host: 'com.google.android.gm' }],
    ['this site', 'https://vva227.org/about', { kind: 'internal', host: 'vva227.org' }],
    ['a preview deployment', 'https://abc.vva227-refresh-12g.pages.dev/', { kind: 'internal', host: 'abc.vva227-refresh-12g.pages.dev' }],
    ['a local run, with its port', 'http://localhost:4321/give', { kind: 'internal', host: 'localhost:4321' }],
    ['an unparseable value with space around it', '  not a url  ', { kind: 'external', host: 'not a url' }],
    ['a URL with no host', ' mailto:someone@example.org?subject=hi ', { kind: 'external', host: 'mailto:someone@example.org' }],
  ])('classifies %s', (_label, referrer, expected) => {
    expect(classifyReferrer(referrer)).toEqual(expected);
  });

  it('shows an unparseable referrer as a cut-down external label rather than hiding it', () => {
    expect(classifyReferrer('not a url?token=secret')).toEqual({ kind: 'external', host: 'not a url' });
    expect((classifyReferrer('x'.repeat(500)) as { host: string }).host).toHaveLength(64);
    expect((classifyReferrer(`mailto:${'x'.repeat(500)}@example.org`) as { host: string }).host).toHaveLength(64);
  });
});

describe('groupVisitorDays', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const t = (h: number, m = 0) => Date.UTC(2026, 9, 17, h, m); // UTC hours; EDT is UTC-4

  it('builds one visitor-day with every field the table shows', () => {
    const days = groupVisitorDays([
      row({ view: '01', visitor: A, ts: t(14, 0), path: '/', referrer: 'https://www.google.com/', city: 'Fairfax', region: 'VA', country: 'US', asn: 7922, as_org: 'Comcast', viewport_w: 390, engaged_ms: 30_000 }),
      row({ view: '02', visitor: A, ts: t(14, 2), path: '/give', referrer: 'https://vva227.org/', city: 'Fairfax', region: 'VA', country: 'US', asn: 7922, as_org: 'Comcast', viewport_w: 390, engaged_ms: 45_000 }),
    ]);
    expect(days).toEqual([
      {
        visitor: A,
        day: '2026-10-17',
        firstSeen: t(14, 0),
        lastSeen: t(14, 2),
        place: 'Fairfax, VA, US',
        network: 'Comcast',
        device: 'mobile',
        source: 'www.google.com',
        entry: '/',
        views: 2,
        engagedMs: 75_000,
      },
    ]);
  });

  it('takes the entry page from the earliest view whatever order the rows arrive in', () => {
    const [day] = groupVisitorDays([
      row({ view: '03', visitor: A, ts: t(15), path: '/contact' }),
      row({ view: '01', visitor: A, ts: t(13), path: '/about' }),
      row({ view: '02', visitor: A, ts: t(14), path: '/give' }),
    ]);
    expect(day.entry).toBe('/about');
    expect(day.firstSeen).toBe(t(13));
    expect(day.lastSeen).toBe(t(15));
  });

  it('orders a day by time before view id, and views at the same moment by view id, one with none first', () => {
    // Either order of arrival gives the same entry page, so the table does
    // not change between two loads of the page.
    const entry = (rows: VisitRow[]) => [groupVisitorDays(rows)[0].entry, groupVisitorDays([...rows].reverse())[0].entry];
    expect(entry([row({ view: 'ff', visitor: A, ts: t(13), path: '/first' }), row({ view: '01', visitor: A, ts: t(14), path: '/second' })])).toEqual(['/first', '/first']);
    expect(entry([row({ view: '01', visitor: A, ts: t(13), path: '/z' }), row({ view: '02', visitor: A, ts: t(13), path: '/a' })])).toEqual(['/z', '/z']);
    expect(entry([row({ view: undefined, visitor: A, ts: t(13), path: '/z' }), row({ view: '02', visitor: A, ts: t(13), path: '/a' })])).toEqual(['/z', '/z']);
  });

  it('names the FIRST external referrer as the source, skipping internal ones', () => {
    const [day] = groupVisitorDays([
      row({ view: '01', visitor: A, ts: t(13), referrer: 'https://vva227.org/' }),
      row({ view: '02', visitor: A, ts: t(14), referrer: 'https://l.facebook.com/' }),
      row({ view: '03', visitor: A, ts: t(15), referrer: 'https://www.google.com/' }),
    ]);
    expect(day.source).toBe('l.facebook.com');
  });

  it('calls a visitor-day with only internal or no referrers direct', () => {
    const [day] = groupVisitorDays([
      row({ view: '01', visitor: A, ts: t(13), referrer: null }),
      row({ view: '02', visitor: A, ts: t(14), referrer: 'https://vva227.org/' }),
    ]);
    expect(day.source).toBeNull();
  });

  it('splits one hash across Eastern midnight into two visitor-days', () => {
    // One hash on both sides of midnight is what a SALT_PERIOD_DAYS above 1
    // produces: 11pm and 1am Eastern under one code are still two of the
    // owner's days.
    const days = groupVisitorDays([
      row({ view: '01', visitor: A, ts: Date.UTC(2026, 9, 18, 3, 0), path: '/late' }), // 23:00 EDT Oct 17
      row({ view: '02', visitor: A, ts: Date.UTC(2026, 9, 18, 5, 0), path: '/early' }), // 01:00 EDT Oct 18
    ]);
    expect(days.map((d) => [d.day, d.entry, d.views])).toEqual([
      ['2026-10-18', '/early', 1],
      ['2026-10-17', '/late', 1],
    ]);
  });

  it('keeps two visitors on the same day apart', () => {
    const days = groupVisitorDays([row({ view: '01', visitor: A, ts: t(13) }), row({ view: '02', visitor: B, ts: t(14) })]);
    expect(days.map((d) => d.visitor)).toEqual([B, A]);
  });

  it('takes place, network and device from the earliest row that has them', () => {
    const [day] = groupVisitorDays([
      row({ view: '01', visitor: A, ts: t(13) }),
      row({ view: '02', visitor: A, ts: t(14), country: 'US', asn: 701, viewport_w: 1440 }),
      row({ view: '03', visitor: A, ts: t(15), country: 'CA', asn: 999, viewport_w: 390 }),
    ]);
    expect([day.place, day.network, day.device]).toEqual(['US', 'AS701', 'desktop']);
  });

  it('prints dashes, not undefined, for a visitor-day with nothing known', () => {
    const [day] = groupVisitorDays([row({ visitor: A, ts: t(13) })]);
    expect([day.place, day.network, day.device, day.source]).toEqual(['-', '-', '-', null]);
  });

  it('keeps the most recently ACTIVE visitor-days and lists them newest arrival first', () => {
    // Three visitors, limit two. C arrived first but is still reading, so it
    // is among the two most recently active and must not be cut; B left
    // earliest and is. Displayed by arrival, so C is last.
    const C = 'c'.repeat(32);
    const days = groupVisitorDays(
      [
        row({ view: '01', visitor: C, ts: t(12) }),
        row({ view: '02', visitor: C, ts: t(15, 30) }),
        row({ view: '03', visitor: B, ts: t(13) }),
        row({ view: '04', visitor: A, ts: t(14) }),
      ],
      2,
    );
    expect(days.map((d) => d.visitor)).toEqual([A, C]);
  });

  it('breaks ties the same way whatever order the rows arrive in', () => {
    const C = 'c'.repeat(32);
    const both = (rows: VisitRow[], limit?: number) => [rows, [...rows].reverse()].map((r) => groupVisitorDays(r, limit).map((d) => d.visitor));
    // Two visitors seen at the same moment: by visitor code.
    expect(both([row({ view: '01', visitor: B, ts: t(13) }), row({ view: '02', visitor: A, ts: t(13) })])).toEqual([[A, B], [A, B]]);
    // Last seen at the same moment, one cut: the later arrival is kept.
    const sameLast = [row({ view: '01', visitor: A, ts: t(12) }), row({ view: '02', visitor: A, ts: t(15) }), row({ view: '03', visitor: C, ts: t(15) })];
    expect(both(sameLast, 1)).toEqual([[C], [C]]);
    // Arrived at the same moment: the one active later is listed first.
    const sameFirst = [row({ view: '01', visitor: A, ts: t(12) }), row({ view: '02', visitor: A, ts: t(13) }), row({ view: '03', visitor: C, ts: t(12) }), row({ view: '04', visitor: C, ts: t(15) })];
    expect(both(sameFirst)).toEqual([[C, A], [C, A]]);
  });

  it.each([
    ['no rows', [], 100, 0],
    ['a limit of zero', [row()], 0, 0],
    ['a negative limit', [row()], -1, 0],
  ])('returns an empty list for %s', (_label, rows, limit, expected) => {
    expect(groupVisitorDays(rows as VisitRow[], limit)).toHaveLength(expected);
  });

  it('sums reading time without letting a junk value poison the total', () => {
    const [day] = groupVisitorDays([
      row({ view: '01', visitor: A, ts: t(13), engaged_ms: 1000 }),
      row({ view: '02', visitor: A, ts: t(14), engaged_ms: NaN as unknown as number }),
    ]);
    expect(day.engagedMs).toBe(1000);
  });
});

describe('summarizeSources', () => {
  it('sums arrivals per external host and drops internal and direct ones', () => {
    expect(
      summarizeSources([
        { referrer: 'https://www.google.com/', views: 3 },
        { referrer: 'https://www.google.com/search', views: 2 },
        { referrer: 'https://vva227.org/about', views: 40 },
        { referrer: 'https://l.facebook.com/', views: 4 },
        { referrer: null, views: 99 },
      ]),
    ).toEqual([
      { host: 'www.google.com', views: 5 },
      { host: 'l.facebook.com', views: 4 },
    ]);
  });

  it('orders ties by host so the table does not reshuffle between loads', () => {
    expect(
      summarizeSources([
        { referrer: 'https://b.example/', views: 1 },
        { referrer: 'https://a.example/', views: 1 },
      ]).map((s) => s.host),
    ).toEqual(['a.example', 'b.example']);
  });

  it('treats a junk count as zero', () => {
    expect(summarizeSources([{ referrer: 'https://a.example/', views: 'lots' }])).toEqual([{ host: 'a.example', views: 0 }]);
  });

  it('honours its limit', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ referrer: `https://s${i}.example/`, views: i }));
    expect(summarizeSources(rows, 5)).toHaveLength(5);
  });
});

describe('renderStatsPage', () => {
  it('renders an empty window without pretending there is data', () => {
    const html = renderStatsPage(emptyPage());
    expect(html).toContain('No visitors in this window yet.');
    expect(html).toContain('<strong>0</strong> views');
    expect(html).not.toContain('<table');
  });

  it('marks the selected window and links every other one', () => {
    const html = renderStatsPage(emptyPage({ days: 90 }));
    expect(html).toContain('<strong aria-current="page">90 days</strong>');
    for (const d of WINDOWS.filter((w) => w !== 90)) expect(html).toContain(`href="?days=${d}"`);
    expect(html).not.toContain('href="?days=90"');
  });

  it('escapes a hostile path, referrer host and network name', () => {
    // THE test this function exists for. Anyone can POST a path to the
    // collector; this is the page that shows it back.
    const html = renderStatsPage(
      emptyPage({
        pages: [{ path: '/<script>alert(1)</script>', views: 1, avg_engaged: 0 }],
        sources: [{ host: '"><img src=x onerror=alert(1)>', views: 1 }],
        networks: [{ asn: 1, as_org: '<b>bold</b>', visitors: 1, views: 1 }],
        automated: [{ reason: '<i>why</i>', asn: 2, as_org: '<u>crawler</u>', visitors: 1, views: 1 }],
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // The page renders no images at all, so any <img> is injected markup.
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain('<b>bold</b>');
    expect(html).not.toContain('<i>why</i>');
    expect(html).not.toContain('<u>crawler</u>');
    expect(html).toContain('&lt;u&gt;crawler&lt;/u&gt;');
  });

  it('can actually fail — the assertions above would catch unescaped output', () => {
    const unescaped = renderStatsPage(emptyPage()).replace('</main>', '<img src=x></main>');
    expect(unescaped).toMatch(/<img/i);
  });

  it('carries no-referrer and noindex, and no script tag', () => {
    const html = renderStatsPage(emptyPage());
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('<title>Visits | VVA Chapter 227</title>');
  });

  /** One row in every table. */
  const fullPage = () =>
    emptyPage({
      summary: { views: 3, visitors: 2, pages: 2 },
      visitors: groupVisitorDays([row({ visitor: 'a'.repeat(32), city: 'Fairfax', asn: 701, viewport_w: 390, engaged_ms: 61_000 })]),
      pages: [{ path: '/about', views: 2, avg_engaged: 30_000 }],
      sources: [{ host: 'www.google.com', views: 1 }],
      locations: [{ country: 'US', region: 'VA', city: 'Fairfax', visitors: 1, views: 2 }],
      networks: [{ asn: 701, as_org: 'Verizon Business', visitors: 1, views: 2 }],
      automated: [{ reason: 'crawler-network', asn: 132203, as_org: 'ACEVILLE PTE.LTD.', visitors: 4, views: 9 }],
    });

  it('puts nothing between the cells of a table, or between the window links', () => {
    const $ = cheerio.load(renderStatsPage(fullPage()));
    expect($('table')).toHaveLength(6);
    const stray = $('.scroll, table, thead, tbody, tr, .windows')
      .contents()
      .toArray()
      .filter((n) => n.type === 'text')
      .map((n) => (n as unknown as { data: string }).data);
    expect(stray).toEqual([]);
  });

  it('right-aligns every count and duration, and nothing else', () => {
    const $ = cheerio.load(renderStatsPage(fullPage()));
    const aligned = $('table')
      .toArray()
      .map((table) => [$(table).closest('section').find('h2').text(), $(table).find('tr').toArray().map((tr) => $(tr).children().toArray().flatMap((c, i) => ($(c).hasClass('n') ? [i] : [])))]);
    expect(aligned).toEqual([
      ['Recent visitors', [[7, 8], [7, 8]]],
      ['Pages', [[1, 2], [1, 2]]],
      ['Sources', [[1], [1]]],
      ['Locations', [[1, 2], [1, 2]]],
      ['Networks', [[1, 2], [1, 2]]],
      ['Set aside as likely automated', [[2, 3], [2, 3]]],
    ]);
    expect(STATS_STYLE).toContain('td.n,th.n{text-align:right}');
  });

  it('has exactly one <style> block, and it is STATS_STYLE', () => {
    const html = renderStatsPage(emptyPage());
    const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    expect(blocks).toHaveLength(1);
    expect(blocks[0][1]).toBe(STATS_STYLE);
    expect(html).not.toMatch(/\sstyle=/i);
  });
});

describe('tallyPeople — every table but the last, from the rows of people', () => {
  const P = (n: number) => String(n).padStart(32, '0');
  const r = (over: Partial<VisitRow>) => row({ view: undefined, ...over });

  it('counts views, distinct visitors and distinct pages for the summary', () => {
    const t = tallyPeople([r({ visitor: P(1), path: '/' }), r({ visitor: P(1), path: '/give' }), r({ visitor: P(2), path: '/' })]);
    expect(t.summary).toEqual({ views: 3, visitors: 2, pages: 2 });
  });

  it('ranks pages by views, then by path, with the average reading time', () => {
    const t = tallyPeople([
      r({ path: '/zeta', engaged_ms: 60_000 }),
      r({ path: '/zeta', engaged_ms: 30_000 }),
      r({ path: '/beta', engaged_ms: 10_000 }),
      r({ path: '/alpha', engaged_ms: 0 }),
    ]);
    expect(t.pages).toEqual([
      { path: '/zeta', views: 2, avg_engaged: 45_000 },
      { path: '/alpha', views: 1, avg_engaged: 0 },
      { path: '/beta', views: 1, avg_engaged: 10_000 },
    ]);
  });

  it('keeps each table to its limit, dropping the least seen', () => {
    const rows = Array.from({ length: TABLE_LIMIT + 2 }, (_, i) => r({ path: `/p-${String(i).padStart(2, '0')}`, asn: 1000 + i, city: `C${i}` }));
    rows.push(r({ path: '/p-05', asn: 1005, city: 'C5' }));
    const t = tallyPeople(rows);
    expect(t.pages).toHaveLength(TABLE_LIMIT);
    expect(t.pages[0]).toMatchObject({ path: '/p-05', views: 2 });
    expect(t.pages.map((p) => p.path)).not.toContain(`/p-${TABLE_LIMIT + 1}`);
    expect(t.locations).toHaveLength(TABLE_LIMIT);
    expect(t.networks).toHaveLength(TABLE_LIMIT);
    expect(tallyPeople(rows, { tableLimit: 2 }).pages).toHaveLength(2);
  });

  it('groups places with their unknown parts together, unknown first among ties, as SQL did', () => {
    const t = tallyPeople([
      r({ visitor: P(1), country: 'US', region: 'VA', city: 'Vienna' }),
      r({ visitor: P(2), country: null, region: null, city: null }),
      r({ visitor: P(3), country: null, region: null, city: null }),
      r({ visitor: P(4), country: 'US', region: null, city: null }),
    ]);
    expect(t.locations).toEqual([
      { country: null, region: null, city: null, visitors: 2, views: 2 },
      { country: 'US', region: null, city: null, visitors: 1, views: 1 },
      { country: 'US', region: 'VA', city: 'Vienna', visitors: 1, views: 1 },
    ]);
  });

  it('groups networks by number, shows the largest name, and leaves out rows with no number', () => {
    const t = tallyPeople([
      // The smaller name first, so "keep the first name" and "keep the largest" disagree.
      r({ visitor: P(1), asn: 701, as_org: 'MCI Communications Services' }),
      r({ visitor: P(1), asn: 701, as_org: 'Verizon Business' }),
      r({ visitor: P(2), asn: 701, as_org: null }),
      r({ visitor: P(3), asn: 7922, as_org: 'Comcast Cable Communications, LLC' }),
      r({ visitor: P(4), asn: null, as_org: 'No number' }),
    ]);
    expect(t.networks).toEqual([
      { asn: 701, as_org: 'Verizon Business', visitors: 2, views: 3 },
      { asn: 7922, as_org: 'Comcast Cable Communications, LLC', visitors: 1, views: 1 },
    ]);
  });

  it('counts sources from rows that carry a referrer, and only external ones', () => {
    const t = tallyPeople([
      r({ referrer: 'https://www.google.com/' }),
      r({ referrer: 'https://www.google.com/search' }),
      r({ referrer: 'https://vva227.org/' }),
      r({ referrer: null }),
    ]);
    expect(t.sources).toEqual([{ host: 'www.google.com', views: 2 }]);
  });

  it('cuts Recent visitors itself, to the most recently active', () => {
    const rows = [r({ visitor: P(1), ts: NOW - 3_000, path: '/old' }), r({ visitor: P(2), ts: NOW - 2_000, path: '/mid' }), r({ visitor: P(3), ts: NOW - 1_000, path: '/new' })];
    expect(tallyPeople(rows, { visitorLimit: 2 }).visitors.map((d) => d.entry)).toEqual(['/new', '/mid']);
  });

  it('tallies nothing into empty tables, and a junk reading time into zero', () => {
    expect(tallyPeople([])).toEqual({ summary: { views: 0, visitors: 0, pages: 0 }, visitors: [], pages: [], sources: [], locations: [], networks: [] });
    const junk = tallyPeople([r({ engaged_ms: Number.NaN }), r({ engaged_ms: 'x' as unknown as number })]);
    expect(junk.pages).toEqual([{ path: '/', views: 2, avg_engaged: 0 }]);
  });

  it('orders unicode paths by code point, the same way whatever order the rows arrive in', () => {
    const paths = ['/é', '/z', '/Z', '/a', '/日本'];
    const forward = tallyPeople(paths.map((path) => r({ path }))).pages.map((p) => p.path);
    const backward = tallyPeople([...paths].reverse().map((path) => r({ path }))).pages.map((p) => p.path);
    expect(forward).toEqual(['/Z', '/a', '/z', '/é', '/日本']);
    expect(backward).toEqual(forward);
  });
});

describe('buildStatsPageData and setAsideTotals', () => {
  const crawler = { reason: 'crawler-network', asn: 136907, as_org: 'Huawei', visitors: 4, views: 9 };

  it('adds up the set-aside rows for the summary, one visitor per row', () => {
    expect(setAsideTotals([crawler, { ...crawler, asn: 132203, visitors: 2, views: 2 }])).toEqual({ visitors: 6, views: 11 });
    expect(setAsideTotals([])).toEqual({ visitors: 0, views: 0 });
    expect(setAsideTotals([{ ...crawler, visitors: 'x', views: null }])).toEqual({ visitors: 0, views: 0 });
  });

  it('builds the whole page from the two queries, and says when the people rows hit their limit', () => {
    const people = [row({ visitor: 'a'.repeat(32), path: '/give' })];
    const data = buildStatsPageData({ days: 30, generatedAt: NOW, people, automated: [crawler] });
    expect(data.summary).toEqual({ views: 1, visitors: 1, pages: 1, automated_visitors: 4, automated_views: 9 });
    expect(data.automated).toEqual([crawler]);
    expect(data.peopleCapped).toBe(false);
    expect(Object.keys(data).sort()).toEqual(['automated', 'days', 'generatedAt', 'locations', 'networks', 'pages', 'peopleCapped', 'sources', 'summary', 'visitors']);

    const capped = buildStatsPageData({ days: 365, generatedAt: NOW, people, automated: [], peopleRowLimit: 1 });
    expect(capped.peopleCapped).toBe(true);
    expect(renderStatsPage(capped)).toContain(`more than ${PEOPLE_ROW_LIMIT} views counted as people`);
    expect(renderStatsPage(data)).not.toContain('views counted as people');
  });
});

describe('visits set aside as likely automated', () => {
  const lists = (over: Partial<AutomatedLists> = {}): AutomatedLists => ({ ...AUTOMATED_LISTS, ...over });

  it('takes its lists from the registry, not a copy', () => {
    expect(AUTOMATED_LISTS).toEqual({
      crawlerNetworks: CRAWLER_NETWORKS,
      crawlerWindows: CRAWLER_WINDOWS,
      nothingReadNetworks: NOTHING_READ_NETWORKS,
      nothingReadCountries: NOTHING_READ_COUNTRIES,
    });
  });

  it('writes every listed network, window and country into the condition', () => {
    const sql = automatedReasonSql();
    for (const { asn } of [...CRAWLER_NETWORKS, ...NOTHING_READ_NETWORKS]) expect(sql).toMatch(new RegExp(`\\b${asn}\\b`));
    for (const { width, height } of CRAWLER_WINDOWS) {
      expect(sql).toContain(`viewport_w = ${width} AND viewport_h = ${height}`);
    }
    for (const { code } of NOTHING_READ_COUNTRIES) expect(sql).toContain(`'${code}'`);
  });

  it('refuses a list entry that is not a positive whole number', () => {
    // The numbers are written into the statement rather than bound, so this
    // check is what keeps the statement a statement.
    for (const bad of [0, -1, 1.5, NaN, Infinity, 2 ** 53, '7922', null, '1) OR (1=1']) {
      const n = bad as unknown as number;
      expect(() => automatedReasonSql(lists({ crawlerNetworks: [{ asn: n, owner: 'x' }] })), String(bad)).toThrow(/positive whole number/);
      expect(() => automatedReasonSql(lists({ nothingReadNetworks: [{ asn: n, owner: 'x' }] })), String(bad)).toThrow(/positive whole number/);
      expect(() => automatedReasonSql(lists({ crawlerWindows: [{ width: n, height: 600 }] })), String(bad)).toThrow(/positive whole number/);
      expect(() => automatedReasonSql(lists({ crawlerWindows: [{ width: 800, height: n }] })), String(bad)).toThrow(/positive whole number/);
    }
  });

  it('refuses a country that is not a two-letter code', () => {
    for (const bad of ['cn', 'CHN', 'C', '', "C'", "CN') OR ('1'='1", 'C\u0000']) {
      expect(() => automatedReasonSql(lists({ nothingReadCountries: [{ code: bad, name: 'x' }] })), bad).toThrow(/two-letter/);
    }
  });

  it('writes no empty IN () for an empty list, which some engines refuse', () => {
    const sql = automatedReasonSql({ crawlerNetworks: [], crawlerWindows: [], nothingReadNetworks: [], nothingReadCountries: [] });
    expect(sql).not.toMatch(/IN\s*\(\s*\)/);
    expect(sql).not.toMatch(/\(\s*\)/);
  });

  it('labels each reason in plain words, and shows an unknown one as it is', () => {
    expect(automatedReasonLabel('crawler-network')).toBe('Network that sends only crawlers');
    expect(automatedReasonLabel('crawler-window')).toBe('Window size only crawlers use');
    expect(automatedReasonLabel('network-nothing-read')).toBe('Company data centre, nothing read');
    expect(automatedReasonLabel('country-nothing-read')).toBe('From mainland China, nothing read');
    expect(automatedReasonLabel('something-new')).toBe('something-new');
    expect(automatedReasonLabel(null)).toBe('-');
    expect(automatedReasonLabel(undefined)).toBe('-');
  });

  it('explains every rule from the lists themselves', () => {
    const text = automatedExplanation();
    for (const { owner } of [...CRAWLER_NETWORKS, ...NOTHING_READ_NETWORKS]) expect(text).toContain(owner);
    for (const { width, height } of CRAWLER_WINDOWS) expect(text).toContain(`${width} × ${height}`);
    for (const { name } of NOTHING_READ_COUNTRIES) expect(text).toContain(name);
    expect(text).toContain('Nothing is deleted');
    // One mention per owner, however many networks it has.
    expect(text.split('Tencent Cloud')).toHaveLength(2);
    expect(text.split('Amazon')).toHaveLength(2);
  });

  it('explains a changed list in its own words, so the page cannot fall behind the registry', () => {
    const text = automatedExplanation({
      crawlerNetworks: [{ asn: 64500, owner: 'Example Cloud' }],
      crawlerWindows: [{ width: 640, height: 480 }],
      nothingReadNetworks: [{ asn: 64501, owner: 'Example DC' }],
      nothingReadCountries: [{ code: 'XX', name: 'Nowhere' }, { code: 'YY', name: 'Elsewhere' }],
    });
    expect(text).toContain('nothing but crawlers (Example Cloud)');
    expect(text).toContain('a window of exactly 640 × 480, a size only crawlers');
    expect(text).toContain('came from a Example DC data centre, Nowhere or Elsewhere.');
    expect(text).toContain('Home and mobile networks in Nowhere or Elsewhere are expected here');
    for (const gone of ['Tencent', '1800 × 1125', '1024 × 569', 'Microsoft', 'mainland China']) expect(text).not.toContain(gone);
    expect(automatedReasonLabel('country-nothing-read', lists({ nothingReadCountries: [{ code: 'XX', name: 'Nowhere' }] }))).toBe(
      'From Nowhere, nothing read',
    );
  });

  it('says so when every list is empty, and uses no "or when" for a single rule', () => {
    const empty = automatedExplanation({ crawlerNetworks: [], crawlerWindows: [], nothingReadNetworks: [], nothingReadCountries: [] });
    expect(empty).toContain('No visitor is set aside: every list is empty.');
    expect(empty).not.toContain('set aside when');
    expect(empty).toContain('A home or mobile network here may be a person.');

    const one = automatedExplanation({ crawlerNetworks: [{ asn: 64500, owner: 'Example Cloud' }], crawlerWindows: [], nothingReadNetworks: [], nothingReadCountries: [] });
    expect(one).toContain('A visitor is set aside when their network has sent this site nothing but crawlers (Example Cloud).');
    expect(one).not.toContain('; or when');

    const two = automatedExplanation(lists({ crawlerWindows: [{ width: 1, height: 2 }, { width: 3, height: 4 }] }));
    expect(two).toContain('1 × 2 or 3 × 4, sizes only crawlers');
  });

  it('refuses a people-row limit that is not a positive whole number', () => {
    for (const bad of [0, -5, 2.5, NaN]) expect(() => buildStatsSql(AUTOMATED_LISTS, { peopleRowLimit: bad }), String(bad)).toThrow(/positive whole number/);
    expect(buildStatsSql(AUTOMATED_LISTS, { peopleRowLimit: 7 }).people).toMatch(/LIMIT 7\s*$/);
    expect(STATS_SQL_KEYS(buildStatsSql())).toEqual(['people', 'automated']);
  });

  it('says how much it set aside under the summary, and only when there is some', () => {
    const none = cheerio.load(renderStatsPage(emptyPage()));
    expect(none('.setaside')).toHaveLength(0);

    const some = cheerio.load(
      renderStatsPage(emptyPage({ summary: { views: 3, visitors: 2, pages: 2, automated_visitors: 179, automated_views: 520 } })),
    );
    expect(some('.summary').text()).toBe('3 views · 2 visitors · 2 pages');
    expect(some('.setaside').text()).toBe('Not counted: 179 visitors (520 views) that look automated, listed at the end of the page.');
  });

  it('treats a summary without the set-aside counts as none set aside', () => {
    const $ = cheerio.load(renderStatsPage(emptyPage({ summary: { views: 1, visitors: 1, pages: 1 } })));
    expect($('.setaside')).toHaveLength(0);
    expect($('.summary').text()).toBe('1 views · 1 visitors · 1 pages');
  });

  it('lists what it set aside, last, with the reason in words and the network by name or number', () => {
    const $ = cheerio.load(
      renderStatsPage(
        emptyPage({
          automated: [
            { reason: 'crawler-network', asn: 136907, as_org: 'Huawei Cloud Singapore Region', visitors: 47, views: 329 },
            { reason: 'crawler-window', asn: 4837, as_org: null, visitors: 33, views: 33 },
          ],
        }),
      ),
    );
    const section = $('section').last();
    expect(section.find('h2').text()).toBe('Set aside as likely automated');
    expect(section.find('p.note').text()).toBe(automatedExplanation());
    expect(section.find('tr').toArray().map((tr) => $(tr).find('th, td').toArray().map((c) => $(c).text()))).toEqual([
      ['Why', 'Network', 'Visitors', 'Views'],
      ['Network that sends only crawlers', 'Huawei Cloud Singapore Region (AS136907)', '47', '329'],
      ['Window size only crawlers use', 'AS4837', '33', '33'],
    ]);
  });

  it('says so, and still explains the rule, when nothing was set aside', () => {
    const $ = cheerio.load(renderStatsPage(emptyPage()));
    const section = $('section').last();
    expect(section.find('h2').text()).toBe('Set aside as likely automated');
    expect(section.find('p.note').text()).toBe(automatedExplanation());
    expect(section.find('.empty').text()).toBe('Nothing was set aside in this window.');
  });
});

describe('the CSP hash', () => {
  it('matches the hash Node computes for the same text', async () => {
    const expected = createHash('sha256').update(STATS_STYLE, 'utf8').digest('base64');
    await expect(sha256Base64(STATS_STYLE)).resolves.toBe(expected);
    await expect(pageCsp()).resolves.toContain(`'sha256-${expected}'`);
  });

  it('changes when the text changes, so a stale hash cannot hide', async () => {
    expect(await sha256Base64(`${STATS_STYLE} `)).not.toBe(await sha256Base64(STATS_STYLE));
  });

  it('does not keep a failed hash, so the next request tries again', async () => {
    vi.resetModules();
    const fresh = await import('../../src/lib/stats');
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('digest unavailable'));
    await expect(fresh.pageCsp()).rejects.toThrow('digest unavailable');
    await expect(fresh.pageCsp()).resolves.toBe(statsCsp(createHash('sha256').update(STATS_STYLE, 'utf8').digest('base64')));
    expect(digest).toHaveBeenCalledTimes(2);
    digest.mockRestore();
  });

  it('builds the whole policy with no inline or script allowance', () => {
    expect(statsCsp('abc=')).toBe(
      "default-src 'none'; style-src 'sha256-abc='; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });
});

describe('authorizeStats — the Cloudflare Access gate', () => {
  const URL_ = 'https://vva227.org/stats';
  const NOW_MS = Date.UTC(2026, 9, 17, 16, 0);
  const NOW_S = NOW_MS / 1000;
  let signer: Signer;

  beforeAll(async () => {
    signer = await createSigner();
  });

  /** A gate with its own cache, its own clock and a recording stand-in for the certs endpoint. */
  function gate() {
    const certs = certsServer(signer.jwks);
    return { authorize: createAccessGate({ fetchImpl: certs.fetch, now: () => NOW_MS }), certs };
  }

  const withToken = (token: string, header = ACCESS_JWT_HEADER) => new Request(URL_, { headers: { [header]: token } });

  it.each([
    ['a bare request', new Request(URL_), {}],
    ['one carrying an Access token', withToken('x.y.z'), {}],
    ['one with only the team domain set', withToken('x.y.z'), { ACCESS_TEAM_DOMAIN: TEAM }],
    ['one with only the AUD set', withToken('x.y.z'), { ACCESS_AUD: AUD }],
    ['one with both set to whitespace', withToken('x.y.z'), { ACCESS_TEAM_DOMAIN: ' ', ACCESS_AUD: '\n' }],
    ['one with both set to non-strings', withToken('x.y.z'), { ACCESS_TEAM_DOMAIN: 1, ACCESS_AUD: true }],
    ['one with a password set instead', new Request(URL_, { headers: { Authorization: 'Basic b3duZXI6cGFzcw==' } }), { STATS_PASSWORD: 'pass' }],
  ])('refuses %s while Access is not configured, and fetches nothing', async (_label, request, env) => {
    const { authorize, certs } = gate();
    await expect(authorize(request, env)).resolves.toEqual({ ok: false, reason: 'access not configured' });
    expect(certs.calls).toEqual([]);
  });

  it('ships refusing everyone until Access is configured', async () => {
    // The exported gate, as functions/stats.ts uses it, with no settings.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in the unit tier'));
    await expect(authorizeStats(withToken(await signer.sign(claimsFor(NOW_S))), {})).resolves.toEqual({
      ok: false,
      reason: 'access not configured',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('with Access configured, refuses Basic credentials and a bare request as carrying no token', async () => {
    const { authorize, certs } = gate();
    const basic = new Request(URL_, { headers: { Authorization: 'Basic b3duZXI6cGFzcw==' } });
    await expect(authorize(basic, accessEnv({ STATS_PASSWORD: 'pass' }))).resolves.toEqual({ ok: false, reason: 'no token' });
    await expect(authorize(new Request(URL_), accessEnv())).resolves.toEqual({ ok: false, reason: 'no token' });
    expect(certs.calls).toEqual([]);
  });

  it('lets a valid token in, and answers with nothing but ok', async () => {
    const { authorize, certs } = gate();
    const verdict = await authorize(withToken(await signer.sign(claimsFor(NOW_S))), accessEnv());
    // Exactly { ok: true }: no claims, no email, nothing the handler could
    // be tempted to echo into a page.
    expect(verdict).toEqual({ ok: true });
    expect(certs.calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  it('reads the token from the Access header and nowhere else', async () => {
    const { authorize } = gate();
    const token = await signer.sign(claimsFor(NOW_S));
    for (const request of [
      new Request(URL_, { headers: { Authorization: `Bearer ${token}` } }),
      new Request(URL_, { headers: { Cookie: `CF_Authorization=${token}` } }),
      new Request(`${URL_}?token=${token}`),
    ]) {
      await expect(authorize(request, accessEnv())).resolves.toEqual({ ok: false, reason: 'no token' });
    }
    // Header names are case-insensitive, as they are on the wire.
    await expect(authorize(withToken(token, ACCESS_JWT_HEADER.toLowerCase()), accessEnv())).resolves.toEqual({ ok: true });
  });

  it('accepts settings stored with a trailing newline', async () => {
    const { authorize } = gate();
    const token = await signer.sign(claimsFor(NOW_S));
    await expect(authorize(withToken(token), accessEnv({ ACCESS_TEAM_DOMAIN: `${TEAM}\n`, ACCESS_AUD: `${AUD}\r\n` }))).resolves.toEqual({ ok: true });
  });

  it('checks expiry against its own clock', async () => {
    const certs = certsServer(signer.jwks);
    const later = createAccessGate({ fetchImpl: certs.fetch, now: () => NOW_MS + 2 * 3_600_000 });
    await expect(later(withToken(await signer.sign(claimsFor(NOW_S))), accessEnv())).resolves.toEqual({ ok: false, reason: 'expired' });
  });

  it('fetches the keys once per team domain, and starts again when the team domain changes', async () => {
    const calls: string[] = [];
    const authorize = createAccessGate({
      fetchImpl: async (url) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => signer.jwks };
      },
      now: () => NOW_MS,
    });
    const token = await signer.sign(claimsFor(NOW_S));
    await authorize(withToken(token), accessEnv());
    await authorize(withToken(token), accessEnv());
    // A corrected setting reaching a warm isolate must not keep verifying
    // against the old team's keys.
    await expect(authorize(withToken(token), accessEnv({ ACCESS_TEAM_DOMAIN: 'other.cloudflareaccess.com' }))).resolves.toEqual({
      ok: false,
      reason: 'wrong issuer',
    });
    await authorize(withToken(token), accessEnv());
    expect(calls).toEqual([
      `https://${TEAM}/cdn-cgi/access/certs`,
      'https://other.cloudflareaccess.com/cdn-cgi/access/certs',
      `https://${TEAM}/cdn-cgi/access/certs`,
    ]);
  });

  it('reads a setting as trimmed text, and anything that is not text as absent', () => {
    expect(accessSetting(' team.cloudflareaccess.com\r\n')).toBe('team.cloudflareaccess.com');
    for (const absent of [undefined, null, '', ' \n', 1, true, ['x'], { value: 'x' }]) expect(accessSetting(absent)).toBe('');
  });

  it('turns a request that throws into a refusal, not an exception', async () => {
    const { authorize } = gate();
    const hostile = { headers: { get: () => { throw new Error('boom'); } } } as unknown as Request;
    await expect(authorize(hostile, accessEnv())).resolves.toEqual({ ok: false, reason: 'gate error: boom' });
  });

  it('settles "not configured" before reading the request, and with no environment at all', async () => {
    // The same request that throws above: unconfigured, it is never read.
    const { authorize, certs } = gate();
    const hostile = { headers: { get: () => { throw new Error('boom'); } } } as unknown as Request;
    for (const env of [{}, { ACCESS_TEAM_DOMAIN: TEAM }, { ACCESS_AUD: AUD }]) {
      await expect(authorize(hostile, env)).resolves.toEqual({ ok: false, reason: 'access not configured' });
    }
    await expect(authorize(new Request(URL_), undefined as never)).resolves.toEqual({ ok: false, reason: 'access not configured' });
    expect(certs.calls).toEqual([]);
  });
});
