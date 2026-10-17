import { test, expect, type Browser, type Page, type Request, type Response, type TestInfo } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BEACON_ENDPOINT, BEACON_SCRIPT, EVENT_VIEW, SITE_KEY, STATS_PATH } from '../../src/data/analytics';
import { headersPolicy, redirectRules } from '../helpers/pages-files';
import { RUNTIME_D1_DIR, RUNTIME_ORIGIN } from '../helpers/pages-runtime';

/**
 * SYSTEM — the built site in the real Pages runtime, in a real browser.
 *
 * Served by `wrangler pages dev` (workerd, what Cloudflare Pages runs), with
 * public/_headers, _redirects and _routes.json applied as Pages applies them,
 * functions/ compiled and running, and a local D1 database with the real
 * migration bound as BEACON. See tests/helpers/pages-runtime-server.ts.
 *
 * TIER JUSTIFICATION, and it is why this file exists. Every tier below reads
 * bytes: the contract tier proves connect-src is in a header file and the unit
 * tier proves the tracker calls fetch when driven by stubs. NEITHER ENFORCES A
 * POLICY, and neither routes a request. Only a real engine decides whether
 * the beacon is allowed to load and to post, and only the Pages runtime
 * decides whether a legacy redirect still wins once functions/ exists. This
 * feature's defining failure is silence: a blocked beacon reports nothing,
 * and the site looks perfect while the table stays empty. So every test here
 * asserts on what the DATABASE received, not on what the page appeared to do.
 *
 * Each test browses as its own visitor (a unique user agent, so a unique
 * visitor hash) because tests run in parallel against one database.
 */

const DIST = join(process.cwd(), 'dist');

type Row = Record<string, unknown>;

/** Rows from the run's D1 database, read straight from its SQLite file. */
function query(sql: string, ...args: Array<string | number>): Row[] {
  const files = readdirSync(RUNTIME_D1_DIR).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (files.length !== 1) throw new Error(`expected one D1 database in ${RUNTIME_D1_DIR}, found [${files.join(', ')}]`);
  const db = new DatabaseSync(join(RUNTIME_D1_DIR, files[0]), { readOnly: true });
  try {
    return db.prepare(sql).all(...args).map((r) => ({ ...(r as Row) }));
  } finally {
    db.close();
  }
}

const byView = (view: string) => query('SELECT * FROM views WHERE view = ?', view);
const byVisitor = (visitor: string) => query('SELECT * FROM views WHERE visitor = ? ORDER BY ts', visitor);

/** A stored row, checked whole. */
function expectStoredView(row: Row | undefined, expected: { path: string; referrer: string | null }): Row {
  expect(row, 'no row was stored').toBeDefined();
  const r = row!;
  const columns = query('PRAGMA table_info(views)').map((c) => String(c.name));
  expect(Object.keys(r).sort()).toEqual([...columns].sort());
  // Nothing that could hold the address or the browser string.
  expect(columns.filter((c) => /ip|addr|agent|^ua$/i.test(c))).toEqual([]);
  expect(r).toMatchObject({ site: SITE_KEY, path: expected.path, referrer: expected.referrer, viewport_w: 1280, viewport_h: 720 });
  expect(r.view).toMatch(/^[0-9a-f]{16}$/);
  expect(r.visitor).toMatch(/^[0-9a-f]{32}$/);
  expect(Number.isInteger(r.engaged_ms) && (r.engaged_ms as number) >= 0).toBe(true);
  expect(r.ts as number).toBeGreaterThan(Date.now() - 10 * 60_000);
  expect(r.ts as number).toBeLessThanOrEqual(Date.now());
  for (const col of ['country', 'city', 'region', 'as_org']) expect(r[col] === null || typeof r[col] === 'string', col).toBe(true);
  expect(r.asn === null || Number.isInteger(r.asn)).toBe(true);
  return r;
}

const isBeaconPost = (r: Request | Response) => {
  const req = 'request' in r ? r.request() : r;
  return req.method() === 'POST' && new URL(req.url()).pathname === BEACON_ENDPOINT;
};

/** The built pages, as the routes Pages serves them at. */
function builtRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.html')) {
        const rel = relative(DIST, full).split(sep).join('/');
        if (rel !== '404.html') out.push(rel === 'index.html' ? '/' : `/${rel.replace(/\.html$/, '')}`);
      }
    }
  };
  walk(DIST);
  return out.sort();
}

/** The Content-Security-Policy dist/_headers sets on every path. */
const shippedPolicy = () => headersPolicy(readFileSync(join(DIST, '_headers'), 'utf8'));

