import { describe, it, expect, vi } from 'vitest';
import * as plan from '../../tools/lib/setup-analytics-plan.mjs';

/**
 * UNIT — every decision the setup script makes, on hand-built inputs. No
 * network, no files: tools/lib/setup-analytics-plan.mjs is pure.
 *
 * TIER JUSTIFICATION: the feature tier runs the script against one scripted
 * Cloudflare at a time. The boundaries live here: a 254-character address,
 * migration 2 against migration 10, an Access policy that admits one right
 * address AND everyone, an application the owner has already edited, an
 * error body with eleven errors or none at all.
 */

const { ACCOUNT } = plan;
const OTHER = 'b'.repeat(32);
const SUBDOMAIN = 'vva227-refresh-12g.pages.dev';

describe('normalizeEmail', () => {
  it('trims and lower-cases a real address', () => {
    expect(plan.normalizeEmail('  Owner@Example.ORG ')).toBe('owner@example.org');
    expect(plan.normalizeEmail('first.last+stats@mail.example.co.uk')).toBe('first.last+stats@mail.example.co.uk');
  });

  it.each([
    ['empty', ''],
    ['no @', 'owner.example.org'],
    ['two @', 'a@b@example.org'],
    ['no dot in the domain', 'owner@localhost'],
    ['a trailing dot', 'owner@example.'],
    ['an inner space', 'own er@example.org'],
    ['a quote', 'o"wner@example.org'],
    ['not a string', 42],
    ['null', null],
  ])('refuses %s', (_label, value) => {
    expect(plan.normalizeEmail(value)).toBeNull();
  });

  it('accepts 254 characters and refuses 255', () => {
    const at = (n: number) => `${'a'.repeat(n - '@example.org'.length)}@example.org`;
    expect(plan.normalizeEmail(at(254))).toBe(at(254));
    expect(plan.normalizeEmail(at(255))).toBeNull();
  });
});

describe('parseArgs', () => {
  it('collects repeated addresses in order, deduplicated, in both spellings', () => {
    expect(plan.parseArgs(['--email', 'a@example.org', '--email=B@example.org', '--email', 'A@example.org'])).toEqual({
      emails: ['a@example.org', 'b@example.org'],
      dryRun: false,
      endSignIns: false,
      help: false,
    });
  });

  it('reads --dry-run anywhere', () => {
    expect(plan.parseArgs(['--dry-run', '--email', 'a@example.org'])).toEqual({ emails: ['a@example.org'], dryRun: true, endSignIns: false, help: false });
  });

  it('reads --end-sign-ins anywhere, and still requires an address with it', () => {
    expect(plan.parseArgs(['--end-sign-ins', '--email', 'a@example.org'])).toEqual({ emails: ['a@example.org'], dryRun: false, endSignIns: true, help: false });
    expect(plan.parseArgs(['--end-sign-ins'])).toEqual({ error: expect.stringMatching(/--email/) });
    expect(plan.USAGE).toContain('--end-sign-ins');
  });

  it('answers --help without requiring an address', () => {
    expect(plan.parseArgs(['--help'])).toEqual({ emails: [], dryRun: false, endSignIns: false, help: true });
    expect(plan.parseArgs(['-h'])).toMatchObject({ help: true });
  });

  it.each([
    [[], /--email/],
    [['--dry-run'], /--email/],
    [['--email'], /needs an address/],
    [['--email', '--dry-run'], /needs an address/],
    [['--email='], /is not an email address/],
    [['--email', 'nope'], /"nope" is not an email address/],
    [['--email', 'a@example.org', 'extra'], /Unknown option "extra"/],
    [['--emails', 'a@example.org'], /Unknown option "--emails"/],
  ])('refuses %j', (argv, message) => {
    const result = plan.parseArgs(argv);
    expect(result).toEqual({ error: expect.stringMatching(message) });
  });
});

describe('resolveToken', () => {
  it('prefers the environment, trimmed', () => {
    expect(plan.resolveToken('  env-token\n', 'file-token')).toBe('env-token');
  });

  it.each([
    ['a trailing newline', 'file-token\n'],
    ['a CRLF', 'file-token\r\n'],
    ['surrounding spaces', '  file-token  '],
  ])('reads the file with %s', (_label, text) => {
    expect(plan.resolveToken(undefined, text)).toBe('file-token');
  });

  it('falls back to the file when the environment value is blank', () => {
    expect(plan.resolveToken('   ', 'file-token')).toBe('file-token');
  });

  it('is empty when there is neither', () => {
    expect(plan.resolveToken(undefined, undefined)).toBe('');
    expect(plan.resolveToken('', '\n')).toBe('');
  });
});

describe('tokenFileOpenToOthers', () => {
  it.each([[0o600], [0o400], [0o700], [0o100600]])('accepts a file only its owner can reach: %o', (mode) => {
    expect(plan.tokenFileOpenToOthers(mode)).toBe(false);
  });

  it.each([[0o644], [0o640], [0o604], [0o660], [0o610], [0o601], [0o777], [0o100644]])('refuses one any other account can reach: %o', (mode) => {
    expect(plan.tokenFileOpenToOthers(mode)).toBe(true);
  });

  it('says how to close it, and that nothing was changed', () => {
    const text = plan.tokenFileOpenMessage();
    expect(text).toContain('.cf-api-token can be read by other accounts on this computer');
    expect(text).toContain('chmod 600 .cf-api-token');
    expect(text).toContain('Nothing was changed.');
  });

  it('offers CF_API_TOKEN where chmod has no effect, such as a Windows drive under WSL', () => {
    // There every file reads as open to everyone, whatever chmod is given,
    // so the refusal would repeat for ever with chmod as its only way out.
    const text = plan.tokenFileOpenMessage();
    expect(text).toContain('Or set CF_API_TOKEN instead');
    expect(text).toContain('WSL');
    expect(text.indexOf('CF_API_TOKEN')).toBeLessThan(text.indexOf('Nothing was changed.'));
  });
});

describe('redact', () => {
  it('removes every occurrence', () => {
    expect(plan.redact('tok and tok again', 'tok')).toBe('[token] and [token] again');
  });

  it('leaves text alone when there is no token, and stringifies what it is given', () => {
    expect(plan.redact('nothing here', '')).toBe('nothing here');
    expect(plan.redact(404 as unknown as string, 'tok')).toBe('404');
  });
});

