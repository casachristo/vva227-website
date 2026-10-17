import { describe, it, expect, afterEach } from 'vitest';
import { beaconConfig, beaconScript, GET } from '../../src/pages/b.js.ts';
import { BEACON_ENDPOINT, EVENT_END, EVENT_VIEW, HEARTBEAT_MS, MAX_PATH_CHARS, MAX_REFERRER_CHARS } from '../../src/data/analytics';
import { emittedConfig, errorName, runTracker, type TrackerRunOptions } from '../helpers/tracker-harness';

/**
 * UNIT — the tracker, run as the text /b.js serves.
 *
 * Every test here executes beaconScript(), the same `'use strict'; (function
 * tracker(cfg){…})(cfg);` string src/pages/b.js.ts hands to the build, in a V8
 * context that holds nothing but browser stubs (tests/helpers/tracker-harness
 * .ts). Calling tracker() directly would run it inside this module, with this
 * module's imports in scope, which is exactly the situation in which the
 * tracker's one rule (reference nothing outside its own body) cannot be seen
 * to break.
 *
 * TIER JUSTIFICATION: the tracker swallows every error so that broken
 * analytics can never break a page, which makes a dead tracker look exactly
 * like a working one from outside. This tier drives every branch with a
 * controlled clock and controlled visibility, including the ones no real
 * browser run can reach on demand: a missing crypto, a sendBeacon that says
 * no, a fetch that throws synchronously.
 */

const source = beaconScript();
const T0 = 1_000_000;

const run = (options: TrackerRunOptions = {}) => runTracker(source, { now: T0, ...options });

/** The full shape of a `view` body: these keys, these types, nothing else. */
function expectViewBody(body: Record<string, unknown>) {
  expect(Object.keys(body).sort()).toEqual(['h', 'k', 'p', 'r', 'v', 'w']);
  expect(body.k).toBe(EVENT_VIEW);
  expect(body.v).toMatch(/^[0-9a-f]{16}$/);
  expect(typeof body.p).toBe('string');
  expect(body.r === null || typeof body.r === 'string').toBe(true);
  expect(body.w === null || Number.isInteger(body.w)).toBe(true);
  expect(body.h === null || Number.isInteger(body.h)).toBe(true);
}

/** The full shape of an `end` body. */
function expectEndBody(body: Record<string, unknown>) {
  expect(Object.keys(body).sort()).toEqual(['e', 'k', 'p', 'v']);
  expect(body.k).toBe(EVENT_END);
  expect(body.v).toMatch(/^[0-9a-f]{16}$/);
  expect(typeof body.p).toBe('string');
  expect(Number.isInteger(body.e) && (body.e as number) >= 0).toBe(true);
}

describe('the emitted script', () => {
  it('runs with nothing in scope but browser globals, and sends its view', () => {
    const t = run();
    expect(t.sent).toHaveLength(1);
    expectViewBody(t.sent[0].body);
  });

  it('is what GET serves at /b.js, as JavaScript', async () => {
    const res = GET();
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    await expect(res.text()).resolves.toBe(source);
  });

  it('carries the registry values as its config', () => {
    expect(emittedConfig(source)).toEqual({
      endpoint: BEACON_ENDPOINT,
      heartbeatMs: HEARTBEAT_MS,
      maxPathChars: MAX_PATH_CHARS,
      maxReferrerChars: MAX_REFERRER_CHARS,
    });
    expect(beaconConfig()).toEqual(emittedConfig(source));
  });

  it('can fail: a reference to a module constant outside the body is caught', () => {
    // The mistake the harness exists for. Replacing cfg.heartbeatMs with the
    // registry's own name is the natural "simplification", and it ships as a
    // bare identifier that is undefined in the browser.
    const stray = source.replace('cfg.heartbeatMs', 'HEARTBEAT_MS');
    expect(stray).not.toBe(source);
    expect(errorName(() => runTracker(stray))).toBe('ReferenceError');
  });

  it('can fail: a stray reference inside a guarded call sends nothing, which the view test sees', () => {
    // Inside send()'s try, the ReferenceError is swallowed and nothing
    // throws. What catches it is the assertion that a view was sent.
    const stray = source.replace('fetch(cfg.endpoint', 'fetch(BEACON_ENDPOINT');
    expect(stray).not.toBe(source);
    expect(() => runTracker(stray)).not.toThrow();
    expect(runTracker(stray).sent).toEqual([]);
  });

  it("can fail: Node's own globals are not in scope", () => {
    // Node has fetch, crypto, navigator and setInterval of its own. In this
    // context none of them, nor process, exists unless stubbed.
    expect(errorName(() => runTracker('process.exit(1)'))).toBe('ReferenceError');
    expect(errorName(() => runTracker('setTimeout(function(){}, 1)'))).toBe('ReferenceError');
  });

  it('runs in strict mode, as the module it was written in did', () => {
    // Without the directive, a missing `var` would quietly create a global
    // on every page of the site.
    expect(source.startsWith("'use strict';\n(function tracker(cfg")).toBe(true);
    const sloppy = source.replace('var engagedMs = 0;', 'engagedMs = 0;');
    expect(sloppy).not.toBe(source);
    expect(errorName(() => runTracker(sloppy))).toBe('ReferenceError');
  });

  it('registers exactly the listeners and the one timer it needs, and no unload', () => {
    // An unload listener makes the page ineligible for the back/forward cache
    // in Safari and Firefox, so every Back press would reload the page.
    const t = run();
    expect(t.listeners.map((l) => `${l.target}:${l.type}`).sort()).toEqual([
      'document:visibilitychange',
      'window:pagehide',
      'window:pageshow',
    ]);
    expect(t.intervals.map((i) => i.ms)).toEqual([HEARTBEAT_MS]);
  });
});

