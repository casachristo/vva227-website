import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as registry from '../../src/data/analytics';
import { MAX_ENGAGED_MS, MAX_VIEWPORT_PX, validateEvent } from '../../src/lib/beacon';
import { beaconConfig } from '../../src/pages/b.js.ts';
import { onRequest } from '../../functions/api/e';
import { beaconRequest, createD1, createEnv } from '../helpers/d1';
import { expectAccepted, expectViewRow } from '../helpers/analytics';
import { DIST, loadPages } from '../helpers/dist';
import { emittedConfig, runTracker, type SentRequest, type TrackerRun, type TrackerRunOptions } from '../helpers/tracker-harness';

/**
 * CONTRACT — the shipped beacon against everything it has to agree with.
 *
 * Every way the beacon can break is SILENT. A blocked or refused request
 * reports nothing to the page: there is no console error from the tracker, no
 * server log, and the site looks perfect while the table stays empty. These
 * tests read the BUILT artefacts (dist/b.js, dist/_headers, dist/_routes.json)
 * and check each against the registry rather than against a value restated
 * here.
 *
 * TIER JUSTIFICATION: the unit tier proves the tracker sends what it means to
 * send, and the collector's tests prove it accepts what they hand it. Neither
 * can see whether the two agree. Here the real shipped bytes produce payloads
 * under generated, browser-shaped inputs, and every one of them is put
 * through the real validateEvent() and the real collector. A field renamed on
 * one side, a limit changed on one side, or a path shape one side produces
 * and the other refuses passes both of those suites and fails this one.
 */

const shipped = () => {
  const file = join(DIST, registry.BEACON_SCRIPT.slice(1));
  if (!existsSync(file)) throw new Error(`${file} is missing; run the build first`);
  return readFileSync(file, 'utf8');
};

let source: string;
beforeAll(() => {
  source = shipped();
});

describe('dist/b.js, the bytes a browser runs', () => {
  it('is built at the path every page loads', () => {
    const srcs = loadPages().map((p) => p.html.match(/<script\b[^>]*\bsrc="([^"]*)"/)?.[1]);
    expect(srcs.length).toBeGreaterThan(10);
    expect(new Set(srcs)).toEqual(new Set([registry.BEACON_SCRIPT]));
    expect(existsSync(join(DIST, registry.BEACON_SCRIPT.slice(1)))).toBe(true);
  });

  it('targets BEACON_ENDPOINT, with every limit taken from the registry', () => {
    expect(emittedConfig(source)).toEqual({
      endpoint: registry.BEACON_ENDPOINT,
      heartbeatMs: registry.HEARTBEAT_MS,
      maxPathChars: registry.MAX_PATH_CHARS,
      maxReferrerChars: registry.MAX_REFERRER_CHARS,
    });
    expect(emittedConfig(source)).toEqual(beaconConfig());
  });

  it('sends no site of its own: the collector stamps SITE_KEY', () => {
    // A site taken from the client would let any page write into another
    // site's rows. The stamp is checked end to end below.
    expect(source).not.toContain(JSON.stringify(registry.SITE_KEY));
    for (const body of fullVisit(source).bodies()) expect(Object.keys(body)).not.toContain('s');
  });

  it('is a self-contained classic script: no module syntax, no transpiler helper', () => {
    // Astro compiles src/lib/tracker.ts before toString() sees it. A helper
    // such as __name( or __spreadValues( is defined at the top of the
    // compiled module, outside the function, so it would ship as an undefined
    // identifier, and the tracker would swallow the resulting error.
    expect(source.startsWith("'use strict';\n(function tracker(cfg")).toBe(true);
    expect(source).not.toMatch(/^\s*(import|export)\b/m);
    expect(source).not.toMatch(/\bimport\s*\(|import\.meta|\brequire\s*\(/);
    expect(source).not.toMatch(/\b__[A-Za-z]\w*/);
  });

  it('can fail: the helper pattern sees what a transpiler would inject', () => {
    expect('var t = __name(function () {}, "t");').toMatch(/\b__[A-Za-z]\w*/);
    expect('__vite_ssr_import_0__.HEARTBEAT_MS').toMatch(/\b__[A-Za-z]\w*/);
  });

  it('never reads the full URL or its query string', () => {
    expect(source).toContain('location.pathname');
    expect(source).not.toMatch(/location\.(href|search|hash)\b/);
  });

  it('runs, as shipped, against nothing but browser stubs', () => {
    const t = runTracker(source, { pathname: '/events' });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ url: registry.BEACON_ENDPOINT, body: { k: registry.EVENT_VIEW, p: '/events' } });
  });
});

