import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as cheerio from 'cheerio';
import { onRequest as collect } from '../../functions/api/e';
import { createStatsHandler } from '../../functions/stats';
import { beaconRequest, createD1, createEnv, ORIGIN, type BeaconRequestOptions, type TestD1 } from '../helpers/d1';
import { expectAccepted, expectStatsPageHeaders, expectViewRow } from '../helpers/analytics';
import { CRAWLER_NETWORKS, EVENT_END, EVENT_VIEW, RETENTION_DAYS, SITE_KEY, STATS_PATH } from '../../src/data/analytics';
import {
  AUTOMATED_LISTS,
  buildStatsSql,
  groupVisitorDays,
  RECENT_VISITORS_LIMIT,
  setAsideTotals,
  shortVisitor,
  STATS_SQL,
  TABLE_LIMIT,
  tallyPeople,
  type AutomatedStat,
  type VisitRow,
} from '../../src/lib/stats';
import type { CfProperties } from '../../src/lib/runtime';
import { PRUNE_SQL } from '../../src/lib/beacon';

/**
 * INTEGRATION — what the collector writes, read back by the stats page.
 *
 * The two Functions never call each other; the database is the only thing
 * they share, and each is tested on its own elsewhere. This is the handoff:
 * real requests through the real collector (real hashing, real upsert, real
 * prune) into real SQLite, then the real stats queries and handler reading
 * the result.
 *
 * TIER JUSTIFICATION: the stats feature test seeds rows by hand, so it cannot
 * notice when the collector writes something the stats page reads
 * differently — a hash that does not stay stable across a visitor's pages, a
 * restamped ts that moves "first seen", a referrer the collector stores in a
 * shape the classifier does not recognise. Only both halves together can.
 */

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.UTC(2026, 9, 17, 16, 0); // 12:00 Eastern

const HOME_IP = '198.51.100.20';
const OFFICE_IP = '198.51.100.30';

let d1: TestD1;
let clock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  d1 = createD1();
  clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  clock.mockRestore();
  d1.close();
});

/** Post one event as a given visitor at a given time. */
async function at(ts: number, ip: string, body: Record<string, unknown>, opts: BeaconRequestOptions = {}) {
  clock.mockReturnValue(ts);
  await expectAccepted(
    await collect({
      request: beaconRequest(body, { ...opts, headers: { 'CF-Connecting-IP': ip, ...(opts.headers ?? {}) } }),
      env: createEnv(d1.binding),
    }),
  );
}

const view = (v: string, p: string, r?: string) => ({ k: EVENT_VIEW, v, p, r, w: 390, h: 844 });
const end = (v: string, p: string, e: number) => ({ k: EVENT_END, v, p, e });

/** The real people query, as the handler runs it. */
async function peopleRows(days = 30, now = NOW, sql = STATS_SQL.people) {
  return (await d1.binding.prepare(sql).bind(SITE_KEY, now - days * DAY).all<VisitRow>()).results;
}

/** The real set-aside query, as the handler runs it. */
async function setAsideRows(days = 30, now = NOW, sql = STATS_SQL.automated) {
  return (await d1.binding.prepare(sql).bind(SITE_KEY, now - days * DAY).all<AutomatedStat>()).results;
}

/** The summary line the page shows: people's counts, then the set-aside totals. */
async function summaryOf(days = 30, now = NOW) {
  const people = tallyPeople(await peopleRows(days, now)).summary;
  const setAside = setAsideTotals(await setAsideRows(days, now));
  return { ...people, automated_visitors: setAside.visitors, automated_views: setAside.views };
}

/** Recent visitors, from the real people query and grouping. */
async function visitorDays(days = 30, now = NOW) {
  return tallyPeople(await peopleRows(days, now)).visitors;
}

/** The highest ?N a statement uses. */
const paramCount = (sql: string) => Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));

/** Steps of SQLite's plan that read the whole table rather than an index. */
function fullScans(sql: string, args: unknown[]): string[] {
  const plan = d1.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as Array<{ detail: string }>;
  return plan.map((step) => step.detail).filter((detail) => /^SCAN views$/.test(detail));
}