describe('the opt-out', () => {
  it.each([
    ['Global Privacy Control', { navigator: { globalPrivacyControl: true } }],
    ["Do-Not-Track '1'", { navigator: { doNotTrack: '1' } }],
    ["Do-Not-Track 'yes' (old Firefox)", { navigator: { doNotTrack: 'yes' } }],
    ["window.doNotTrack '1' (old Safari and Edge)", { window: { doNotTrack: '1' } }],
  ] as Array<[string, TrackerRunOptions]>)('does nothing at all when %s is set', (_label, options) => {
    // Nothing sent AND nothing registered: an opt-out that still attached a
    // listener or drew a random id would still be processing.
    const t = run(options);
    expect(t.sent).toEqual([]);
    expect(t.listeners).toEqual([]);
    expect(t.intervals).toEqual([]);
    expect(t.randomCalls).toBe(0);
  });

  it.each([
    ['globalPrivacyControl is false', { navigator: { globalPrivacyControl: false } }],
    ["globalPrivacyControl is the string 'true'", { navigator: { globalPrivacyControl: 'true' } }],
    ["doNotTrack is '0'", { navigator: { doNotTrack: '0' } }],
    ['doNotTrack is null (unspecified)', { navigator: { doNotTrack: null } }],
    ['no signal is present', {}],
  ] as Array<[string, TrackerRunOptions]>)('still collects when %s', (_label, options) => {
    // The case that matters most: an over-eager check would switch analytics
    // off for everyone, which looks exactly like a site nobody visits.
    expect(run(options).sent).toHaveLength(1);
  });

  it('collects nothing, and does not throw, if reading the signal throws', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'globalPrivacyControl', {
      get() {
        throw new Error('no');
      },
    });
    let t: ReturnType<typeof run> | undefined;
    expect(() => {
      t = runTracker(source, { navigator: hostile as Record<string, unknown> });
    }).not.toThrow();
    expect(t!.sent).toEqual([]);
    expect(t!.listeners).toEqual([]);
  });
});

