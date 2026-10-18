import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, copyFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSetup } from '../../tools/lib/setup-analytics.mjs';
import { loginMethodWarning, nextSteps, projectNotFoundMessage, RUNTIME_DATE_NOTE, USAGE, zeroTrustInstructions } from '../../tools/lib/setup-analytics-plan.mjs';
import { VIEW_COLUMNS } from '../helpers/analytics';
import { NO_TOKEN_FILE, runSetupAgainst, type SetupRunOptions } from '../helpers/setup-run';
import {
  CH227,
  emptyMaps,
  FakeCloudflare,
  freshProject,
  OTHER_ACCOUNT,
  OTHER_ACCOUNT_NAME,
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

/** What a stop says when sign-ins it owed an end were left open. */
const NOT_ENDED = 'Sign-ins already open to /stats were NOT ended';

/** A migrations directory holding the repo's migration, for a test to add to. */
function migrationsCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vva227-migrations-'));
  dirs.push(dir);
  copyFileSync(join(process.cwd(), 'migrations', '0001_views.sql'), join(dir, '0001_views.sql'));
  return dir;
}

/** A second migration, so a list of them has two entries. */
const addMigration = (dir: string) => writeFileSync(join(dir, '0002_extra.sql'), 'CREATE INDEX IF NOT EXISTS views_ts ON views(ts);\n');
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
      `GET /accounts/${CH227}/access/identity_providers`, // read only: is One-time PIN on?
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
      'bound BEACON to the vva227-beacon database',
      'created BEACON_SALT, a new random secret, encrypted',
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
    expect(again.output).toContain('application "vva227 stats" already covers vva227.org/stats');
    expect(again.output).toContain('with "vva227 stats owners" as its only policy');
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

  it('with a different --email list, changes the policy to exactly that list, ends the sign-ins of whoever it left out, and changes nothing else in Access', async () => {
    const fake = cloudflare();
    await run(fake);
    const appBefore = structuredClone(fake.apps.get(CH227));
    const again = await run(fake, ['--email', 'second@example.org', '--email', 'Third@Example.org']);
    expect(again.code).toBe(0);
    expect(again.writes.map(line)).toEqual([
      `PUT /accounts/${CH227}/access/policies/${fake.policies.get(CH227)![0].id}`,
      `POST /accounts/${CH227}/access/apps/${appBefore![0].id}/revoke_tokens`,
      `PATCH ${PROJECT_PATH}`,
    ]);
    expect(fake.policies.get(CH227)![0].include).toEqual([{ email: { email: 'second@example.org' } }, { email: { email: 'third@example.org' } }]);
    expect(fake.apps.get(CH227)).toEqual(appBefore);
  });

  it('keeps every setting the owner made on the application and the policy, when a rerun has to update both', async () => {
    const fake = cloudflare();
    await run(fake);
    const app = fake.apps.get(CH227)![0];
    const policy = fake.policies.get(CH227)![0];
    // Hardening an owner can turn on in the dashboard. Access replaces an
    // application or policy whole on update, so anything an update leaves out is lost.
    const appSettings = {
      enable_binding_cookie: true,
      same_site_cookie_attribute: 'strict',
      http_only_cookie_attribute: true,
      custom_deny_url: 'https://vva227.org/denied',
      cors_headers: { allowed_methods: ['GET'] },
      skip_interstitial: true,
    };
    const policySettings = {
      session_duration: '1h',
      approval_required: true,
      approval_groups: [{ approvals_needed: 1, email_addresses: ['boss@example.org'] }],
      purpose_justification_required: true,
      mfa_config: { allowed_authenticators: ['totp'] },
    };
    // ...and what Cloudflare keeps itself and returns on every GET.
    Object.assign(app, appSettings, { created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', self_hosted_domains: ['vva227.org/stats'] });
    app.destinations = app.destinations.slice(0, 1);
    Object.assign(policy, policySettings, { created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z', reusable: true, app_count: 1 });

    const again = await run(fake, ['--email', EMAIL, '--email', 'second@example.org']);
    expect(again.code, again.output).toBe(0);
    const puts = again.writes.filter((w) => w.method === 'PUT');
    expect(puts.map(line)).toEqual([`PUT /accounts/${CH227}/access/policies/${policy.id}`, `PUT /accounts/${CH227}/access/apps/${app.id}`]);
    expect(fake.policies.get(CH227)![0]).toMatchObject({ ...policySettings, include: [{ email: { email: EMAIL } }, { email: { email: 'second@example.org' } }] });
    expect(fake.apps.get(CH227)![0]).toMatchObject({ ...appSettings, destinations: expect.arrayContaining([{ type: 'public', uri: 'www.vva227.org/stats' }]) });
    for (const put of puts) {
      for (const key of ['id', 'aud', 'created_at', 'updated_at', 'self_hosted_domains', 'reusable', 'app_count']) expect(put.body, `${line(put)} sent ${key}`).not.toHaveProperty(key);
    }
  });

  it('adds what is missing to an existing application, keeps the owner\'s own settings, and takes off any other policy', async () => {
    const fake = cloudflare();
    await run(fake);
    const app = fake.apps.get(CH227)![0];
    // The owner trimmed it to the apex, lengthened the session and put a policy of their own in place of ours.
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
      // Rule A13: the script's policy alone decides who opens /stats.
      policies: [{ id: ours.id, precedence: 1 }],
      aud: app.aud,
    });
    expect(again.output).toContain('removed the policy "their policy" (decision: allow) from the Access application "vva227 stats"');
    // Taken off this application only; the policy itself stays in the account.
    expect(fake.policies.get(CH227)!.some((p) => p.id === 'theirs')).toBe(true);
    expect(again.output).toContain(`Who can open /stats: ${EMAIL}`);
    expect(fake.admits(CH227)).toEqual([EMAIL]);
  });
});

