import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as plan from '../../tools/lib/setup-analytics-plan.mjs';
import * as registry from '../../src/data/analytics';
import { isSiteHost } from '../../src/lib/stats';
import { createAccessGate } from '../../src/lib/stats-gate';
import { onRequest as collect } from '../../functions/api/e';
import { onRequest as stats } from '../../functions/stats';
import { beaconRequest, createD1, ORIGIN, type TestD1 } from '../helpers/d1';
import { AUD, certsServer, claimsFor, createSigner, TEAM } from '../helpers/access-jwt';
import { expectAccepted } from '../helpers/analytics';

/**
 * CONTRACT — what the setup script writes into the Pages project, against
 * what the code reads out of it.
 *
 * The script names a binding, three variables, a path, a project and a
 * migrations directory as strings. The Functions read the same names off
 * `env`, the registry states the path, package.json deploys to the project.
 * Nothing but this file forces them to agree, and each disagreement is
 * silent: a binding written as BEACONS leaves the collector answering 500 in
 * production; an Access setting written under the wrong name keeps /stats a
 * 404 for the owner forever, with every test of the gate still green.
 *
 * Each name is checked by USING it: the env the script would produce is
 * handed to the real handler, and the handler must work.
 *
 * TIER JUSTIFICATION: the unit and feature tiers test the script against its
 * own constants, so a wrong constant passes both. Only a check that crosses
 * from the script's output to the Functions' input can fail on it.
 */

const ROOT = process.cwd();
let d1: TestD1 | null = null;
afterEach(() => {
  d1?.close();
  d1 = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the names the script writes are the names the Functions read', () => {
  it('the collector stores a visit with exactly the binding and salt the script sets', async () => {
    d1 = createD1();
    const env = { [plan.BINDING]: d1.binding, [plan.SALT_VAR]: 'a-salt' };
    await expectAccepted(await collect({ request: beaconRequest({ k: registry.EVENT_VIEW, v: 'abcdef0123456789', p: '/' }), env }));
    expect(d1.rows()).toHaveLength(1);
  });

  it('can actually fail: under any other binding name the collector stores nothing', async () => {
    d1 = createD1();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await collect({ request: beaconRequest({ k: registry.EVENT_VIEW, v: 'abcdef0123456789', p: '/' }), env: { [`${plan.BINDING}S`]: d1.binding, [plan.SALT_VAR]: 'a-salt' } });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(d1.rows()).toHaveLength(0);
  });

  it('the gate lets a valid token in under exactly the Access settings the script writes', async () => {
    const signer = await createSigner();
    const now = Date.UTC(2026, 9, 17);
    const gate = createAccessGate({ fetchImpl: certsServer(signer.jwks).fetch, now: () => now });
    const request = new Request(`${ORIGIN}${registry.STATS_PATH}`, { headers: { 'Cf-Access-Jwt-Assertion': await signer.sign(claimsFor(now / 1000)) } });
    expect(await gate(request, { [plan.TEAM_VAR]: TEAM, [plan.AUD_VAR]: AUD })).toEqual({ ok: true });
    // And not under a near miss.
    expect(await gate(request, { [`${plan.TEAM_VAR}_`]: TEAM, [plan.AUD_VAR]: AUD })).toEqual({ ok: false, reason: 'access not configured' });
  });

  it('the stats page renders for the owner with the whole env the script leaves behind', async () => {
    d1 = createD1();
    const signer = await createSigner();
    const now = Date.now();
    vi.stubGlobal('fetch', certsServer(signer.jwks).fetch);
    const env = { [plan.BINDING]: d1.binding, [plan.SALT_VAR]: 's', [plan.TEAM_VAR]: TEAM, [plan.AUD_VAR]: AUD };
    const request = new Request(`${ORIGIN}${registry.STATS_PATH}`, { headers: { 'Cf-Access-Jwt-Assertion': await signer.sign(claimsFor(Math.floor(now / 1000))) } });
    const res = await stats({ request, env });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<h1>Visits</h1>');
  });
});

describe('the script, the registry and the repo agree', () => {
  it('protects the path the stats page is served at', () => {
    expect(plan.STATS_PATH).toBe(registry.STATS_PATH);
  });

  it('covers only hostnames the site counts as itself', () => {
    const { destinations } = plan.destinationsFor({ accessAccount: { id: plan.ACCOUNT, name: 'Ch 227' }, subdomain: 'vva227-refresh-12g.pages.dev' });
    for (const { uri } of destinations) {
      const host = uri.slice(0, uri.indexOf('/')).replace(/^\*\./, 'preview.');
      expect(isSiteHost(host), `${host} is not in SITE_HOSTS`).toBe(true);
      expect(registry.SITE_HOSTS.some((h) => h === uri.slice(0, uri.indexOf('/')))).toBe(true);
    }
  });

  it('targets the project and branch `npm run deploy` publishes to', () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
    expect(scripts.deploy).toContain(`--project-name=${plan.PROJECT}`);
    expect(scripts.deploy).toContain(`--branch=${plan.DEPLOY_BRANCH}`);
    expect(scripts['setup:analytics']).toBe('node tools/setup-analytics.mjs');
  });

  it('applies the same migrations, in the same order, that the tests build their database from', () => {
    const files = readdirSync(join(ROOT, 'migrations'));
    const ordered = plan.migrationOrder(files);
    expect(ordered).toEqual(files.filter((f) => f.endsWith('.sql')).sort());
    expect(ordered.length).toBeGreaterThan(0);
  });

  it('reads its token from the file .gitignore keeps out of the repo', () => {
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/)).toContain(plan.TOKEN_FILE);
  });

  it('points step 1 at the file holding the date the runtime tests use, and that file says why it differs', () => {
    // Step 1 prints production's compatibility date and this note under it.
    // The note is true only while the file it names exists, holds the date,
    // and explains that the installed wrangler caps it.
    const file = /see (tests\/helpers\/[\w.-]+\.ts)\)$/.exec(plan.RUNTIME_DATE_NOTE)?.[1];
    expect(file).toBe('tests/helpers/pages-runtime.ts');
    const text = readFileSync(join(ROOT, file!), 'utf8');
    expect(text).toMatch(/export const RUNTIME_COMPATIBILITY_DATE = '\d{4}-\d{2}-\d{2}';/);
    expect(text).toContain('nearest date it can run');
  });
});
