import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { onRequest, createStatsHandler } from '../../functions/stats';
import { onRequest as collect } from '../../functions/api/e';
import { beaconRequest, createD1, createEnv, ORIGIN, type TestD1 } from '../helpers/d1';
import { expectStatsNotFound, expectStatsPageHeaders } from '../helpers/analytics';
import { EVENT_VIEW, STATS_PATH } from '../../src/data/analytics';
import type { D1Like } from '../../src/lib/runtime';
import type { GateVerdict } from '../../src/lib/stats-gate';

/**
 * SECURITY — the /stats handler: who gets in, what they see, and what a
 * stranger learns from being turned away.
 *
 * Three properties, each of which a page can lose without any test of its
 * rendering noticing:
 *   - the gate runs FIRST — before the method check and before D1 is touched;
 *   - every refusal is the same response, byte for byte, whatever the reason;
 *   - everything rendered is escaped, because path, referrer and the network
 *     name all reach the page from a public endpoint.
 *
 * The gate is not chosen yet (src/lib/stats-gate.ts). These tests use the
 * REAL gate wherever the question is "is a stranger refused", so they hold
 * whatever replaces it, and inject one only to reach the allowed path.
 *
 * TIER JUSTIFICATION: the unit tier proves the gate function returns a
 * refusal. Only here is it proven that the handler asks it before anything
 * else, honours the answer, and gives nothing away when it refuses.
 */

const SECRET_PATH = '/a-page-only-the-owner-should-see';
const allow = async (): Promise<GateVerdict> => ({ ok: true });

let d1: TestD1;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  d1 = createD1();
  d1.seed({ view: 'aaaaaaaabbbbbbbb', visitor: 'f'.repeat(32), path: SECRET_PATH, ts: Date.now() });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  d1.close();
  vi.restoreAllMocks();
});

const request = (init: RequestInit = {}, query = '') => new Request(`${ORIGIN}${STATS_PATH}${query}`, init);

/** A D1 binding that records any use at all, and refuses it. */
function tripwire(): { binding: D1Like; touched: string[] } {
  const touched: string[] = [];
  const binding = new Proxy({} as D1Like, {
    get(_t, prop) {
      touched.push(String(prop));
      throw new Error(`D1 touched: ${String(prop)}`);
    },
  });
  return { binding, touched };
}

/** A response reduced to everything a client can observe. */
async function observable(res: Response) {
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
}

