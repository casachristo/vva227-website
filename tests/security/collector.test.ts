import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { onRequest } from '../../functions/api/e';
import {
  beaconRequest,
  createD1,
  createEnv,
  ORIGIN,
  TEST_IP,
  TEST_SALT,
  TEST_UA,
  type BeaconRequestOptions,
  type TestD1,
} from '../helpers/d1';
import { expectAccepted, expectRefused, expectViewRow } from '../helpers/analytics';
import {
  BEACON_ENDPOINT,
  COLLECT_HOSTS,
  EVENT_END,
  EVENT_VIEW,
  MAX_BODY_BYTES,
  MAX_PATH_CHARS,
  MAX_REFERRER_CHARS,
  SITE_KEY,
} from '../../src/data/analytics';
import { MAX_ENGAGED_MS } from '../../src/lib/beacon';

/**
 * SECURITY — the collector is the only place on this site where a stranger's
 * input is written anywhere.
 *
 * Everything else is static files. functions/api/e.ts accepts a POST from
 * anyone who reads the HTML, parses their JSON and writes it to a database, so
 * its input handling and its origin check are its whole defence. There is no
 * authentication to test: a beacon cannot have any, because the credential
 * would ship in the page.
 *
 * Refusals are paired with "and wrote nothing", because a handler that answers
 * 400 after inserting passes a status-only test while filling the table.
 *
 * TIER JUSTIFICATION: the unit tier proves the validator rejects a protocol-
 * relative path. Only here is it proven that the handler consults the
 * validator before writing, that the origin check runs before the body is
 * parsed, and that the IP — which the handler does read — reaches no column
 * and no log line.
 */

const VIEW = 'aaaaaaaabbbbbbbb';
let d1: TestD1;

beforeEach(() => {
  d1 = createD1();
});

afterEach(() => {
  d1.close();
  vi.restoreAllMocks();
});

const post = (body: unknown, opts?: BeaconRequestOptions) =>
  onRequest({ request: beaconRequest(body, opts), env: createEnv(d1.binding) });
const view = (over: Record<string, unknown> = {}) => ({ k: EVENT_VIEW, v: VIEW, p: '/give', ...over });

