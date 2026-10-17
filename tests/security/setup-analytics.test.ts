import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeEmail, parseArgs, policyBody, policyMatches } from '../../tools/lib/setup-analytics-plan.mjs';
import { CH227, FakeCloudflare, OTHER_ACCOUNT } from '../helpers/fake-cloudflare';
import { runSetupAgainst } from '../helpers/setup-run';

/**
 * SECURITY — the setup script holds a Cloudflare token that can edit the
 * chapter's live site, and it decides who may read the visit log.
 *
 *   - the token goes to api.cloudflare.com over https, in the Authorization
 *     header, and nowhere else: never into a URL, a body or the terminal;
 *   - the salt it creates is never printed;
 *   - the Access policy admits exactly the addresses given, never a wider rule;
 *   - an address cannot smuggle anything into a request;
 *   - the token file can never be committed, and is not used while other
 *     accounts on the computer can read it.
 *
 * TIER JUSTIFICATION: the feature tier proves the setup works. Only here is
 * each of these checked against the worst case: a Cloudflare error that
 * echoes the token back, a policy someone widened to "everyone", an argument
 * written to break out of its JSON.
 */

const TOKEN = 'cf-token-SECRET-do-not-print-0123456789';
const SALT = '9e'.repeat(32);
const EMAIL = 'owner@example.org';

