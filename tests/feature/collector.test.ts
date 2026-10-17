import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { onRequest } from '../../functions/api/e';
import { beaconRequest, createD1, createEnv, FAIRFAX_CF, type BeaconRequestOptions, type TestD1 } from '../helpers/d1';
import { expectAccepted, expectRefused, expectViewRow } from '../helpers/analytics';
import { EVENT_END, EVENT_VIEW, SITE_KEY } from '../../src/data/analytics';

/**
 * FEATURE — the collector, run whole: a request goes in, a response and a row
 * come out. Nothing inside the handler is mocked; the database is real SQLite
 * running the real migration (tests/helpers/d1.ts).
 *
 * Every response is checked in full — status, every header, body — and every
 * stored row in full, through the shared validators in tests/helpers/analytics.ts.
 *
 * TIER JUSTIFICATION: the unit tier proves validateEvent() returns the right
 * object. It cannot prove those values reach the right COLUMNS in the right
 * order, that a `view` and its later `end` — two separate requests — become
 * one row, or that the handler checks the origin before it reads a body.
 */

const VIEW = 'aaaaaaaabbbbbbbb';
const T0 = Date.UTC(2026, 9, 17, 16, 0);

let d1: TestD1;
let clock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  d1 = createD1();
  clock = vi.spyOn(Date, 'now').mockReturnValue(T0);
});

afterEach(() => {
  clock.mockRestore();
  d1.close();
});

const post = (body: unknown, opts?: BeaconRequestOptions, env = createEnv(d1.binding)) =>
  onRequest({ request: beaconRequest(body, opts), env });

const view = (over: Record<string, unknown> = {}) => ({ k: EVENT_VIEW, v: VIEW, p: '/give', ...over });
const end = (over: Record<string, unknown> = {}) => ({ k: EVENT_END, v: VIEW, p: '/give', e: 5_000, ...over });

describe('happy path — a pageview, start to finish', () => {
  it('accepts a view and stores one complete row', async () => {
    await expectAccepted(await post(view({ r: 'https://www.google.com/search?q=vva+227', w: 390, h: 844 })));

    const rows = d1.rows();
    expect(rows).toHaveLength(1);
    expect(expectViewRow(rows[0])).toEqual({
      view: VIEW,
      site: SITE_KEY,
      visitor: rows[0].visitor,
      path: '/give',
      referrer: 'https://www.google.com/search',
      country: 'US',
      city: 'Fairfax',
      region: 'VA',
      asn: 7922,
      as_org: 'Comcast Cable Communications, LLC',
      viewport_w: 390,
      viewport_h: 844,
      engaged_ms: 0,
      ts: T0,
    });
  });

  it('fills in reading time from a later end without duplicating the row', async () => {
    await post(view({ r: 'https://www.facebook.com/', w: 1440, h: 900 }));
    clock.mockReturnValue(T0 + 47_000);
    await expectAccepted(await post(end({ e: 47_312 })));

    const rows = d1.rows();
    expect(rows).toHaveLength(1);
    expect(expectViewRow(rows[0])).toMatchObject({
      engaged_ms: 47_312,
      referrer: 'https://www.facebook.com/',
      viewport_w: 1440,
      viewport_h: 900,
      ts: T0,
    });
  });

  it('runs the retention prune through waitUntil when the runtime offers it', async () => {
    const deferred: Promise<unknown>[] = [];
    const res = await onRequest({ request: beaconRequest(view()), env: createEnv(d1.binding), waitUntil: (p) => deferred.push(p) });
    await expectAccepted(res);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(d1.statements.map((s) => s.sql.split(/\s+/)[0])).toEqual(['INSERT', 'DELETE']);
  });

  it('prunes inline when there is no waitUntil, rather than dropping the promise', async () => {
    await post(view());
    expect(d1.statements.map((s) => s.sql.split(/\s+/)[0])).toEqual(['INSERT', 'DELETE']);
  });

  it('does not prune on an end, which arrives several times per visit', async () => {
    await post(end());
    expect(d1.statements.map((s) => s.sql.split(/\s+/)[0])).toEqual(['INSERT']);
  });
});