describe('a page the browser prerenders', () => {
  // Chrome loads a page it expects you to open (one you type often, or a
  // bookmark you hover) and runs its scripts unseen. Often it is never shown.
  const prerendered = (options: TrackerRunOptions = {}) => run({ prerendering: true, visibility: 'hidden', ...options });

  it('sends nothing and starts nothing until the page is shown', () => {
    const t = prerendered();
    expect(t.sent).toEqual([]);
    expect(t.intervals).toEqual([]);
    expect(t.listeners.map((l) => `${l.target}:${l.type}`)).toEqual(['document:prerenderingchange']);
  });

  it('sends exactly one view once shown, and counts reading time from then', () => {
    const t = prerendered({ pathname: '/get-help', referrer: 'https://www.google.com/' });
    t.at(T0 + 30_000); // thirty seconds unseen, which must not count
    t.setPrerendering(false);
    t.setVisibility('visible');
    t.fire('document', 'prerenderingchange');
    expect(t.sent).toHaveLength(1);
    expectViewBody(t.sent[0].body);
    expect(t.sent[0].body).toMatchObject({ p: '/get-help', r: 'https://www.google.com/' });

    t.at(T0 + 34_000);
    t.fire('window', 'pagehide');
    expect(t.bodies().map((b) => [b.k, b.e])).toEqual([
      [EVENT_VIEW, undefined],
      [EVENT_END, 4_000],
    ]);
  });

  it('registers the same listeners and timer as an ordinary page once shown', () => {
    const t = prerendered();
    t.setPrerendering(false);
    t.fire('document', 'prerenderingchange');
    expect(t.listeners.map((l) => `${l.target}:${l.type}`).sort()).toEqual([
      'document:prerenderingchange',
      'document:visibilitychange',
      'window:pagehide',
      'window:pageshow',
    ]);
    expect(t.intervals.map((i) => i.ms)).toEqual([HEARTBEAT_MS]);
  });

  it('honours the opt-out first: not even the prerender listener', () => {
    const t = prerendered({ navigator: { globalPrivacyControl: true } });
    expect(t.listeners).toEqual([]);
    expect(t.sent).toEqual([]);
  });
});

describe('the view event', () => {
  it('goes to the registered endpoint with the path, stripped referrer and viewport', () => {
    const t = run({ pathname: '/give/impact', referrer: 'https://www.facebook.com/' });
    expect(t.sent).toHaveLength(1);
    const [req] = t.sent;
    expect(req.url).toBe(BEACON_ENDPOINT);
    expect(req.transport).toBe('fetch');
    expectViewBody(req.body);
    expect(req.body).toEqual({
      k: EVENT_VIEW,
      v: req.body.v,
      p: '/give/impact',
      r: 'https://www.facebook.com/',
      w: 1280,
      h: 800,
    });
  });

  it('is a same-origin, cookieless, keepalive JSON POST', () => {
    const { init } = run().sent[0];
    expect(init).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      credentials: 'omit',
      mode: 'same-origin',
    });
  });

  it('never sends a query string or fragment, from the referrer or the page', () => {
    const t = run({
      pathname: '/join',
      search: '?token=secret&email=a%40b.example',
      hash: '#frag-secret',
      referrer: 'https://news.example/story?token=secret&utm_source=x#frag-secret',
    });
    expect(t.sent[0].body.p).toBe('/join');
    expect(t.sent[0].body.r).toBe('https://news.example/story');
    t.fire('window', 'pagehide');
    for (const { raw } of t.sent) {
      expect(raw).not.toMatch(/secret|token|utm_|email|#/);
    }
  });

  it.each([
    ['empty', '', null],
    ['nothing but a query', '?token=secret', null],
    ['nothing but a fragment', '#x', null],
    ['a fragment before a query', 'https://a.example/p#x?y', 'https://a.example/p'],
  ])('reports a referrer that is %s as %s', (_label, referrer, expected) => {
    expect(run({ referrer }).sent[0].body.r).toBe(expected);
  });

  it.each([
    [MAX_PATH_CHARS - 1, MAX_PATH_CHARS - 1],
    [MAX_PATH_CHARS, MAX_PATH_CHARS],
    [MAX_PATH_CHARS + 1, MAX_PATH_CHARS],
    [MAX_PATH_CHARS * 4, MAX_PATH_CHARS],
  ])('cuts a %i-character path to %i', (length, expected) => {
    const pathname = '/' + 'a'.repeat(length - 1);
    expect((run({ pathname }).sent[0].body.p as string).length).toBe(expected);
  });

  it.each([
    [MAX_REFERRER_CHARS - 1, MAX_REFERRER_CHARS - 1],
    [MAX_REFERRER_CHARS, MAX_REFERRER_CHARS],
    [MAX_REFERRER_CHARS + 1, MAX_REFERRER_CHARS],
  ])('cuts a %i-character referrer to %i, after removing its query', (length, expected) => {
    const base = 'https://x.example/' + 'r'.repeat(length - 'https://x.example/'.length);
    expect(base).toHaveLength(length);
    const r = run({ referrer: `${base}?q=${'z'.repeat(2000)}` }).sent[0].body.r as string;
    expect(r).toHaveLength(expected);
    expect(r).not.toContain('?');
  });

  it.each([
    ['//evil.example/x', '/evil.example/x'],
    ['///', '/'],
    ['/a//b', '/a//b'],
  ])('sends the path %s as %s, which the collector accepts', (pathname, expected) => {
    // The collector refuses a path beginning '//' as a protocol-relative URL.
    // Only the leading run is collapsed; slashes later in the path are the
    // path.
    const t = run({ pathname });
    t.fire('window', 'pagehide');
    expect(t.bodies().map((b) => b.p)).toEqual([expected, expected]);
  });

  it('keeps a non-ASCII path intact', () => {
    expect(run({ pathname: '/über/✓' }).sent[0].body.p).toBe('/über/✓');
  });

  it.each([
    ['zero', 0, null],
    ['missing', undefined, null],
    ['NaN', Number.NaN, null],
  ])('reports a %s viewport as null', (_label, size, expected) => {
    const body = run({ innerWidth: size as number, innerHeight: size as number }).sent[0].body;
    expect(body.w).toBe(expected);
    expect(body.h).toBe(expected);
  });

  it.each([
    ['missing', null],
    [
      'throwing',
      {
        getRandomValues() {
          throw new Error('insecure context');
        },
      },
    ],
  ])('still sends a valid hex view id when crypto is %s', (_label, crypto) => {
    const t = run({ crypto: crypto as TrackerRunOptions['crypto'] });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].body.v).toMatch(/^[0-9a-f]{16}$/);
  });

  it('draws its view id from crypto.getRandomValues once, and keeps it for every end', () => {
    const t = run();
    t.at(T0 + 60_000);
    t.tick();
    t.at(T0 + 61_000);
    t.fire('window', 'pagehide');
    expect(t.sent).toHaveLength(3);
    expect(t.randomCalls).toBe(1);
    // The harness fills byte i with (i * 37 + 11) & 0xff.
    const expected = Array.from({ length: 8 }, (_, i) => ((i * 37 + 11) & 0xff).toString(16).padStart(2, '0')).join('');
    expect(t.bodies().map((b) => b.v)).toEqual([expected, expected, expected]);
  });
});