const fakes: FakeCloudflare[] = [];
const dirs: string[] = [];
afterEach(() => {
  fakes.splice(0).forEach((f) => f.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** A .cf-api-token holding TOKEN, with exactly these permissions whatever the umask. */
function tokenFileAt(mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'vva227-token-'));
  dirs.push(dir);
  const file = join(dir, '.cf-api-token');
  writeFileSync(file, `${TOKEN}\n`);
  chmodSync(file, mode);
  return file;
}

const run = (fake: FakeCloudflare, argv: string[] = ['--email', EMAIL]) => runSetupAgainst(fake, argv, { randomHex: () => SALT });

function cloudflare(options: ConstructorParameters<typeof FakeCloudflare>[0] = {}) {
  const fake = new FakeCloudflare({ token: TOKEN, ...options });
  fakes.push(fake);
  return fake;
}

describe('the token', () => {
  it('is never printed, even when a Cloudflare error repeats it', async () => {
    const fake = cloudflare();
    fake.failNext({
      method: 'POST',
      path: /access\/apps$/,
      status: 400,
      body: { success: false, errors: [{ code: 9999, message: `bad request for token ${TOKEN}` }] },
    });
    const { code, output } = await run(fake);
    expect(code).toBe(1);
    expect(output).not.toContain(TOKEN);
    expect(output).toContain('bad request for token [token]');
  });

  it('is never printed in a successful run, a rerun or a dry run', async () => {
    const fake = cloudflare();
    const outputs = [(await run(fake)).output, (await run(fake)).output, (await run(fake, ['--email', EMAIL, '--dry-run'])).output];
    for (const output of outputs) expect(output).not.toContain(TOKEN);
  });

  it('goes only to https://api.cloudflare.com, only in the Authorization header', async () => {
    const fake = cloudflare({ zoneAccount: OTHER_ACCOUNT, tokenAccounts: [CH227, OTHER_ACCOUNT], teams: { [OTHER_ACCOUNT]: 'other.cloudflareaccess.com' } });
    expect((await run(fake)).code).toBe(0);
    expect(fake.requests.length).toBeGreaterThan(10);
    for (const r of fake.requests) {
      expect(r.url.startsWith('https://api.cloudflare.com/client/v4/'), r.url).toBe(true);
      expect(r.authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.url).not.toContain(TOKEN);
      expect(JSON.stringify(r.body ?? null)).not.toContain(TOKEN);
    }
  });

  it('lives in a file git ignores', () => {
    const res = spawnSync('git', ['check-ignore', '--no-index', '.cf-api-token'], { cwd: process.cwd(), encoding: 'utf8' });
    expect(res.status, 'the token file is not gitignored').toBe(0);
    expect(res.stdout.trim()).toBe('.cf-api-token');
  });

  // Windows has no owner/group/other permission bits to check, so neither
  // does the script there.
  describe.skipIf(process.platform === 'win32')('in a file other accounts on this computer could read', () => {
    it('is refused before any request, with the command that fixes it, and is not echoed', async () => {
      const fake = cloudflare();
      const { code, output, requests } = await runSetupAgainst(fake, ['--email', EMAIL], { env: {}, tokenFile: tokenFileAt(0o644) });
      expect(code).toBe(1);
      expect(requests).toEqual([]);
      expect(output).toContain('can be read by other accounts on this computer');
      expect(output).toContain('chmod 600 .cf-api-token');
      expect(output).not.toContain(TOKEN);
    });

    it('is used once only its owner can read it', async () => {
      const fake = cloudflare();
      const { code, output, requests } = await runSetupAgainst(fake, ['--email', EMAIL], { env: {}, tokenFile: tokenFileAt(0o600) });
      expect(code, output).toBe(0);
      expect(`${requests[0].method} ${requests[0].path}`).toBe(`GET /accounts/${CH227}/pages/projects/vva227-refresh`);
      expect(requests[0].authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('does not stop a run that takes its token from CF_API_TOKEN', async () => {
      const fake = cloudflare();
      const { code } = await runSetupAgainst(fake, ['--email', EMAIL], { env: { CF_API_TOKEN: TOKEN }, tokenFile: tokenFileAt(0o644) });
      expect(code).toBe(0);
    });
  });
});

describe('the salt', () => {
  it('is sent once, encrypted, and never printed', async () => {
    const fake = cloudflare();
    const { output } = await run(fake);
    expect(output).not.toContain(SALT);
    const carrying = fake.requests.filter((r) => JSON.stringify(r.body ?? null).includes(SALT));
    expect(carrying).toHaveLength(1);
    expect(carrying[0].body).toEqual({ deployment_configs: { production: { env_vars: { BEACON_SALT: { type: 'secret_text', value: SALT } }, d1_databases: { BEACON: { id: fake.database()!.uuid } } } } });
  });
});

describe('who the policy admits', () => {
  it('is exactly the given addresses, as single-address rules', async () => {
    const fake = cloudflare();
    await run(fake, ['--email', EMAIL, '--email', 'second@example.org']);
    const [policy] = fake.policies.get(CH227)!;
    expect(policy.decision).toBe('allow');
    expect(policy.include).toEqual([{ email: { email: EMAIL } }, { email: { email: 'second@example.org' } }]);
  });

  it('replaces a policy someone widened to everyone, or to a whole domain', async () => {
    const fake = cloudflare();
    await run(fake);
    const [policy] = fake.policies.get(CH227)!;
    for (const widened of [[{ everyone: {} }], [{ email_domain: { domain: 'example.org' } }], [{ email: { email: EMAIL } }, { everyone: {} }]]) {
      policy.include = widened;
      expect(policyMatches(policy, [EMAIL])).toBe(false);
      await run(fake);
      expect(fake.policies.get(CH227)![0].include).toEqual([{ email: { email: EMAIL } }]);
    }
  });

  it('is decided by that policy alone: any other policy on the application is taken off, and named', async () => {
    const fake = cloudflare();
    await run(fake);
    const ours = fake.policies.get(CH227)![0];
    fake.policies.get(CH227)!.push({ id: 'wide', name: 'Allow everyone', decision: 'allow', include: [{ everyone: {} }] });
    fake.apps.get(CH227)![0].policies.push({ id: 'wide', precedence: 2 });

    const { code, output, writes } = await run(fake);
    expect(code, output).toBe(0);
    const put = writes.find((w) => w.method === 'PUT' && w.path.includes('/access/apps/'));
    expect((put?.body as { policies?: unknown })?.policies).toEqual([{ id: ours.id, precedence: 1 }]);
    expect(fake.admits(CH227)).toEqual([EMAIL]);
    expect(output).toContain('removed the policy "Allow everyone" (decision: allow) from the Access application "vva227 stats"');
    expect(output).toContain(`Who can open /stats: ${EMAIL}`);
  });

  it('takes away the open sign-in of someone removed, not only their next one', async () => {
    const fake = cloudflare();
    await run(fake, ['--email', EMAIL, '--email', 'departed@example.org']);
    const { code, writes } = await run(fake);
    expect(code).toBe(0);
    const revoke = writes.findIndex((w) => w.method === 'POST' && w.path === `/accounts/${CH227}/access/apps/${fake.apps.get(CH227)![0].id}/revoke_tokens`);
    const narrowed = writes.findIndex((w) => w.method === 'PUT' && w.path.includes('/access/policies/'));
    expect(narrowed).toBeGreaterThanOrEqual(0);
    expect(revoke).toBeGreaterThan(narrowed);
  });

  it('is never a deny-by-default policy turned into an allow by accident, nor the reverse', () => {
    expect(policyMatches({ decision: 'deny', include: [{ email: { email: EMAIL } }] }, [EMAIL])).toBe(false);
    expect(policyBody([EMAIL]).decision).toBe('allow');
  });
});

describe('arguments cannot reach into a request', () => {
  it.each([
    ['a quote and a brace', 'a@b.org"},{"everyone":{}'],
    ['a newline', 'a@b.org\nb@c.org'],
    ['a shell substitution', '$(whoami)@example.org'],
    ['a wildcard', '*@example.org'],
    ['a bare domain', '@example.org'],
    ['an address with spaces', 'owner @example.org'],
    ['an overlong address', `${'a'.repeat(250)}@example.org`],
  ])('refuses %s as an address', (_label, value) => {
    expect(normalizeEmail(value)).toBeNull();
    expect(parseArgs(['--email', value])).toHaveProperty('error');
  });

  it('makes no request at all when an address is refused', async () => {
    const fake = cloudflare();
    const { code } = await run(fake, ['--email', 'a@b.org"},{"everyone":{}']);
    expect(code).toBe(2);
    expect(fake.requests).toEqual([]);
  });
});

describe('it never deploys', () => {
  it('runs no other program, so it cannot call wrangler', () => {
    const dir = join(process.cwd(), 'tools');
    const sources = [...readdirSync(dir).filter((f) => f.startsWith('setup-')).map((f) => join(dir, f)), ...readdirSync(join(dir, 'lib')).map((f) => join(dir, 'lib', f))];
    expect(sources.length).toBeGreaterThanOrEqual(3);
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/child_process|\bspawn(Sync)?\(|\bexecFile(Sync)?\(|\bexecSync\(/);
    }
  });

  it('makes no deployment request, in a fresh run or a rerun', async () => {
    const fake = cloudflare();
    await run(fake);
    await run(fake);
    expect(fake.requests.filter((r) => /deployments/.test(r.path))).toEqual([]);
  });
});
