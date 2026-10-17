import { describe, it, expect } from 'vitest';
import {
  cleanText,
  geoFromCf,
  MAX_ENGAGED_MS,
  MAX_VIEWPORT_PX,
  pruneCutoff,
  readBodyCapped,
  saltWindow,
  stripQuery,
  UPSERT_SQL,
  upsertBindings,
  validateEvent,
  visitorHash,
} from '../../src/lib/beacon';
import {
  EVENT_END,
  EVENT_VIEW,
  MAX_PATH_CHARS,
  MAX_REFERRER_CHARS,
  RETENTION_DAYS,
  SITE_KEY,
} from '../../src/data/analytics';

/**
 * UNIT — what the collector is willing to store, decided before it touches D1.
 *
 * functions/api/e.ts is a thin shell over these functions, so this is where
 * the rules for a public, unauthenticated endpoint are pinned: what is refused,
 * what is clamped, what is cut.
 *
 * TIER JUSTIFICATION: the handler tiers can only send what a Request can carry.
 * NaN and Infinity cannot be written in JSON, a field-boundary collision needs
 * the hash called with crafted pairs, and a body stream that arrives in many
 * small chunks is awkward to build through a Request. Only a pure function can
 * be driven through all of those.
 */

const VIEW_ID = 'a1b2c3d4e5f60718';

/** ASCII Unit Separator, built rather than typed — no literal control bytes in source files. */
const US = String.fromCharCode(0x1f);

const viewEvent = (over: Record<string, unknown> = {}) => ({ k: EVENT_VIEW, v: VIEW_ID, p: '/about', ...over });
const endEvent = (over: Record<string, unknown> = {}) => ({ k: EVENT_END, v: VIEW_ID, p: '/about', e: 1000, ...over });

/** validateEvent's success branch, or a failure naming why it did not succeed. */
function accepted(raw: unknown) {
  const result = validateEvent(raw);
  if (!result.ok) throw new Error(`expected acceptance, got: ${result.reason}`);
  return result.event;
}

describe('validateEvent — happy path', () => {
  it('accepts a view and returns every field the collector binds', () => {
    // The whole shape, not one field: these values are bound straight into a
    // statement, so a field missing here is a silent NULL in the table.
    expect(validateEvent(viewEvent({ r: 'https://www.google.com/', w: 1440, h: 900 }))).toEqual({
      ok: true,
      event: {
        kind: EVENT_VIEW,
        view: VIEW_ID,
        path: '/about',
        referrer: 'https://www.google.com/',
        viewportW: 1440,
        viewportH: 900,
        engagedMs: 0,
      },
    });
  });

  it('accepts an end carrying reading time and nothing a view carries', () => {
    // A view's fields must stay null on an end: the upsert coalesces, and a
    // null here is what preserves the value the view stored.
    expect(accepted(endEvent({ e: 47_312, r: 'https://evil.example/', w: 300 }))).toEqual({
      kind: EVENT_END,
      view: VIEW_ID,
      path: '/about',
      referrer: null,
      viewportW: null,
      viewportH: null,
      engagedMs: 47_312,
    });
  });

  it('ignores a client-supplied site, which the server assigns', () => {
    expect(accepted(viewEvent({ site: 'someone-else', s: 'x' }))).not.toHaveProperty('site');
  });
});

describe('validateEvent — sad path', () => {
  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'hello'],
    ['a number', 42],
    ['undefined', undefined],
  ])('refuses a body that is %s', (_label, body) => {
    expect(validateEvent(body)).toEqual({ ok: false, reason: 'body must be a JSON object' });
  });

  it.each([
    ['an unknown kind', { k: 'pageview', v: VIEW_ID, p: '/' }],
    ['no kind', { v: VIEW_ID, p: '/' }],
    ['a kind of the wrong type', { k: 1, v: VIEW_ID, p: '/' }],
    ['the dropped click kind', { k: 'click', v: VIEW_ID, p: '/' }],
  ])('refuses %s', (_label, body) => {
    expect(validateEvent(body)).toEqual({ ok: false, reason: 'unknown event kind' });
  });

  it.each([
    ['too short', 'abc'],
    ['one under the minimum', 'a'.repeat(7)],
    ['not hex', 'zzzzzzzzzzzzzzzz'],
    ['uppercase hex', 'A1B2C3D4E5F60718'],
    ['one over the maximum', 'a'.repeat(65)],
    ['a number', 12345678],
    ['absent', undefined],
    ['hex with a trailing newline', `${VIEW_ID}\n`],
  ])('refuses a view id that is %s', (_label, v) => {
    expect(validateEvent({ k: EVENT_VIEW, v, p: '/' })).toEqual({ ok: false, reason: 'invalid view id' });
  });

  it.each([
    ['an absolute URL', 'https://evil.example/x'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['a backslash-relative URL', '/\\evil.example/x'],
    ['a bare word', 'about'],
    ['empty', ''],
    ['only a query string', '?token=x'],
    ['not a string', 7],
    ['only control characters', `${US}\n${US}`],
  ])('refuses a path that is %s', (_label, p) => {
    // The protocol-relative case is the one worth stating: it DOES start with a
    // slash, so the naive check passes it, and a browser resolves it to another
    // origin.
    expect(validateEvent({ k: EVENT_VIEW, v: VIEW_ID, p })).toEqual({ ok: false, reason: 'invalid path' });
  });
});