async function page(query = '') {
  clock.mockReturnValue(NOW);
  const res = await createStatsHandler(async () => ({ ok: true }))({
    request: new Request(`${ORIGIN}${STATS_PATH}${query}`),
    env: createEnv(d1.binding),
  });
  expect(res.status).toBe(200);
  expectStatsPageHeaders(res);
  return cheerio.load(await res.text());
}

describe('a visit, collected and then reported', () => {
  it('turns one visitor reading three pages into one visitor-day', async () => {
    await at(NOW - 2 * H, HOME_IP, view('1000000000000001', '/', 'https://www.google.com/search?q=vva+chapter+227'));
    await at(NOW - 2 * H + 40_000, HOME_IP, end('1000000000000001', '/', 40_000));
    await at(NOW - 2 * H + 41_000, HOME_IP, view('1000000000000002', '/give', 'https://vva227.org/'));
    await at(NOW - 2 * H + 61_000, HOME_IP, view('1000000000000003', '/give/impact', 'https://vva227.org/give'));
    for (const row of d1.rows()) expectViewRow(row);

    const days = await visitorDays();
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      day: '2026-10-17',
      firstSeen: NOW - 2 * H,
      entry: '/',
      source: 'www.google.com',
      views: 3,
      engagedMs: 40_000,
      place: 'Fairfax, VA, US',
      network: 'Comcast Cable Communications, LLC',
      device: 'mobile',
    });
  });

  it('keeps two people on the same network apart, by user agent', async () => {
    await at(NOW - H, HOME_IP, view('2000000000000001', '/'), { headers: { 'User-Agent': 'Phone' } });
    await at(NOW - H + 1, HOME_IP, view('2000000000000002', '/'), { headers: { 'User-Agent': 'Laptop' } });
    expect(await visitorDays()).toHaveLength(2);
  });

  it('shows the same person on two days as two visitors — the daily rotation, end to end', async () => {
    await at(NOW - DAY, HOME_IP, view('3000000000000001', '/'));
    await at(NOW, HOME_IP, view('3000000000000002', '/'));
    const days = await visitorDays();
    expect(days).toHaveLength(2);
    expect(days[0].visitor).not.toBe(days[1].visitor);
  });

  it('splits a visit at Eastern midnight into two visitor-days, each with its own code', async () => {
    // 23:30 and 00:30 Eastern on Oct 17/18 are 03:30 and 04:30 UTC on Oct 18.
    // The code changes at Eastern midnight, which is where the owner's day
    // changes too.
    await at(Date.UTC(2026, 9, 18, 3, 30), HOME_IP, view('4000000000000001', '/late'));
    await at(Date.UTC(2026, 9, 18, 4, 30), HOME_IP, view('4000000000000002', '/early'));
    const rows = d1.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0].visitor).not.toBe(rows[1].visitor);

    const days = await visitorDays(30, Date.UTC(2026, 9, 18, 12));
    expect(days.map((d) => [d.day, d.entry])).toEqual([
      ['2026-10-18', '/early'],
      ['2026-10-17', '/late'],
    ]);
  });

  it('keeps one evening visit across 8pm Eastern as one visitor, with its source and entry page', async () => {
    // 19:50 and 20:10 EDT on Oct 14 are 23:50 UTC Oct 14 and 00:10 UTC Oct 15.
    // UTC midnight falls between them; the owner's day does not.
    await at(Date.UTC(2026, 9, 14, 23, 50), HOME_IP, view('4100000000000001', '/', 'https://www.google.com/'));
    await at(Date.UTC(2026, 9, 15, 0, 10), HOME_IP, view('4100000000000002', '/get-help', 'https://vva227.org/'));
    const rows = d1.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0].visitor).toBe(rows[1].visitor);

    const days = await visitorDays();
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ day: '2026-10-14', source: 'www.google.com', entry: '/', views: 2 });

    expect(await summaryOf()).toEqual({ views: 2, visitors: 1, pages: 2, automated_visitors: 0, automated_views: 0 });
  });
});