describe('reading time and the end event', () => {
  it('counts only the time the page is visible', () => {
    const t = run();
    t.at(T0 + 5_000); // 5s visible
    t.setVisibility('hidden');
    t.fire('document', 'visibilitychange');
    expect(t.sent.at(-1)!.body).toMatchObject({ k: EVENT_END, e: 5_000 });

    t.at(T0 + 65_000); // a minute in another tab, which must not count
    t.setVisibility('visible');
    t.fire('document', 'visibilitychange');
    t.at(T0 + 68_000); // 3s more
    t.fire('window', 'pagehide');
    const last = t.sent.at(-1)!;
    expectEndBody(last.body);
    expect(last.body).toEqual({ k: EVENT_END, v: t.sent[0].body.v, p: '/about', e: 8_000 });
  });

  it('goes by sendBeacon as an application/json Blob on the way out', () => {
    const t = run();
    t.at(T0 + 2_000);
    t.fire('window', 'pagehide');
    const last = t.sent.at(-1)!;
    expect(last.transport).toBe('beacon');
    expect(last.url).toBe(BEACON_ENDPOINT);
    expect(last.blobType).toBe('application/json');
  });

  it('starts at zero for a page opened in a background tab', () => {
    const t = run({ visibility: 'hidden' });
    t.at(T0 + 60_000);
    t.fire('window', 'pagehide');
    expect(t.sent.at(-1)!.body).toMatchObject({ k: EVENT_END, e: 0 });
  });

  it('resumes counting when a page comes back from the back/forward cache', () => {
    const t = run();
    t.at(T0 + 1_000);
    t.setVisibility('hidden');
    t.fire('window', 'pagehide');
    t.at(T0 + 100_000);
    t.setVisibility('visible');
    t.fire('window', 'pageshow');
    t.at(T0 + 104_000);
    t.fire('window', 'pagehide');
    expect(t.sent.at(-1)!.body.e).toBe(5_000);
  });

  it('reports on the heartbeat while visible, so a frozen tab still counts', () => {
    const t = run();
    t.at(T0 + 90_000);
    t.tick();
    const last = t.sent.at(-1)!;
    expect(last.transport).toBe('fetch');
    expect(last.body).toMatchObject({ k: EVENT_END, e: 90_000 });
  });

  it('sends nothing on the heartbeat while hidden', () => {
    const t = run();
    t.at(T0 + 3_000);
    t.setVisibility('hidden');
    t.fire('document', 'visibilitychange');
    const before = t.sent.length;
    t.at(T0 + 200_000);
    t.tick();
    expect(t.sent).toHaveLength(before);
  });

  it('sends nothing on the heartbeat for a page opened in a background tab', () => {
    // Nothing has been read yet, so there is nothing to report: an end with
    // zero reading time every minute would be a row write that says nothing.
    const t = run({ visibility: 'hidden' });
    t.at(T0 + HEARTBEAT_MS);
    t.tick();
    t.at(T0 + 5 * HEARTBEAT_MS);
    t.tick();
    expect(t.bodies().map((b) => b.k)).toEqual([EVENT_VIEW]);
  });

  it('does not resend an unchanged total', () => {
    const t = run();
    t.at(T0 + 4_000);
    t.fire('window', 'pagehide');
    const after = t.sent.length;
    t.fire('window', 'pagehide');
    t.fire('document', 'visibilitychange');
    expect(t.sent).toHaveLength(after);
  });

  it('sends the path again so an end stands on its own', () => {
    const t = run({ pathname: '/get-help/vet-center' });
    t.fire('window', 'pagehide');
    expect(t.sent.at(-1)!.body.p).toBe('/get-help/vet-center');
  });
});

