import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { onRequest } from '../../functions/stats';
import { createD1, createEnv, ORIGIN, type TestD1 } from '../helpers/d1';
import { expectStatsNotFound, expectStatsPageHeaders } from '../helpers/analytics';
import { accessEnv, AUD, certsServer, claimsFor, createSigner, TEAM, type Signer } from '../helpers/access-jwt';
import { STATS_PATH } from '../../src/data/analytics';
import { ACCESS_REFUSAL_REASONS } from '../../src/lib/access';
import { ACCESS_JWT_HEADER } from '../../src/lib/stats-gate';
import type { D1Like } from '../../src/lib/runtime';
import { RECENT_VISITORS_LIMIT, shortVisitor, WINDOWS } from '../../src/lib/stats';

/**
 * FEATURE — the /stats page, run whole: rows in the database, a signed-in
 * owner's request in, a complete page out. The handler is the one production
 * exports, with the real Cloudflare Access gate in front of it. The database
 * is real SQLite with the real migration; the token is really signed with an
 * RSA key; the only stand-in is Cloudflare's certs endpoint, which serves that
 * key's public half (global fetch, the one external boundary).
 *
 * Every section and every column is asserted from the parsed page, along
 * with every response header. Every way the gate can refuse is driven through
 * the same handler and must give the same plain 404, with the reason in the
 * log and nowhere else.
 *
 * TIER JUSTIFICATION: the unit tier renders hand-built view models and asks
 * the gate questions on its own. Here the values have to survive the gate,
 * six real queries, the batch's result order, the grouping and the rendering
 * together — a query returning columns in the wrong order, the batch results
 * mapped to the wrong table, or a gate verdict the handler reads wrongly, only
 * shows up when all of them run at once.
 */

const NOW = Date.UTC(2026, 9, 17, 16, 0); // 12:00 Eastern
const H = 3_600_000;
const DAY = 24 * H;

const A = 'a1'.repeat(16);
const B = 'b2'.repeat(16);
const C = 'c3'.repeat(16);

const NOW_S = NOW / 1000;

let signer: Signer;
let d1: TestD1;
let clock: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  signer = await createSigner();
});

beforeEach(() => {
  d1 = createD1();
  clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
  // Cloudflare's certs endpoint for TEAM, serving the signer's public key.
  // Any other URL is a 404, so a gate that fetched the wrong one would fail.
  vi.stubGlobal('fetch', certsServer(signer.jwks).fetch);
});