interface Visitor {
  page: Page;
  ua: string;
  /** Every beacon POST the browser was seen to make. Teardown beacons can be missed; the database is the truth. */
  beacons: Array<Record<string, unknown>>;
  /** Every request for the beacon script. */
  scriptLoads: string[];
  /** Uncaught exceptions. */
  pageErrors: string[];
  /** CSP violations Chromium logged to the console. */
  consoleViolations: string[];
  /** POST a beacon directly, as this visitor, and return the stored row. */
  control(): Promise<Row>;
}

async function newVisitor(browser: Browser, testInfo: TestInfo, { gpc = false } = {}): Promise<Visitor> {
  const ua = `Mozilla/5.0 (vva227 runtime test ${testInfo.testId}.${testInfo.retry}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36`;
  const context = await browser.newContext({ baseURL: RUNTIME_ORIGIN, userAgent: ua, viewport: { width: 1280, height: 720 } });
  await testInfo.attach('user agent', { body: ua });
  await context.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`));
  });
  if (gpc) {
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true });
    });
  }
  const page = await context.newPage();
  const v: Visitor = {
    page,
    ua,
    beacons: [],
    scriptLoads: [],
    pageErrors: [],
    consoleViolations: [],
    async control() {
      // Same user agent, same address, same day: the same visitor hash the
      // browser's own rows carry. Proven to match in the first test below.
      const id = `c0${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16)}`.slice(0, 16).padEnd(16, '0');
      const res = await context.request.post(BEACON_ENDPOINT, {
        headers: { 'User-Agent': ua, 'Content-Type': 'application/json' },
        data: { k: EVENT_VIEW, v: id, p: '/control' },
      });
      expect(res.status()).toBe(204);
      return byView(id)[0];
    },
  };
  context.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path === BEACON_SCRIPT) v.scriptLoads.push(r.url());
    if (isBeaconPost(r)) v.beacons.push(r.postDataJSON());
  });
  page.on('pageerror', (e) => v.pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) v.consoleViolations.push(m.text());
  });
  return v;
}

const violations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

/** A tab switch, synthesised: tests cannot background a headless tab for real. */
const setVisibility = (page: Page, state: 'hidden' | 'visible') =>
  page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { value: s, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);

const POLL = { timeout: 10_000 };

test.describe('a visit, as the database records it', () => {
  test('one page load writes exactly one row: its path, this site, a 32-hex visitor, no device storage', async ({ browser }, testInfo) => {
    const v = await newVisitor(browser, testInfo);
    const view = v.page.waitForResponse(isBeaconPost);
    await v.page.goto('/give?token=secret#frag');
    const res = await view;
    expect(res.status()).toBe(204);
    const sent = res.request().postDataJSON();
    expect(Object.keys(sent).sort()).toEqual(['h', 'k', 'p', 'r', 'v', 'w']);
    expect(sent).toMatchObject({ k: EVENT_VIEW, p: '/give', r: null, w: 1280, h: 720 });

    await expect.poll(() => byView(sent.v).length, POLL).toBe(1);
    const row = expectStoredView(byView(sent.v)[0], { path: '/give', referrer: null });
    expect(row.engaged_ms).toBe(0);

    // Exactly one: give a duplicate time to land, then count this visitor's rows.
    await v.page.waitForTimeout(500);
    expect(byVisitor(row.visitor as string)).toHaveLength(1);

    // The control post lands under the same visitor hash. This is what makes
    // "no row for this visitor" meaningful in the opt-out tests below.
    const control = await v.control();
    expect(control.visitor).toBe(row.visitor);

    // Nothing was written to the device, checked in a real engine.
    expect(await v.page.context().cookies()).toEqual([]);
    expect(await v.page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    expect(v.pageErrors).toEqual([]);
  });

  test('arriving from a URL that carries ?token=secret stores the referrer without it', async ({ browser }, testInfo) => {
    const v = await newVisitor(browser, testInfo);
    await v.page.goto('/?token=secret#frag');
    const next = v.page.waitForRequest((r) => isBeaconPost(r) && r.postDataJSON().p === '/about');
    await v.page.locator('a[href="/about"]:visible').first().click();
    await v.page.waitForURL('**/about');
    const req = await next;

    // Not vacuous: the browser really did hand the page the full URL.
    expect(await v.page.evaluate(() => document.referrer)).toBe(`${RUNTIME_ORIGIN}/?token=secret`);
    // Stripped before it left the browser...
    expect(req.postData()).not.toContain('secret');
    const sent = req.postDataJSON();
    expect(sent.r).toBe(`${RUNTIME_ORIGIN}/`);
    // ...and stored stripped.
    await expect.poll(() => byView(sent.v).length, POLL).toBe(1);
    expectStoredView(byView(sent.v)[0], { path: '/about', referrer: `${RUNTIME_ORIGIN}/` });
    expect(query("SELECT view FROM views WHERE referrer LIKE '%secret%' OR path LIKE '%secret%' OR referrer LIKE '%#%'")).toEqual([]);
  });

  test('hiding the page, then leaving it, raises reading time on that same row', async ({ browser }, testInfo) => {
    const v = await newVisitor(browser, testInfo);
    const view = v.page.waitForResponse(isBeaconPost);
    await v.page.goto('/events');
    const { v: id } = (await view).request().postDataJSON();
    await expect.poll(() => byView(id).length, POLL).toBe(1);
    const first = byView(id)[0];

    await v.page.waitForTimeout(800);
    await setVisibility(v.page, 'hidden');
    await expect.poll(() => byView(id)[0].engaged_ms as number, POLL).toBeGreaterThanOrEqual(700);
    const afterHide = byView(id)[0];
    // Real elapsed time, bounded on both sides so a nonsense number fails.
    expect(afterHide.engaged_ms as number).toBeLessThan(30_000);
    expect(afterHide.ts).toBe(first.ts);

    // Two seconds in another tab, which must not count.
    await v.page.waitForTimeout(2_000);
    await setVisibility(v.page, 'visible');
    await v.page.waitForTimeout(500);
    // THE REALISTIC EXIT: a navigation, so the browser fires pagehide and has
    // to deliver the beacon while the page is torn down. A client-side
    // listener routinely misses that request; the database does not.
    await v.page.goto('/contact');
    await expect.poll(() => byView(id)[0].engaged_ms as number, POLL).toBeGreaterThanOrEqual((afterHide.engaged_ms as number) + 400);
    // The half second visible plus the navigation, not the hidden two
    // seconds: counting them would put this past 2,500.
    expect((byView(id)[0].engaged_ms as number) - (afterHide.engaged_ms as number)).toBeLessThan(1_800);

    const rows = byVisitor(first.visitor as string);
    expect(rows.map((r) => r.path)).toEqual(['/events', '/contact']);
    expect(byView(id)).toHaveLength(1);
    expect(byView(id)[0].ts).toBe(first.ts);
  });
});

test.describe('every built page, under the real policy', () => {
  const pages = [...builtRoutes().map((route) => ({ route, path: route, status: 200 })), { route: '/no-such-page-404', path: '/no-such-page-404', status: 404 }];

  test('covers the whole build', () => {
    expect(pages.length).toBeGreaterThan(15);
    expect(pages.map((p) => p.route)).toContain('/');
  });

  for (const { route, path, status } of pages) {
    test(`${route} loads the beacon, records the visit, with no CSP violation or page error`, async ({ browser }, testInfo) => {
      const v = await newVisitor(browser, testInfo);
      const view = v.page.waitForResponse(isBeaconPost);
      const res = await v.page.goto(route);
      expect(res?.status()).toBe(status);
      expect(res?.headers()['content-security-policy']).toBe(shippedPolicy());

      const beacon = await view;
      expect(beacon.status()).toBe(204);
      const sent = beacon.request().postDataJSON();
      expect(sent.p).toBe(path);
      await expect.poll(() => byView(sent.v).length, POLL).toBe(1);
      expectStoredView(byView(sent.v)[0], { path, referrer: null });

      expect(v.scriptLoads).toEqual([`${RUNTIME_ORIGIN}${BEACON_SCRIPT}`]);
      expect(await violations(v.page)).toEqual([]);
      expect(v.consoleViolations).toEqual([]);
      expect(v.pageErrors).toEqual([]);
    });
  }
});

test.describe('the opt-out, in a real browser', () => {
  test('with Global Privacy Control on, no request reaches the collector and nothing is stored', async ({ browser }, testInfo) => {
    const v = await newVisitor(browser, testInfo, { gpc: true });
    await v.page.goto('/');
    expect(await v.page.evaluate(() => (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl)).toBe(true);
    await v.page.waitForTimeout(400);
    // Every exit the tracker listens for, given its chance to send.
    await setVisibility(v.page, 'hidden');
    await setVisibility(v.page, 'visible');
    await v.page.goto('/about');
    await v.page.waitForTimeout(600);

    // The script loaded and ran on both pages: the silence is the opt-out,
    // not a script that never arrived.
    expect(v.scriptLoads).toHaveLength(2);
    expect(v.pageErrors).toEqual([]);
    expect(v.beacons).toEqual([]);

    // Server side: this visitor's only row is the control post.
    const control = await v.control();
    expect(byVisitor(control.visitor as string).map((r) => r.path)).toEqual(['/control']);
  });
});

test.describe('the policy is actually doing the work', () => {
  test('a cross-origin connection and an inline script are blocked, and the listener reports both', async ({ browser }, testInfo) => {
    // Proof that "zero violations" above is measured by something that can
    // see a violation. Neither request needs the network: the policy refuses
    // both before anything leaves the page.
    const v = await newVisitor(browser, testInfo);
    await v.page.goto('/privacy');
    const result = await v.page.evaluate(async () => {
      let fetched = 'allowed';
      try {
        await fetch('https://analytics.example/collect', { method: 'POST', body: '{}' });
      } catch {
        fetched = 'blocked';
      }
      const s = document.createElement('script');
      s.textContent = '(window).__inline = 1;';
      document.head.append(s);
      return { fetched, inline: (window as unknown as { __inline?: number }).__inline ?? null };
    });
    expect(result).toEqual({ fetched: 'blocked', inline: null });
    await expect
      .poll(() => violations(v.page), POLL)
      .toEqual(expect.arrayContaining(['connect-src https://analytics.example/collect', 'script-src-elem inline']));
  });

  test("under the site's old policy, script-src 'none', the beacon is blocked and nothing is recorded", async ({ browser }, testInfo) => {
    // The state the site was in before this feature, served by the real
    // runtime with only the CSP header swapped. If the system tier could not
    // tell this apart from a working beacon, every pass above would be
    // meaningless.
    const policy = shippedPolicy();
    const old = policy.replace("script-src 'self'", "script-src 'none'");
    expect(old, 'the substitution matched nothing; this test would be vacuous').not.toBe(policy);

    const v = await newVisitor(browser, testInfo);
    await v.page.route(`${RUNTIME_ORIGIN}/about`, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': old } });
    });
    await v.page.goto('/about');
    await v.page.waitForTimeout(800);
    await setVisibility(v.page, 'hidden');
    await v.page.waitForTimeout(300);

    expect(v.beacons).toEqual([]);
    await expect.poll(() => violations(v.page), POLL).toContain(`script-src-elem ${RUNTIME_ORIGIN}${BEACON_SCRIPT}`);
    // The page itself still renders perfectly, which is the danger.
    await expect(v.page.locator('h1')).toBeVisible();
    const control = await v.control();
    expect(byVisitor(control.visitor as string).map((r) => r.path)).toEqual(['/control']);
  });
});

test.describe('routing with Functions present', () => {
  test('every legacy redirect in _redirects still answers with its own status and target', async ({ request }) => {
    // All 50-odd legacy URLs keep working with functions/ deployed beside
    // them, in the runtime Pages uses.
    //
    // WHAT THIS DOES NOT PROVE: that the _routes.json pin is what protects
    // them. Measured 2026-10-17 by swapping dist/_routes.json for
    // include ["/*"]: wrangler pages dev hands a request no Function matches
    // on to its asset server, which still applies _redirects, so this test
    // passed. Whether production does the same is not something a local run
    // can show. The pin is held by tests/contracts/analytics-routes.test.ts;
    // what this runtime does catch is the opposite mistake, a routes file
    // that leaves the collector out (see the next test, and every page test
    // above, whose beacon would then be answered by the asset server).
    const rules = redirectRules(readFileSync(join(DIST, '_redirects'), 'utf8'));
    expect(rules.length).toBeGreaterThan(40);
    for (const { from, to, status } of rules) {
      const res = await request.get(from, { maxRedirects: 0 });
      expect(res.status(), from).toBe(status);
      expect(new URL(res.headers()['location'], RUNTIME_ORIGIN).pathname, from).toBe(to);
    }
  });

  test('while the collector is live in the same runtime', async ({ request }) => {
    // Without this, the redirects above would also pass on a runtime that had
    // simply not loaded functions/. Measured the same day: with /api/e
    // excluded in dist/_routes.json the asset server answers here instead,
    // and this fails.
    const res = await request.get(BEACON_ENDPOINT);
    expect(res.status()).toBe(405);
    expect(res.headers()['allow']).toBe('POST');
    expect(await res.json()).toEqual({ error: 'method not allowed' });
  });

  test("/stats answers the handler's plain 404, not the site's 404 page", async ({ request }) => {
    // The gate is not chosen yet and fails closed. Its 404 must be the
    // handler's own, so it is distinguishable from a route that does not
    // exist at all: that is what shows the Function is there and refusing.
    for (const res of [await request.get(STATS_PATH), await request.get(`${STATS_PATH}?days=365`), await request.post(STATS_PATH, { data: 'password=x' })]) {
      expect(res.status()).toBe(404);
      expect(res.headers()['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.headers()['cache-control']).toBe('no-store');
      expect(res.headers()['x-content-type-options']).toBe('nosniff');
      expect(await res.text()).toBe('Not found');
    }
    const missing = await request.get('/no-such-page');
    expect(missing.status()).toBe(404);
    expect(missing.headers()['content-type']).toMatch(/^text\/html/);
    expect(await missing.text()).toContain('could not find');
  });

  test('/b.js is served as JavaScript, byte for byte the built file', async ({ request }) => {
    const res = await request.get(BEACON_SCRIPT);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/javascript/);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(await res.text()).toBe(readFileSync(join(DIST, BEACON_SCRIPT.slice(1)), 'utf8'));
  });
});
