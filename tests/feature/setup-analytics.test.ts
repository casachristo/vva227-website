import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSetup } from '../../tools/lib/setup-analytics.mjs';
import { USAGE } from '../../tools/lib/setup-analytics-plan.mjs';
import { VIEW_COLUMNS } from '../helpers/analytics';
import { runSetupAgainst, type SetupRunOptions } from '../helpers/setup-run';
import {
  CH227,
  emptyMaps,
  FakeCloudflare,
  freshProject,
  OTHER_ACCOUNT,
  PAGES_SUBDOMAIN,
  TEAM_DOMAIN,
  type FakeOptions,
  type RecordedRequest,
} from '../helpers/fake-cloudflare';

/**
 * FEATURE — `npm run setup:analytics`, run whole against a scripted Cloudflare
 * (tests/helpers/fake-cloudflare.ts) that records every request.
 *
 * The real sequence runs: the real plan functions, the real migration file
 * executed against SQLite through the D1 query path, the real bookkeeping
 * table. The only stand-in is Cloudflare itself, and it holds state, so a
 * second run sees what the first one left behind.
 *
 * Every test asserts on what Cloudflare RECEIVED and what state it ended in,
 * not only on what the script printed.
 *
 * TIER JUSTIFICATION: the unit tier proves each decision on hand-built
 * inputs. Only here do the decisions meet each other and an API with memory:
 * that a rerun finds what the first run created (by name, through a paged
 * list and a loose filter), that a stop leaves a state the next run can
 * finish, that the app body Access receives is one Access accepts for the
 * account the zone is in, and that the migration SQL plus wrangler's
 * bookkeeping row actually execute.
 */

const EMAIL = 'owner@example.org';
const SALT = '5a'.repeat(32);
const PROJECT_PATH = `/accounts/${CH227}/pages/projects/vva227-refresh`;