describe('which visitors Recent visitors keeps, once there are more than it lists', () => {
  // The people query returns every row in the window and groupVisitorDays
  // makes the cut, which must mean "the most recently active". Every
  // visitor-day is a new hash, so the 90- and 365-day windows pass the limit
  // even at this traffic.

  it('keeps only the most recently active, from every row of people in the window', async () => {
    // C arrived first and is still reading; B left earliest; A came in between.
    await at(NOW - 5 * H, '198.51.100.41', view('a100000000000001', '/c-arrives'));
    await at(NOW - 4 * H, '198.51.100.42', view('a100000000000002', '/b-leaves-first'));
    await at(NOW - 3 * H, '198.51.100.43', view('a100000000000003', '/a-between'));
    await at(NOW - H, '198.51.100.41', view('a100000000000004', '/c-still-here'));

    const results = await peopleRows(1);
    expect(results.map((r) => r.path).sort()).toEqual(['/a-between', '/b-leaves-first', '/c-arrives', '/c-still-here']);
    // Newest arrival first: A, then C, whose day began earliest. B left first.
    expect(groupVisitorDays(results, 2).map((d) => d.entry)).toEqual(['/a-between', '/c-arrives']);
  });

  it(`lists exactly ${RECENT_VISITORS_LIMIT}, leaving out the least recently active`, async () => {
    const total = RECENT_VISITORS_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      // One visitor each, a minute apart: visitor i was last seen i minutes after visitor 0.
      await at(NOW - (total - i) * 60_000, `10.0.${Math.floor(i / 256)}.${i % 256}`, view(`b${String(i).padStart(15, '0')}`, `/p-${i}`));
    }
    const days = await visitorDays();
    expect(days).toHaveLength(RECENT_VISITORS_LIMIT);
    expect(days.map((d) => d.entry)).toEqual(Array.from({ length: RECENT_VISITORS_LIMIT }, (_, k) => `/p-${total - 1 - k}`));
  });
});

describe('the upsert, as the owner sees it', () => {
  it('shows when a visit STARTED, not when its last flush arrived', async () => {
    await at(NOW - 3 * H, HOME_IP, view('5000000000000001', '/'));
    await at(NOW - 3 * H + 25 * 60_000, HOME_IP, end('5000000000000001', '/', 25 * 60_000));
    const $ = await page();
    const row = $('section').first().find('tbody tr').first().find('td').toArray().map((c) => $(c).text());
    expect(row[0]).toBe('2026-10-17 09:00');
    expect(row[8]).toBe('25m');
  });

  it('reports the longest reading time when flushes arrive out of order', async () => {
    await at(NOW - H, HOME_IP, view('6000000000000001', '/about'));
    await at(NOW - H + 2_000, HOME_IP, end('6000000000000001', '/about', 90_000));
    await at(NOW - H + 3_000, HOME_IP, end('6000000000000001', '/about', 30_000));
    const $ = await page();
    const pages = $('section').filter((_, el) => $(el).find('h2').text() === 'Pages');
    expect(pages.find('tbody td').toArray().map((c) => $(c).text())).toEqual(['/about', '1', '1m 30s']);
  });

  it('counts where a visitor came from once, though every later page carries an internal referrer', async () => {
    await at(NOW - H, HOME_IP, view('7000000000000001', '/', 'https://www.facebook.com/VVA227/'));
    await at(NOW - H + 1, HOME_IP, view('7000000000000002', '/about', 'https://vva227.org/'));
    await at(NOW - H + 2, OFFICE_IP, view('7000000000000003', '/', 'https://www.facebook.com/'), {
      headers: { 'User-Agent': 'Office' },
    });
    const $ = await page();
    const sources = $('section').filter((_, el) => $(el).find('h2').text() === 'Sources');
    expect(sources.find('tbody tr').toArray().map((tr) => $(tr).find('td').toArray().map((c) => $(c).text()))).toEqual([
      ['www.facebook.com', '2'],
    ]);
  });
});

