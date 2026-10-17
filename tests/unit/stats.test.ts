import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  classifyReferrer,
  DEFAULT_DAYS,
  deviceOf,
  escapeHtml,
  etDay,
  formatCount,
  formatDuration,
  formatEt,
  formatNetwork,
  formatPlace,
  groupVisitorDays,
  isSiteHost,
  pageCsp,
  parseWindow,
  renderStatsPage,
  sha256Base64,
  shortVisitor,
  statsCsp,
  STATS_STYLE,
  summarizeSources,
  WINDOWS,
  type StatsPageData,
  type VisitRow,
} from '../../src/lib/stats';
import { authorizeStats } from '../../src/lib/stats-gate';
import { SITE_HOSTS } from '../../src/data/analytics';

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

const emptyPage = (over: Partial<StatsPageData> = {}): StatsPageData => ({
  days: 30,
  generatedAt: NOW,
  summary: { views: 0, visitors: 0, pages: 0 },
  visitors: [],
  pages: [],
  sources: [],
  locations: [],
  networks: [],
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
  ])('formats a network with %s', (_label, net, expected) => {
    expect(formatNetwork(net)).toBe(expected);
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
  ])('classifies %s', (_label, referrer, expected) => {
    expect(classifyReferrer(referrer)).toEqual(expected);
  });

  it('shows an unparseable referrer as a cut-down external label rather than hiding it', () => {
    expect(classifyReferrer('not a url?token=secret')).toEqual({ kind: 'external', host: 'not a url' });
    expect((classifyReferrer('x'.repeat(500)) as { host: string }).host).toHaveLength(64);
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
    // The hash rotates at UTC midnight (8pm EDT), so 11pm and 1am Eastern on
    // the same UTC day share a hash — and are two of the owner's days.
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
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // The page renders no images at all, so any <img> is injected markup.
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain('<b>bold</b>');
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

  it('has exactly one <style> block, and it is STATS_STYLE', () => {
    const html = renderStatsPage(emptyPage());
    const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    expect(blocks).toHaveLength(1);
    expect(blocks[0][1]).toBe(STATS_STYLE);
    expect(html).not.toMatch(/\sstyle=/i);
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

  it('builds the whole policy with no inline or script allowance', () => {
    expect(statsCsp('abc=')).toBe(
      "default-src 'none'; style-src 'sha256-abc='; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });
});

describe('authorizeStats, while no gate has been chosen', () => {
  it.each([
    ['a bare request', new Request('https://vva227.org/stats'), {}],
    ['one carrying an Access token', new Request('https://vva227.org/stats', { headers: { 'Cf-Access-Jwt-Assertion': 'x.y.z' } }), {}],
    ['one with every plausible secret set', new Request('https://vva227.org/stats', { headers: { Authorization: 'Basic b3duZXI6cGFzcw==' } }), { ACCESS_AUD: 'a', ACCESS_TEAM_DOMAIN: 'b', STATS_PASSWORD: 'pass' }],
  ])('refuses %s, naming why', async (_label, request, env) => {
    await expect(authorizeStats(request, env)).resolves.toEqual({ ok: false, reason: 'gate not configured' });
  });
});