describe('the transport', () => {
  it.each([
    ['missing', { sendBeacon: null }],
    ['refusing (returns false)', { sendBeacon: () => false }],
    [
      'throwing',
      {
        sendBeacon: () => {
          throw new TypeError('Illegal invocation');
        },
      },
    ],
  ] as Array<[string, TrackerRunOptions]>)('falls back to a keepalive fetch when sendBeacon is %s', (_label, options) => {
    const t = run(options);
    t.at(T0 + 3_000);
    t.fire('window', 'pagehide');
    const last = t.sent.at(-1)!;
    expect(last.transport).toBe('fetch');
    expect(last.url).toBe(BEACON_ENDPOINT);
    expect(last.body).toMatchObject({ k: EVENT_END, e: 3_000 });
    expect(last.init).toMatchObject({ keepalive: true, credentials: 'omit', mode: 'same-origin' });
  });

  describe('never throws into the page', () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    afterEach(() => {
      process.off('unhandledRejection', onRejection);
    });

    it('when fetch throws synchronously or rejects, and sendBeacon throws', async () => {
      process.on('unhandledRejection', onRejection);
      for (const fetch of [
        () => {
          throw new TypeError('Failed to fetch');
        },
        () => Promise.reject(new TypeError('network down')),
      ]) {
        const options: TrackerRunOptions = {
          fetch,
          sendBeacon: () => {
            throw new Error('beacon broken');
          },
        };
        let t: ReturnType<typeof run> | undefined;
        expect(() => {
          t = run(options);
        }).not.toThrow();
        t!.at(T0 + 1_000);
        expect(() => t!.fire('window', 'pagehide')).not.toThrow();
        t!.setVisibility('hidden');
        expect(() => t!.fire('document', 'visibilitychange')).not.toThrow();
        t!.setVisibility('visible');
        expect(() => t!.fire('window', 'pageshow')).not.toThrow();
        t!.at(T0 + 120_000);
        expect(() => t!.tick()).not.toThrow();
      }
      // A rejected fetch with no handler is an "Uncaught (in promise)" error
      // in the visitor's console. Give any such rejection a turn to surface.
      await new Promise((r) => setTimeout(r, 10));
      expect(rejections).toEqual([]);
    });

    it('when the page itself throws under it', () => {
      // A listener body that throws, here on reading location.pathname, is
      // swallowed, and the page carries on.
      const t = run();
      t.at(T0 + 1_000);
      t.setPathname(() => {
        throw new Error('location is gone');
      });
      expect(() => t.fire('window', 'pagehide')).not.toThrow();
      expect(() => t.tick()).not.toThrow();
      expect(t.sent).toHaveLength(1); // the view only; the broken end is dropped
    });
  });
});

describe('the device', () => {
  it('is never written to or read from: no cookie, no storage, across a whole visit', () => {
    const t = run();
    t.at(T0 + 5_000);
    t.tick();
    t.setVisibility('hidden');
    t.fire('document', 'visibilitychange');
    t.fire('window', 'pagehide');
    expect(t.sent.length).toBeGreaterThan(1);
    expect(t.storageTouched).toEqual([]);
  });

  it('can fail: the harness does see a storage access', () => {
    const t = runTracker("window.localStorage; document.cookie = 'x=1';");
    expect(t.storageTouched).toEqual(['localStorage', 'cookie']);
  });
});