describe('crawlers, set aside from the people', () => {
  // Networks and places as Cloudflare attaches them, under its own field names.
  const net = (asn: number, asOrganization: string, place: Partial<CfProperties> = {}): CfProperties => ({
    country: 'US',
    asn,
    asOrganization,
    ...place,
  });
  const TENCENT = net(132203, 'ACEVILLE PTE.LTD.', { city: 'Ashburn', regionCode: 'VA' });
  const UNICOM = net(4837, 'China Unicom Jiangsu province network', { country: 'CN', city: 'Nanjing' });
  const CHINA_MOBILE = net(56046, 'China Mobile Communications Group Co., Ltd.', { country: 'CN', city: 'Suzhou' });
  const GOOGLE = net(15169, 'Google LLC', { city: 'Council Bluffs', regionCode: 'IA' });
  const PRIVATE_RELAY = net(13335, 'Cloudflare, Inc.', { city: 'Fairfax', regionCode: 'VA' });

  const sized = (v: string, p: string, w: number, h: number) => ({ k: EVENT_VIEW, v, p, w, h });

  async function setAside() {
    const { results } = await d1.binding.prepare(STATS_SQL.automated).bind(SITE_KEY, NOW - 30 * DAY).all<Record<string, unknown>>();
    return results.map((r) => [r.reason, r.asn, r.visitors, r.views]);
  }

  it('keeps a person on Recent visitors however many crawlers came after them', async () => {
    // Before crawlers were set aside, a reader who arrived early in the day
    // was pushed past the 100 the table lists by crawlers that came later.
    await at(NOW - 5 * H, HOME_IP, view('d000000000000001', '/events', 'https://www.bing.com/'));
    await at(NOW - 5 * H + 47_000, HOME_IP, end('d000000000000001', '/events', 47_000));
    const crawlers = RECENT_VISITORS_LIMIT + 5;
    for (let i = 0; i < crawlers; i++) {
      await at(NOW - 4 * H + i * 60_000, `10.9.${Math.floor(i / 256)}.${i % 256}`, view(`d1${String(i).padStart(14, '0')}`, `/old-${i}`), { cf: TENCENT });
    }

    const days = await visitorDays();
    expect(days.map((d) => [d.entry, d.source, d.engagedMs])).toEqual([['/events', 'www.bing.com', 47_000]]);

    expect(await summaryOf()).toEqual({ views: 1, visitors: 1, pages: 1, automated_visitors: crawlers, automated_views: crawlers });
    expect(await setAside()).toEqual([['crawler-network', 132203, crawlers, crawlers]]);
  });

  it('sets aside each kind of crawler, through the real collector, and keeps the people beside them', async () => {
    const ip = (n: number) => `198.51.100.${100 + n}`;
    // A crawler network, set aside whatever it did: even 60s of "reading".
    await at(NOW - 9 * H, ip(1), view('e000000000000001', '/view-calendar'), { cf: TENCENT });
    await at(NOW - 9 * H + 60_000, ip(1), end('e000000000000001', '/view-calendar', 60_000), { cf: TENCENT });
    // A crawler-sized window on a home network, on every view it made.
    await at(NOW - 8 * H, ip(2), sized('e000000000000002', '/PTSD', 1800, 1125), { cf: UNICOM });
    await at(NOW - 8 * H + 1, ip(2), sized('e000000000000003', '/Surveys', 1800, 1125), { cf: UNICOM });
    // A person who happened to be in that size once, then resized: counted.
    await at(NOW - 7 * H, ip(3), sized('e000000000000004', '/', 1800, 1125));
    await at(NOW - 7 * H + 1, ip(3), sized('e000000000000005', '/give', 1440, 900));
    // Google's data centre: loaded and left is a crawler; reading is a person.
    await at(NOW - 6 * H, ip(4), view('e000000000000006', '/'), { cf: GOOGLE });
    await at(NOW - 5 * H, ip(5), view('e000000000000007', '/events'), { cf: GOOGLE });
    await at(NOW - 5 * H + 30_000, ip(5), end('e000000000000007', '/events', 30_000), { cf: GOOGLE });
    // Mainland China: loaded and left is set aside; reading is counted.
    await at(NOW - 4 * H, ip(6), sized('e000000000000008', '/news-stories', 1295, 999), { cf: CHINA_MOBILE });
    await at(NOW - 3 * H, ip(7), view('e000000000000009', '/about'), { cf: CHINA_MOBILE });
    await at(NOW - 3 * H + 20_000, ip(7), end('e000000000000009', '/about', 20_000), { cf: CHINA_MOBILE });
    // A person whose last flush never arrived: no reading time, still a person.
    await at(NOW - 2 * H, ip(8), view('e000000000000010', '/get-help'));
    // iCloud Private Relay leaves through Cloudflare's network: a person.
    await at(NOW - H, ip(9), view('e000000000000011', '/join'), { cf: PRIVATE_RELAY });
    for (const row of d1.rows()) expectViewRow(row);

    expect(await setAside()).toEqual([
      ['crawler-window', 4837, 1, 2],
      ['country-nothing-read', 56046, 1, 1],
      ['crawler-network', 132203, 1, 1],
      ['network-nothing-read', 15169, 1, 1],
    ]);
    expect((await visitorDays()).map((d) => d.entry).sort()).toEqual(['/', '/about', '/events', '/get-help', '/join']);

    expect(await summaryOf()).toEqual({ views: 6, visitors: 5, pages: 6, automated_visitors: 4, automated_views: 5 });

    // The other tables count only the people.
    const $ = await page();
    const table = (caption: string) =>
      $('section')
        .filter((_, el) => $(el).find('h2').text() === caption)
        .find('tbody tr')
        .toArray()
        .map((tr) => $(tr).find('td').toArray().map((c) => $(c).text()));
    expect(table('Pages').map((r) => r[0]).sort()).toEqual(['/', '/about', '/events', '/get-help', '/give', '/join']);
    expect(table('Networks').map((r) => r[0]).sort()).toEqual([
      'China Mobile Communications Group Co., Ltd.',
      'Cloudflare, Inc.',
      'Comcast Cable Communications, LLC',
      'Google LLC',
    ]);
    expect(table('Set aside as likely automated').map((r) => r[1])).toEqual([
      'China Unicom Jiangsu province network (AS4837)',
      'China Mobile Communications Group Co., Ltd. (AS56046)',
      'ACEVILLE PTE.LTD. (AS132203)',
      'Google LLC (AS15169)',
    ]);
  });

  it('lists every set-aside network, never cut short, so a one-visitor misjudgement shows', async () => {
    // More set-aside groups than any other table keeps, each of two crawlers...
    for (let g = 0; g < TABLE_LIMIT + 3; g++) {
      for (let k = 0; k < 2; k++) {
        await at(NOW - 3 * H + g * 100 + k, `10.8.${g}.${k}`, sized(`d2${String(g * 2 + k).padStart(14, '0')}`, '/', 1800, 1125), {
          cf: net(64_512 + g, `Crawler host ${g}`, { country: 'CN' }),
        });
      }
    }
    // ...and one home reader whose window happened to be crawler-sized.
    await at(NOW - H, '198.51.100.250', sized('d300000000000001', '/join', 1800, 1125));

    const rows = await setAsideRows();
    expect(rows).toHaveLength(TABLE_LIMIT + 4);
    expect(rows.at(-1)).toMatchObject({ reason: 'crawler-window', asn: 7922, visitors: 1, views: 1 });
    expect(setAsideTotals(rows)).toEqual({ visitors: 2 * (TABLE_LIMIT + 3) + 1, views: 2 * (TABLE_LIMIT + 3) + 1 });
    const html = (await page()).html();
    expect(html).toContain('Comcast Cable Communications, LLC (AS7922)');
  });

  it('names the strongest reason when a visitor matches several rules', async () => {
    // Tencent, crawler-sized, in China, nothing read: the network wins.
    await at(NOW - 2 * H, '198.51.100.231', sized('f200000000000001', '/', 1800, 1125), { cf: { ...TENCENT, country: 'CN' } });
    // Crawler-sized on Google, nothing read: the window wins over the data centre.
    await at(NOW - 2 * H + 1, '198.51.100.232', sized('f200000000000002', '/', 1024, 569), { cf: GOOGLE });
    // Google's data centre in China, nothing read: the data centre wins over the country.
    await at(NOW - 2 * H + 2, '198.51.100.233', view('f200000000000003', '/'), { cf: { ...GOOGLE, country: 'CN' } });
    expect((await setAside()).map(([reason, asn]) => [reason, asn])).toEqual([
      ['crawler-network', 132203],
      ['crawler-window', 15169],
      ['network-nothing-read', 15169],
    ]);
  });

  it('keeps a network’s reasons apart, and ranks by visitors before views', async () => {
    // Two China Mobile visitors set aside for their window, one view each...
    await at(NOW - 4 * H, '198.51.100.241', sized('f300000000000001', '/', 1800, 1125), { cf: CHINA_MOBILE });
    await at(NOW - 4 * H + 1, '198.51.100.242', sized('f300000000000002', '/', 1800, 1125), { cf: CHINA_MOBILE });
    // ...one more for reading nothing, over three views...
    for (let i = 0; i < 3; i++) await at(NOW - 3 * H + i, '198.51.100.243', sized(`f30000000000001${i}`, `/p${i}`, 1295, 999), { cf: CHINA_MOBILE });
    // ...and one Tencent visitor with five views, more than either.
    for (let i = 0; i < 5; i++) await at(NOW - 2 * H + i, '198.51.100.244', view(`f30000000000002${i}`, `/t${i}`), { cf: TENCENT });
    expect(await setAside()).toEqual([
      ['crawler-window', 56046, 2, 2],
      ['crawler-network', 132203, 1, 5],
      ['country-nothing-read', 56046, 1, 3],
    ]);
  });

  it('judges a visitor on their whole day, though the window starts part-way through it', async () => {
    // A reader on Google's network read a page before the 7-day window began
    // and opened one more, unread, inside it. Judged on the in-window row
    // alone they would be "a data centre, nothing read".
    const since = NOW - 7 * DAY;
    await at(since - 2 * H, '198.51.100.251', view('f400000000000001', '/before'), { cf: GOOGLE });
    await at(since - 2 * H + 30_000, '198.51.100.251', end('f400000000000001', '/before', 30_000), { cf: GOOGLE });
    await at(since + H, '198.51.100.251', view('f400000000000002', '/after'), { cf: GOOGLE });
    expect(d1.rows().map((r) => r.visitor).every((v, _, all) => v === all[0])).toBe(true);

    for (const days of [7, 30]) {
      expect(await setAsideRows(days), `${days} days`).toEqual([]);
      expect((await visitorDays(days)).length, `${days} days`).toBe(1);
    }
    // In the 7-day window only the in-window view is counted.
    expect((await summaryOf(7)).views).toBe(1);
  });

  it('counts a crawler’s referrer nowhere, not even under Sources', async () => {
    // A link checker on Meta's network that followed a link from Facebook.
    await at(NOW - H, '198.51.100.252', view('f500000000000001', '/', 'http://m.facebook.com'), { cf: net(32934, 'Meta Platforms Ireland Limited') });
    await at(NOW - H + 1, '198.51.100.253', view('f500000000000002', '/', 'https://duckduckgo.com/'));
    const $ = await page();
    const sources = $('section').filter((_, el) => $(el).find('h2').text() === 'Sources');
    expect(sources.find('tbody tr').toArray().map((tr) => $(tr).find('td').first().text())).toEqual(['duckduckgo.com']);
    expect(await setAside()).toEqual([['network-nothing-read', 32934, 1, 1]]);
  });

  it('tallies only the most recent rows past the people-row limit, and the page says so', async () => {
    for (let i = 0; i < 4; i++) await at(NOW - (4 - i) * H, `198.51.100.${150 + i}`, view(`f60000000000000${i}`, `/p${i}`));
    const small = buildStatsSql(AUTOMATED_LISTS, { peopleRowLimit: 3 });
    const rows = await peopleRows(30, NOW, small.people);
    expect(rows.map((r) => r.path)).toEqual(['/p3', '/p2', '/p1']);
  });

  it('sets aside nothing when every list is empty, and counts every visitor as a person', async () => {
    await at(NOW - 2 * H, '198.51.100.201', sized('f000000000000001', '/', 1800, 1125), { cf: TENCENT });
    await at(NOW - H, '198.51.100.202', view('f000000000000002', '/'), { cf: GOOGLE });
    const bare = buildStatsSql({ crawlerNetworks: [], crawlerWindows: [], nothingReadNetworks: [], nothingReadCountries: [] });
    expect(tallyPeople(await peopleRows(30, NOW, bare.people)).summary).toEqual({ views: 2, visitors: 2, pages: 1 });
    expect(await setAsideRows(30, NOW, bare.automated)).toEqual([]);
  });

  it('judges a crawler network by its number, whatever name it is registered under', async () => {
    // Tencent's addresses come back as "ACEVILLE PTE.LTD.", "16 COLLYER QUAY"
    // and "6 COLLYER QUAY"; only the number is the same.
    for (const [i, name] of ['ACEVILLE PTE.LTD.', '16 COLLYER QUAY # 18-29 INCOME AT RAFFLES', '6 COLLYER QUAY'].entries()) {
      await at(NOW - H + i, `198.51.100.${210 + i}`, view(`f10000000000000${i}`, '/'), { cf: net(132203, name) });
    }
    expect(await setAside()).toEqual([['crawler-network', 132203, 3, 3]]);
    expect(CRAWLER_NETWORKS.map((n) => n.asn)).toContain(132203);
  });
});