/** A visit that exercises every event the tracker can send. */
function fullVisit(src: string, options: TrackerRunOptions = {}): TrackerRun {
  const t = runTracker(src, { now: 0, ...options });
  t.at(30_000);
  t.tick();
  t.setVisibility('hidden');
  t.fire('document', 'visibilitychange');
  t.at(90_000);
  t.setVisibility('visible');
  t.fire('document', 'visibilitychange');
  t.at(95_000);
  t.fire('window', 'pagehide');
  return t;
}

// ---------------------------------------------------------------------------
// Generated, browser-shaped inputs. Deterministic (seeded), so a failure
// reproduces; varied enough to reach the limits and the odd shapes real
// browsers do produce.

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATH_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-_./~%! ü✓"<>\\\'`';

function generate(seed: number) {
  const rand = prng(seed);
  const int = (n: number) => Math.floor(rand() * n);
  const pick = <T>(xs: readonly T[]) => xs[int(xs.length)];
  const text = (max: number) => Array.from({ length: int(max) }, () => pick([...PATH_CHARS])).join('');

  // Every value goes through the WHATWG URL parser, as a browser's would:
  // location.pathname and document.referrer are serialised URLs, never raw
  // strings. A leading '//' or '/\' is kept on purpose: both are real paths
  // a visitor (or a probe) can request.
  const rawPath = pick(['/', '//', '/\\', '/about/', '']) + text(pick([10, 40, 700]));
  // Concatenated, not resolved against a base: new URL('//x', base) would
  // read '//x' as a host, which is not what typing it after the domain does.
  const pathname = new URL(`https://vva227.org${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`).pathname;
  const referrer = pick([
    '',
    () => new URL(`https://${pick(['www.google.com', 'm.facebook.com', 'vva227.org', 'xn--bcher-kva.example'])}/${text(pick([5, 60, 700]))}?${text(30)}#${text(10)}`).href,
    () => new URL(`android-app://com.google.android.gm/${'\\'.repeat(int(700))}`).href,
    () => new URL(`http://127.0.0.1:8799/${text(20)}?token=secret`).href,
  ] as const);

  return {
    options: {
      pathname,
      referrer: typeof referrer === 'function' ? referrer() : referrer,
      visibility: pick(['visible', 'visible', 'hidden'] as const),
      innerWidth: pick([0, 320, 375, 1280, 2560, 3840]),
      innerHeight: pick([0, 568, 800, 2160]),
      // Seeded bytes, so every generated visit has its own view id; null
      // takes the tracker's no-crypto path.
      crypto:
        rand() < 0.2
          ? null
          : {
              getRandomValues(a: Uint8Array) {
                for (let i = 0; i < a.length; i++) a[i] = int(256);
                return a;
              },
            },
      now: 1_700_000_000_000,
    } satisfies TrackerRunOptions,
    // A random life: time passing, tab switches, heartbeats, leaving and
    // coming back. Steps up to an hour, so some totals pass the server's cap.
    steps: Array.from({ length: int(12) }, () => ({
      action: pick(['tick', 'hide', 'show', 'pagehide', 'pageshow'] as const),
      advance: pick([0, 250, 4_000, 60_000, 3_600_000]),
    })),
  };
}

