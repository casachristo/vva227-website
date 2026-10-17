import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { createStatsHandler } from '../../functions/stats';
import { createD1, createEnv, ORIGIN, type TestD1 } from '../helpers/d1';
import { expectStatsNotFound, expectStatsPageHeaders } from '../helpers/analytics';
import { STATS_PATH } from '../../src/data/analytics';
import { shortVisitor, WINDOWS } from '../../src/lib/stats';

/**
 * FEATURE — the /stats page, run whole: rows in the database, a request in,
 * a complete page out. The database is real SQLite with the real migration;
 * the only stand-in is the gate, which is replaced by one that says yes,
 * because the real gate refuses everyone until it is chosen (the security
 * tier proves that).
 *
 * Every section and every column is asserted from the parsed page, along
 * with every response header.
 *
 * TIER JUSTIFICATION: the unit tier renders hand-built view models. Here the
 * values have to survive six real queries, the batch's result order, the
 * grouping and the rendering together — a query returning columns in the
 * wrong order, or the batch results mapped to the wrong table, only shows up
 * when all of them run at once.
 */

const NOW = Date.UTC(2026, 9, 17, 16, 0); // 12:00 Eastern
const H = 3_600_000;
const DAY = 24 * H;

const A = 'a1'.repeat(16);
const B = 'b2'.repeat(16);
const C = 'c3'.repeat(16);

const allow = async () => ({ ok: true as const });
const handler = createStatsHandler(allow);

let d1: TestD1;
let clock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  d1 = createD1();
  clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  clock.mockRestore();
  d1.close();
  vi.restoreAllMocks();
});

const get = (query = '', { method = 'GET', env = createEnv(d1.binding) }: { method?: string; env?: ReturnType<typeof createEnv> } = {}) =>
  handler({ request: new Request(`${ORIGIN}${STATS_PATH}${query}`, { method }), env });

/** A morning's traffic: two visitors today, one ten days ago, and a row from another site. */
function seedTraffic() {
  const fairfax = { country: 'US', region: 'VA', city: 'Fairfax', asn: 7922, as_org: 'Comcast Cable Communications, LLC' };
  d1.seed({ view: '1000000000000001', visitor: A, ts: NOW - 3 * H, path: '/', referrer: 'https://www.google.com/', viewport_w: 390, viewport_h: 844, engaged_ms: 30_000, ...fairfax });
  d1.seed({ view: '1000000000000002', visitor: A, ts: NOW - 3 * H + 2 * 60_000, path: '/give', referrer: 'https://vva227.org/', viewport_w: 390, viewport_h: 844, engaged_ms: 90_000, ...fairfax });
  d1.seed({ view: '1000000000000003', visitor: B, ts: NOW - H, path: '/about', referrer: null, viewport_w: 1440, viewport_h: 900, engaged_ms: 45_000, country: 'US', region: 'VA', city: 'Arlington', asn: 701, as_org: 'Verizon Business' });
  d1.seed({ view: '1000000000000004', visitor: C, ts: NOW - 10 * DAY, path: '/contact', referrer: 'https://l.facebook.com/', country: 'CA', asn: 15169, engaged_ms: 0 });
  d1.seed({ view: '1000000000000005', site: 'some-other-site', visitor: 'd4'.repeat(16), ts: NOW - H, path: '/not-ours', country: 'FR' });
}

/** A section's table as rows of cell text, header row first. */
function tableOf($: cheerio.CheerioAPI, caption: string): string[][] {
  const section = $('section').filter((_, el) => $(el).find('h2').text() === caption);
  expect(section.length, `no "${caption}" section`).toBe(1);
  return section
    .find('tr')
    .toArray()
    .map((tr) => $(tr).find('th, td').toArray().map((c) => $(c).text()));
}