describe('method', () => {
  it.each(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('refuses %s', async (method) => {
    const res = await post(null, { method });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(d1.rows()).toHaveLength(0);
  });

  it('accepts POST, so the matrix above cannot pass by refusing everything', async () => {
    await expectAccepted(await post(view()));
  });
});

describe('host', () => {
  // The same Function, with the same production database and salt, also
  // answers on the project's pages.dev address, where no rate-limiting rule
  // on the vva227.org zone applies. Only the domain itself may write.
  // The Origin header as a browser writes it: the serialised origin of the page.
  const at = (origin: string, body: unknown = view()) =>
    post(body, { origin: new URL(origin).origin, url: `${origin}${BEACON_ENDPOINT}` });

  it.each([
    ['the live project on pages.dev', 'https://vva227-refresh-12g.pages.dev'],
    ['a preview deployment', 'https://3f2a9c1d.vva227-refresh-12g.pages.dev'],
    ['the old staging address', 'https://vva227-refresh.pages.dev'],
    ['an unknown host', 'https://evil.example'],
    ['a lookalike of the domain', 'https://vva227.org.evil.example'],
    ['a subdomain the site does not use', 'https://staging.vva227.org'],
    ['plain http on another port', 'http://vva227-refresh-12g.pages.dev:8080'],
  ])('refuses a valid view sent to %s, and writes nothing', async (_label, origin) => {
    // Its own origin, so the origin check alone would let it through.
    await expectRefused(await at(origin), 403, 'wrong host');
    expect(d1.rows()).toHaveLength(0);
    expect(d1.statements).toEqual([]);
  });

  it('refuses the host BEFORE reading the body', async () => {
    const pagesDev = 'https://vva227-refresh-12g.pages.dev';
    await expectRefused(await at(pagesDev, '{ not json'), 403, 'wrong host');
    await expectRefused(
      await post('x', { origin: pagesDev, url: `${pagesDev}${BEACON_ENDPOINT}`, headers: { 'Content-Length': String(MAX_BODY_BYTES * 100) } }),
      403,
      'wrong host',
    );
  });

  it.each(COLLECT_HOSTS)('accepts a view on %s, so the list above cannot pass by refusing everything', async (host) => {
    await expectAccepted(await at(`https://${host}`));
    expect(d1.rows()).toHaveLength(1);
  });

  it('reads the domain however it is spelled: capitals and the trailing dot of a full name', async () => {
    for (const [i, origin] of ['https://VVA227.ORG', 'https://vva227.org.'].entries()) {
      await expectAccepted(await at(origin, view({ v: `${'d'.repeat(15)}${i}` })));
    }
    expect(d1.rows()).toHaveLength(2);
  });
});

describe('origin', () => {
  it.each([
    ['another site', 'https://evil.example'],
    ['a lookalike host', 'https://vva227.org.evil.example'],
    ['a subdomain', 'https://staging.vva227.org'],
    ['plain http', 'http://vva227.org'],
    ['the pages.dev host posting to the real domain', 'https://vva227-refresh-12g.pages.dev'],
    ['an opaque origin', 'null'],
  ])('refuses a POST from %s and writes nothing', async (_label, origin) => {
    await expectRefused(await post(view(), { origin }), 403, 'cross-origin');
    expect(d1.rows()).toHaveLength(0);
  });

  it('checks the origin BEFORE reading the body', async () => {
    // A cross-origin caller sending garbage learns only "no" — never "invalid
    // JSON" or "invalid view id", which would map the request contract for free.
    await expectRefused(await post('{ not json', { origin: 'https://evil.example' }), 403, 'cross-origin');
    await expectRefused(
      await post('x', { origin: 'https://evil.example', headers: { 'Content-Length': String(MAX_BODY_BYTES * 100) } }),
      403,
      'cross-origin',
    );
  });

  it('never advertises itself as a cross-origin service', async () => {
    const res = await post(view(), { origin: ORIGIN });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('null');
    const refused = await post(view(), { origin: 'https://evil.example' });
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('body size', () => {
  it('refuses an oversized body on its declared length', async () => {
    await expectRefused(
      await post(view(), { headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } }),
      413,
      'body too large',
    );
    expect(d1.rows()).toHaveLength(0);
  });

  it('refuses an oversized body whose declared length lied', async () => {
    const huge = { ...view(), pad: 'a'.repeat(MAX_BODY_BYTES * 4) };
    await expectRefused(await post(huge, { headers: { 'Content-Length': '10' } }), 413, 'body too large');
    expect(d1.rows()).toHaveLength(0);
  });

  it('refuses a body one byte over the cap and accepts one exactly at it', async () => {
    const at = (n: number) => {
      const base = JSON.stringify(view({ pad: '' }));
      return JSON.stringify(view({ pad: 'a'.repeat(n - base.length) }));
    };
    expect(new TextEncoder().encode(at(MAX_BODY_BYTES)).length).toBe(MAX_BODY_BYTES);
    await expectAccepted(await post(at(MAX_BODY_BYTES)));
    await expectRefused(await post(at(MAX_BODY_BYTES + 1), { headers: { 'Content-Length': '0' } }), 413, 'body too large');
  });

  it('counts bytes, not characters, so multi-byte text cannot triple the limit', async () => {
    const chars = Math.ceil(MAX_BODY_BYTES / 3) + 10; // under the cap in characters, over it in bytes
    const body = JSON.stringify(view({ pad: '日'.repeat(chars) }));
    expect(body.length).toBeLessThan(MAX_BODY_BYTES);
    await expectRefused(await post(body, { headers: { 'Content-Length': '0' } }), 413, 'body too large');
  });

  it('accepts the largest payload the tracker can legitimately send', async () => {
    const largest = {
      k: EVENT_VIEW,
      v: 'a'.repeat(64),
      p: '/' + 'a'.repeat(MAX_PATH_CHARS - 1),
      r: 'https://x.example/' + 'b'.repeat(MAX_REFERRER_CHARS - 18),
      w: 20_000,
      h: 20_000,
    };
    expect(JSON.stringify(largest).length).toBeLessThan(MAX_BODY_BYTES);
    await expectAccepted(await post(largest));
  });
});

describe('malformed input', () => {
  it.each([
    ['not JSON', 'hello'],
    ['truncated JSON', '{"k":"view",'],
    ['an empty body', ''],
    ['JSON with a trailing comma', '{"k":"view","v":"aaaaaaaabbbbbbbb","p":"/",}'],
  ])('refuses %s as invalid JSON and writes nothing', async (_label, raw) => {
    await expectRefused(await post(raw), 400, 'invalid JSON');
    expect(d1.rows()).toHaveLength(0);
  });

  it.each([
    ['a JSON array', '[1,2,3]'],
    ['JSON null', 'null'],
    ['a JSON string', '"view"'],
  ])('refuses %s as the wrong shape', async (_label, raw) => {
    await expectRefused(await post(raw), 400, 'body must be a JSON object');
  });

  it('refuses bytes that are not UTF-8', async () => {
    const request = new Request(`${ORIGIN}/api/e`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    });
    await expectRefused(await onRequest({ request, env: createEnv(d1.binding) }), 400, 'invalid JSON');
  });

  it('survives deeply nested JSON without crashing', async () => {
    await expectRefused(await post('['.repeat(500) + ']'.repeat(500)), 400, 'body must be a JSON object');
  });
});

describe('paths that are not paths on this site', () => {
  it.each([
    ['protocol-relative', '//evil.example/x'],
    ['backslash-relative', '/\\evil.example/x'],
    ['absolute', 'https://evil.example/x'],
    ['javascript:', 'javascript:alert(1)'],
    ['a control-character prefix hiding a protocol-relative URL', '\u0000//evil.example'],
  ])('refuses a %s path and writes nothing', async (_label, p) => {
    // A protocol-relative URL starts with a slash, so a naive check passes it,
    // and anything that later renders these paths as links becomes an open
    // redirect.
    await expectRefused(await post(view({ p })), 400, 'invalid path');
    expect(d1.rows()).toHaveLength(0);
  });
});

describe('injection', () => {
  it.each([
    ['the path', { p: "/x'; DROP TABLE views; --" }, 'path', "/x'; DROP TABLE views; --"],
    ['the referrer', { r: "https://x.example/'); DELETE FROM views; --" }, 'referrer', "https://x.example/'); DELETE FROM views; --"],
  ])('stores a SQL payload in %s as inert text, and the table survives', async (_label, over, column, stored) => {
    await post(view({ v: 'cccccccccccccccc' })); // a bystander row the payload would try to destroy
    await expectAccepted(await post(view(over)));
    expect(d1.one(VIEW)?.[column]).toBe(stored);
    expect(d1.rows()).toHaveLength(2);
  });

  it.each([
    ['path', 'p', '/a\r\nFAKE: injected\u0000\u001b[31m'],
    ['referrer', 'r', 'https://x.example/\r\nFAKE: injected\u001b[31m'],
  ])('strips control characters from the %s so it cannot forge a log line', async (_label, field, value) => {
    await expectAccepted(await post(view({ [field]: value })));
    const stored = JSON.stringify(d1.rows());
    expect(stored).not.toMatch(/\\[rn]|\\u00(0|1)/);
    expect(stored).toContain('FAKE: injected');
  });

  it('does not let a crafted user agent collide two visitors into one', async () => {
    await post(view(), { headers: { 'CF-Connecting-IP': '203.0.113.7|x', 'User-Agent': 'y' } });
    await post(view({ v: 'ccccccccdddddddd' }), { headers: { 'CF-Connecting-IP': '203.0.113.7', 'User-Agent': 'x|y' } });
    expect(new Set(d1.rows().map((r) => r.visitor)).size).toBe(2);
  });

  it('cannot file a row under another site', async () => {
    await post(view({ site: 'someone-else', s: 'someone-else' }));
    expect(d1.one(VIEW)?.site).toBe(SITE_KEY);
  });

  it('cannot write an arbitrarily large reading time', async () => {
    await post({ k: EVENT_END, v: VIEW, p: '/x', e: Number.MAX_SAFE_INTEGER });
    expect(d1.one(VIEW)?.engaged_ms).toBe(MAX_ENGAGED_MS);
  });
});

describe('the IP address is never kept', () => {
  it('appears in no stored column, and neither does the user agent or the salt', async () => {
    // The load-bearing privacy claim, asserted against the stored bytes rather
    // than against the code meant to avoid storing them. Every column of every
    // row, so a column added later cannot quietly reintroduce it.
    await post(view({ r: 'https://www.google.com/' }));
    await post({ k: EVENT_END, v: VIEW, p: '/give', e: 9_000 });
    const rows = d1.rows();
    for (const row of rows) expectViewRow(row);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(TEST_IP);
    expect(stored).not.toContain(TEST_UA);
    expect(stored).not.toContain('Mozilla');
    expect(stored).not.toContain(TEST_SALT);
  });

  it('is not bound into any statement the handler runs', async () => {
    await post(view());
    expect(d1.statements.length).toBeGreaterThan(0);
    expect(JSON.stringify(d1.statements)).not.toContain(TEST_IP);
  });

  it('appears in no log line, even when the write fails', async () => {
    const lines: unknown[][] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args);
      });
    }
    const exploding = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error('D1_ERROR: boom'); } }) }) };
    await onRequest({ request: beaconRequest(view()), env: createEnv(exploding as never) });
    await post(view({ v: 'cccccccccccccccc' }));

    expect(lines.length).toBeGreaterThan(0); // the failure was logged — so the check below can fail
    expect(JSON.stringify(lines)).not.toContain(TEST_IP);
    expect(JSON.stringify(lines)).not.toContain(TEST_SALT);
  });

  it('has no column to be stored in', () => {
    const columns = d1.db.prepare('PRAGMA table_info(views)').all().map((c) => String((c as { name: string }).name));
    expect(columns.filter((c) => /ip|addr|user_agent|\bua\b/i.test(c))).toEqual([]);
  });
});