describe('validateEvent — edge cases', () => {
  it('keeps a path at exactly the limit and cuts one over it', () => {
    const atLimit = '/' + 'a'.repeat(MAX_PATH_CHARS - 1);
    expect(accepted(viewEvent({ p: atLimit })).path).toBe(atLimit);

    const over = '/' + 'a'.repeat(MAX_PATH_CHARS);
    const cut = accepted(viewEvent({ p: over })).path;
    expect(cut).toHaveLength(MAX_PATH_CHARS);
    expect(over.startsWith(cut)).toBe(true);
  });

  it('cuts an over-long referrer rather than rejecting the visit', () => {
    const long = 'https://x.example/' + 'a'.repeat(MAX_REFERRER_CHARS);
    expect(accepted(viewEvent({ r: long })).referrer).toHaveLength(MAX_REFERRER_CHARS);
  });

  it.each([
    ['a query string', 'https://x.example/page?token=SECRET&utm=abc', 'https://x.example/page'],
    ['a fragment', 'https://x.example/page#section', 'https://x.example/page'],
    ['both', 'https://x.example/p?a=1#b', 'https://x.example/p'],
    ['a bare query', 'https://x.example/?email=a@b.example', 'https://x.example/'],
  ])('strips %s from the referrer before it is stored', (_label, input, expected) => {
    // A Referer is written under the SENDING site's policy, so it can carry
    // their session tokens and an email address. None of that is ours to keep.
    expect(accepted(viewEvent({ r: input })).referrer).toBe(expected);
  });

  it('keeps a referrer with no query or fragment intact', () => {
    expect(accepted(viewEvent({ r: 'https://www.facebook.com/VVA227/' })).referrer).toBe(
      'https://www.facebook.com/VVA227/',
    );
  });

  it('stores a referrer that is only a query string as no referrer at all', () => {
    expect(accepted(viewEvent({ r: '?token=SECRET' })).referrer).toBeNull();
  });

  it('cuts a query string a hand-built post put in the path', () => {
    expect(accepted(viewEvent({ p: '/give?email=a@b.example#x' })).path).toBe('/give');
  });

  it('removes control characters from stored strings', () => {
    // 0x1F is the hash separator, and a newline would let a stored value forge
    // extra lines in anything printed from this table.
    expect(accepted(viewEvent({ p: '/abo\r\nut' + US })).path).toBe('/about');
  });

  it('keeps non-ASCII text, which is not a control character', () => {
    expect(accepted(viewEvent({ p: '/café/日本' })).path).toBe('/café/日本');
  });

  it.each([
    ['NaN', NaN, 0],
    ['Infinity', Infinity, 0],
    ['-Infinity', -Infinity, 0],
    ['negative', -5000, 0],
    ['a numeric string', '5000', 0],
    ['absent', undefined, 0],
    ['a boolean', true, 0],
    ['one above the ceiling', MAX_ENGAGED_MS + 1, MAX_ENGAGED_MS],
    ['exactly the ceiling', MAX_ENGAGED_MS, MAX_ENGAGED_MS],
    ['one below the ceiling', MAX_ENGAGED_MS - 1, MAX_ENGAGED_MS - 1],
    ['fractional', 1500.6, 1501],
    ['zero', 0, 0],
  ])('clamps reading time that is %s', (_label, e, expected) => {
    // Non-finite is "no information" and becomes 0. Clamping it to the ceiling
    // would let a caller write the maximum by sending nonsense.
    expect(accepted(endEvent({ e })).engagedMs).toBe(expected);
  });

  it.each([
    ['zero', 0, 0],
    ['negative', -100, 0],
    ['absurd', 999_999, MAX_VIEWPORT_PX],
    ['not a number', 'wide', null],
    ['NaN', NaN, null],
  ])('clamps a viewport width that is %s', (_label, w, expected) => {
    expect(accepted(viewEvent({ w })).viewportW).toBe(expected);
  });
});