describe('retention, end to end', () => {
  it('a view prunes only expired rows, and the page never shows them', async () => {
    d1.seed({ view: '8000000000000001', visitor: 'e'.repeat(32), ts: NOW - (RETENTION_DAYS + 1) * DAY, path: '/expired' });
    d1.seed({ view: '8000000000000002', visitor: 'e'.repeat(32), ts: NOW - 300 * DAY, path: '/kept' });
    await at(NOW, HOME_IP, view('8000000000000003', '/'));

    expect(d1.rows().map((r) => r.path).sort()).toEqual(['/', '/kept']);
    const html = (await page('?days=365')).html();
    expect(html).toContain('/kept');
    expect(html).not.toContain('/expired');
  });
});

describe('the queries themselves', () => {
  it('run as one batch of two, each within D1’s limits, none scanning the whole table', async () => {
    await at(NOW, HOME_IP, view('9000000000000001', '/'));
    const before = d1.statements.length;
    await page();
    const ran = d1.statements.slice(before);
    expect(ran.map((s) => s.sql)).toEqual(Object.values(STATS_SQL));

    // The shim already throws on more than 100 parameters or a long compound
    // SELECT; this adds that no query reads every row to answer.
    for (const sql of Object.values(STATS_SQL)) {
      expect(paramCount(sql), sql).toBe(2);
      expect(fullScans(sql, [SITE_KEY, 0]), sql).toEqual([]);
    }
    expect(fullScans(PRUNE_SQL, [0])).toEqual([]);
  });

  it('can actually fail — an unindexed query is reported as a full scan', () => {
    expect(fullScans('SELECT * FROM views WHERE path = ?1', ['/'])).toEqual(['SCAN views']);
  });

  it(`keep the ${TABLE_LIMIT} most viewed pages, dropping the least viewed though it sorts first by name`, async () => {
    // A probe or a 404 adds paths nobody chose; past the limit the table
    // must lose the least viewed, not whichever sorts last.
    let n = 0;
    const visit = (path: string) => at(NOW - H + n, HOME_IP, view(`c${String(n++).padStart(15, '0')}`, path));
    await visit('/a-least');
    for (let i = 0; i < TABLE_LIMIT; i++) {
      await visit(`/p-${String(i).padStart(2, '0')}`);
      await visit(`/p-${String(i).padStart(2, '0')}`);
    }
    const $ = await page();
    const pages = $('section').filter((_, el) => $(el).find('h2').text() === 'Pages');
    const paths = pages.find('tbody tr').toArray().map((tr) => $(tr).find('td').first().text());
    expect(paths).toEqual(Array.from({ length: TABLE_LIMIT }, (_, i) => `/p-${String(i).padStart(2, '0')}`));
  });

  it('find nothing for another site sharing the database', async () => {
    d1.seed({ view: '9100000000000001', site: 'another-site', visitor: 'e'.repeat(32), ts: NOW, path: '/theirs' });
    expect(await visitorDays()).toEqual([]);
    expect((await page()).html()).not.toContain('/theirs');
  });

  it('show the visitor id only as its first six characters', async () => {
    await at(NOW, HOME_IP, view('9200000000000001', '/'));
    const full = String(d1.rows()[0].visitor);
    const html = (await page()).html();
    expect(html).toContain(shortVisitor(full));
    expect(html).not.toContain(full);
  });
});