describe('the real gate, as it ships today', () => {
  it.each([
    ['a bare request', {}],
    ['a forged Access token', { headers: { 'Cf-Access-Jwt-Assertion': 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.' } }],
    ['Basic credentials', { headers: { Authorization: 'Basic b3duZXI6b3duZXI=' } }],
    ['a POST', { method: 'POST', body: 'password=owner' }],
  ])('refuses %s with the plain 404 and leaks nothing', async (_label, init) => {
    const res = await onRequest({ request: request(init as RequestInit), env: createEnv(d1.binding, { STATS_PASSWORD: 'owner' }) });
    const seen = await observable(res.clone());
    await expectStatsNotFound(res);
    expect(seen.body).not.toContain(SECRET_PATH);
    expect(seen.body).not.toContain('Visits');
  });

  it('refuses before touching D1', async () => {
    const { binding, touched } = tripwire();
    await expectStatsNotFound(await onRequest({ request: request(), env: createEnv(binding) }));
    expect(touched).toEqual([]);
  });

  it('logs why it refused, and only logs it', async () => {
    const res = await onRequest({ request: request(), env: createEnv(d1.binding) });
    expect(warn).toHaveBeenCalledWith('stats denied:', 'gate not configured');
    expect(await res.text()).not.toContain('configured');
  });
});

describe('the gate runs first', () => {
  it('is asked before D1 is touched, and D1 is never touched on a refusal', async () => {
    const { binding, touched } = tripwire();
    const order: string[] = [];
    const deny = async () => {
      order.push('gate');
      return { ok: false as const, reason: 'nope' };
    };
    await expectStatsNotFound(await createStatsHandler(deny)({ request: request(), env: createEnv(binding) }));
    expect(order).toEqual(['gate']);
    expect(touched).toEqual([]);
  });

  it('is asked before the method is checked, so a refused POST cannot learn the route exists', async () => {
    // An allowed POST is a 405; a refused one must be the same 404 as a GET.
    const deny = async () => ({ ok: false as const, reason: 'nope' });
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      await expectStatsNotFound(await createStatsHandler(deny)({ request: request({ method }), env: createEnv(d1.binding) }));
    }
  });

  it('can actually let the owner in — the refusals above are not a handler that refuses everything', async () => {
    const res = await createStatsHandler(allow)({ request: request(), env: createEnv(d1.binding) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SECRET_PATH);
  });
});

describe('every refusal is indistinguishable', () => {
  it('answers byte-for-byte the same whatever the reason', async () => {
    const env = createEnv(d1.binding);
    const responses = await Promise.all([
      onRequest({ request: request(), env }),
      createStatsHandler(async () => ({ ok: false, reason: 'wrong password' }))({ request: request(), env }),
      createStatsHandler(async () => ({ ok: false, reason: 'expired token' }))({ request: request({ method: 'POST' }), env }),
      createStatsHandler(async () => {
        throw new Error('certs fetch failed');
      })({ request: request(), env }),
      // Allowed, but no database — what a preview deployment answers.
      createStatsHandler(allow)({ request: request(), env: createEnv(undefined) }),
    ]);
    const seen = await Promise.all(responses.map(observable));
    for (const s of seen) expect(s).toEqual(seen[0]);
    expect(seen[0].status).toBe(404);
  });

  it.each([
    ['undefined', undefined],
    ['a truthy string', 'yes'],
    ['ok as a number', { ok: 1 }],
    ['ok as a string', { ok: 'true' }],
    ['an empty object', {}],
  ])('treats a gate answering %s as a refusal', async (_label, verdict) => {
    const odd = createStatsHandler((async () => verdict) as never);
    await expectStatsNotFound(await odd({ request: request(), env: createEnv(d1.binding) }));
  });

  it('never says 401 or asks for credentials', async () => {
    const res = await onRequest({ request: request(), env: createEnv(d1.binding) });
    expect(res.status).not.toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBeNull();
  });
});

describe('hostile values posted to the collector, then shown to the owner', () => {
  async function postHostile() {
    const hostile = {
      p: '/<script>alert(1)</script>',
      r: '"><img src=x onerror=alert(1)>',
    };
    const res = await collect({
      request: beaconRequest(
        { k: EVENT_VIEW, v: 'cccccccccccccccc', ...hostile },
        { cf: { country: '<b>', city: '<img src=x>', regionCode: '"><svg onload=alert(1)>', asn: 1, asOrganization: '<script>alert(2)</script>' } },
      ),
      env: createEnv(d1.binding),
    });
    expect(res.status).toBe(204);
  }

  it('renders every one of them as text, never as markup', async () => {
    await postHostile();
    const html = await (await createStatsHandler(allow)({ request: request(), env: createEnv(d1.binding) })).text();

    // The page renders no images, scripts or SVG of its own, so any of these
    // is injected markup.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<svg/i);
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('keeps the CSP hash matching the page even with hostile content on it', async () => {
    await postHostile();
    const res = await createStatsHandler(allow)({ request: request(), env: createEnv(d1.binding) });
    const csp = expectStatsPageHeaders(res);
    const html = await res.text();
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    expect(styles).toHaveLength(1);
    expect(csp).toContain(`'sha256-${createHash('sha256').update(styles[0]).digest('base64')}'`);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('script-src');
  });
});

describe('the query string, the only input past the gate', () => {
  it.each(['?days=30;DROP TABLE views', "?days=30'--", '?days=99999999999', '?days=-1', '?days=%00'])(
    'falls back to the default window for %s, with the table intact',
    async (query) => {
      const res = await createStatsHandler(allow)({ request: request({}, query), env: createEnv(d1.binding) });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Last 30 days');
      expect(d1.rows()).toHaveLength(1);
    },
  );

  it('reflects no query parameter into the page', async () => {
    const res = await createStatsHandler(allow)({
      request: request({}, '?days=%3Cscript%3Ealert(1)%3C%2Fscript%3E&x=%3Cimg%3E'),
      env: createEnv(d1.binding),
    });
    const html = await res.text();
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).not.toContain('alert(1)');
  });
});