function live(src: string, seed: number): SentRequest[] {
  const { options, steps } = generate(seed);
  const t = runTracker(src, options);
  let now = options.now;
  for (const { action, advance } of steps) {
    now += advance;
    t.at(now);
    if (action === 'tick') t.tick();
    else if (action === 'hide' || action === 'show') {
      t.setVisibility(action === 'hide' ? 'hidden' : 'visible');
      t.fire('document', 'visibilitychange');
    } else t.fire('window', action);
  }
  return t.sent;
}

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);

describe('every payload the shipped tracker sends is one the collector accepts unchanged', () => {
  it('passes validateEvent, and validation changes nothing a browser sent', () => {
    let payloads = 0;
    const kinds = new Set<string>();
    const failures: string[] = [];
    for (const seed of SEEDS) {
      for (const req of live(source, seed)) {
        payloads++;
        const body = req.body;
        kinds.add(String(body.k));
        const result = validateEvent(JSON.parse(req.raw));
        if (!result.ok) {
          failures.push(`seed ${seed}: ${result.reason} for ${req.raw.slice(0, 120)}`);
          continue;
        }
        const e = result.event;
        // The server's cleaning is the authority, but on real traffic it
        // must be a no-op: a field it has to change is a field the two sides
        // disagree about.
        const expected = {
          kind: body.k,
          view: body.v,
          path: body.p,
          referrer: body.k === registry.EVENT_VIEW ? body.r : null,
          viewportW: body.k === registry.EVENT_VIEW ? body.w : null,
          viewportH: body.k === registry.EVENT_VIEW ? body.h : null,
          engagedMs: body.k === registry.EVENT_END ? Math.min(body.e as number, MAX_ENGAGED_MS) : 0,
        };
        try {
          expect(e).toEqual(expected);
        } catch {
          failures.push(`seed ${seed}: normalised ${JSON.stringify(e)} != sent ${req.raw.slice(0, 200)}`);
        }
      }
    }
    expect(failures.slice(0, 5), `${failures.length} of ${payloads} payloads disagree`).toEqual([]);
    // Not vacuous: hundreds of payloads, both kinds.
    expect(payloads).toBeGreaterThan(SEEDS.length);
    expect([...kinds].sort()).toEqual([registry.EVENT_END, registry.EVENT_VIEW]);
  });

  it('fits under MAX_BODY_BYTES, even at the largest a browser can produce', () => {
    // The largest view: a path at its cap and a referrer whose every
    // character JSON has to escape. A non-special scheme keeps backslashes
    // in its path, and each one doubles in JSON.
    const worst = runTracker(source, {
      pathname: '/' + '%E2'.repeat(400),
      referrer: new URL(`android-app://x/${'\\'.repeat(2_000)}`).href,
      innerWidth: MAX_VIEWPORT_PX,
      innerHeight: MAX_VIEWPORT_PX,
    }).sent[0];
    expect(worst.raw.length).toBeGreaterThan(1_500);
    expect(Buffer.byteLength(worst.raw)).toBeLessThanOrEqual(registry.MAX_BODY_BYTES);

    for (const seed of SEEDS) {
      for (const req of live(source, seed)) {
        expect(Buffer.byteLength(req.raw), `seed ${seed}`).toBeLessThanOrEqual(registry.MAX_BODY_BYTES);
      }
    }
  });

  it('can fail: a payload the collector refuses is reported', () => {
    expect(validateEvent({ k: 'view', v: 'abcdef0123456789', p: '//evil.example/x' }).ok).toBe(false);
    expect(validateEvent({ k: 'view', v: 'not-hex', p: '/' }).ok).toBe(false);
  });
});