describe('what it says about who can open /stats', () => {
  // The last thing the owner reads, held against what Access then does:
  // fake.admits reads every policy on the application the way Access would.
  const said = (output: string) => /^Who can open \/stats: (.*)$/m.exec(output)?.[1].split(', ').sort() ?? null;
  const SECOND = 'second@example.org';
  const other = { zoneAccount: OTHER_ACCOUNT, tokenAccounts: [CH227, OTHER_ACCOUNT], teams: { [OTHER_ACCOUNT]: TEAM_DOMAIN } };

  // The last column: does this run take access away from anyone? Access
  // checks a changed policy only at the next sign-in, so then the sign-ins
  // already open must be ended, after the change, or the line is not yet true.
  it.each<[string, FakeOptions, (fake: FakeCloudflare, account: string) => Promise<unknown>, string[], boolean]>([
    ['a fresh account', {}, async () => {}, [EMAIL], false],
    ['a rerun with the same list', {}, (fake) => run(fake), [EMAIL], false],
    ['a rerun with a longer list', {}, (fake) => run(fake), [EMAIL, SECOND], false],
    ['a rerun with a shorter list', {}, (fake) => run(fake, ['--email', EMAIL, '--email', SECOND]), [EMAIL], true],
    ['a rerun with a different list of the same length', {}, (fake) => run(fake, ['--email', SECOND]), [EMAIL], true],
    [
      'a rerun after someone attached another policy to the application',
      {},
      async (fake, account) => {
        await run(fake);
        fake.policies.get(account)!.push({ id: 'wide', name: 'Allow everyone', decision: 'allow', include: [{ everyone: {} }] });
        fake.apps.get(account)![0].policies.push({ id: 'wide', precedence: 2 });
      },
      [EMAIL],
      true,
    ],
    [
      'a rerun after someone widened its policy to a whole domain',
      {},
      async (fake, account) => {
        await run(fake);
        fake.policies.get(account)![0].include = [{ email_domain: { domain: 'example.org' } }];
      },
      [EMAIL],
      true,
    ],
    ['vva227.org in another account', other, async () => {}, [EMAIL], false],
    ['a rerun with a shorter list, vva227.org in another account', other, (fake) => run(fake, ['--email', EMAIL, '--email', SECOND]), [EMAIL], true],
  ])('is true after %s', async (_label, options, before, emails, endsSignIns) => {
    const fake = cloudflare(options);
    const account = fake.zoneAccount;
    await before(fake, account);
    const { code, output, requests } = await run(fake, emails.flatMap((e) => ['--email', e]));
    expect(code, output).toBe(0);
    expect(fake.admits(account)).toEqual([...emails].sort());
    expect(said(output)).toEqual(fake.admits(account));

    const revokes = requests.filter((r) => r.path.endsWith('/revoke_tokens'));
    if (!endsSignIns) {
      expect(revokes).toEqual([]);
      return;
    }
    const app = fake.apps.get(account)![0];
    expect(revokes.map(line)).toEqual([`POST /accounts/${account}/access/apps/${app.id}/revoke_tokens`]);
    const lastPut = requests.map((r) => r.method).lastIndexOf('PUT');
    expect(lastPut).toBeGreaterThanOrEqual(0);
    expect(requests.indexOf(revokes[0])).toBeGreaterThan(lastPut);
    expect(output).toContain('ended every existing sign-in to /stats');
  });

  it('can actually fail: a second policy on the application shows in what Access admits', async () => {
    const fake = cloudflare();
    await run(fake);
    fake.policies.get(CH227)!.push({ id: 'wide', name: 'Allow everyone', decision: 'allow', include: [{ everyone: {} }] });
    fake.apps.get(CH227)![0].policies.push({ id: 'wide', precedence: 2 });
    expect(fake.admits(CH227)).toEqual([JSON.stringify({ everyone: {} }), EMAIL].sort());
  });

  it('says the list is narrowed further when the policy keeps require or exclude rules from the dashboard', async () => {
    const fake = cloudflare();
    await run(fake, ['--email', EMAIL, '--email', SECOND]);
    fake.policies.get(CH227)![0].exclude = [{ email: { email: SECOND } }];
    const { code, output } = await run(fake, ['--email', EMAIL, '--email', SECOND, '--email', 'third@example.org']);
    expect(code, output).toBe(0);
    expect(fake.policies.get(CH227)![0].exclude).toEqual([{ email: { email: SECOND } }]);
    expect(output).toMatch(/^Who can open \/stats: .*\n\(.*the policy's exclude rules/m);
  });
});

describe('ending sign-ins when someone is taken off the list', () => {
  const SECOND = 'second@example.org';

  it('ends them after the policy changes, and says so, when a rerun leaves an address out', async () => {
    const fake = cloudflare();
    await run(fake, ['--email', EMAIL, '--email', SECOND]);
    const { code, output, writes } = await run(fake, ['--email', EMAIL]);
    expect(code, output).toBe(0);
    const policy = fake.policies.get(CH227)![0];
    const app = fake.apps.get(CH227)![0];
    expect(writes.map(line)).toEqual([
      `PUT /accounts/${CH227}/access/policies/${policy.id}`,
      `POST /accounts/${CH227}/access/apps/${app.id}/revoke_tokens`,
      `PATCH ${PROJECT_PATH}`,
    ]);
    expect(writes[1].body).toBeUndefined();
    expect(output).toContain('ended every existing sign-in to /stats, because this run took access away from someone');
    expect(output).toContain('the people still on the list sign in again');
  });

  it('ends none when a rerun only adds someone', async () => {
    const fake = cloudflare();
    await run(fake);
    const { code, writes, output } = await run(fake, ['--email', EMAIL, '--email', SECOND]);
    expect(code).toBe(0);
    expect(writes.filter((w) => w.path.endsWith('/revoke_tokens'))).toEqual([]);
    expect(output).not.toContain('sign-in to /stats');
  });

  it('in a dry run, says it would end them, and sends only GETs', async () => {
    const fake = cloudflare();
    await run(fake, ['--email', EMAIL, '--email', SECOND]);
    const { code, output, requests } = await run(fake, ['--email', EMAIL, '--dry-run']);
    expect(code, output).toBe(0);
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(output).toContain('   would end existing sign-ins to /stats');
    expect(output).toContain('  - end every existing sign-in to /stats');
  });

  it('when vva227.org is in another account, says a copied sign-in still works at the pages.dev address until it runs out', async () => {
    const fake = cloudflare({ zoneAccount: OTHER_ACCOUNT, tokenAccounts: [CH227, OTHER_ACCOUNT], teams: { [OTHER_ACCOUNT]: TEAM_DOMAIN } });
    await run(fake, ['--email', EMAIL, '--email', SECOND]);
    const { code, output } = await run(fake, ['--email', EMAIL]);
    expect(code, output).toBe(0);
    expect(output).toMatch(/^Who can open \/stats: owner@example\.org\n.*pages\.dev address.*\n?.*24h/m);
  });

  it('stops, keeping the policy change, if Cloudflare refuses to end them', async () => {
    const fake = cloudflare();
    await run(fake, ['--email', EMAIL, '--email', SECOND]);
    fake.failNext({ method: 'POST', path: /revoke_tokens$/, status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } });
    const { code, output } = await run(fake, ['--email', EMAIL]);
    expect(code).toBe(1);
    expect(output).toContain('/revoke_tokens (HTTP 403)');
    expect(output).toContain('It needs "Account › Access: Apps and Policies › Edit".');
    expect(output).toMatch(/Already done in this run, and kept:\n {2}- changed the Access policy "vva227 stats owners" to admit exactly owner@example\.org/);
    expect(output).not.toContain('Who can open /stats');
    expect(fake.policies.get(CH227)![0].include).toEqual([{ email: { email: EMAIL } }]);
  });

  // A stop between taking access away and ending the open sign-ins leaves
  // nothing a rerun can see: the policy already matches, so a plain rerun
  // changes nothing and ends nothing. The stopped run has to say so, and
  // --end-sign-ins is how the owner finishes it.
  const revokes = (writes: RecordedRequest[]) => writes.filter((w) => w.method === 'POST' && w.path.endsWith('/revoke_tokens'));

  it('says the open sign-ins were not ended, and how to end them, when ending them fails after the policy change', async () => {
    const fake = cloudflare();
    await run(fake, ['--email', EMAIL, '--email', SECOND]);
    fake.failNext({ method: 'POST', path: /revoke_tokens$/, status: 503, body: { success: false, errors: [{ code: 7010, message: 'service unavailable' }] } });
    const stopped = await run(fake, ['--email', EMAIL]);
    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain(NOT_ENDED);
    expect(stopped.output).toContain('--end-sign-ins');
    expect(stopped.output).toContain('application "vva227 stats" in the Zero Trust dashboard');
    expect(stopped.output).not.toContain('Who can open /stats');

    // What the message warns of: the rerun it would otherwise ask for ends nothing.
    const plain = await run(fake, ['--email', EMAIL]);
    expect(plain.code, plain.output).toBe(0);
    expect(revokes(plain.writes)).toEqual([]);

    const finished = await run(fake, ['--email', EMAIL, '--end-sign-ins']);
    expect(finished.code, finished.output).toBe(0);
    expect(revokes(finished.writes).map(line)).toEqual([`POST /accounts/${CH227}/access/apps/${fake.apps.get(CH227)![0].id}/revoke_tokens`]);
    expect(finished.output).toContain('ended every existing sign-in to /stats, as --end-sign-ins asked');
    expect(finished.output).toContain(`Who can open /stats: ${EMAIL}`);
  });

  it('says the same when the stop comes after the policy change and before the application is updated', async () => {
    const fake = cloudflare();
    await run(fake, ['--email', EMAIL, '--email', SECOND]);
    // The application needs an update too: someone trimmed its destinations.
    fake.apps.get(CH227)![0].destinations = [{ type: 'public', uri: 'vva227.org/stats' }];
    fake.failNext({ method: 'PUT', path: /access\/apps\/[^/]+$/, status: 500, body: { success: false, errors: [{ code: 12000, message: 'internal error' }] } });
    const stopped = await run(fake, ['--email', EMAIL]);
    expect(stopped.code).toBe(1);
    expect(fake.policies.get(CH227)![0].include).toEqual([{ email: { email: EMAIL } }]);
    expect(stopped.output).toContain(NOT_ENDED);

    const finished = await run(fake, ['--email', EMAIL, '--end-sign-ins']);
    expect(finished.code, finished.output).toBe(0);
    const app = fake.apps.get(CH227)![0];
    expect(finished.writes.map(line)).toEqual([
      `PUT /accounts/${CH227}/access/apps/${app.id}`,
      `POST /accounts/${CH227}/access/apps/${app.id}/revoke_tokens`,
      `PATCH ${PROJECT_PATH}`,
    ]);
  });

  it('says the same when it took another policy off the application and Cloudflare could then not be reached', async () => {
    const fake = cloudflare();
    await run(fake);
    fake.policies.get(CH227)!.push({ id: 'theirs', name: 'their policy', decision: 'allow', include: [{ everyone: {} }] });
    fake.apps.get(CH227)![0].policies.push({ id: 'theirs', precedence: 2 });
    const failing = ((input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('/revoke_tokens') ? Promise.reject(new TypeError('fetch failed')) : fake.fetch(input, init)) as typeof fetch;
    const lines: string[] = [];
    const code = await runSetup({ argv: ['--email', EMAIL], env: { CF_API_TOKEN: fake.token }, fetchImpl: failing, print: (l: string) => lines.push(l), randomHex: () => SALT });
    const output = lines.join('\n');
    expect(code).toBe(1);
    expect(output).toContain('Cloudflare could not be reached');
    expect(fake.admits(CH227)).toEqual([EMAIL]);
    expect(output).toContain(NOT_ENDED);
  });

  it('says nothing about sign-ins when it stops before taking anyone\'s access away', async () => {
    const fake = cloudflare();
    await run(fake, ['--email', EMAIL, '--email', SECOND]);
    fake.failNext({ method: 'PUT', path: /access\/policies\//, status: 500, body: { success: false, errors: [{ code: 12000, message: 'internal error' }] } });
    const stopped = await run(fake, ['--email', EMAIL]);
    expect(stopped.code).toBe(1);
    expect(stopped.output).not.toContain(NOT_ENDED);
    expect(fake.admits(CH227)).toEqual([EMAIL, SECOND].sort());
  });

  it('with --end-sign-ins, ends them even when nothing else changes, and a dry run only says it would', async () => {
    const fake = cloudflare();
    await run(fake);
    const looked = await run(fake, ['--email', EMAIL, '--end-sign-ins', '--dry-run']);
    expect(looked.code, looked.output).toBe(0);
    expect(looked.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(looked.output).toContain('   would end existing sign-ins to /stats, as --end-sign-ins asks');
    const { code, writes, output } = await run(fake, ['--email', EMAIL, '--end-sign-ins']);
    expect(code, output).toBe(0);
    expect(writes.map(line)).toEqual([`POST /accounts/${CH227}/access/apps/${fake.apps.get(CH227)![0].id}/revoke_tokens`, `PATCH ${PROJECT_PATH}`]);
  });

  it('with --end-sign-ins on a fresh account, has nothing to end and ends nothing', async () => {
    const fake = cloudflare();
    const { code, writes, output } = await run(fake, ['--email', EMAIL, '--end-sign-ins']);
    expect(code, output).toBe(0);
    expect(revokes(writes)).toEqual([]);
    expect(output).not.toContain('sign-in to /stats');
  });

  it('with --end-sign-ins, still says the open sign-ins were not ended if ending them fails', async () => {
    const fake = cloudflare();
    await run(fake);
    fake.failNext({ method: 'POST', path: /revoke_tokens$/, status: 503, body: { success: false, errors: [{ code: 7010, message: 'service unavailable' }] } });
    const { code, output } = await run(fake, ['--email', EMAIL, '--end-sign-ins']);
    expect(code).toBe(1);
    expect(output).toContain(NOT_ENDED);
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
    expect(output).toContain(`vva227.org is in a different Cloudflare account, "${OTHER_ACCOUNT_NAME}" (${OTHER_ACCOUNT}); Access is set up there`);
    expect(output).toContain(`created the Access policy "vva227 stats owners" in the account "${OTHER_ACCOUNT_NAME}" (${OTHER_ACCOUNT}) admitting ${EMAIL}`);
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
    expect(output).toContain(`This call is in account "${OTHER_ACCOUNT_NAME}" (${OTHER_ACCOUNT}), which owns vva227.org but is not the "Ch 227" account`);
    expect(output).toContain('The token must include BOTH accounts');
  });

  it('says what to grant when the token cannot see the zone at all', async () => {
    const fake = cloudflare({ zoneAccount: OTHER_ACCOUNT, tokenAccounts: [CH227] });
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).toContain('The token cannot see the vva227.org zone');
    expect(output).toContain('the token must include that account too');
    // The case the owner cannot fix with the token form alone.
    expect(output).toContain('If you cannot select vva227.org in the token form');
  });

  it('names the zone\'s account when Zero Trust is missing there', async () => {
    const fake = cloudflare({ zoneAccount: OTHER_ACCOUNT, tokenAccounts: [CH227, OTHER_ACCOUNT], teams: { [CH227]: TEAM_DOMAIN } });
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).toContain(`Cloudflare Zero Trust is not turned on for the account "${OTHER_ACCOUNT_NAME}" (${OTHER_ACCOUNT}), which owns vva227.org.`);
  });

  it('names that account, by name and id, in what a dry run says it would do there', async () => {
    const fake = cloudflare({ zoneAccount: OTHER_ACCOUNT, tokenAccounts: [CH227, OTHER_ACCOUNT], teams: { [OTHER_ACCOUNT]: TEAM_DOMAIN } });
    const { code, output, requests } = await run(fake, ['--email', EMAIL, '--dry-run']);
    expect(code, output).toBe(0);
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
    const there = `in the account "${OTHER_ACCOUNT_NAME}" (${OTHER_ACCOUNT})`;
    expect(output).toContain(`vva227.org is in a different Cloudflare account, "${OTHER_ACCOUNT_NAME}" (${OTHER_ACCOUNT}); Access is set up there`);
    expect(output).toContain(`  - create the Access policy "vva227 stats owners" ${there} admitting ${EMAIL}`);
    expect(output).toContain(`  - create the Access application "vva227 stats" ${there} covering vva227.org/stats, www.vva227.org/stats`);
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
      'bind BEACON to the vva227-beacon database',
      'create BEACON_SALT',
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

  it('on an application carrying another policy, says it would remove it, and changes nothing', async () => {
    const fake = cloudflare();
    await run(fake);
    fake.policies.get(CH227)!.push({ id: 'wide', name: 'Allow everyone', decision: 'allow', include: [{ everyone: {} }] });
    fake.apps.get(CH227)![0].policies.push({ id: 'wide', precedence: 2 });
    const before = structuredClone(fake.apps.get(CH227));
    const { code, output, requests } = await run(fake, ['--email', EMAIL, '--dry-run']);
    expect(code, output).toBe(0);
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(fake.apps.get(CH227)).toEqual(before);
    expect(output).toContain('   would remove the policy "Allow everyone" (decision: allow) from the application');
    expect(output).toContain('  - remove the policy "Allow everyone" (decision: allow) from the Access application "vva227 stats"');
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

describe('the login methods the team offers', () => {
  // Without One-time PIN, the people on the list cannot sign in with their
  // address, and Access answers "That account does not have access": what
  // the owner met on 2026-10-18, with only a method of type 'cloudflare' on.
  // The script cannot turn it on (the token only reads login methods), and
  // another method might still sign the listed people in, so it warns and
  // carries on.
  const ONLY_CLOUDFLARE = [{ id: '7ba3f272', name: '', type: 'cloudflare' }];
  const WARNING = loginMethodWarning(ONLY_CLOUDFLARE)!;
  const indented = (text: string) => text.split('\n').map((l) => `   ${l}`).join('\n');

  it('reads them in the account that owns vva227.org, once its team is known', async () => {
    const fake = cloudflare();
    const { code, requests } = await run(fake);
    expect(code).toBe(0);
    const lines = requests.map(line);
    const at = lines.indexOf(`GET /accounts/${CH227}/access/identity_providers`);
    expect(at).toBeGreaterThan(lines.indexOf(`GET /accounts/${CH227}/access/organizations`));
  });

  it('reads them in the other account when vva227.org lives there', async () => {
    const fake = cloudflare({ zoneAccount: OTHER_ACCOUNT, tokenAccounts: [CH227, OTHER_ACCOUNT], teams: { [OTHER_ACCOUNT]: 'other-team.cloudflareaccess.com' }, loginMethods: ONLY_CLOUDFLARE });
    const { code, output, requests } = await run(fake);
    expect(code, output).toBe(0);
    expect(requests.map(line)).toContain(`GET /accounts/${OTHER_ACCOUNT}/access/identity_providers`);
    expect(requests.map(line)).not.toContain(`GET /accounts/${CH227}/access/identity_providers`);
    expect(output).toContain(WARNING);
  });

  it('says nothing about them when One-time PIN is on', async () => {
    const { code, output } = await run(cloudflare());
    expect(code).toBe(0);
    expect(output).not.toContain('One-time PIN');
    expect(output).not.toContain('login methods');
  });

  it('with only another method on, warns in step 4 and again before the next step, and still sets everything up', async () => {
    const fake = cloudflare({ loginMethods: ONLY_CLOUDFLARE });
    const { code, output } = await run(fake);
    expect(code, output).toBe(0);
    // In step 4, under the team it belongs to.
    const step4 = output.indexOf('4. Cloudflare Access for vva227.org/stats');
    const step5 = output.indexOf('5. Production settings for the /stats lock');
    const inStep4 = output.indexOf(indented(WARNING));
    expect(inStep4).toBeGreaterThan(step4);
    expect(inStep4).toBeLessThan(step5);
    // Again at the end, where it cannot scroll away: after who can open
    // /stats, before the deploy.
    const atEnd = output.indexOf(`\n${WARNING}\n`, output.indexOf('Who can open /stats:'));
    expect(atEnd).toBeGreaterThan(-1);
    expect(atEnd).toBeLessThan(output.indexOf('NEXT STEP.'));
    // A warning, not a stop: the whole setup is done.
    expect(fake.admits(CH227)).toEqual([EMAIL]);
    expectProductionConfigured(fake, { aud: fake.apps.get(CH227)![0].aud });
  });

  it('on a dry run with only another method on, warns the same way and sends only GETs', async () => {
    const fake = cloudflare({ loginMethods: ONLY_CLOUDFLARE });
    const before = structuredClone(fake.project);
    const { code, output, requests } = await run(fake, ['--email', EMAIL, '--dry-run']);
    expect(code, output).toBe(0);
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(fake.project).toEqual(before);
    expect(output).toContain(indented(WARNING));
    const summary = output.indexOf('DRY RUN. Nothing was changed. A real run would:');
    const atEnd = output.indexOf(`\n${WARNING}\n`, summary);
    expect(atEnd).toBeGreaterThan(summary);
    expect(atEnd).toBeLessThan(output.indexOf('Run the same command without --dry-run'));
  });

  it.each([
    ['refused', { status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } }],
    ['failed', { status: 500, body: { success: false, errors: [{ code: 12000, message: 'internal error' }] } }],
    ['answered with something that is not JSON', { status: 502, text: '<html>Bad gateway</html>' }],
  ])('when reading them is %s, notes it in one line and still sets everything up', async (_label, answer) => {
    const fake = cloudflare();
    fake.failNext({ method: 'GET', path: /\/access\/identity_providers$/, ...answer });
    const { code, output } = await run(fake);
    expect(code, output).toBe(0);
    const note = output.split('\n').filter((l) => l.includes('Could not read the login methods'));
    expect(note).toHaveLength(2);
    expect(note[0]).toMatch(/^ {3}Could not read the login methods \(.+\); check that One-time PIN is turned on: Zero Trust -> Integrations -> Identity providers\.$/);
    expect(fake.admits(CH227)).toEqual([EMAIL]);
    expectProductionConfigured(fake, { aud: fake.apps.get(CH227)![0].aud });
  });
});

describe('what the owner reads, word for word', () => {
  // The person running the script reads its output and nothing else, so
  // whole runs are checked line for line: a step heading lost, a list run
  // together or a line from the wrong branch fails here, where a test of
  // single phrases would pass. NEXT STEP's own words are checked whole in
  // tests/unit/setup-analytics-plan.test.ts.
  const SECOND = 'second@example.org';
  const THIRD = 'third@example.org';
  const COVERS = `vva227.org/stats, www.vva227.org/stats, ${PAGES_SUBDOMAIN}/stats, *.${PAGES_SUBDOMAIN}/stats`;

  /** The repo's migration plus a second, so every list of them has two entries. */
  function twoMigrations(): string {
    const dir = migrationsCopy();
    addMigration(dir);
    return dir;
  }

  const STEP_1 = [
    '1. The Pages project "vva227-refresh" in the "Ch 227" account',
    '   serves vva227.org: yes',
    '   production branch: main',
    '   production compatibility date: 2025-09-01',
    '   (the local runtime tests run on the nearest date the installed wrangler supports; see tests/helpers/pages-runtime.ts)',
  ];
  const STEP_4 = ['', '4. Cloudflare Access for vva227.org/stats', '   vva227.org is in the "Ch 227" account', `   Zero Trust team: ${TEAM_DOMAIN}`];
  const SETTINGS = (aud: string) => `  - set ACCESS_TEAM_DOMAIN (${TEAM_DOMAIN}) and ACCESS_AUD (${aud}), encrypted`;

  it('on a fresh account', async () => {
    const fake = cloudflare();
    const { code, output } = await run(fake, ['--email', EMAIL, '--email', SECOND], { migrationsDir: twoMigrations() });
    expect(code).toBe(0);
    expect(output).toBe(
      [
        ...STEP_1,
        '',
        '2. The D1 database "vva227-beacon"',
        '',
        '3. Production settings for the visit collector',
        ...STEP_4,
        '',
        '5. Production settings for the /stats lock',
        '',
        'Done. What changed in this run:',
        `  - created the D1 database vva227-beacon (${fake.database()!.uuid})`,
        '  - applied migration 0001_views.sql',
        '  - applied migration 0002_extra.sql',
        '  - bound BEACON to the vva227-beacon database',
        '  - created BEACON_SALT, a new random secret, encrypted',
        `  - created the Access policy "vva227 stats owners" admitting ${EMAIL}, ${SECOND}`,
        `  - created the Access application "vva227 stats" covering ${COVERS}`,
        SETTINGS(fake.apps.get(CH227)![0].aud),
        '',
        `Who can open /stats: ${EMAIL}, ${SECOND}`,
        '',
        nextSteps(),
      ].join('\n'),
    );
  });

  it('on a dry run on a fresh account', async () => {
    const { code, output } = await run(cloudflare(), ['--email', EMAIL, '--email', SECOND, '--dry-run'], { migrationsDir: twoMigrations() });
    expect(code).toBe(0);
    expect(output).toBe(
      [
        'DRY RUN: looking only. Nothing will be changed.',
        '',
        ...STEP_1,
        '',
        '2. The D1 database "vva227-beacon"',
        '',
        '3. Production settings for the visit collector',
        ...STEP_4,
        '',
        '5. Production settings for the /stats lock',
        '',
        'DRY RUN. Nothing was changed. A real run would:',
        '  - create the D1 database vva227-beacon',
        '  - apply whichever of 0001_views.sql, 0002_extra.sql the database has not recorded (a dry run cannot query it)',
        '  - bind BEACON to the vva227-beacon database',
        '  - create BEACON_SALT, a new random secret, encrypted',
        `  - create the Access policy "vva227 stats owners" admitting ${EMAIL}, ${SECOND}`,
        `  - create the Access application "vva227 stats" covering ${COVERS}`,
        `  - set ACCESS_TEAM_DOMAIN to ${TEAM_DOMAIN} and ACCESS_AUD to the application's AUD tag`,
        '',
        'Run the same command without --dry-run to do it.',
      ].join('\n'),
    );
  });

  it('on a dry run where the team has no One-time PIN', async () => {
    const methods = [{ id: '7ba3f272', name: '', type: 'cloudflare' }];
    const { code, output } = await run(cloudflare({ loginMethods: methods }), ['--email', EMAIL, '--dry-run']);
    expect(code).toBe(0);
    expect(output).toBe(
      [
        'DRY RUN: looking only. Nothing will be changed.',
        '',
        ...STEP_1,
        '',
        '2. The D1 database "vva227-beacon"',
        '',
        '3. Production settings for the visit collector',
        ...STEP_4,
        '   WARNING: One-time PIN is not turned on for this Zero Trust team.',
        '   Login methods turned on now: cloudflare.',
        '   Until it is on, the people on the list cannot sign in to /stats with a code emailed to them, and',
        '   anyone the sign-in page lets in with an address not on the list sees "That account does not have access".',
        '   Turn it on in the dashboard: Zero Trust -> Integrations -> Identity providers -> Add new identity provider',
        '   -> One-time PIN (in older dashboards: Settings -> Authentication -> Login methods -> Add new -> One-time PIN).',
        '   This script does not need to run again for it.',
        '',
        '5. Production settings for the /stats lock',
        '',
        'DRY RUN. Nothing was changed. A real run would:',
        '  - create the D1 database vva227-beacon',
        '  - apply whichever of 0001_views.sql the database has not recorded (a dry run cannot query it)',
        '  - bind BEACON to the vva227-beacon database',
        '  - create BEACON_SALT, a new random secret, encrypted',
        `  - create the Access policy "vva227 stats owners" admitting ${EMAIL}`,
        `  - create the Access application "vva227 stats" covering ${COVERS}`,
        `  - set ACCESS_TEAM_DOMAIN to ${TEAM_DOMAIN} and ACCESS_AUD to the application's AUD tag`,
        '',
        'WARNING: One-time PIN is not turned on for this Zero Trust team.',
        'Login methods turned on now: cloudflare.',
        'Until it is on, the people on the list cannot sign in to /stats with a code emailed to them, and',
        'anyone the sign-in page lets in with an address not on the list sees "That account does not have access".',
        'Turn it on in the dashboard: Zero Trust -> Integrations -> Identity providers -> Add new identity provider',
        '-> One-time PIN (in older dashboards: Settings -> Authentication -> Login methods -> Add new -> One-time PIN).',
        'This script does not need to run again for it.',
        '',
        'Run the same command without --dry-run to do it.',
      ].join('\n'),
    );
  });

  it('on a rerun with nothing left to do', async () => {
    const fake = cloudflare();
    const migrationsDir = twoMigrations();
    await run(fake, ['--email', EMAIL, '--email', SECOND], { migrationsDir });
    const { code, output } = await run(fake, ['--email', EMAIL, '--email', SECOND], { migrationsDir });
    expect(code).toBe(0);
    expect(output).toBe(
      [
        ...STEP_1,
        '',
        '2. The D1 database "vva227-beacon"',
        `   exists (${fake.database()!.uuid})`,
        '   migrations already applied: 0001_views.sql, 0002_extra.sql',
        '',
        '3. Production settings for the visit collector',
        '   BEACON is already bound to vva227-beacon.',
        '   BEACON_SALT already exists, encrypted; it is kept as it is.',
        ...STEP_4,
        `   policy "vva227 stats owners" already admits exactly ${EMAIL}, ${SECOND}`,
        `   application "vva227 stats" already covers ${COVERS}, with "vva227 stats owners" as its only policy`,
        '',
        '5. Production settings for the /stats lock',
        '',
        'Done. What changed in this run:',
        SETTINGS(fake.apps.get(CH227)![0].aud),
        '',
        `Who can open /stats: ${EMAIL}, ${SECOND}`,
        '',
        nextSteps(),
      ].join('\n'),
    );
  });

  /** A configured account whose list loses SECOND and gains THIRD, and whose application lost a destination. */
  async function changed() {
    const fake = cloudflare();
    await run(fake, ['--email', EMAIL, '--email', SECOND]);
    fake.apps.get(CH227)![0].destinations.pop();
    return fake;
  }

  it('on a dry run that would take someone off and repair the application', async () => {
    const fake = await changed();
    const { code, output } = await run(fake, ['--email', EMAIL, '--email', THIRD, '--dry-run']);
    expect(code).toBe(0);
    expect(output).toBe(
      [
        'DRY RUN: looking only. Nothing will be changed.',
        '',
        ...STEP_1,
        '',
        '2. The D1 database "vva227-beacon"',
        `   exists (${fake.database()!.uuid})`,
        '',
        '3. Production settings for the visit collector',
        '   BEACON is already bound to vva227-beacon.',
        '   BEACON_SALT already exists, encrypted; it is kept as it is.',
        ...STEP_4,
        '   would end existing sign-ins to /stats, because this run takes access away from someone',
        '',
        '5. Production settings for the /stats lock',
        '',
        'DRY RUN. Nothing was changed. A real run would:',
        '  - apply whichever of 0001_views.sql the database has not recorded (a dry run cannot query it)',
        `  - change the Access policy "vva227 stats owners" to admit exactly ${EMAIL}, ${THIRD}`,
        `  - update the Access application "vva227 stats" to cover ${COVERS}, with "vva227 stats owners" as its only policy`,
        '  - end every existing sign-in to /stats (the people still on the list sign in again)',
        `  - set ACCESS_TEAM_DOMAIN to ${TEAM_DOMAIN} and ACCESS_AUD to the application's AUD tag`,
        '',
        'Run the same command without --dry-run to do it.',
      ].join('\n'),
    );
  });

  it('on a run that takes someone off and repairs the application', async () => {
    const fake = await changed();
    const { code, output } = await run(fake, ['--email', EMAIL, '--email', THIRD]);
    expect(code).toBe(0);
    expect(output).toBe(
      [
        ...STEP_1,
        '',
        '2. The D1 database "vva227-beacon"',
        `   exists (${fake.database()!.uuid})`,
        '   migrations already applied: 0001_views.sql',
        '',
        '3. Production settings for the visit collector',
        '   BEACON is already bound to vva227-beacon.',
        '   BEACON_SALT already exists, encrypted; it is kept as it is.',
        ...STEP_4,
        '',
        '5. Production settings for the /stats lock',
        '',
        'Done. What changed in this run:',
        `  - changed the Access policy "vva227 stats owners" to admit exactly ${EMAIL}, ${THIRD}`,
        `  - updated the Access application "vva227 stats" to cover ${COVERS}`,
        '  - ended every existing sign-in to /stats, because this run took access away from someone; the people still on the list sign in again',
        SETTINGS(fake.apps.get(CH227)![0].aud),
        '',
        `Who can open /stats: ${EMAIL}, ${THIRD}`,
        '',
        nextSteps(),
      ].join('\n'),
    );
  });

  it('when it stops at the first step: the reason and nothing else', async () => {
    const { code, output } = await run(cloudflare({ project: null }));
    expect(code).toBe(1);
    expect(output).toBe([STEP_1[0], '', projectNotFoundMessage()].join('\n'));
  });

  it('when the project has no production branch or date', async () => {
    const { output } = await run(cloudflare({ project: freshProject({ production_branch: '', deployment_configs: { production: {}, preview: {} } }) }));
    expect(output).toContain('   production branch: (not set)\n   production compatibility date: (not set)\n');
  });

  it('when vva227.org is in another account and no sign-in was ended, with no word about ending one', async () => {
    const fake = cloudflare({ zoneAccount: OTHER_ACCOUNT, tokenAccounts: [CH227, OTHER_ACCOUNT], teams: { [OTHER_ACCOUNT]: TEAM_DOMAIN } });
    const { code, output } = await run(fake);
    expect(code, output).toBe(0);
    expect(output).toMatch(/\nWho can open \/stats: owner@example\.org\n\nNEXT STEP/);
  });
});

describe('answers from Cloudflare the script does not take on trust', () => {
  const done = (body: unknown) => ({ status: 200, body: { success: true, errors: [], messages: [], result: body } });

  it.each([
    ['two D1 databases', 'There are 2 D1 databases named "vva227-beacon".', (fake: FakeCloudflare) => {
      for (const uuid of ['db-1', 'db-2']) fake.databases.push({ uuid, name: 'vva227-beacon', db: new DatabaseSync(':memory:') });
    }],
    ['two Access policies', 'There are 2 Access policies named "vva227 stats owners".', (fake: FakeCloudflare) => {
      fake.policies.set(CH227, ['p-1', 'p-2'].map((id) => ({ id, name: 'vva227 stats owners', decision: 'allow', include: [] })));
    }],
  ])('stops, naming them, when it finds %s of its name', async (_label, said, arrange) => {
    const fake = cloudflare();
    arrange(fake);
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).toContain(said);
    expect(output).not.toContain('Stopped:');
  });

  it('stops, naming them, when it finds two Access applications of its name', async () => {
    const fake = cloudflare();
    await run(fake);
    fake.apps.get(CH227)!.push({ ...fake.apps.get(CH227)![0], id: 'a-copy' });
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).toContain('There are 2 Access applications named "vva227 stats".');
  });

  it.each([
    ['a database with no id', 'POST', /d1\/database$/, null, 'Cloudflare created the database but did not say its id. Run this again; it will find it by name.'],
    ['a database whose id is not text', 'POST', /d1\/database$/, { uuid: 123 }, 'Cloudflare created the database but did not say its id.'],
    ['a policy with no id', 'POST', /access\/policies$/, null, 'Cloudflare created the policy but did not say its id. Run this again; it will find it by name.'],
    ['an application with no AUD tag', 'POST', /access\/apps$/, null, 'Cloudflare did not return the AUD tag of "vva227 stats". Run this again.'],
    ['an application with an empty AUD tag', 'POST', /access\/apps$/, { aud: '' }, 'Cloudflare did not return the AUD tag of "vva227 stats". Run this again.'],
    ['an application whose AUD tag is not text', 'POST', /access\/apps$/, { aud: 123 }, 'Cloudflare did not return the AUD tag of "vva227 stats". Run this again.'],
  ])('stops with its own words when Cloudflare creates %s', async (_label, method, path, result, said) => {
    const fake = cloudflare();
    fake.failNext({ method, path, ...done(result) });
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).toContain(said);
    expect(output).not.toContain('Stopped:');
  });

  it('keeps the AUD tag it has when an update of the application answers without one', async () => {
    const fake = cloudflare();
    await run(fake);
    const { aud } = fake.apps.get(CH227)![0];
    fake.apps.get(CH227)![0].destinations.pop();
    fake.failNext({ method: 'PUT', path: /access\/apps\/[^/]+$/, ...done(null) });
    const { code, output } = await run(fake);
    expect(code, output).toBe(0);
    expect(prod(fake).env_vars!.ACCESS_AUD).toEqual({ type: 'secret_text', value: aud });
  });

  it.each([['no project at all', null], ['a project with no settings', {}]])('stops, naming everything missing, when the read-back is %s', async (_label, readBack) => {
    const fake = cloudflare();
    fake.failNext({ method: 'GET', path: /pages\/projects/, ...done(fake.publicProject()) });
    fake.failNext({ method: 'GET', path: /pages\/projects/, ...done(readBack) });
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).toMatch(/reading the project back shows: BEACON is not bound to vva227-beacon \([0-9a-f-]{36}\); BEACON_SALT is missing\./);
  });

  it('checks the Access settings themselves read back', async () => {
    const fake = cloudflare();
    await run(fake);
    const lost = fake.publicProject();
    delete lost.deployment_configs.production.env_vars!.ACCESS_TEAM_DOMAIN;
    delete lost.deployment_configs.production.env_vars!.ACCESS_AUD;
    fake.failNext({ method: 'GET', path: /pages\/projects/, ...done(fake.publicProject()) });
    fake.failNext({ method: 'GET', path: /pages\/projects/, ...done(lost) });
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).toContain('reading the project back shows: ACCESS_TEAM_DOMAIN is missing; ACCESS_AUD is missing.');
  });

  it('treats an organisation with no team domain as Zero Trust not turned on', async () => {
    const fake = cloudflare();
    fake.failNext({ method: 'GET', path: /access\/organizations$/, ...done({ name: 'team' }) });
    const { code, output, writes } = await run(fake);
    expect(code).toBe(1);
    expect(output).toContain(`\n${zeroTrustInstructions({ id: CH227, name: 'Ch 227' })}\n`);
    expect(writes.filter((w) => w.path.includes('/access/'))).toEqual([]);
  });

  it('gives the dashboard steps, then what Cloudflare said, when the organisation lookup fails', async () => {
    const fake = cloudflare();
    fake.failNext({ method: 'GET', path: /access\/organizations$/, status: 500, body: { success: false, errors: [{ code: 12000, message: 'internal error' }] } });
    const { output } = await run(fake);
    expect(output).toContain(
      `${zeroTrustInstructions({ id: CH227, name: 'Ch 227' })}\n(Cloudflare said: Cloudflare refused GET /accounts/${CH227}/access/organizations (HTTP 500): 12000: internal error)`,
    );
  });

  it.each([
    ['a body that is not JSON', { status: 200, text: 'OK' }, `Cloudflare refused GET ${PROJECT_PATH} (HTTP 200): the response was not JSON: OK`],
    ['success: false', { status: 200, body: { success: false, errors: [{ code: 1000, message: 'nope' }], result: null } }, `Cloudflare refused GET ${PROJECT_PATH} (HTTP 200): 1000: nope`],
  ])('treats a 200 carrying %s as a refusal', async (_label, answer, said) => {
    const fake = cloudflare();
    fake.failNext({ method: 'GET', path: /pages\/projects/, ...answer });
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).toContain(said);
  });

  it('reads a list as far as its hundredth page', async () => {
    const fake = cloudflare();
    const junk = Array.from({ length: 199 }, (_, i) => ({ id: `p-${i}`, name: `someone else's ${i}`, decision: 'allow', include: [] }));
    fake.policies.set(CH227, [...junk, { id: 'p-ours', name: 'vva227 stats owners', decision: 'allow', include: [{ email: { email: EMAIL } }], session_duration: '24h' }]);
    const { code, output, writes, requests } = await run(fake);
    expect(code, output).toBe(0);
    expect(requests.filter((r) => r.query.page).length).toBe(100);
    expect(writes.filter((w) => w.path.endsWith('/access/policies'))).toEqual([]);
  });

  it('pages a list that does not say how many pages it has until a page comes back short', async () => {
    const fake = cloudflare();
    fake.policies.set(CH227, [{ id: 'p-ours', name: 'vva227 stats owners', decision: 'allow', include: [{ email: { email: EMAIL } }], session_duration: '24h' }]);
    const full = Array.from({ length: 50 }, (_, i) => ({ id: `p-${i}`, name: `someone else's ${i}`, decision: 'allow' }));
    fake.failNext({ method: 'GET', path: /access\/policies$/, ...done(full) });
    fake.failNext({ method: 'GET', path: /access\/policies$/, ...done([{ id: 'p-ours', name: 'vva227 stats owners', decision: 'allow' }]) });
    const { code, output, writes, requests } = await run(fake);
    expect(code, output).toBe(0);
    expect(requests.map((r) => r.query.page).filter(Boolean)).toEqual(['1', '2']);
    expect(writes.filter((w) => w.path.endsWith('/access/policies'))).toEqual([]);
  });

  it('applies only a new migration on a later run, without making the bookkeeping table again', async () => {
    const fake = cloudflare();
    const dir = migrationsCopy();
    await run(fake, ['--email', EMAIL], { migrationsDir: dir });
    addMigration(dir);
    const { code, requests } = await run(fake, ['--email', EMAIL], { migrationsDir: dir });
    expect(code).toBe(0);
    const sql = requests.filter((r) => r.path.endsWith('/query')).map((r) => String((r.body as { sql: string }).sql));
    expect(sql).toHaveLength(3);
    expect(sql.join('\n')).not.toContain('CREATE TABLE IF NOT EXISTS d1_migrations');
    expect(sql[2]).toContain("values ('0002_extra.sql')");
  });

  it('names the database a dry run would create where a binding points elsewhere', async () => {
    const project = freshProject();
    project.deployment_configs.production.d1_databases = { BEACON: { id: 'their-database' } };
    const { code, output } = await run(cloudflare({ project }), ['--email', EMAIL, '--dry-run']);
    expect(code).toBe(1);
    expect(output).toContain('not vva227-beacon, which a real run would create.');
    expect(output).not.toContain('((');
  });

  it.each([
    ['a rerun that only adds someone stops after the policy change', async (fake: FakeCloudflare) => {
      await run(fake);
      fake.failNext({ method: 'GET', path: /access\/apps$/, status: 500, body: { success: false, errors: [{ code: 12000, message: 'internal error' }] } });
      return run(fake, ['--email', EMAIL, '--email', 'second@example.org']);
    }],
    ['--end-sign-ins on a fresh account stops creating the application', async (fake: FakeCloudflare) => {
      fake.failNext({ method: 'POST', path: /access\/apps$/, status: 500, body: { success: false, errors: [{ code: 12000, message: 'internal error' }] } });
      return run(fake, ['--email', EMAIL, '--end-sign-ins']);
    }],
    ['a rerun that only repairs the application stops after it', async (fake: FakeCloudflare) => {
      await run(fake);
      fake.apps.get(CH227)![0].destinations.pop();
      fake.failNext({ method: 'PATCH', path: /pages\/projects/, status: 500, body: { success: false, errors: [{ code: 8000000, message: 'internal error' }] } });
      return run(fake);
    }],
  ])('says nothing about open sign-ins when %s, having taken no one\'s access away', async (_label, act) => {
    const { code, output } = await act(cloudflare());
    expect(code).toBe(1);
    expect(output).not.toContain(NOT_ENDED);
  });
});

describe('the script as a library', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prints the usage for --help and succeeds, in the process as from the command line', async () => {
    const lines: string[] = [];
    expect(await runSetup({ argv: ['--help'], print: (l: string) => lines.push(l) })).toBe(0);
    expect(lines).toEqual([USAGE]);
  });

  it('with no arguments at all, asks for an address and prints the usage', async () => {
    const lines: string[] = [];
    expect(await runSetup({ print: (l: string) => lines.push(l) })).toBe(2);
    expect(lines).toEqual([`Say who may open /stats with --email (repeat it for each person). Nobody is added by default.\n\n${USAGE}`]);
  });

  it('prints to the console and asks the runtime\'s fetch when given neither', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runSetup({ argv: ['--help'] })).toBe(0);
    expect(log).toHaveBeenCalledWith(USAGE);

    const fake = cloudflare();
    vi.stubGlobal('fetch', fake.fetch);
    expect(await runSetup({ argv: ['--email', EMAIL], env: { CF_API_TOKEN: fake.token }, tokenFile: NO_TOKEN_FILE, randomHex: () => SALT })).toBe(0);
    expect(fake.apps.get(CH227)).toHaveLength(1);
  });

  it('sends every request as JSON', async () => {
    const fake = cloudflare();
    const types: Array<string | null> = [];
    const fetchImpl = ((input: string, init: RequestInit) => {
      types.push(new Headers(init.headers).get('Content-Type'));
      return fake.fetch(input, init);
    }) as unknown as typeof fetch;
    expect(await runSetup({ argv: ['--email', EMAIL], env: { CF_API_TOKEN: fake.token }, fetchImpl, print: () => {}, tokenFile: NO_TOKEN_FILE, randomHex: () => SALT })).toBe(0);
    expect(types.length).toBeGreaterThan(10);
    expect(new Set(types)).toEqual(new Set(['application/json']));
  });
});