describe('stripQuery and cleanText', () => {
  it.each([
    ['https://a.example/x?y', 'https://a.example/x'],
    ['https://a.example/x#y?z', 'https://a.example/x'],
    ['/plain', '/plain'],
    ['', ''],
    ['?', ''],
  ])('stripQuery(%j) is %j', (input, expected) => {
    expect(stripQuery(input)).toBe(expected);
  });

  it.each([
    ['a normal string', '  Fairfax  ', 64, 'Fairfax'],
    ['a string over the cap', 'abcdef', 3, 'abc'],
    ['only whitespace', '   ', 64, null],
    ['only control characters', `\u0000${US}\u007f`, 64, null],
    ['a number', 7922, 64, null],
    ['null', null, 64, null],
    ['an object', { toString: () => 'x' }, 64, null],
  ])('cleanText of %s', (_label, value, max, expected) => {
    expect(cleanText(value, max)).toBe(expected);
  });
});

describe('geoFromCf', () => {
  it('takes location and network from what Cloudflare resolved', () => {
    expect(
      geoFromCf({
        country: 'US',
        city: 'Fairfax',
        regionCode: 'VA',
        region: 'Virginia',
        asn: 7922,
        asOrganization: 'Comcast Cable Communications, LLC',
      }),
    ).toEqual({ country: 'US', city: 'Fairfax', region: 'VA', asn: 7922, asOrg: 'Comcast Cable Communications, LLC' });
  });

  it('falls back to the long region name when the code is missing', () => {
    expect(geoFromCf({ country: 'IE', region: 'Leinster' }).region).toBe('Leinster');
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', {}],
  ])('returns all nulls when request.cf is %s', (_label, cf) => {
    expect(geoFromCf(cf)).toEqual({ country: null, city: null, region: null, asn: null, asOrg: null });
  });

  it.each([
    ['a numeric string', '13335', 13335],
    ['zero', 0, null],
    ['negative', -1, null],
    ['fractional', 1.5, null],
    ['beyond 32 bits', 4_294_967_296, null],
    ['the 32-bit maximum', 4_294_967_295, 4_294_967_295],
    ['a word', 'lots', null],
    ['an array', [], null],
    ['NaN', NaN, null],
  ])('accepts only a real ASN: %s', (_label, asn, expected) => {
    expect(geoFromCf({ asn }).asn).toBe(expected);
  });

  it('cleans and caps the text fields like any client-supplied string', () => {
    const geo = geoFromCf({ city: 'Fair\nfax' + 'x'.repeat(200), asOrganization: 'A'.repeat(300), country: 12 });
    expect(geo.city).toHaveLength(64);
    expect(geo.city).not.toContain('\n');
    expect(geo.asOrg).toHaveLength(96);
    expect(geo.country).toBeNull();
  });
});

describe('upsertBindings', () => {
  it('lines every value up with its column in UPSERT_SQL', () => {
    // Read the column list out of the real statement rather than restating it,
    // so reordering one without the other fails here.
    const columns = UPSERT_SQL.match(/\(([^)]*)\)\s*VALUES/)![1].split(',').map((c) => c.trim());
    const values = upsertBindings({
      event: accepted(viewEvent({ r: 'https://www.google.com/', w: 390, h: 844 })),
      site: SITE_KEY,
      visitor: 'f'.repeat(32),
      geo: geoFromCf({ country: 'US', city: 'Fairfax', regionCode: 'VA', asn: 7922, asOrganization: 'Comcast' }),
      now: 1_000,
    });
    expect(Object.fromEntries(columns.map((c, i) => [c, values[i]]))).toEqual({
      view: VIEW_ID,
      site: SITE_KEY,
      visitor: 'f'.repeat(32),
      path: '/about',
      referrer: 'https://www.google.com/',
      country: 'US',
      city: 'Fairfax',
      region: 'VA',
      asn: 7922,
      as_org: 'Comcast',
      viewport_w: 390,
      viewport_h: 844,
      engaged_ms: 0,
      ts: 1_000,
    });
    expect(UPSERT_SQL.match(/\?\d+/g)).toHaveLength(values.length);
  });

  it('never leaves ts in the update list, which is what stops a late end restamping a visit', () => {
    const updateList = UPSERT_SQL.split('DO UPDATE SET')[1];
    expect(updateList).toBeDefined();
    expect(updateList).not.toMatch(/\bts\s*=/);
    expect(updateList).toMatch(/engaged_ms\s*=\s*max\(/);
  });
});