describe('happy path — a populated page', () => {
  it('answers 200 with every security header, and a CSP hash that matches its own <style>', async () => {
    seedTraffic();
    const res = await get();
    expect(res.status).toBe(200);
    const csp = expectStatsPageHeaders(res);

    const html = await res.text();
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    expect(styles).toHaveLength(1);
    const hash = createHash('sha256').update(styles[0], 'utf8').digest('base64');
    expect(csp).toContain(`style-src 'sha256-${hash}'`);
  });

  it('renders the head, the window links, the summary and the note', async () => {
    seedTraffic();
    const $ = cheerio.load(await (await get()).text());

    expect($('title').text()).toBe('Visits | VVA Chapter 227');
    expect($('meta[name="referrer"]').attr('content')).toBe('no-referrer');
    expect($('meta[name="robots"]').attr('content')).toBe('noindex, nofollow');
    expect($('script')).toHaveLength(0);
    expect($('h1').text()).toBe('Visits');
    expect($('.meta').text()).toBe('Last 30 days · generated 2026-10-17 12:00 ET');

    expect($('.windows strong').text()).toBe('30 days');
    expect($('.windows a').toArray().map((a) => $(a).attr('href'))).toEqual(WINDOWS.filter((d) => d !== 30).map((d) => `?days=${d}`));

    // 4 views on this site in 30 days; the other site's row is not counted.
    expect($('.summary').text()).toBe('4 views · 3 visitors · 4 pages');

    const note = $('.note').text();
    expect(note).toContain('Visitor ids reset every day');
    expect(note).toContain('come from Cloudflare');
    expect(note).toContain('IP addresses are never stored');
    expect(note).toContain('Eastern (ET)');
  });

  it('lists recent visitors, one row per visitor-day, newest first, with every column', async () => {
    seedTraffic();
    const $ = cheerio.load(await (await get()).text());
    expect(tableOf($, 'Recent visitors')).toEqual([
      ['First seen (ET)', 'Visitor', 'Where', 'Network', 'Device', 'Came from', 'Entry page', 'Pages viewed', 'Read time'],
      ['2026-10-17 11:00', shortVisitor(B), 'Arlington, VA, US', 'Verizon Business', 'desktop', '(direct)', '/about', '1', '45s'],
      // Two views, one visitor-day; came from Google, not from its own internal
      // second hop; entry is the earlier page; read time is the sum.
      ['2026-10-17 09:00', shortVisitor(A), 'Fairfax, VA, US', 'Comcast Cable Communications, LLC', 'mobile', 'www.google.com', '/', '2', '2m'],
      ['2026-10-07 12:00', shortVisitor(C), 'CA', 'AS15169', '-', 'l.facebook.com', '/contact', '1', '0s'],
    ]);
  });

  it('lists pages, sources, locations and networks', async () => {
    seedTraffic();
    const $ = cheerio.load(await (await get()).text());

    expect(tableOf($, 'Pages')).toEqual([
      ['Page', 'Views', 'Average read'],
      ['/', '1', '30s'],
      ['/about', '1', '45s'],
      ['/contact', '1', '0s'],
      ['/give', '1', '1m 30s'],
    ]);

    // External hosts only: the vva227.org referrer on /give is internal.
    expect(tableOf($, 'Sources')).toEqual([
      ['Came from', 'Arrivals'],
      ['l.facebook.com', '1'],
      ['www.google.com', '1'],
    ]);

    expect(tableOf($, 'Locations')).toEqual([
      ['Where', 'Visitors', 'Views'],
      ['Fairfax, VA, US', '1', '2'],
      ['CA', '1', '1'],
      ['Arlington, VA, US', '1', '1'],
    ]);

    // Grouped by ASN, shown by name, number when there is no name.
    expect(tableOf($, 'Networks')).toEqual([
      ['Network', 'Visitors', 'Views'],
      ['Comcast Cable Communications, LLC', '1', '2'],
      ['Verizon Business', '1', '1'],
      ['AS15169', '1', '1'],
    ]);
  });

  it('narrows everything to the chosen window', async () => {
    seedTraffic();
    const $ = cheerio.load(await (await get('?days=7')).text());
    expect($('.windows strong').text()).toBe('7 days');
    expect($('.summary').text()).toBe('3 views · 2 visitors · 3 pages');
    expect(tableOf($, 'Recent visitors').map((r) => r[1])).toEqual(['Visitor', shortVisitor(B), shortVisitor(A)]);
    expect(tableOf($, 'Sources').slice(1)).toEqual([['www.google.com', '1']]);
  });

  it('answers HEAD with the same headers and no body', async () => {
    seedTraffic();
    const res = await get('', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expectStatsPageHeaders(res);
    await expect(res.text()).resolves.toBe('');
  });
});

describe('sad path', () => {
  it('says so in every section when the window is empty', async () => {
    const $ = cheerio.load(await (await get()).text());
    expect($('.summary').text()).toBe('0 views · 0 visitors · 0 pages');
    expect($('table')).toHaveLength(0);
    expect($('.empty').toArray().map((p) => $(p).text())).toEqual([
      'No visitors in this window yet.',
      'No pages viewed in this window.',
      'No visitors arrived from another site in this window.',
      'No locations in this window.',
      'No networks in this window.',
    ]);
  });

  it('refuses a method other than GET or HEAD from an allowed caller', async () => {
    const res = await get('', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, HEAD');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers the same 404 as a refusal when the D1 binding is missing, as on a preview', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expectStatsNotFound(await get('', { env: createEnv(undefined) }));
  });

  it('answers 500 without describing the schema when a query fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { ...d1.binding, batch: async () => { throw new Error('D1_ERROR: no such column: visitor'); } };
    const res = await get('', { env: createEnv(broken) });
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await expect(res.text()).resolves.toBe('Stats unavailable');
    expect(errors).toHaveBeenCalledWith('stats query failed', 'D1_ERROR: no such column: visitor');
  });
});

describe('edge cases', () => {
  it('falls back to 30 days for a window that is not offered', async () => {
    seedTraffic();
    const $ = cheerio.load(await (await get('?days=45')).text());
    expect($('.windows strong').text()).toBe('30 days');
    expect($('.summary').text()).toBe('4 views · 3 visitors · 4 pages');
  });

  it('shows a row Cloudflare could not place as dashes rather than "undefined"', async () => {
    d1.seed({ view: '2000000000000001', visitor: A, ts: NOW - H, path: '/' });
    const $ = cheerio.load(await (await get()).text());
    expect(tableOf($, 'Recent visitors')[1]).toEqual(['2026-10-17 11:00', shortVisitor(A), '-', '-', '-', '(direct)', '/', '1', '0s']);
    expect(tableOf($, 'Locations')[1]).toEqual(['-', '1', '1']);
    expect($('body').text()).not.toMatch(/undefined|NaN|null/);
  });

  it('includes a row exactly at the start of the window', async () => {
    d1.seed({ view: '2000000000000002', visitor: A, ts: NOW - 30 * DAY, path: '/edge' });
    d1.seed({ view: '2000000000000003', visitor: B, ts: NOW - 30 * DAY - 1, path: '/outside' });
    const html = await (await get()).text();
    expect(html).toContain('/edge');
    expect(html).not.toContain('/outside');
  });
});