describe('through the real collector, into the real schema', () => {
  it('stores one row per pageview, stamped with SITE_KEY, holding exactly what was sent', async () => {
    const d1 = createD1();
    try {
      const sentBy = new Map<string, SentRequest[]>();
      for (const seed of SEEDS.slice(0, 60)) {
        for (const req of live(source, seed)) {
          const res = await onRequest({ request: beaconRequest(req.raw), env: createEnv(d1.binding) });
          await expectAccepted(res);
          const list = sentBy.get(String(req.body.v)) ?? [];
          list.push(req);
          sentBy.set(String(req.body.v), list);
        }
      }
      expect(sentBy.size).toBeGreaterThan(30);
      expect(d1.rows()).toHaveLength(sentBy.size);

      for (const [view, reqs] of sentBy) {
        const row = expectViewRow(d1.one(view));
        expect(row.site).toBe(registry.SITE_KEY);
        expect(row.path).toBe(reqs[0].body.p);
        const viewBody = reqs.find((r) => r.body.k === registry.EVENT_VIEW)!.body;
        expect(row.referrer).toBe(viewBody.r);
        const ends = reqs.filter((r) => r.body.k === registry.EVENT_END).map((r) => Math.min(r.body.e as number, MAX_ENGAGED_MS));
        expect(row.engaged_ms).toBe(Math.max(0, ...ends));
      }
    } finally {
      d1.close();
    }
  });
});

describe('the Content-Security-Policy the built site is served with', () => {
  /** The /* block's CSP from dist/_headers, as directive -> sources. */
  function cspOf(headersText: string): Record<string, string[]> {
    const lines = headersText.split(/\r?\n/);
    const policies: string[] = [];
    let block = '';
    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      if (!/^\s/.test(line)) block = line.trim();
      else if (/^\s+Content-Security-Policy:/i.test(line)) {
        expect(block, 'a CSP outside the /* block').toBe('/*');
        policies.push(line.slice(line.indexOf(':') + 1).trim());
      }
    }
    expect(policies).toHaveLength(1);
    return Object.fromEntries(
      policies[0]
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const [name, ...sources] = d.split(/\s+/);
          return [name, sources];
        }),
    );
  }

  /** Every source that is not a keyword or a bare scheme names an origin. */
  const origins = (csp: Record<string, string[]>) =>
    Object.entries(csp).flatMap(([name, sources]) =>
      sources.filter((s) => !/^'(self|none|unsafe-inline)'$/.test(s) && !/^(data|blob):$/.test(s)).map((s) => `${name} ${s}`),
    );

  const csp = () => cspOf(readFileSync(join(DIST, '_headers'), 'utf8'));

  it("lets the beacon load and post: script-src 'self' and connect-src 'self', stated", () => {
    expect(csp()['script-src']).toEqual(["'self'"]);
    expect(csp()['connect-src']).toEqual(["'self'"]);
  });

  it('names no origin but its own, in any directive', () => {
    expect(origins(csp())).toEqual([]);
  });

  it('opened no inline or eval allowance for scripts', () => {
    const all = Object.values(csp()).flat();
    expect(all).not.toContain("'unsafe-eval'");
    expect(csp()['script-src']).not.toContain("'unsafe-inline'");
  });

  it('can fail: a hosted analytics origin would be caught', () => {
    const vendor = { ...csp(), 'connect-src': ["'self'", 'https://plausible.io'], 'script-src': ["'self'", 'cdn.example'] };
    expect(origins(vendor)).toEqual(['script-src cdn.example', 'connect-src https://plausible.io']);
  });
});

describe('dist/_routes.json', () => {
  it('routes exactly the registered Function paths', () => {
    expect(JSON.parse(readFileSync(join(DIST, '_routes.json'), 'utf8'))).toEqual({
      version: 1,
      include: [registry.BEACON_ENDPOINT, registry.STATS_PATH],
      exclude: [],
    });
  });

  it('does not route the beacon script itself into Functions', () => {
    // /b.js is a static file. Routed into Functions it would 404.
    const { include } = JSON.parse(readFileSync(join(DIST, '_routes.json'), 'utf8'));
    expect(include).not.toContain(registry.BEACON_SCRIPT);
  });
});