describe('saltWindow and pruneCutoff', () => {
  const DAY = 86_400_000;

  it('is stable within a day and moves by exactly one at UTC midnight', () => {
    const midnight = Date.UTC(2026, 9, 17);
    expect(saltWindow(midnight)).toBe(saltWindow(midnight + DAY - 1));
    expect(saltWindow(midnight + DAY)).toBe(saltWindow(midnight) + 1);
    expect(saltWindow(midnight - 1)).toBe(saltWindow(midnight) - 1);
  });

  it('honours a longer period, anchored to the epoch rather than to any chosen date', () => {
    const period = 30;
    const span = period * DAY;
    const w = saltWindow(Date.UTC(2026, 9, 17), period);
    expect(saltWindow(w * span, period)).toBe(w);
    expect(saltWindow(w * span + span - 1, period)).toBe(w);
    expect(saltWindow(w * span + span, period)).toBe(w + 1);
  });

  it('puts the retention cutoff exactly RETENTION_DAYS back', () => {
    const now = Date.UTC(2026, 9, 17, 12);
    expect(pruneCutoff(now)).toBe(now - RETENTION_DAYS * DAY);
    expect(pruneCutoff(now, 1)).toBe(now - DAY);
    expect(pruneCutoff(now, 0)).toBe(now);
  });
});

describe('visitorHash', () => {
  const base = { secret: 's3cret', window: 20_743, site: SITE_KEY, ip: '203.0.113.7', ua: 'Mozilla/5.0' };

  it('is deterministic, 32 lowercase hex characters', async () => {
    const a = await visitorHash(base);
    expect(await visitorHash({ ...base })).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it.each([
    ['the day rolls over', { window: base.window + 1 }],
    ['the site differs', { site: 'another-site' }],
    ['the IP differs', { ip: '203.0.113.8' }],
    ['the user agent differs', { ua: 'Mozilla/5.0 (other)' }],
    ['the secret differs', { secret: 'other' }],
  ])('gives a different identifier when %s', async (_label, over) => {
    expect(await visitorHash({ ...base, ...over })).not.toBe(await visitorHash(base));
  });

  it('refuses to run without a secret, by name', async () => {
    // The specific message, not a bare toThrow: a TypeError from a refactor
    // would satisfy that, and the point is that this failure is identifiable.
    await expect(visitorHash({ ...base, secret: '' })).rejects.toThrow(/secret is required/);
    await expect(visitorHash({ ...base, secret: undefined })).rejects.toThrow(/secret is required/);
    await expect(visitorHash({ ...base, secret: null })).rejects.toThrow(/secret is required/);
  });

  it('cannot be collided by shifting a field boundary', async () => {
    // With a printable separator such as '|', a user agent containing it could
    // move the IP/UA boundary and hash identically to a different visitor.
    // This pair is exactly that construction.
    const a = await visitorHash({ ...base, ip: '203.0.113.7|x', ua: 'y' });
    const b = await visitorHash({ ...base, ip: '203.0.113.7', ua: 'x|y' });
    expect(a).not.toBe(b);
  });

  it('contains neither input in its output', async () => {
    const hash = await visitorHash(base);
    expect(hash).not.toContain('203');
    expect(hash).not.toContain('Mozilla');
  });

  it('treats a missing IP or user agent as empty rather than throwing', async () => {
    await expect(visitorHash({ ...base, ip: null, ua: undefined })).resolves.toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('readBodyCapped', () => {
  const streamOf = (...chunks: string[]) => {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
  };

  it('returns the body when it fits, however it is chunked', async () => {
    await expect(readBodyCapped(streamOf('{"k":', '"view"', '}'), 100)).resolves.toBe('{"k":"view"}');
  });

  it('accepts exactly the cap and refuses one byte more', async () => {
    await expect(readBodyCapped(streamOf('a'.repeat(10)), 10)).resolves.toBe('a'.repeat(10));
    await expect(readBodyCapped(streamOf('a'.repeat(5), 'a'.repeat(6)), 10)).resolves.toBeNull();
  });

  it('counts bytes, not characters', async () => {
    // "é" is two bytes in UTF-8. A character count would let a multi-byte body
    // through at up to three times the stated limit.
    await expect(readBodyCapped(streamOf('é'.repeat(6)), 10)).resolves.toBeNull();
    await expect(readBodyCapped(streamOf('é'.repeat(5)), 10)).resolves.toBe('é'.repeat(5));
  });

  it('stops reading as soon as the cap is passed', async () => {
    // An endless stream is the attack the real-length check exists for.
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(64));
      },
    });
    await expect(readBodyCapped(endless, 1_000)).resolves.toBeNull();
    expect(pulls).toBeLessThan(40);
  });

  it('treats an absent body as empty', async () => {
    await expect(readBodyCapped(null, 10)).resolves.toBe('');
  });

  it('throws on bytes that are not UTF-8, which the handler answers as invalid JSON', async () => {
    const bad = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
        controller.close();
      },
    });
    await expect(readBodyCapped(bad, 100)).rejects.toThrow();
  });
});