describe('sad path — every refusal, with its exact answer, and nothing written', () => {
  it.each([
    ['a GET', null, { method: 'GET' }, 405, 'method not allowed', { allow: 'POST' }],
    ['another site', view(), { origin: 'https://evil.example' }, 403, 'cross-origin', {}],
    ['not JSON', 'hello', {}, 400, 'invalid JSON', {}],
    ['an unknown kind', { k: 'click', v: VIEW, p: '/' }, {}, 400, 'unknown event kind', {}],
    ['a bad view id', { k: EVENT_VIEW, v: 'nope', p: '/' }, {}, 400, 'invalid view id', {}],
    ['a bad path', view({ p: 'https://evil.example/' }), {}, 400, 'invalid path', {}],
    ['a JSON array', '[1]', {}, 400, 'body must be a JSON object', {}],
  ] as const)('refuses %s', async (_label, body, opts, status, reason, extra) => {
    await expectRefused(await post(body, opts as BeaconRequestOptions), status, reason, extra);
    expect(d1.rows()).toHaveLength(0);
  });

  it.each([
    ['the D1 binding is missing', { BEACON: undefined }],
    ['the salt is missing', { BEACON_SALT: undefined }],
    ['the salt is empty', { BEACON_SALT: '' }],
  ])('answers 500 "collector not configured" when %s — loud, never a fallback salt', async (_label, over) => {
    // This is also exactly what a preview deployment answers: previews get no
    // binding and no salt.
    await expectRefused(await post(view(), {}, createEnv(d1.binding, over)), 500, 'collector not configured');
    expect(d1.rows()).toHaveLength(0);
  });

  it('answers 500 "write failed" without echoing the database error', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exploding = {
      prepare: () => ({ bind: () => ({ run: async () => { throw new Error('D1_ERROR: no such table: views'); } }) }),
    };
    const res = await post(view(), {}, createEnv(exploding as never));
    await expectRefused(res, 500, 'write failed');
    expect(errors).toHaveBeenCalledWith('beacon write failed', 'D1_ERROR: no such table: views');
    errors.mockRestore();
  });

  it('still records the visit when the prune fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const flaky = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (sql.startsWith('DELETE')) throw new Error('prune exploded');
            return d1.binding.prepare(sql).bind(...args).run();
          },
        }),
      }),
    };
    await expectAccepted(await post(view(), {}, createEnv(flaky as never)));
    expect(d1.rows()).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith('beacon prune failed', 'prune exploded');
    errors.mockRestore();
  });
});

describe('edge cases', () => {
  it.each([
    ['request.cf is absent entirely', null],
    ['request.cf is empty', {}],
    ['every field is the wrong type', { country: 1, city: 12, region: {}, regionCode: [], asn: 'lots', asOrganization: [] }],
  ])('stores nulls rather than junk when %s', async (_label, cf) => {
    // A row Cloudflare could not place must say so, not invent a location.
    await expectAccepted(await post(view(), { cf: cf as never }));
    expect(expectViewRow(d1.one(VIEW))).toMatchObject({ country: null, city: null, region: null, asn: null, as_org: null });
  });

  it('records a complete row from an end with no view before it', async () => {
    // A visitor who leaves within milliseconds, or a lost first request. The
    // tracker resends the path on `end` so this row is still usable.
    await expectAccepted(await post(end({ e: 800 })));
    expect(expectViewRow(d1.one(VIEW))).toMatchObject({ path: '/give', engaged_ms: 800, referrer: null, ts: T0 });
  });

  it('lets a view that arrives after its end fill in what the end lacked, without moving ts', async () => {
    await post(end({ e: 800 }));
    clock.mockReturnValue(T0 + 5_000);
    await post(view({ r: 'https://www.google.com/', w: 390 }));
    expect(d1.one(VIEW)).toMatchObject({ referrer: 'https://www.google.com/', viewport_w: 390, engaged_ms: 800, ts: T0 });
  });

  it('accepts a request that carries no Origin header at all', async () => {
    // A missing Origin is allowed, a mismatched one refused: requiring it could
    // silently drop our own traffic from a transport that omits it.
    await expectAccepted(await post(view(), { origin: null }));
    expect(d1.rows()).toHaveLength(1);
  });

  it('accepts its own origin on the pages.dev host, where the origin moves with the request', async () => {
    const host = 'https://vva227-refresh-12g.pages.dev';
    await expectAccepted(await post(view(), { origin: host, url: `${host}/api/e` }));
    expect(d1.rows()).toHaveLength(1);
  });

  it('gives the same visitor the same id across pages, and a different visitor a different one', async () => {
    await post(view());
    await post(view({ v: 'ccccccccdddddddd', p: '/about' }));
    await post(view({ v: 'eeeeeeeeffffffff' }), { headers: { 'CF-Connecting-IP': '198.51.100.9' } });

    const byView = Object.fromEntries(d1.rows().map((r) => [r.view, r.visitor]));
    expect(byView[VIEW]).toBe(byView.ccccccccdddddddd);
    expect(byView[VIEW]).not.toBe(byView.eeeeeeeeffffffff);
  });

  it('gives the same visitor a new id the next day', async () => {
    await post(view());
    clock.mockReturnValue(T0 + 86_400_000);
    await post(view({ v: 'ccccccccdddddddd' }));
    const visitors = new Set(d1.rows().map((r) => r.visitor));
    expect(visitors.size).toBe(2);
  });

  it('records the geo it is given, the same on a view and an end', async () => {
    await post(end(), { cf: { ...FAIRFAX_CF, city: 'Arlington' } });
    expect(d1.one(VIEW)?.city).toBe('Arlington');
  });
});