const fakes: FakeCloudflare[] = [];
const dirs: string[] = [];
afterEach(() => {
  fakes.splice(0).forEach((f) => f.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function cloudflare(options: FakeOptions = {}) {
  const fake = new FakeCloudflare(options);
  fakes.push(fake);
  return fake;
}

/** One run with a fixed salt, so a test can tell whether it was written. */
const run = (fake: FakeCloudflare, argv: string[] = ['--email', EMAIL], options: SetupRunOptions = {}) =>
  runSetupAgainst(fake, argv, { randomHex: () => SALT, ...options });

const line = (r: RecordedRequest) => `${r.method} ${r.path}`;
const prod = (fake: FakeCloudflare) => fake.project!.deployment_configs.production;

/** Production, checked whole: exactly the binding and the three variables, each encrypted, plus what was there. */
function expectProductionConfigured(fake: FakeCloudflare, { aud, salt = SALT, team = TEAM_DOMAIN }: { aud: string; salt?: string; team?: string }) {
  const db = fake.database()!;
  expect(prod(fake)).toEqual({
    compatibility_date: '2025-09-01',
    d1_databases: { BEACON: { id: db.uuid } },
    env_vars: {
      BEACON_SALT: { type: 'secret_text', value: salt },
      ACCESS_TEAM_DOMAIN: { type: 'secret_text', value: team },
      ACCESS_AUD: { type: 'secret_text', value: aud },
    },
  });
}

describe('a fresh account', () => {
  it('sets everything up in one run, in order, and says what to do next', async () => {
    const fake = cloudflare();
    const { code, output, requests } = await run(fake);
    expect(code, output).toBe(0);

    const db = fake.database()!;
    const query = `POST /accounts/${CH227}/d1/database/${db.uuid}/query`;
    expect(requests.map(line)).toEqual([
      `GET ${PROJECT_PATH}`,
      `GET /accounts/${CH227}/d1/database`,
      `POST /accounts/${CH227}/d1/database`,
      query, // is the bookkeeping table there?
      query, // create it
      query, // 0001_views.sql + its bookkeeping row
      `PATCH ${PROJECT_PATH}`,
      `GET ${PROJECT_PATH}`,
      'GET /zones',
      `GET /accounts/${CH227}/access/organizations`,
      `GET /accounts/${CH227}/access/policies`,
      `POST /accounts/${CH227}/access/policies`,
      `GET /accounts/${CH227}/access/apps`,
      `POST /accounts/${CH227}/access/apps`,
      `PATCH ${PROJECT_PATH}`,
      `GET ${PROJECT_PATH}`,
    ]);

    // The real migration ran, and was recorded the way wrangler records it.
    const columns = db.db.prepare('PRAGMA table_info(views)').all().map((c) => (c as { name: string }).name);
    expect(columns).toEqual([...VIEW_COLUMNS]);
    expect(db.db.prepare('SELECT name FROM d1_migrations').all().map((r) => ({ ...(r as object) }))).toEqual([{ name: '0001_views.sql' }]);

    // Access: one policy admitting exactly the given address, one application.
    expect(fake.policies.get(CH227)).toEqual([
      { id: expect.any(String), name: 'vva227 stats owners', decision: 'allow', include: [{ email: { email: EMAIL } }], session_duration: '24h' },
    ]);
    const [policy] = fake.policies.get(CH227)!;
    const [app] = fake.apps.get(CH227)!;
    expect(app).toEqual({
      id: expect.any(String),
      aud: expect.stringMatching(/^[0-9a-f]{64}$/),
      type: 'self_hosted',
      name: 'vva227 stats',
      domain: 'vva227.org/stats',
      destinations: [
        { type: 'public', uri: 'vva227.org/stats' },
        { type: 'public', uri: 'www.vva227.org/stats' },
        { type: 'public', uri: `${PAGES_SUBDOMAIN}/stats` },
        { type: 'public', uri: `*.${PAGES_SUBDOMAIN}/stats` },
      ],
      session_duration: '24h',
      app_launcher_visible: false,
      policies: [{ id: policy.id, precedence: 1 }],
    });

    expectProductionConfigured(fake, { aud: app.aud });
    expect(fake.project!.deployment_configs.preview).toEqual(freshProject().deployment_configs.preview);

    for (const said of [
      `created the D1 database vva227-beacon (${db.uuid})`,
      'applied migration 0001_views.sql',
      'BEACON bound to the vva227-beacon database',
      'BEACON_SALT created: a new random secret, encrypted',
      `created the Access policy "vva227 stats owners" admitting ${EMAIL}`,
      `created the Access application "vva227 stats" covering vva227.org/stats, www.vva227.org/stats, ${PAGES_SUBDOMAIN}/stats, *.${PAGES_SUBDOMAIN}/stats`,
      `set ACCESS_TEAM_DOMAIN (${TEAM_DOMAIN}) and ACCESS_AUD (${app.aud}), encrypted`,
      `Who can open /stats: ${EMAIL}`,
      'Nothing has been deployed',
      "BOTH the chapter volunteer's latest changes AND this analytics",
      'npm run deploy',
      'https://vva227.org/stats',
    ]) {
      expect(output).toContain(said);
    }
    // The salt is a secret: it is sent once and never printed.
    expect(output).not.toContain(SALT);
  });

  it('reports the production branch and compatibility date it found', async () => {
    const { output } = await run(cloudflare());
    expect(output).toContain('production branch: main');
    expect(output).toContain('production compatibility date: 2025-09-01');
    expect(output).not.toContain('WARNING');
  });

  it('warns loudly, and still finishes, when production is not the branch `npm run deploy` publishes to', async () => {
    const fake = cloudflare({ project: freshProject({ production_branch: 'production' }) });
    const { code, output } = await run(fake);
    expect(code).toBe(0);
    expect(output).toContain('WARNING: the project\'s production branch is "production", not "main".');
    expect(output).toContain('PREVIEWS');
  });

  it('makes a real random salt when none is given', async () => {
    const a = cloudflare();
    const b = cloudflare();
    await runSetupAgainst(a, ['--email', EMAIL]);
    await runSetupAgainst(b, ['--email', EMAIL]);
    const saltA = prod(a).env_vars!.BEACON_SALT.value;
    expect(saltA).toMatch(/^[0-9a-f]{64}$/);
    expect(prod(b).env_vars!.BEACON_SALT.value).toMatch(/^[0-9a-f]{64}$/);
    expect(prod(b).env_vars!.BEACON_SALT.value).not.toBe(saltA);
  });
});

describe('running it again', () => {
  it('changes nothing but the two Access settings, and keeps the salt', async () => {
    const fake = cloudflare();
    expect((await run(fake)).code).toBe(0);
    const aud = fake.apps.get(CH227)![0].aud;

    const again = await run(fake, ['--email', EMAIL], { randomHex: () => 'c3'.repeat(32) });
    expect(again.code, again.output).toBe(0);
    expect(again.writes.map(line)).toEqual([`PATCH ${PROJECT_PATH}`]);
    expect(again.writes[0].body).toEqual({
      deployment_configs: { production: { env_vars: { ACCESS_TEAM_DOMAIN: { type: 'secret_text', value: TEAM_DOMAIN }, ACCESS_AUD: { type: 'secret_text', value: aud } } } },
    });
    expect(fake.databases).toHaveLength(1);
    expect(fake.policies.get(CH227)).toHaveLength(1);
    expect(fake.apps.get(CH227)).toHaveLength(1);
    expectProductionConfigured(fake, { aud });
    expect(again.output).toContain('migrations already applied: 0001_views.sql');
    expect(again.output).toContain('BEACON is already bound to vva227-beacon.');
    expect(again.output).toContain('BEACON_SALT already exists, encrypted; it is kept as it is.');
    expect(again.output).toContain(`policy "vva227 stats owners" already admits exactly ${EMAIL}`);
    expect(again.output).toMatch(/What changed in this run:\n {2}- set ACCESS_TEAM_DOMAIN .*\n\nWho can open/);
  });

  it('finds its policy on a later page of a long list, rather than making a second one', async () => {
    const fake = cloudflare();
    // The fake pages two at a time; four unrelated policies push ours to page 3.
    fake.policies.set(CH227, ['a', 'b', 'c', 'd'].map((n) => ({ id: `p-${n}`, name: `someone else's ${n}`, decision: 'allow', include: [] })));
    await run(fake);
    const again = await run(fake);
    expect(again.requests.map((r) => r.query.page).filter(Boolean)).toEqual(['1', '2', '3']);
    expect(fake.policies.get(CH227)!.filter((p) => p.name === 'vva227 stats owners')).toHaveLength(1);
    expect(fake.policies.get(CH227)!.filter((p) => p.name.startsWith('someone else'))).toHaveLength(4);
  });

  it('with a different --email list, changes the policy to exactly that list and touches nothing else in Access', async () => {
    const fake = cloudflare();
    await run(fake);
    const appBefore = structuredClone(fake.apps.get(CH227));
    const again = await run(fake, ['--email', 'second@example.org', '--email', 'Third@Example.org']);
    expect(again.code).toBe(0);
    expect(again.writes.map(line)).toEqual([`PUT /accounts/${CH227}/access/policies/${fake.policies.get(CH227)![0].id}`, `PATCH ${PROJECT_PATH}`]);
    expect(fake.policies.get(CH227)![0].include).toEqual([{ email: { email: 'second@example.org' } }, { email: { email: 'third@example.org' } }]);
    expect(fake.apps.get(CH227)).toEqual(appBefore);
  });

  it('adds what is missing to an existing application without removing what the owner added', async () => {
    const fake = cloudflare();
    await run(fake);
    const app = fake.apps.get(CH227)![0];
    // The owner trimmed it to the apex, lengthened the session and added a policy of their own.
    fake.policies.get(CH227)!.push({ id: 'theirs', name: 'their policy', decision: 'allow', include: [{ email: { email: 'x@example.org' } }] });
    Object.assign(app, { destinations: [{ type: 'public', uri: 'vva227.org/stats' }, { type: 'public', uri: 'vva227.org/stats/extra' }], session_duration: '720h', policies: [{ id: 'theirs', precedence: 1 }] });

    const again = await run(fake);
    expect(again.code, again.output).toBe(0);
    const ours = fake.policies.get(CH227)!.find((p) => p.name === 'vva227 stats owners')!;
    expect(fake.apps.get(CH227)![0]).toMatchObject({
      session_duration: '720h',
      destinations: [
        { type: 'public', uri: 'vva227.org/stats' },
        { type: 'public', uri: 'vva227.org/stats/extra' },
        { type: 'public', uri: 'www.vva227.org/stats' },
        { type: 'public', uri: `${PAGES_SUBDOMAIN}/stats` },
        { type: 'public', uri: `*.${PAGES_SUBDOMAIN}/stats` },
      ],
      policies: [
        { id: 'theirs', precedence: 1 },
        { id: ours.id, precedence: 2 },
      ],
      aud: app.aud,
    });
  });
});

describe('refusing to touch the wrong project', () => {
  it('stops before any write when the project does not exist in the Ch 227 account', async () => {
    const fake = cloudflare({ project: null });
    const { code, output, requests } = await run(fake);
    expect(code).toBe(1);
    expect(requests.map(line)).toEqual([`GET ${PROJECT_PATH}`]);
    expect(output).toContain(`There is no Pages project named "vva227-refresh" in account ${CH227} ("Ch 227").`);
    expect(output).toContain('Nothing was changed.');
  });

  it('stops before any write when the project does not serve vva227.org', async () => {
    // The accident this guard exists for: a same-named copy in another place.
    const fake = cloudflare({ project: freshProject({ domains: [PAGES_SUBDOMAIN] }) });
    const { code, output, writes } = await run(fake);
    expect(code).toBe(1);
    expect(writes).toEqual([]);
    expect(output).toContain('does not serve vva227.org');
    expect(output).toContain(`its domains: ${PAGES_SUBDOMAIN}`);
  });

  it('names the permission and the account when the token is for somewhere else', async () => {
    const fake = cloudflare({ tokenAccounts: [OTHER_ACCOUNT] });
    const { code, output, writes } = await run(fake);
    expect(code).toBe(1);
    expect(writes).toEqual([]);
    expect(output).toContain(`Cloudflare refused GET ${PROJECT_PATH} (HTTP 403): 10000: Authentication error`);
    expect(output).toContain('It needs "Account › Cloudflare Pages › Edit".');
    expect(output).toContain(`The token must include the "Ch 227" account (${CH227}).`);
  });
});

describe('production settings', () => {
  it('never replaces an existing secret salt', async () => {
    const project = freshProject();
    project.deployment_configs.production.env_vars = { BEACON_SALT: { type: 'secret_text', value: 'the-original-salt' } };
    const fake = cloudflare({ project });
    const { code, requests } = await run(fake);
    expect(code).toBe(0);
    expect(prod(fake).env_vars!.BEACON_SALT).toEqual({ type: 'secret_text', value: 'the-original-salt' });
    expect(JSON.stringify(requests.map((r) => r.body))).not.toContain('BEACON_SALT');
  });

  it('leaves a plain-text salt alone, and says why', async () => {
    const project = freshProject();
    project.deployment_configs.production.env_vars = { BEACON_SALT: { type: 'plain_text', value: 'visible-salt' } };
    const fake = cloudflare({ project });
    const { code, output } = await run(fake);
    expect(code).toBe(0);
    expect(prod(fake).env_vars!.BEACON_SALT).toEqual({ type: 'plain_text', value: 'visible-salt' });
    expect(output).toContain('BEACON_SALT exists as a plain-text variable. It is left alone');
  });

  it('never touches preview, never sends an empty map, and keeps every setting it did not write', async () => {
    const project = freshProject();
    project.deployment_configs.production.env_vars = { SOMETHING_ELSE: { type: 'plain_text', value: 'kept' } };
    project.deployment_configs.production.d1_databases = { OTHER_DB: { id: 'other-db-id' } };
    const previewBefore = structuredClone(project.deployment_configs.preview);
    const fake = cloudflare({ project });

    expect((await run(fake)).code).toBe(0);
    await run(fake);

    for (const r of fake.requests.filter((x) => x.body !== undefined)) {
      expect(emptyMaps(r.body), line(r)).toEqual([]);
    }
    for (const r of fake.requests.filter((x) => x.method === 'PATCH')) {
      expect(Object.keys(r.body as object)).toEqual(['deployment_configs']);
      expect(Object.keys((r.body as { deployment_configs: object }).deployment_configs)).toEqual(['production']);
    }
    expect(fake.project!.deployment_configs.preview).toEqual(previewBefore);
    expect(prod(fake).env_vars!.SOMETHING_ELSE).toEqual({ type: 'plain_text', value: 'kept' });
    expect(prod(fake).d1_databases!.OTHER_DB).toEqual({ id: 'other-db-id' });
  });

  it('will not move a BEACON binding that points at another database', async () => {
    const project = freshProject();
    project.deployment_configs.production.d1_databases = { BEACON: { id: 'their-database' } };
    const fake = cloudflare({ project });
    const { code, output, writes } = await run(fake);
    expect(code).toBe(1);
    expect(prod(fake).d1_databases).toEqual({ BEACON: { id: 'their-database' } });
    expect(writes.filter((w) => w.method === 'PATCH')).toEqual([]);
    expect(output).toContain('BEACON is already bound to a different D1 database (their-database)');
  });

  it('stops, rather than reporting success, when a write does not read back', async () => {
    const fake = cloudflare();
    // Cloudflare says yes to the PATCH but the project reads back without it.
    fake.failNext({ method: 'PATCH', path: /pages\/projects/, status: 200, body: { success: true, errors: [], result: {} } });
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).toContain('Cloudflare accepted the change, but reading the project back shows: BEACON is not bound');
  });
});

describe('Zero Trust not turned on yet', () => {
  it('stops with the one-time dashboard instructions, and changes nothing after that point', async () => {
    const fake = cloudflare({ teams: {} });
    const { code, output, requests } = await run(fake);
    expect(code).toBe(1);
    expect(line(requests.at(-1)!)).toBe(`GET /accounts/${CH227}/access/organizations`);
    expect(fake.policies.get(CH227) ?? []).toEqual([]);
    expect(fake.apps.get(CH227) ?? []).toEqual([]);
    expect(prod(fake).env_vars!.ACCESS_AUD).toBeUndefined();
    for (const said of ['Cloudflare Zero Trust is not turned on', 'team name', 'Free plan', 'card details', 'does not charge', 'run this command again', 'Nothing after this point was changed.']) {
      expect(output).toContain(said);
    }
    // What came before the stop is done, said so, and kept.
    expect(output).toContain('Already done in this run, and kept:');
    expect(prod(fake).d1_databases!.BEACON.id).toBe(fake.database()!.uuid);
  });

  it('finishes on the next run, without redoing what the first one did', async () => {
    const fake = cloudflare({ teams: {} });
    await run(fake);
    fake.teams[CH227] = TEAM_DOMAIN;
    const again = await run(fake);
    expect(again.code, again.output).toBe(0);
    expect(again.writes.map(line)).toEqual([`POST /accounts/${CH227}/access/policies`, `POST /accounts/${CH227}/access/apps`, `PATCH ${PROJECT_PATH}`]);
    expectProductionConfigured(fake, { aud: fake.apps.get(CH227)![0].aud });
  });
});

describe('vva227.org in a different Cloudflare account', () => {
  it('sets up Access in the zone\'s account, without the pages.dev address, and says why', async () => {
    const fake = cloudflare({ zoneAccount: OTHER_ACCOUNT, tokenAccounts: [CH227, OTHER_ACCOUNT], teams: { [OTHER_ACCOUNT]: 'other-team.cloudflareaccess.com' } });
    const { code, output } = await run(fake);
    expect(code, output).toBe(0);
    expect(fake.apps.get(CH227) ?? []).toEqual([]);
    const [app] = fake.apps.get(OTHER_ACCOUNT)!;
    expect(app.destinations).toEqual([
      { type: 'public', uri: 'vva227.org/stats' },
      { type: 'public', uri: 'www.vva227.org/stats' },
    ]);
    expectProductionConfigured(fake, { aud: app.aud, team: 'other-team.cloudflareaccess.com' });
    expect(output).toContain(`vva227.org is in a different Cloudflare account (${OTHER_ACCOUNT})`);
    expect(output).toContain('the pages.dev address is not covered');
    expect(output).toContain('use https://vva227.org/stats');
  });

  it('is accepted by Access only because the pages.dev address was left out', async () => {
    // The tier-justification case: the fake enforces Access's own rule, so an
    // application body naming the pages.dev host in the zone's account fails
    // here even though every unit test of the body would pass.
    const fake = cloudflare({ zoneAccount: OTHER_ACCOUNT, tokenAccounts: [CH227, OTHER_ACCOUNT], teams: { [OTHER_ACCOUNT]: TEAM_DOMAIN } });
    const res = await fake.fetch(`https://api.cloudflare.com/client/v4/accounts/${OTHER_ACCOUNT}/access/apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fake.token}` },
      body: JSON.stringify({ name: 'x', destinations: [{ type: 'public', uri: `${PAGES_SUBDOMAIN}/stats` }], policies: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('says the token must cover both accounts when the second one refuses it', async () => {
    const fake = cloudflare({ zoneAccount: OTHER_ACCOUNT, tokenAccounts: [CH227], zoneVisible: true });
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).toContain(`Cloudflare refused GET /accounts/${OTHER_ACCOUNT}/access/organizations (HTTP 403)`);
    expect(output).toContain(`This call is in account ${OTHER_ACCOUNT}, which owns vva227.org but is not the "Ch 227" account`);
    expect(output).toContain('The token must include BOTH accounts');
  });

  it('says what to grant when the token cannot see the zone at all', async () => {
    const fake = cloudflare({ zoneAccount: OTHER_ACCOUNT, tokenAccounts: [CH227] });
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).toContain('The token cannot see the vva227.org zone');
    expect(output).toContain('the token must include that account too');
  });

  it('names the zone\'s account when Zero Trust is missing there', async () => {
    const fake = cloudflare({ zoneAccount: OTHER_ACCOUNT, tokenAccounts: [CH227, OTHER_ACCOUNT], teams: { [CH227]: TEAM_DOMAIN } });
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).toContain(`Cloudflare Zero Trust is not turned on for account ${OTHER_ACCOUNT} (the account that owns vva227.org).`);
  });
});

describe('--dry-run', () => {
  it('on a fresh account, only reads, changes nothing, and lists what a real run would do', async () => {
    const fake = cloudflare();
    const before = structuredClone(fake.project);
    const { code, output, requests } = await run(fake, ['--email', EMAIL, '--dry-run']);
    expect(code, output).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(fake.project).toEqual(before);
    expect(fake.databases).toEqual([]);
    expect(output.startsWith('DRY RUN: looking only.')).toBe(true);
    for (const said of [
      'create the D1 database vva227-beacon',
      'apply whichever of 0001_views.sql the database has not recorded',
      'BEACON bound to the vva227-beacon database',
      'BEACON_SALT created',
      `create the Access policy "vva227 stats owners" admitting ${EMAIL}`,
      'create the Access application "vva227 stats" covering vva227.org/stats',
      `set ACCESS_TEAM_DOMAIN to ${TEAM_DOMAIN}`,
      'DRY RUN. Nothing was changed.',
      'Run the same command without --dry-run',
    ]) {
      expect(output).toContain(said);
    }
    expect(output).not.toContain('npm run deploy');
  });

  it('on a configured account, finds nothing to do but the settings refresh', async () => {
    const fake = cloudflare();
    await run(fake);
    const { code, output, requests } = await run(fake, ['--email', EMAIL, '--dry-run']);
    expect(code).toBe(0);
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
    expect(output).toMatch(/A real run would:\n {2}- apply whichever of 0001_views\.sql .*\n {2}- set ACCESS_TEAM_DOMAIN .*\n\nRun the same/);
  });
});

describe('arguments and the token', () => {
  it.each([
    ['no --email at all', []],
    ['only --dry-run', ['--dry-run']],
    ['--email with nothing after it', ['--email']],
    ['an address that is not one', ['--email', 'not-an-address']],
    ['an unknown option', ['--email', EMAIL, '--force']],
  ])('refuses %s with the usage, before any request', async (_label, argv) => {
    const fake = cloudflare();
    const { code, output, requests } = await run(fake, argv);
    expect(code).toBe(2);
    expect(requests).toEqual([]);
    expect(output).toContain('Usage: npm run setup:analytics -- --email you@example.com');
  });

  it('reads the token from .cf-api-token, without its trailing newline', async () => {
    const fake = cloudflare();
    const dir = mkdtempSync(join(tmpdir(), 'vva227-token-'));
    dirs.push(dir);
    const tokenFile = join(dir, '.cf-api-token');
    // Private, as docs/analytics.md step 3 has the owner make it.
    writeFileSync(tokenFile, `${fake.token}\n`);
    chmodSync(tokenFile, 0o600);
    const { code, requests } = await run(fake, ['--email', EMAIL], { env: {}, tokenFile });
    expect(code).toBe(0);
    expect(new Set(requests.map((r) => r.authorization))).toEqual(new Set([`Bearer ${fake.token}`]));
  });

  it('prefers CF_API_TOKEN to the file', async () => {
    const fake = cloudflare();
    const dir = mkdtempSync(join(tmpdir(), 'vva227-token-'));
    dirs.push(dir);
    const tokenFile = join(dir, '.cf-api-token');
    writeFileSync(tokenFile, 'a-stale-token\n');
    const { code } = await run(fake, ['--email', EMAIL], { env: { CF_API_TOKEN: ` ${fake.token} ` }, tokenFile });
    expect(code).toBe(0);
  });

  it('with no token anywhere, says how to make one, before any request', async () => {
    const fake = cloudflare();
    const { code, output, requests } = await run(fake, ['--email', EMAIL], { env: {} });
    expect(code).toBe(1);
    expect(requests).toEqual([]);
    for (const permission of [
      'Account › Cloudflare Pages › Edit',
      'Account › D1 › Edit',
      'Account › Access: Apps and Policies › Edit',
      'Account › Access: Organizations, Identity Providers, and Groups › Read',
      'Zone › Zone › Read',
    ]) {
      expect(output).toContain(permission);
    }
  });
});

describe('the command the owner runs', () => {
  // Every other test here imports runSetup. This runs tools/setup-analytics.mjs
  // itself, in its own Node process, the way `npm run setup:analytics` does: a
  // wrong import path, or arguments or environment not handed through, fails
  // here and nowhere else. fetch is replaced before the script loads by one
  // that notes the attempt on stderr and fails, so nothing reaches the network.
  const ENTRY = join('tools', 'setup-analytics.mjs');
  const ATTEMPT = 'NETWORK ATTEMPT';

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'vva227-entry-'));
    dirs.push(dir);
    return dir;
  }

  function entry(cwd: string, args: string[], env: Record<string, string> = {}) {
    const stub = join(scratch(), 'no-network.mjs');
    writeFileSync(stub, `globalThis.fetch = async (url) => { process.stderr.write('${ATTEMPT} ' + url + '\\n'); throw new TypeError('fetch failed'); };\n`);
    return spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, ENTRY, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  /** tools/ copied into an empty directory, so no real .cf-api-token at the top of this repo can be read. */
  function isolatedCopy(): string {
    const dir = scratch();
    cpSync(join(process.cwd(), 'tools'), join(dir, 'tools'), { recursive: true });
    return dir;
  }

  it('prints the usage for --help and exits 0', () => {
    const res = entry(process.cwd(), ['--help']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.startsWith(USAGE)).toBe(true);
    expect(res.stderr).not.toContain(ATTEMPT);
  });

  it('refuses an address that is not one with exit 2 and the usage', () => {
    const res = entry(process.cwd(), ['--email', 'bad']);
    expect(res.status, res.stderr).toBe(2);
    expect(res.stdout).toContain('"bad" is not an email address.');
    expect(res.stdout).toContain(USAGE);
    expect(res.stderr).not.toContain(ATTEMPT);
  });

  it('with no token anywhere, says how to make one, exits 1 and makes no network call', () => {
    const res = entry(isolatedCopy(), ['--email', 'a@b.example', '--dry-run']);
    expect(res.status, res.stderr).toBe(1);
    expect(res.stdout).toContain('No Cloudflare API token found.');
    expect(res.stderr).not.toContain(ATTEMPT);
  });

  it('hands CF_API_TOKEN through: with one set, it goes on to ask Cloudflare for the project', () => {
    const token = 'entry-test-token-0123456789';
    const res = entry(isolatedCopy(), ['--email', 'a@b.example', '--dry-run'], { CF_API_TOKEN: token });
    expect(res.status, res.stderr).toBe(1);
    expect(res.stderr).toContain(`${ATTEMPT} https://api.cloudflare.com/client/v4${PROJECT_PATH}`);
    expect(res.stdout).toContain('Cloudflare could not be reached');
    expect(res.stdout + res.stderr).not.toContain(token);
  });
});

describe('when Cloudflare says no', () => {
  it('surfaces the method, path, status, code and message, and lists what was already done', async () => {
    const fake = cloudflare();
    fake.failNext({ method: 'POST', path: /access\/policies$/, status: 400, body: { success: false, errors: [{ code: 12130, message: 'access.api.error.invalid_request: include is invalid' }] } });
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).toContain(`Cloudflare refused POST /accounts/${CH227}/access/policies (HTTP 400): 12130: access.api.error.invalid_request: include is invalid`);
    expect(output).toContain('Already done in this run, and kept:');
    expect(output).toContain('applied migration 0001_views.sql');
    expect(output).not.toContain('NEXT STEP');
  });

  it('reports a response that is not JSON by its status and its text', async () => {
    const fake = cloudflare();
    fake.failNext({ method: 'GET', path: /pages\/projects/, status: 502, text: '<html><body><h1>502 Bad Gateway</h1></body></html>' });
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).toContain('(HTTP 502): the response was not JSON: 502 Bad Gateway');
  });

  it('reports an unreachable API as a connection problem', async () => {
    const lines: string[] = [];
    const code = await runSetup({
      argv: ['--email', EMAIL],
      env: { CF_API_TOKEN: 'tok' },
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
      print: (l: string) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Stopped: fetch failed');
    expect(lines.join('\n')).toContain('Cloudflare could not be reached');
  });
});