describe('checkProject', () => {
  const project = (over: Record<string, unknown> = {}) => ({
    name: 'vva227-refresh',
    subdomain: SUBDOMAIN,
    domains: [SUBDOMAIN, 'vva227.org'],
    production_branch: 'main',
    deployment_configs: { production: { compatibility_date: '2025-09-01', env_vars: { X: { type: 'plain_text', value: '1' } } } },
    ...over,
  });

  it('returns what later steps need, with no warning, for the live project', () => {
    expect(plan.checkProject(project())).toEqual({
      productionBranch: 'main',
      compatibilityDate: '2025-09-01',
      subdomain: SUBDOMAIN,
      production: { compatibility_date: '2025-09-01', env_vars: { X: { type: 'plain_text', value: '1' } } },
      warnings: [],
    });
  });

  it.each([
    ['no domains', { domains: undefined }],
    ['only its pages.dev name', { domains: [SUBDOMAIN] }],
    ['a look-alike domain', { domains: ['vva227.org.example.com', 'www.vva227.org'] }],
  ])('refuses a project with %s', (_label, over) => {
    expect(() => plan.checkProject(project(over))).toThrow(plan.StopError);
    expect(() => plan.checkProject(project(over))).toThrow(/does not serve vva227\.org/);
  });

  it('refuses no project at all', () => {
    expect(() => plan.checkProject(null)).toThrow(/returned no project/);
  });

  it.each([['production'], [''], [undefined]])('warns when the production branch is %j', (branch) => {
    const { warnings } = plan.checkProject(project({ production_branch: branch }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^WARNING: the project's production branch is "(production|\(not set\))", not "main"\./);
  });

  it('ignores a subdomain that is not a pages.dev name, and a missing production config', () => {
    const checked = plan.checkProject(project({ subdomain: 'evil.example.com', deployment_configs: undefined }));
    expect(checked.subdomain).toBeNull();
    expect(checked.compatibilityDate).toBeNull();
    expect(checked.production).toEqual({});
  });
});

describe('planBindings', () => {
  const DB = 'db-uuid';

  it('on an empty production config, binds the database and creates a salt, in production only', () => {
    const newSalt = vi.fn(() => 'salt');
    expect(plan.planBindings({}, { databaseId: DB, newSalt })).toEqual({
      body: { deployment_configs: { production: { d1_databases: { BEACON: { id: DB } }, env_vars: { BEACON_SALT: { type: 'secret_text', value: 'salt' } } } } },
      changes: [
        { did: 'bound BEACON to the vva227-beacon database', would: 'bind BEACON to the vva227-beacon database' },
        { did: 'created BEACON_SALT, a new random secret, encrypted', would: 'create BEACON_SALT, a new random secret, encrypted' },
      ],
      notes: [],
    });
    expect(newSalt).toHaveBeenCalledTimes(1);
  });

  it('sends nothing at all when both are already in place, and makes no salt', () => {
    const newSalt = vi.fn(() => 'salt');
    const result = plan.planBindings(
      { d1_databases: { BEACON: { id: DB } }, env_vars: { BEACON_SALT: { type: 'secret_text', value: '' } } },
      { databaseId: DB, newSalt },
    );
    expect(result.body).toBeNull();
    expect(result.changes).toEqual([]);
    expect(newSalt).not.toHaveBeenCalled();
  });

  it('sends only the missing half, with no empty map for the other', () => {
    expect(plan.planBindings({ d1_databases: { BEACON: { id: DB } } }, { databaseId: DB, newSalt: () => 's' }).body).toEqual({
      deployment_configs: { production: { env_vars: { BEACON_SALT: { type: 'secret_text', value: 's' } } } },
    });
    expect(plan.planBindings({ env_vars: { BEACON_SALT: { type: 'secret_text', value: '' } } }, { databaseId: DB, newSalt: () => 's' }).body).toEqual({
      deployment_configs: { production: { d1_databases: { BEACON: { id: DB } } } },
    });
  });

  it('keeps a plain-text salt and explains, rather than re-keying every visitor', () => {
    const result = plan.planBindings({ d1_databases: { BEACON: { id: DB } }, env_vars: { BEACON_SALT: { type: 'plain_text', value: 'x' } } }, { databaseId: DB, newSalt: () => 's' });
    expect(result.body).toBeNull();
    expect(result.notes.join('\n')).toMatch(/plain-text variable\. It is left alone/);
  });

  it('refuses to move a binding that points at another database', () => {
    expect(() => plan.planBindings({ d1_databases: { BEACON: { id: 'theirs' } } }, { databaseId: DB, newSalt: () => 's' })).toThrow(
      /BEACON is already bound to a different D1 database \(theirs\)/,
    );
  });

  it('names the database a dry run has not created yet in plain words', () => {
    let message = '';
    try {
      plan.planBindings({ d1_databases: { BEACON: { id: 'theirs' } } }, { databaseId: null, newSalt: () => 's' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('(theirs), not vva227-beacon, which a real run would create.');
    expect(message).not.toMatch(/\(\(|null|undefined/);
  });

  it('tolerates a missing config', () => {
    expect(plan.planBindings(undefined, { databaseId: DB, newSalt: () => 's' }).changes).toHaveLength(2);
  });
});

describe('accessSettingsBody and verifyProduction', () => {
  it('writes both Access settings as secrets, in production only', () => {
    expect(plan.accessSettingsBody('team.cloudflareaccess.com', 'aud')).toEqual({
      deployment_configs: {
        production: {
          env_vars: {
            ACCESS_TEAM_DOMAIN: { type: 'secret_text', value: 'team.cloudflareaccess.com' },
            ACCESS_AUD: { type: 'secret_text', value: 'aud' },
          },
        },
      },
    });
  });

  const complete = {
    d1_databases: { BEACON: { id: 'db' } },
    env_vars: { BEACON_SALT: { type: 'secret_text', value: '' }, ACCESS_TEAM_DOMAIN: { type: 'secret_text', value: '' }, ACCESS_AUD: { type: 'secret_text', value: '' } },
  };

  it('finds nothing wrong with a complete config', () => {
    expect(plan.verifyProduction(complete, { databaseId: 'db', access: true })).toEqual([]);
  });

  it('names every missing piece', () => {
    expect(plan.verifyProduction({}, { databaseId: 'db', access: true })).toEqual([
      'BEACON is not bound to vva227-beacon (db)',
      'BEACON_SALT is missing',
      'ACCESS_TEAM_DOMAIN is missing',
      'ACCESS_AUD is missing',
    ]);
    expect(plan.verifyProduction({ ...complete, d1_databases: { BEACON: { id: 'other' } } }, { databaseId: 'db', access: false })).toEqual([
      'BEACON is not bound to vva227-beacon (db)',
    ]);
  });

  it('does not ask for the Access settings before step (e)', () => {
    expect(plan.verifyProduction({ d1_databases: complete.d1_databases, env_vars: { BEACON_SALT: { type: 'plain_text', value: 'x' } } }, { databaseId: 'db', access: false })).toEqual([]);
  });
});

describe('findByName', () => {
  it('matches the name exactly, ignoring a loose filter\'s near misses', () => {
    const items = [{ name: 'vva227-beacon-old' }, { name: 'vva227-beacon' }, { name: 'VVA227-BEACON' }];
    expect(plan.findByName(items, 'vva227-beacon', 'D1 database')).toEqual({ name: 'vva227-beacon' });
  });

  it('is null for none, and for a result that is not a list', () => {
    expect(plan.findByName([{ name: 'other' }, null], 'x', 'thing')).toBeNull();
    expect(plan.findByName(undefined, 'x', 'thing')).toBeNull();
    expect(plan.findByName({ name: 'x' }, 'x', 'thing')).toBeNull();
  });

  it('refuses to guess between two exact matches', () => {
    expect(() => plan.findByName([{ name: 'x', id: 1 }, { name: 'x', id: 2 }], 'x', 'Access application')).toThrow(/There are 2 Access applications named "x"/);
  });

  it('names what it found two of in plain English, whatever it is', () => {
    const two = [{ name: 'x' }, { name: 'x' }];
    expect(() => plan.findByName(two, 'x', 'Access policy')).toThrow('There are 2 Access policies named "x". Delete the extra one in the dashboard and run this again. Nothing further was changed.');
    expect(() => plan.findByName(two, 'x', 'D1 database')).toThrow('There are 2 D1 databases named "x".');
  });
});

describe('migrations', () => {
  it('orders by number, not by text, then by name, and skips what is not SQL', () => {
    expect(plan.migrationOrder(['0010_later.sql', '0002_second.sql', 'README.md', '0002_another.sql', '0001_views.sql'])).toEqual([
      '0001_views.sql',
      '0002_another.sql',
      '0002_second.sql',
      '0010_later.sql',
    ]);
  });

  it.each([["0003_it's.sql"], ['views.sql'], ['0004 space.sql'], ['0005_a;drop.sql']])('refuses the file name %j', (name) => {
    expect(() => plan.migrationOrder([name])).toThrow(plan.StopError);
    expect(() => plan.migrationRequestSql(name, 'SELECT 1;')).toThrow(plan.StopError);
  });

  it('is empty for an empty directory', () => {
    expect(plan.migrationOrder([])).toEqual([]);
  });

  it('applies what is not yet recorded, in order', () => {
    expect(plan.pendingMigrations(['0001_a.sql', '0002_b.sql', '0003_c.sql'], ['0002_b.sql'])).toEqual(['0001_a.sql', '0003_c.sql']);
    expect(plan.pendingMigrations(['0001_a.sql'], ['0001_a.sql', '0099_unknown.sql'])).toEqual([]);
  });

  it('sends the file and its bookkeeping row together, as wrangler does', () => {
    expect(plan.migrationRequestSql('0001_views.sql', 'CREATE TABLE t (x);\n\n')).toBe("CREATE TABLE t (x);\nINSERT INTO d1_migrations (name) values ('0001_views.sql');");
  });

  it('reads rows from the first statement of a query response', () => {
    expect(plan.queryRows([{ results: [{ name: 'a' }] }, { results: [{ name: 'b' }] }])).toEqual([{ name: 'a' }]);
    expect(plan.queryRows([{ success: true }])).toEqual([]);
    expect(plan.queryRows(null)).toEqual([]);
  });

  it('creates the bookkeeping table exactly as wrangler does', () => {
    expect(plan.CREATE_MIGRATIONS_TABLE_SQL).toBe(
      'CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
    );
  });
});

describe('zone and Zero Trust', () => {
  it('reads the owning account of the exact zone, by id and by name', () => {
    expect(plan.zoneAccount([{ name: 'vva227.org.example', account: { id: 'x', name: 'Wrong' } }, { name: 'vva227.org', account: { id: OTHER, name: ' Other Org ' } }])).toEqual({
      id: OTHER,
      name: 'Other Org',
    });
  });

  it('has no name when Cloudflare gives none, and prints none of the control characters one could carry', () => {
    expect(plan.zoneAccount([{ name: 'vva227.org', account: { id: OTHER } }])).toEqual({ id: OTHER, name: null });
    expect(plan.zoneAccount([{ name: 'vva227.org', account: { id: OTHER, name: 7 } }])).toEqual({ id: OTHER, name: null });
    expect(plan.zoneAccount([{ name: 'vva227.org', account: { id: OTHER, name: ' \n ' } }])).toEqual({ id: OTHER, name: null });
    const esc = String.fromCharCode(27);
    expect(plan.zoneAccount([{ name: 'vva227.org', account: { id: OTHER, name: `Evil${esc}[2J\nOrg` } }])).toEqual({ id: OTHER, name: 'Evil [2J Org' });
  });

  it.each([[[]], [undefined], [[{ name: 'vva227.org' }]], [[{ name: 'vva227.org', account: { id: '' } }]]])('is null when the zone or its account is not visible: %j', (zones) => {
    expect(plan.zoneAccount(zones)).toBeNull();
  });

  it('names "Ch 227" by its own name, and any other account by the name Cloudflare gave, each with its id', () => {
    expect(plan.accountLabel({ id: ACCOUNT, name: 'whatever Cloudflare says' })).toBe(`"Ch 227" (${ACCOUNT})`);
    expect(plan.accountLabel({ id: OTHER, name: 'Other Org' })).toBe(`"Other Org" (${OTHER})`);
    expect(plan.accountLabel({ id: OTHER, name: null })).toBe(OTHER);
  });

  it('says what to do when the token cannot see the zone, including when the owner\'s login cannot', () => {
    const text = plan.zoneNotVisibleMessage();
    expect(text).toContain('Give the token "Zone › Zone › Read" for vva227.org');
    expect(text).toContain('If you cannot select vva227.org in the token form');
    expect(text).toContain('an account your login is not a member of');
    expect(text).toContain("ask that account's administrator to add you, or to run this script");
  });

  it('reads the team domain from an object or a one-item list', () => {
    expect(plan.teamDomainFrom({ auth_domain: ' team.cloudflareaccess.com\n' })).toBe('team.cloudflareaccess.com');
    expect(plan.teamDomainFrom([{ auth_domain: 'team.cloudflareaccess.com' }])).toBe('team.cloudflareaccess.com');
  });

  it.each([[null], [{}], [{ auth_domain: '' }], [{ auth_domain: '  ' }], [{ auth_domain: 7 }], [[]]])('treats %j as Zero Trust not set up', (org) => {
    expect(plan.teamDomainFrom(org)).toBeNull();
  });

  it('gives the dashboard steps, naming the account by name and id', () => {
    const own = plan.zeroTrustInstructions({ id: ACCOUNT, name: 'Ch 227' });
    expect(own).toContain(`Cloudflare Zero Trust is not turned on for the account "Ch 227" (${ACCOUNT}), which owns vva227.org.`);
    for (const step of ['one.dash.cloudflare.com', 'team name', 'Free plan', 'card details', 'does not charge', 'Nothing after this point was changed.']) {
      expect(own).toContain(step);
    }
    expect(plan.zeroTrustInstructions({ id: OTHER, name: 'Other Org' })).toContain(`for the account "Other Org" (${OTHER}), which owns vva227.org.`);
  });
});

describe('the policy', () => {
  it('admits exactly the given addresses for a day', () => {
    expect(plan.policyBody(['a@example.org', 'b@example.org'])).toEqual({
      name: 'vva227 stats owners',
      decision: 'allow',
      include: [{ email: { email: 'a@example.org' } }, { email: { email: 'b@example.org' } }],
      session_duration: '24h',
    });
  });

  it('carries over exclude and require rules an existing policy has, and no empty ones', () => {
    const existing = { exclude: [{ geo: { country_code: 'XX' } }], require: [], include: [] };
    expect(plan.policyBody(['a@example.org'], existing)).toEqual({ ...plan.policyBody(['a@example.org']), exclude: existing.exclude });
  });

  it('on update, keeps every setting the policy already has, and sends back none that Cloudflare keeps itself', () => {
    const hardening = {
      session_duration: '1h',
      approval_required: true,
      approval_groups: [{ approvals_needed: 1, email_addresses: ['boss@example.org'] }],
      purpose_justification_required: true,
      purpose_justification_prompt: 'Why do you need the visit log?',
      isolation_required: true,
      mfa_config: { allowed_authenticators: ['totp'], session_duration: '1h' },
      exclude: [{ geo: { country_code: 'XX' } }],
      a_setting_added_after_this_was_written: { on: true },
    };
    const existing = {
      ...hardening,
      id: 'p',
      name: 'vva227 stats owners',
      decision: 'bypass',
      include: [{ everyone: {} }],
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
      app_count: 1,
      reusable: true,
    };
    expect(plan.policyBody(['a@example.org'], existing)).toEqual({
      ...hardening,
      name: 'vva227 stats owners',
      decision: 'allow',
      include: [{ email: { email: 'a@example.org' } }],
    });
  });

  it('on update, keeps a session length the policy has, and gives one only to a policy without', () => {
    expect(plan.policyBody(['a@example.org'], { session_duration: '30m', include: [] }).session_duration).toBe('30m');
    expect(plan.policyBody(['a@example.org'], { include: [] }).session_duration).toBe('24h');
  });

  it('matches regardless of order and case, and not with a missing or extra address', () => {
    const policy = { decision: 'allow', include: [{ email: { email: 'B@example.org' } }, { email: { email: 'a@example.org' } }] };
    expect(plan.policyMatches(policy, ['a@example.org', 'b@example.org'])).toBe(true);
    expect(plan.policyMatches(policy, ['a@example.org'])).toBe(false);
    expect(plan.policyMatches(policy, ['a@example.org', 'b@example.org', 'c@example.org'])).toBe(false);
  });

  it.each([
    ['everyone', [{ everyone: {} }]],
    ['a whole domain', [{ email_domain: { domain: 'example.org' } }]],
    ['the right address and everyone', [{ email: { email: 'a@example.org' } }, { everyone: {} }]],
    ['an email rule with something else beside it', [{ email: { email: 'a@example.org' }, everyone: {} }]],
    ['no rules', []],
  ])('does not match a policy admitting %s', (_label, include) => {
    expect(plan.policyMatches({ decision: 'allow', include }, ['a@example.org'])).toBe(false);
  });

  it.each([
    ['an address left out', 'allow', [{ email: { email: 'a@example.org' } }, { email: { email: 'b@example.org' } }], ['a@example.org'], true],
    ['every address replaced', 'allow', [{ email: { email: 'b@example.org' } }], ['a@example.org'], true],
    ['everyone', 'allow', [{ everyone: {} }], ['a@example.org'], true],
    ['the right address and everyone', 'allow', [{ email: { email: 'a@example.org' } }, { everyone: {} }], ['a@example.org'], true],
    ['a whole domain', 'allow', [{ email_domain: { domain: 'example.org' } }], ['a@example.org'], true],
    ['an email rule with something else beside it', 'allow', [{ email: { email: 'a@example.org' }, everyone: {} }], ['a@example.org'], true],
    ['a bypass of someone left out', 'bypass', [{ email: { email: 'b@example.org' } }], ['a@example.org'], true],
    ['the same list', 'allow', [{ email: { email: 'A@Example.org' } }], ['a@example.org'], false],
    ['a list only added to', 'allow', [{ email: { email: 'a@example.org' } }], ['a@example.org', 'b@example.org'], false],
    ['no rules', 'allow', [], ['a@example.org'], false],
    ['a deny, which let nobody in', 'deny', [{ email: { email: 'b@example.org' } }], ['a@example.org'], false],
  ])('takes access away from someone (or not) when it admitted %s', (_label, decision, include, emails, narrows) => {
    expect(plan.policyNarrows({ decision, include }, emails)).toBe(narrows);
  });

  it('takes nothing away when there was no policy', () => {
    expect(plan.policyNarrows(null, ['a@example.org'])).toBe(false);
    expect(plan.policyNarrows({ decision: 'allow' }, ['a@example.org'])).toBe(false);
  });

  it('does not match a policy that is not an allow, or is not a policy', () => {
    expect(plan.policyMatches({ decision: 'deny', include: [{ email: { email: 'a@example.org' } }] }, ['a@example.org'])).toBe(false);
    expect(plan.policyMatches(null, ['a@example.org'])).toBe(false);
  });
});

describe('destinationsFor', () => {
  const CH227 = { id: ACCOUNT, name: 'Ch 227' };

  it('covers the apex, www, and the project\'s pages.dev names when the zone is in the project\'s account', () => {
    expect(plan.destinationsFor({ accessAccount: CH227, subdomain: SUBDOMAIN })).toEqual({
      destinations: ['vva227.org/stats', 'www.vva227.org/stats', `${SUBDOMAIN}/stats`, `*.${SUBDOMAIN}/stats`].map((uri) => ({ type: 'public', uri })),
      skipped: null,
    });
  });

  it('leaves the pages.dev names out, and says why, naming the account, when the zone is in another account', () => {
    const { destinations, skipped } = plan.destinationsFor({ accessAccount: { id: OTHER, name: 'Other Org' }, subdomain: SUBDOMAIN });
    expect(destinations.map((d: { uri: string }) => d.uri)).toEqual(['vva227.org/stats', 'www.vva227.org/stats']);
    expect(skipped).toContain(`different Cloudflare account, "Other Org" (${OTHER}), from the Pages project`);
    // Not "for everyone": someone holding a copy of a valid sign-in can still
    // send it there by hand (Known gaps, A13). Browsing there, nobody has one.
    expect(skipped).toContain('stays a plain "Not found" to anyone who browses to it');
    expect(skipped).not.toContain('for everyone');
  });

  it('leaves them out when the project reported no pages.dev name', () => {
    const { destinations, skipped } = plan.destinationsFor({ accessAccount: CH227, subdomain: null });
    expect(destinations).toHaveLength(2);
    expect(skipped).toMatch(/reported no pages\.dev address/);
    expect(skipped).toContain('stays a plain "Not found" to anyone who browses to it');
    expect(skipped).not.toContain('for everyone');
  });
});

describe('the application', () => {
  const destinations = plan.destinationsFor({ accessAccount: { id: ACCOUNT, name: 'Ch 227' }, subdomain: SUBDOMAIN }).destinations;

  it('is created hidden from the launcher, for a day, with only this policy', () => {
    expect(plan.appBody({ policyId: 'p1', destinations })).toEqual({
      type: 'self_hosted',
      name: 'vva227 stats',
      domain: 'vva227.org/stats',
      destinations,
      session_duration: '24h',
      app_launcher_visible: false,
      policies: [{ id: 'p1', precedence: 1 }],
    });
  });

  it('on update, adds what is missing, keeps the owner\'s own settings, and carries only this policy', () => {
    const existing = {
      id: 'app',
      aud: 'x',
      domain: 'vva227.org/stats',
      destinations: [{ type: 'public', uri: 'vva227.org/stats' }, { type: 'public', uri: 'vva227.org/stats/more' }, { type: 'public' }],
      session_duration: '1h',
      app_launcher_visible: true,
      allowed_idps: ['idp-1'],
      auto_redirect_to_identity: true,
      policies: [{ id: 'theirs', precedence: 3, name: 'theirs', decision: 'allow' }, { id: 'no-precedence' }],
    };
    expect(plan.appBody({ policyId: 'p1', destinations, existing })).toEqual({
      type: 'self_hosted',
      name: 'vva227 stats',
      domain: 'vva227.org/stats',
      destinations: [
        { type: 'public', uri: 'vva227.org/stats' },
        { type: 'public', uri: 'vva227.org/stats/more' },
        { type: 'public', uri: 'www.vva227.org/stats' },
        { type: 'public', uri: `${SUBDOMAIN}/stats` },
        { type: 'public', uri: `*.${SUBDOMAIN}/stats` },
      ],
      session_duration: '1h',
      app_launcher_visible: true,
      allowed_idps: ['idp-1'],
      auto_redirect_to_identity: true,
      // Rule A13: this policy alone decides who opens /stats. The owner's two
      // are taken off; the script names them as it does.
      policies: [{ id: 'p1', precedence: 1 }],
    });
  });

  it('on update, keeps every setting the application already has, and sends back none that Cloudflare keeps itself', () => {
    const hardening = {
      enable_binding_cookie: true,
      same_site_cookie_attribute: 'strict',
      http_only_cookie_attribute: true,
      path_cookie_attribute: true,
      custom_deny_url: 'https://vva227.org/denied',
      cors_headers: { allowed_methods: ['GET'], allow_credentials: false },
      options_preflight_bypass: false,
      skip_interstitial: true,
      service_auth_401_redirect: true,
      session_duration: '1h',
      a_setting_added_after_this_was_written: { on: true },
    };
    const existing = {
      ...hardening,
      id: 'app',
      uid: 'app',
      aud: 'aud-tag',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
      type: 'self_hosted',
      name: 'vva227 stats',
      domain: 'vva227.org/stats',
      // Deprecated, and derived from destinations: sending both can conflict.
      self_hosted_domains: ['vva227.org/stats'],
      destinations: [{ type: 'public', uri: 'vva227.org/stats' }],
      // A GET returns each policy whole; an update names them by id.
      policies: [{ id: 'p1', precedence: 1, name: 'vva227 stats owners', decision: 'allow', include: [{ email: { email: 'a@example.org' } }], created_at: 't' }],
    };
    const body = plan.appBody({ policyId: 'p1', destinations, existing });
    expect(body).toEqual({
      ...hardening,
      type: 'self_hosted',
      name: 'vva227 stats',
      domain: 'vva227.org/stats',
      destinations,
      app_launcher_visible: false,
      policies: [{ id: 'p1', precedence: 1 }],
    });
    for (const key of ['id', 'uid', 'aud', 'created_at', 'updated_at', 'self_hosted_domains']) expect(body).not.toHaveProperty(key);
  });

  it('on update, does not add the policy twice, and moves it to the front', () => {
    const existing = { destinations: [], policies: [{ id: 'p1', precedence: 3 }] };
    expect(plan.appBody({ policyId: 'p1', destinations, existing }).policies).toEqual([{ id: 'p1', precedence: 1 }]);
  });

  it('matches only when every destination is present and this policy is the only one', () => {
    const full = { destinations, policies: [{ id: 'p1', precedence: 1 }] };
    expect(plan.appMatches(full, { policyId: 'p1', destinations })).toBe(true);
    expect(plan.appMatches({ ...full, policies: [{ id: 'p1', precedence: 2 }] }, { policyId: 'p1', destinations })).toBe(true);
    expect(plan.appMatches({ ...full, destinations: destinations.slice(1) }, { policyId: 'p1', destinations })).toBe(false);
    expect(plan.appMatches({ ...full, policies: [] }, { policyId: 'p1', destinations })).toBe(false);
    expect(plan.appMatches({ ...full, policies: [{ id: 'p1', precedence: 1 }, { id: 'wide', precedence: 2 }] }, { policyId: 'p1', destinations })).toBe(false);
    expect(plan.appMatches({ ...full, policies: [{ id: 'wide', precedence: 1 }, { id: 'p1', precedence: 2 }] }, { policyId: 'p1', destinations })).toBe(false);
    expect(plan.appMatches({ ...full, policies: ['p1', 'wide'] }, { policyId: 'p1', destinations })).toBe(false);
    expect(plan.appMatches(full, { policyId: null, destinations })).toBe(false);
    expect(plan.appMatches({}, { policyId: 'p1', destinations })).toBe(false);
  });

  it('lists the other policies on an application by name and decision, from the application or else the account\'s list', () => {
    const app = {
      policies: [
        { id: 'p1', precedence: 1, name: 'vva227 stats owners', decision: 'allow' },
        { id: 'wide', precedence: 2, name: 'Allow everyone', decision: 'allow' },
        { id: 'bare', precedence: 3 },
        'as-a-string',
        null,
      ],
    };
    const listed = [{ id: 'bare', name: 'Board members', decision: 'allow' }];
    expect(plan.otherPolicies(app, 'p1', listed)).toEqual([
      { id: 'wide', name: 'Allow everyone', decision: 'allow' },
      { id: 'bare', name: 'Board members', decision: 'allow' },
      { id: 'as-a-string', name: null, decision: null },
    ]);
    expect(plan.otherPolicies({ policies: [{ id: 'p1' }] }, 'p1')).toEqual([]);
    expect(plan.otherPolicies(null, 'p1')).toEqual([]);
  });

  it('writes a policy as its name and decision, and as its id when it has no name', () => {
    expect(plan.policyLabel({ id: 'wide', name: 'Allow everyone', decision: 'allow' })).toBe('"Allow everyone" (decision: allow)');
    expect(plan.policyLabel({ id: 'wide', name: null, decision: null })).toBe('wide (decision: not given)');
  });
});

describe('what the run says about who can open /stats', () => {
  it('is the list, when the policy has no rules of its own beside it', () => {
    expect(plan.whoCanOpen(['a@example.org', 'b@example.org'])).toEqual(['Who can open /stats: a@example.org, b@example.org']);
    expect(plan.whoCanOpen(['a@example.org'], { exclude: [], require: [] })).toEqual(['Who can open /stats: a@example.org']);
  });

  it('says a copied sign-in still works where Access cannot end it, for as long as the policy\'s sign-ins last', () => {
    const [, note] = plan.whoCanOpen(['a@example.org'], { session_duration: '2h' }, { endedWherePagesDevUncovered: true });
    expect(note).toContain('Access cannot end a sign-in at the pages.dev address');
    expect(note).toContain('at most 2h');
    expect(plan.whoCanOpen(['a@example.org'], null, { endedWherePagesDevUncovered: true })[1]).toContain('at most 24h');
    expect(plan.whoCanOpen(['a@example.org'], { session_duration: '2h' }, { endedWherePagesDevUncovered: false })).toHaveLength(1);
  });

  it('says so when the policy keeps require or exclude rules someone set in the dashboard, which narrow it', () => {
    const lines = plan.whoCanOpen(['a@example.org'], { require: [{ geo: { country_code: 'US' } }], exclude: [{ email: { email: 'a@example.org' } }] });
    expect(lines[0]).toBe('Who can open /stats: a@example.org');
    expect(lines[1]).toContain("the policy's require and exclude rules");
  });
});

describe('what a stop says when the open sign-ins were not ended', () => {
  it('says they were not, that a plain rerun will not end them, and both ways to end them', () => {
    const text = plan.signInsNotEndedMessage();
    expect(text).toContain('Sign-ins already open to /stats were NOT ended');
    expect(text).toContain('at most 24h');
    expect(text).toContain('Running the same command again will not end them');
    expect(text).toContain('--end-sign-ins');
    expect(text).toContain('open the application "vva227 stats" in the Zero Trust dashboard');
  });

  it('gives the sign-in length the policy has, as the closing line does', () => {
    expect(plan.signInsNotEndedMessage({ session_duration: '2h' })).toContain('at most 2h');
    expect(plan.signInsNotEndedMessage({ session_duration: '' })).toContain('at most 24h');
    expect(plan.signInsNotEndedMessage(null)).toContain('at most 24h');
  });
});

describe('describing a failed call', () => {
  const ZT = `/accounts/${OTHER}/access/organizations`;

  it('quotes Cloudflare\'s codes and messages, at most five', () => {
    const errors = Array.from({ length: 11 }, (_, i) => ({ code: 1000 + i, message: `m${i}` }));
    const text = plan.describeApiError({ method: 'POST', path: '/accounts/x/d1/database', status: 400, body: { success: false, errors } });
    expect(text.split('\n')[0]).toBe('Cloudflare refused POST /accounts/x/d1/database (HTTP 400): 1000: m0; 1001: m1; 1002: m2; 1003: m3; 1004: m4');
    expect(text).toContain('run the command again');
    expect(text).not.toContain('not allowed');
  });

  it('says so when a JSON body has no errors, and quotes a non-JSON body without its markup', () => {
    expect(plan.describeApiError({ method: 'GET', path: '/zones', status: 500, body: { success: false } })).toContain('no error detail in the response');
    const html = plan.describeApiError({ method: 'GET', path: '/zones', status: 502, body: null, text: `<html><b>Bad</b>\n gateway ${'x'.repeat(400)}</html>` });
    expect(html).toMatch(/\(HTTP 502\): the response was not JSON: Bad gateway x+\n/);
    expect(html.split('\n')[0].length).toBeLessThan(300);
    expect(plan.describeApiError({ method: 'GET', path: '/zones', status: 502, body: null, text: '' })).toContain('not JSON: (empty)');
  });

  it.each([
    [401, [], '/accounts/x/pages/projects/p', 'Account › Cloudflare Pages › Edit'],
    [403, [], '/accounts/x/d1/database', 'Account › D1 › Edit'],
    [400, [{ code: 10000, message: 'Authentication error' }], '/accounts/x/access/apps', 'Account › Access: Apps and Policies › Edit'],
    [400, [{ code: 9109, message: 'Unauthorized' }], '/accounts/x/access/policies', 'Account › Access: Apps and Policies › Edit'],
    [403, [], '/accounts/x/access/organizations', 'Account › Access: Organizations, Identity Providers, and Groups › Read'],
    [403, [], '/zones', 'Zone › Zone › Read'],
  ])('a token refusal (%i %j) on %s names the permission', (status, errors, path, permission) => {
    expect(plan.describeApiError({ method: 'GET', path, status, body: { success: false, errors } })).toContain(`It needs "${permission}".`);
  });

  it('a refusal in the zone\'s other account says the token needs both accounts', () => {
    const text = plan.describeApiError({ method: 'GET', path: ZT, status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } });
    expect(text).toContain(`This call is in account ${OTHER}, which owns vva227.org but is not the "Ch 227" account (${ACCOUNT}).`);
    expect(text).toContain('must include BOTH accounts');
  });

  it('names that account by its name once the zone has said it', () => {
    const failure = { method: 'GET', path: ZT, status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } };
    expect(plan.describeApiError(failure, { id: OTHER, name: 'Other Org' })).toContain(`This call is in account "Other Org" (${OTHER}), which owns vva227.org`);
    // A name for some other account is not applied to this one.
    expect(plan.describeApiError(failure, { id: 'c'.repeat(32), name: 'Third' })).toContain(`This call is in account ${OTHER}, which owns`);
  });

  it('a refusal in the Ch 227 account names it', () => {
    const text = plan.describeApiError({ method: 'GET', path: `/accounts/${ACCOUNT}/d1/database`, status: 403, body: { errors: [] } });
    expect(text).toContain(`The token must include the "Ch 227" account (${ACCOUNT}).`);
  });

  it('classifies a missing project and a refused token apart', () => {
    expect(plan.isProjectMissing({ status: 404, body: null })).toBe(true);
    expect(plan.isProjectMissing({ status: 400, body: { errors: [{ code: 8000007 }] } })).toBe(true);
    expect(plan.isProjectMissing({ status: 403, body: { errors: [{ code: 10000 }] } })).toBe(false);
    expect(plan.isAuthRefusal({ status: 403, body: null })).toBe(true);
    expect(plan.isAuthRefusal({ status: 404, body: { errors: [{ code: 8000007 }] } })).toBe(false);
  });

  it('maps a path with no known permission to none', () => {
    expect(plan.permissionFor('/user/tokens/verify')).toBeNull();
  });
});

describe('what the script tells the person', () => {
  it('lists every token permission when there is no token', () => {
    const text = plan.noTokenMessage();
    for (const p of plan.TOKEN_PERMISSIONS) expect(text).toContain(p);
    expect(text).toContain('.cf-api-token');
    // The script refuses a file others can read; the instructions say so first.
    expect(text).toContain('chmod 600 .cf-api-token');
  });

  it('ends a successful run with the deploy that is not its to make', () => {
    const text = plan.nextSteps();
    for (const phrase of [
      'Nothing has been deployed',
      'NEXT production deploy',
      "chapter volunteer's latest changes AND this analytics",
      `CLOUDFLARE_API_TOKEN="$(cat .cf-api-token)" CLOUDFLARE_ACCOUNT_ID=${ACCOUNT} npm run deploy`,
      'main branch',
      'https://vva227.org/stats',
      // Signing in proves only the lock. The check that visits are recorded
      // is a visit, from a browser that does not opt out.
      'without Global Privacy Control',
      'https://vva227.org/ and one other page',
      'reload https://vva227.org/stats',
    ]) {
      expect(text).toContain(phrase);
    }
  });

  it('names the project and account when the project is missing', () => {
    expect(plan.projectNotFoundMessage()).toBe(
      `There is no Pages project named "vva227-refresh" in account ${ACCOUNT} ("Ch 227").\nEither the token is for a different Cloudflare account, or the project has been renamed. Nothing was changed.`,
    );
  });
});

describe('what Cloudflare sends back, read loosely', () => {
  // Every answer arrives over the network. A shape the documentation does not
  // promise has to be read as "not there", never crash the run or pass as valid.

  it('refuses a project that is not an object at all', () => {
    expect(() => plan.checkProject('vva227-refresh')).toThrow(/returned no project/);
  });

  it('reads a production branch that is not text as no branch, and a production config without a date as no date', () => {
    const checked = plan.checkProject({ domains: ['vva227.org'], production_branch: null, deployment_configs: {} });
    expect(checked.productionBranch).toBe('');
    expect(checked.compatibilityDate).toBeNull();
  });

  it.each([
    ['a subdomain of a pages.dev name', `x.${SUBDOMAIN}`],
    ['a pages.dev name with more after it', `${SUBDOMAIN}.evil.example`],
    ['a list holding a pages.dev name', [SUBDOMAIN]],
  ])('takes no pages.dev address from %s', (_label, subdomain) => {
    // It becomes an Access destination: only the project's own name will do.
    expect(plan.checkProject({ domains: ['vva227.org'], subdomain }).subdomain).toBeNull();
  });

  it('names what is missing from a read-back that has the maps but not the entries', () => {
    expect(plan.verifyProduction({ d1_databases: {}, env_vars: {} }, { databaseId: 'db', access: true })).toEqual([
      'BEACON is not bound to vva227-beacon (db)',
      'BEACON_SALT is missing',
      'ACCESS_TEAM_DOMAIN is missing',
      'ACCESS_AUD is missing',
    ]);
  });

  it('reads the zone only from an account id that is text, and refuses two zones of the name', () => {
    expect(plan.zoneAccount([{ name: 'vva227.org', account: { id: 42, name: 'Numbered' } }])).toBeNull();
    const zone = { name: 'vva227.org', account: { id: OTHER } };
    expect(() => plan.zoneAccount([zone, zone])).toThrow('There are 2 zones named "vva227.org".');
  });

  it('prints a run of control characters in a name as one space', () => {
    expect(plan.zoneAccount([{ name: 'vva227.org', account: { id: OTHER, name: 'Other\r\nOrg' } }])).toEqual({ id: OTHER, name: 'Other Org' });
  });

  it('reads an include rule that is not an object as a wider rule, and a padded address as the address', () => {
    expect(plan.policyMatches({ decision: 'allow', include: [null] }, ['a@example.org'])).toBe(false);
    expect(plan.policyNarrows({ decision: 'allow', include: [null] }, ['a@example.org'])).toBe(true);
    expect(plan.policyMatches({ decision: 'allow', include: [{ email: { email: ' A@example.org ' } }] }, ['a@example.org'])).toBe(true);
  });

  it('matches the addresses whatever order they are given in', () => {
    const policy = { decision: 'allow', include: [{ email: { email: 'a@example.org' } }, { email: { email: 'b@example.org' } }] };
    expect(plan.policyMatches(policy, ['b@example.org', 'a@example.org'])).toBe(true);
  });

  it('leaves out an empty exclude list as it does an empty require list', () => {
    expect(plan.policyBody(['a@example.org'], { exclude: [], include: [] })).not.toHaveProperty('exclude');
  });

  it('skips a destination or a listed policy that is not an object, and a policy whose id is not text', () => {
    const destinations = plan.destinationsFor({ accessAccount: { id: ACCOUNT, name: 'Ch 227' }, subdomain: SUBDOMAIN }).destinations;
    const app = { destinations: [null, ...destinations], policies: [{ id: 'p1' }, { id: 7 }] };
    expect(plan.appMatches(app, { policyId: 'p1', destinations })).toBe(true);
    expect(plan.appMatches(null, { policyId: 'p1', destinations })).toBe(false);
    expect(plan.appBody({ policyId: 'p1', destinations, existing: app }).destinations).toEqual(destinations);
    expect(plan.otherPolicies({ policies: [{ id: 'p1' }, { id: 'wide' }] }, 'p1', [null, { id: 'wide', name: 'Allow everyone', decision: 'allow' }])).toEqual([
      { id: 'wide', name: 'Allow everyone', decision: 'allow' },
    ]);
  });

  it.each([
    ['a domain of its own', 'www.vva227.org/stats', 'www.vva227.org/stats'],
    ['an empty domain', '', 'vva227.org/stats'],
    ['no domain', undefined, 'vva227.org/stats'],
    ['a domain that is not text', 7, 'vva227.org/stats'],
  ])('on update, keeps an application\'s main domain when it has %s, and otherwise uses the first destination', (_label, domain, expected) => {
    const destinations = plan.destinationsFor({ accessAccount: { id: ACCOUNT, name: 'Ch 227' }, subdomain: SUBDOMAIN }).destinations;
    expect(plan.appBody({ policyId: 'p1', destinations, existing: { domain, destinations } }).domain).toBe(expected);
  });

  it('reads an error list with holes in it without crashing', () => {
    expect(plan.isProjectMissing({ status: 400, body: { errors: [null] } })).toBe(false);
    expect(plan.isAuthRefusal({ status: 400, body: { errors: [null] } })).toBe(false);
    expect(plan.describeApiError({ method: 'GET', path: '/zones', status: 400, body: { errors: [null, {}] } }).split('\n')[0]).toBe(
      'Cloudflare refused GET /zones (HTTP 400): ?: no message; ?: no message',
    );
  });

  it('counts a token refusal by any one of its errors, and nothing as one when there are none', () => {
    expect(plan.isAuthRefusal({ status: 400, body: { errors: [{ code: 7003 }, { code: 10000 }] } })).toBe(true);
    expect(plan.isAuthRefusal({ status: 404, body: { errors: [] } })).toBe(false);
  });

  it('names the permission for the zone lookup as the script sends it, with its query', () => {
    const text = plan.describeApiError({ method: 'GET', path: '/zones?name=vva227.org', status: 403, body: { errors: [] } });
    expect(text.split('\n')).toEqual([
      'Cloudflare refused GET /zones?name=vva227.org (HTTP 403): no error detail in the response',
      'The token was not allowed to do this. It needs "Zone › Zone › Read".',
      'Everything this run reported as done above stays done; run the command again after fixing this.',
    ]);
  });

  it('says only that the token was refused for a path it has no permission name for', () => {
    expect(plan.describeApiError({ method: 'GET', path: '/user/tokens/verify', status: 401, body: { errors: [] } }).split('\n')[1]).toBe('The token was not allowed to do this.');
  });

  it('quotes a response with no text as empty, and markup as the words between it', () => {
    expect(plan.describeApiError({ method: 'GET', path: '/zones', status: 502, body: null })).toContain('the response was not JSON: (empty)');
    expect(plan.describeApiError({ method: 'GET', path: '/zones', status: 502, body: null, text: '<p>Bad</p><p>gateway</p>' })).toContain('the response was not JSON: Bad gateway\n');
  });
});

describe('migration file names', () => {
  it.each([['x0001_views.sql'], ['0001_views.sql.sql']])('refuses %j, which only contains a migration name', (name) => {
    expect(() => plan.migrationOrder([name])).toThrow(`Unexpected migration file name "${name}". Nothing was applied.`);
  });

  it('refuses a name that would break out of the bookkeeping row', () => {
    const name = "0001_views.sql'); DROP TABLE views; --";
    expect(() => plan.migrationRequestSql(name, 'SELECT 1;')).toThrow(`Unexpected migration file name "${name}".`);
    expect(() => plan.migrationRequestSql('x0001_views.sql', 'SELECT 1;')).toThrow('Unexpected migration file name "x0001_views.sql".');
  });

  it('orders two files with one number by name, whichever order the directory lists them in', () => {
    const names = ['0002_b.sql', '0002_a.sql', '0001_z.sql'];
    expect(plan.migrationOrder([...names])).toEqual(['0001_z.sql', '0002_a.sql', '0002_b.sql']);
    expect(plan.migrationOrder([...names].reverse())).toEqual(['0001_z.sql', '0002_a.sql', '0002_b.sql']);
  });
});

describe('the words the owner reads, whole', () => {
  // The person running this reads these and nothing else, so each is checked
  // whole: a line lost, emptied or run into the next fails here.

  it('when there is no token', () => {
    expect(plan.noTokenMessage()).toBe(
      [
        'No Cloudflare API token found.',
        '',
        'Sign in to Cloudflare with a login that belongs to the chapter\'s "Ch 227" account (not a personal one),',
        'then create one at https://dash.cloudflare.com/profile/api-tokens -> Create Token -> Custom token, with:',
        '  - Account › Cloudflare Pages › Edit',
        '  - Account › D1 › Edit',
        '  - Account › Access: Apps and Policies › Edit',
        '  - Account › Access: Organizations, Identity Providers, and Groups › Read',
        '  - Zone › Zone › Read',
        'Account resources: the "Ch 227" account (and, if vva227.org is in a different Cloudflare account, that one too).',
        'Zone resources: vva227.org.',
        '',
        'Then save it in a file named .cf-api-token at the top of this repository (it is gitignored), and make',
        'that file readable by you alone:  chmod 600 .cf-api-token',
        'Or set CF_API_TOKEN instead.',
      ].join('\n'),
    );
  });

  it('when the token file is open to other accounts', () => {
    expect(plan.tokenFileOpenMessage()).toBe(
      [
        '.cf-api-token can be read by other accounts on this computer, so this script will not use it.',
        'Make it readable by you alone, then run this again:  chmod 600 .cf-api-token',
        'Or set CF_API_TOKEN instead, for example where chmod has no effect, such as a Windows drive opened under WSL.',
        'Nothing was changed.',
      ].join('\n'),
    );
  });

  it('when the project does not serve vva227.org, naming every domain it does serve', () => {
    expect(() => plan.checkProject({ domains: [SUBDOMAIN, 'old.example.org'] })).toThrow(
      [
        `The Pages project "vva227-refresh" in account ${ACCOUNT} does not serve vva227.org`,
        `(its domains: ${SUBDOMAIN}, old.example.org).`,
        'That is not the live site, so nothing was changed. Check that the token is for the "Ch 227" account.',
      ].join('\n'),
    );
    expect(() => plan.checkProject({})).toThrow('(its domains: none).');
  });

  it('when production is not the branch `npm run deploy` publishes to', () => {
    expect(plan.checkProject({ domains: ['vva227.org'], production_branch: 'production' }).warnings).toEqual([
      [
        'WARNING: the project\'s production branch is "production", not "main".',
        '`npm run deploy` publishes to "main", so with this setting its deploys are PREVIEWS:',
        'they get none of the settings below, and visits would not be counted.',
        'Ask whoever deploys the site which branch they publish to before deploying this. The settings',
        'below are still written to production, so they are ready whichever way that is resolved.',
      ].join('\n'),
    ]);
  });

  it('when BEACON points at another database', () => {
    expect(() => plan.planBindings({ d1_databases: { BEACON: { id: 'old-db' } } }, { databaseId: 'db', newSalt: () => 's' })).toThrow(
      [
        'BEACON is already bound to a different D1 database (old-db), not vva227-beacon (db).',
        'This script will not move it: the visits recorded so far live in that database.',
        'If it should be replaced, remove the BEACON binding in the dashboard (Workers & Pages -> vva227-refresh -> Settings -> Bindings) and run this again.',
        'Nothing else was changed in the project.',
      ].join('\n'),
    );
  });

  it('when the salt is a plain-text variable', () => {
    expect(plan.planBindings({ env_vars: { BEACON_SALT: { type: 'plain_text', value: 'x' } } }, { databaseId: 'db', newSalt: () => 's' }).notes).toEqual([
      [
        'BEACON_SALT exists as a plain-text variable. It is left alone, because replacing it would reset every visitor id.',
        'It works as it is, but anyone with dashboard access can read it. To make it secret, delete it in the dashboard and run this again.',
      ].join('\n'),
    ]);
  });

  it('when the token cannot see the zone', () => {
    expect(plan.zoneNotVisibleMessage()).toBe(
      [
        'The token cannot see the vva227.org zone, so this script cannot tell which Cloudflare account Access belongs in.',
        'Give the token "Zone › Zone › Read" for vva227.org. If vva227.org lives in a different Cloudflare account from "Ch 227",',
        'the token must include that account too. Then run this again; what is already done will be skipped.',
        'If you cannot select vva227.org in the token form, the zone is in an account your login is not a member of:',
        "ask that account's administrator to add you, or to run this script, before /stats can be opened.",
      ].join('\n'),
    );
  });

  it('when Zero Trust is not turned on', () => {
    expect(plan.zeroTrustInstructions({ id: ACCOUNT, name: 'Ch 227' })).toBe(
      [
        `Cloudflare Zero Trust is not turned on for the account "Ch 227" (${ACCOUNT}), which owns vva227.org.`,
        'This has to be done once, by hand, in the dashboard:',
        '  1. Open https://one.dash.cloudflare.com and pick that account.',
        '  2. Choose a team name (it becomes <team>.cloudflareaccess.com; anything short works).',
        '  3. Choose the Free plan. Cloudflare asks for card details even on the Free plan; it does not charge them.',
        'Then run this command again. Everything already done above will be skipped.',
        'Nothing after this point was changed.',
      ].join('\n'),
    );
  });

  it('when a stop leaves open sign-ins that should have been ended', () => {
    expect(plan.signInsNotEndedMessage()).toBe(
      [
        'Sign-ins already open to /stats were NOT ended. Anyone taken off the list can still open it',
        'until their sign-in runs out, at most 24h.',
        'Running the same command again will not end them: it finds nothing left to change. To end them,',
        'once the problem above is fixed, run the same command with --end-sign-ins added, or',
        'open the application "vva227 stats" in the Zero Trust dashboard and revoke its existing tokens.',
      ].join('\n'),
    );
  });

  it('at the end of a run', () => {
    expect(plan.nextSteps()).toBe(
      [
        'NEXT STEP. Nothing has been deployed, and nothing on the live site has changed yet.',
        'These settings take effect on the NEXT production deploy of the site. That deploy must be made',
        "from a copy of the code that has BOTH the chapter volunteer's latest changes AND this analytics",
        'branch merged together: deploying either one on its own undoes the other.',
        'From that merged copy, deploy with the same API token this setup used:',
        `  CLOUDFLARE_API_TOKEN="$(cat .cf-api-token)" CLOUDFLARE_ACCOUNT_ID=${ACCOUNT} npm run deploy`,
        '(it publishes to the main branch, which is production). The token and the account id send the',
        'deploy to the chapter\'s "Ch 227" account, whatever Cloudflare login this computer has and whatever',
        'account wrangler remembers. If you gave the token as CF_API_TOKEN, use CLOUDFLARE_API_TOKEN="$CF_API_TOKEN".',
        'On Windows, set both variables first. In PowerShell:',
        `  $env:CLOUDFLARE_API_TOKEN=(Get-Content .cf-api-token -Raw).Trim(); $env:CLOUDFLARE_ACCOUNT_ID='${ACCOUNT}'; npm run deploy`,
        'In the Command Prompt, as three commands:',
        '  set /p CLOUDFLARE_API_TOKEN=<.cf-api-token',
        `  set CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}`,
        '  npm run deploy',
        'The folder you deploy from must contain no wrangler.toml, wrangler.json or wrangler.jsonc.',
        'Then open https://vva227.org/stats and sign in with one of the allowed email addresses.',
        'Signing in shows only that the lock works. To check that visits are being recorded: in a normal',
        'browser window without Global Privacy Control, open https://vva227.org/ and one other page, then',
        'reload https://vva227.org/stats. Your visit and your city should be at the top of Recent visitors.',
      ].join('\n'),
    );
  });
});