afterEach(() => {
  clock.mockRestore();
  d1.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The production env, as the setup script leaves it: the binding, the salt and both Access settings. */
const ownerEnv = (binding: D1Like | undefined) => createEnv(binding, accessEnv());

/** What Access attaches to a request it let through for the owner. */
const ownerToken = () => signer.sign(claimsFor(NOW_S));

const get = async (
  query = '',
  { method = 'GET', env = ownerEnv(d1.binding), token }: { method?: string; env?: ReturnType<typeof createEnv>; token?: string | null } = {},
) => {
  const assertion = token === undefined ? await ownerToken() : token;
  const headers: Record<string, string> = assertion === null ? {} : { [ACCESS_JWT_HEADER]: assertion };
  return onRequest({ request: new Request(`${ORIGIN}${STATS_PATH}${query}`, { method, headers }), env });
};

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
    expect(note).toContain('Visitor ids reset at midnight Eastern time');
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

describe('more visitors than Recent visitors lists', () => {
  it(`shows the ${RECENT_VISITORS_LIMIT} most recently active, the earliest arrival among them if still active, while the summary counts all`, async () => {
    // One reader arrived before everyone, the same day, and was still reading
    // at the end. Ordered by arrival they would be the first cut; by last
    // activity they are the first kept, which is what the table promises.
    const early = 'e'.repeat(32);
    d1.seed({ view: '3000000000000001', visitor: early, ts: NOW - 11 * H, path: '/early-arrival' });
    d1.seed({ view: '3000000000000002', visitor: early, ts: NOW - 60_000, path: '/early-again' });
    const others = RECENT_VISITORS_LIMIT + 4;
    for (let i = 0; i < others; i++) {
      d1.seed({ view: `4${String(i).padStart(15, '0')}`, visitor: i.toString(16).padStart(32, '0'), ts: NOW - 10 * H + i * 60_000, path: `/p-${i}` });
    }

    const $ = cheerio.load(await (await get()).text());
    const rows = tableOf($, 'Recent visitors').slice(1);
    expect(rows).toHaveLength(RECENT_VISITORS_LIMIT);
    const entries = rows.map((r) => r[6]);
    // Newest arrival first, so the early reader is the last row, with both pages.
    expect(rows.at(-1)).toEqual(['2026-10-17 01:00', shortVisitor(early), '-', '-', '-', '(direct)', '/early-arrival', '2', '0s']);
    expect(entries.slice(0, -1)).toEqual(Array.from({ length: RECENT_VISITORS_LIMIT - 1 }, (_, k) => `/p-${others - 1 - k}`));
    // The five least recently active are the ones left out.
    for (let i = 0; i < 5; i++) expect(entries).not.toContain(`/p-${i}`);
    expect($('.summary').text()).toBe(`${others + 2} views · ${others + 1} visitors · ${others + 2} pages`);
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
    await expectStatsNotFound(await get('', { env: ownerEnv(undefined) }));
  });

  it('answers 500 without describing the schema when a query fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { ...d1.binding, batch: async () => { throw new Error('D1_ERROR: no such column: visitor'); } };
    const res = await get('', { env: ownerEnv(broken) });
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

describe('the Access gate, as the owner and a stranger meet it', () => {
  /** One way in being refused: the request it makes, and the reason the log must give. */
  type Attempt = () => Promise<{ token: string | null; env?: ReturnType<typeof createEnv> }>;

  const ATTEMPTS: Array<[string, string, Attempt]> = [
    ['Access settings missing from the deployment', 'access not configured', async () => ({ token: await ownerToken(), env: createEnv(d1.binding) })],
    ['no token, as on a host with no Access application', 'no token', async () => ({ token: null })],
    ['a token that is not a JWT', 'malformed token', async () => ({ token: 'not-a-jwt' })],
    ['alg:none', 'unsupported algorithm', async () => ({ token: signer.signNone(claimsFor(NOW_S)) })],
    ['HS256 keyed with the public key', 'unsupported algorithm', async () => ({ token: await signer.signHs256(claimsFor(NOW_S)) })],
    ['a header with no key id', 'no key id', async () => ({ token: await signer.sign(claimsFor(NOW_S), { header: { kid: undefined } }) })],
    [
      'a team whose keys cannot be fetched',
      'cannot fetch signing keys',
      async () => ({
        token: await signer.sign(claimsFor(NOW_S, { iss: 'https://unreachable.cloudflareaccess.com' })),
        env: createEnv(d1.binding, accessEnv({ ACCESS_TEAM_DOMAIN: 'unreachable.cloudflareaccess.com' })),
      }),
    ],
    ['a key Cloudflare never published', 'unknown key id', async () => ({ token: await (await createSigner('stolen-elsewhere')).sign(claimsFor(NOW_S)) })],
    ['a tampered signature', 'bad signature', async () => ({ token: await signer.sign(claimsFor(NOW_S), { corrupt: true }) })],
    ['another Access team', 'wrong issuer', async () => ({ token: await signer.sign(claimsFor(NOW_S, { iss: 'https://someone-else.cloudflareaccess.com' })) })],
    ['another Access application', 'wrong audience', async () => ({ token: await signer.sign(claimsFor(NOW_S, { aud: ['b'.repeat(64)] })) })],
    ['an expired session', 'expired', async () => ({ token: await signer.sign(claimsFor(NOW_S, { exp: NOW_S - 3600 })) })],
    ['a token not valid yet', 'not yet valid', async () => ({ token: await signer.sign(claimsFor(NOW_S, { nbf: NOW_S + 3600 })) })],
    ['a token issued in the future', 'issued in the future', async () => ({ token: await signer.sign(claimsFor(NOW_S, { iat: NOW_S + 3600, nbf: NOW_S })) })],
  ];

  it('covers every reason the gate can give', () => {
    expect([...new Set(ATTEMPTS.map(([, reason]) => reason))].sort()).toEqual([...ACCESS_REFUSAL_REASONS].sort());
  });

  it.each(ATTEMPTS)('refuses %s with the plain 404, the reason only in the log, and D1 untouched', async (_label, reason, attempt) => {
    seedTraffic();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { token, env } = await attempt();
    const statementsBefore = d1.statements.length;

    const res = await get('', { token, env });

    const body = await res.clone().text();
    await expectStatsNotFound(res);
    expect(body).not.toContain(reason);
    expect(warn.mock.calls).toEqual([['stats denied:', reason]]);
    expect(d1.statements.length).toBe(statementsBefore);
  });

  it('answers every one of them byte for byte the same, by GET or by POST', async () => {
    // Every refusal above is checked against the same expected response; this
    // proves they are also equal to each other, across reasons and methods,
    // so a stranger learns nothing about how close they came.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen = [];
    for (const [, , attempt] of ATTEMPTS) {
      const { token, env } = await attempt();
      for (const method of ['GET', 'POST']) {
        const res = await get('?days=7', { token, env, method });
        seen.push({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
      }
    }
    for (const s of seen) expect(s).toEqual(seen[0]);
  });

  it('lets the owner in with the same token on every window, and on HEAD', async () => {
    seedTraffic();
    const token = await ownerToken();
    for (const query of ['', ...WINDOWS.map((d) => `?days=${d}`)]) {
      const res = await get(query, { token });
      expect(res.status, query).toBe(200);
      expectStatsPageHeaders(res);
    }
    expect((await get('', { token, method: 'HEAD' })).status).toBe(200);
  });

  it('accepts settings stored with a trailing newline, as a pasted value carries', async () => {
    const env = createEnv(d1.binding, accessEnv({ ACCESS_TEAM_DOMAIN: `${TEAM}\n`, ACCESS_AUD: `${AUD}\n` }));
    expect((await get('', { env })).status).toBe(200);
  });
});
