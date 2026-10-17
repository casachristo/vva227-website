import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACCESS_REFUSAL_REASONS } from '../../src/lib/access';
import { BEACON_ENDPOINT, RETENTION_DAYS, RETENTION_MONTHS } from '../../src/data/analytics';
import { ACCOUNT, nextSteps, TOKEN_FILE, TOKEN_PERMISSIONS } from '../../tools/lib/setup-analytics-plan.mjs';
import { VIEW_COLUMNS } from '../helpers/analytics';

/**
 * CONTRACT — the analytics documents against the code they describe.
 *
 * docs/analytics.md is what the owner reads while setting this up and while
 * staring at a refused /stats; tests/BUSINESS_RULES.md is what a reviewer
 * reads to know what is guaranteed. Both are lists of names the code also
 * holds: refusal reasons, token permissions, columns, test titles. A reason
 * the gate can log with no row in the troubleshooting table is a 404 nobody
 * can explain; a rule pointing at a test that was renamed is a guarantee
 * nothing holds.
 *
 * TIER JUSTIFICATION: no test of the code reads the documents, and no review
 * of the documents runs the code. Only a check across both catches the drift.
 */

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const doc = read('docs/analytics.md');

/** The heading of the optional rate-limiting step in docs/analytics.md. */
const RATE_RULE = '**7. Optional: a rate-limiting rule for the collector.**';

/** One numbered step of the setup, from its bold heading to the next one. Empty if it is missing. */
function setupStep(text: string, n: number): string {
  const start = text.indexOf(`\n**${n}. `);
  if (start === -1) return '';
  const end = text.indexOf(`\n**${n + 1}. `, start);
  return text.slice(start, end === -1 ? text.indexOf('\n---', start) : end);
}

/** One bullet of a list, from its bold label to the next bullet or blank line. Empty if it is missing. */
function bulletAt(text: string, label: string): string {
  const start = text.indexOf(`- **${label}**`);
  if (start === -1) return '';
  const rest = text.slice(start + 2);
  const end = rest.search(/\n(- |\n)/);
  return text.slice(start, end === -1 ? undefined : start + 2 + end);
}

/** First-column cells of every markdown table row in a text. */
function tableKeys(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('| '))
    .map((l) => l.split('|')[1].trim());
}

/** The settings table that follows a marker, as setting -> value. Empty if the marker is missing. */
function settingsAfter(text: string, marker: string): Record<string, string> {
  const at = text.indexOf(marker);
  if (at === -1) return {};
  const lines = text.slice(at).split('\n');
  const first = lines.findIndex((l) => l.startsWith('| '));
  const rows: Record<string, string> = {};
  for (const line of lines.slice(first)) {
    if (!line.startsWith('| ')) break;
    const [, key, value] = line.split('|').map((c) => c.trim());
    rows[key] = value;
  }
  return rows;
}

/**
 * The label of every console.error and console.warn call in functions/: its
 * first string, without a trailing colon. `stats denied:` is left out; what
 * follows it is a gate reason, and every reason has its own row (checked
 * above).
 */
function loggedLabels(): string[] {
  const labels: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else for (const m of readFileSync(full, 'utf8').matchAll(/console\.(?:error|warn)\(\s*'([^']+)'/g)) labels.push(m[1].replace(/:$/, ''));
    }
  };
  walk(join(ROOT, 'functions'));
  return labels.filter((label) => label !== 'stats denied');
}

/** Reasons a troubleshooting table explains: every backticked name in its first column. */
function explainedReasons(text: string): string[] {
  return tableKeys(text).flatMap((cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
}

describe('docs/analytics.md', () => {
  it('explains every reason the /stats gate can log', () => {
    const explained = explainedReasons(doc);
    expect(ACCESS_REFUSAL_REASONS.filter((r) => !explained.includes(r))).toEqual([]);
  });

  it('can actually fail: a table missing a reason is caught', () => {
    const without = doc.replace(/^\| `wrong audience`.*$/m, '');
    expect(explainedReasons(without)).not.toContain('wrong audience');
  });

  it('explains every error and warning a Function logs, under the label it logs it with', () => {
    // A Function's answer never says why (the tracker ignores it anyway, and
    // /stats refuses everyone alike), so a logged line with no row here is a
    // failure the owner can see and cannot read.
    const labels = loggedLabels();
    expect(labels).toEqual(
      expect.arrayContaining(['collector not configured', 'beacon write failed', 'stats: BEACON binding missing', 'stats query failed']),
    );
    const explained = explainedReasons(doc);
    expect(labels.filter((label) => !explained.includes(label))).toEqual([]);
  });

  it('can actually fail: a logged label with no row is caught', () => {
    const without = doc.replace(/^\| `beacon prune failed`.*$/m, '');
    expect(without).not.toBe(doc);
    expect(explainedReasons(without)).not.toContain('beacon prune failed');
  });

  it('lists exactly the token permissions the setup script asks for', () => {
    const rows = TOKEN_PERMISSIONS.map((p: string) => `| ${p.split(' › ').join(' | ')} |`);
    for (const row of rows) expect(doc).toContain(row);
  });

  it('has the owner make the token file private, which the setup script requires', () => {
    expect(setupStep(doc, 3)).toContain(`chmod 600 ${TOKEN_FILE}`);
  });

  it('gives the deploy command with the "Ch 227" account id, in step 5 and in the script\'s closing words', () => {
    // wrangler prefers the account it cached in node_modules/.cache/wrangler
    // over the login, and this clone's cache once named another account.
    // CLOUDFLARE_ACCOUNT_ID outranks the cache for `pages deploy`.
    const command = `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT} npm run deploy`;
    const step5 = setupStep(doc, 5);
    expect(step5).toContain(command);
    expect(nextSteps()).toContain(command);
    // For a shell that cannot set a variable in front of a command.
    for (const words of ['npx wrangler whoami', 'node_modules/.cache/wrangler/pages.json']) {
      expect(step5).toContain(words);
      expect(nextSteps()).toContain(words);
    }
    // A local wrangler config, committed or not, replaces the settings the setup wrote.
    for (const name of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']) {
      expect(step5).toContain(name);
      expect(nextSteps()).toContain(name);
    }
  });

  it('says that removing a person ends the sign-ins already open, and that a rerun needs a token again', () => {
    // Access checks a changed policy only at the next sign-in; the setup
    // script ends the open ones when a rerun takes anyone's access away.
    const bullet = bulletAt(doc, 'Add or remove a person:');
    expect(bullet).toContain('ends every sign-in');
    expect(bullet).toContain('next sign-in');
    expect(bullet).toContain('steps 2');
    expect(bullet).not.toMatch(/apply immediately/);
  });

  it('can actually fail: a bullet that is not there reads as empty, and one ends at the next', () => {
    expect(bulletAt(doc, 'No such bullet:')).toBe('');
    expect(bulletAt(doc, 'Add or remove a person:')).not.toContain('**Add a column:**');
  });

  it('can actually fail: a step that is not there reads as empty', () => {
    expect(setupStep(doc, 99)).toBe('');
    expect(setupStep(doc, 3)).not.toContain('**4. ');
  });

  it('describes every column of the visit log', () => {
    const described = tableKeys(doc).join(' ');
    expect(VIEW_COLUMNS.filter((c) => !described.includes(`\`${c}\``))).toEqual([]);
  });

  it('gives the optional rate-limiting rule for the collector, on its real path, in settings the free plan offers', () => {
    // Free plan, checked against Cloudflare's documentation in October 2026:
    // one rate-limiting rule per domain, matching on the path, counted per IP,
    // over 10 seconds, acting for 10 seconds.
    const rule = settingsAfter(doc, RATE_RULE);
    expect(rule).toMatchObject({
      'Rule name': '`Limit visit collector`',
      'When incoming requests match': `Field **URI Path**, operator **equals**, value \`${BEACON_ENDPOINT}\``,
      'With the same characteristics': '**IP**',
      'When rate exceeds': '**10** requests per **10 seconds**',
      'Then take action': '**Block**',
      Duration: '**10 seconds**',
    });
  });

  it('can actually fail: a rule written for another path is caught', () => {
    const moved = doc.replace(`value \`${BEACON_ENDPOINT}\``, 'value `/api/x`');
    expect(settingsAfter(moved, RATE_RULE)['When incoming requests match']).not.toContain(BEACON_ENDPOINT);
    expect(settingsAfter(doc, 'no such step')).toEqual({});
  });

  it('states the retention period the collector enforces', () => {
    expect(doc).toContain(`Kept for ${RETENTION_DAYS} days** (${RETENTION_MONTHS} months)`);
  });

  it('says a stranger meets the Access sign-in page where Access stands, and the plain Not found only elsewhere', () => {
    // Access stops a request with no sign-in at the edge, before the Function
    // runs, on every hostname its application covers. The Function's own 404
    // is what the hostnames it does not cover answer.
    const flat = doc.replace(/\s+/g, ' ');
    expect(flat).not.toContain('on every hostname, `/stats` is a plain');
    expect(flat).toContain("anyone not signed in sees Cloudflare's sign-in page, and only the listed addresses get past it");
    expect(flat).toContain('On any address Access does not cover, `/stats` is a plain `Not found`.');
  });
});

describe('README.md', () => {
  const readme = read('README.md');

  it('no longer says the site ships no JavaScript, and links the analytics document', () => {
    expect(readme).not.toMatch(/zero JavaScript/i);
    expect(readme).toContain('](./docs/analytics.md)');
    expect(existsSync(join(ROOT, 'docs', 'analytics.md'))).toBe(true);
  });

  it('says a stranger at /stats meets the Access sign-in page, or the plain Not found where Access does not stand', () => {
    const flat = readme.replace(/\s+/g, ' ');
    expect(flat).not.toContain('Everyone else gets a plain `Not found`.');
    expect(flat).toContain("Everyone else is stopped at Cloudflare's sign-in page, or gets a plain `Not found` on an address Access does not cover.");
  });
});

describe('tests/BUSINESS_RULES.md, Visit analytics', () => {
  const rules = read('tests/BUSINESS_RULES.md');
  const section = rules.slice(rules.indexOf('## Visit analytics'), rules.indexOf('## Known gaps'));
  const rows = section.split('\n').filter((l) => /^\| A\d+ \|/.test(l));

  /** Every `tests/...` path in a row, with the italic test titles that follow it. */
  function references(row: string): Array<{ path: string; title: string }> {
    const out: Array<{ path: string; title: string }> = [];
    for (const m of row.matchAll(/`(tests\/[^`]+)`((?:\s*—\s*\*[^*]+\*(?:,\s*\*[^*]+\*)*)?)/g)) {
      for (const t of m[2].matchAll(/\*([^*]+)\*/g)) out.push({ path: m[1], title: t[1] });
    }
    return out;
  }

  it('has a rule for each analytics guarantee, numbered without gaps', () => {
    expect(rows.map((r) => r.split('|')[1].trim())).toEqual(Array.from({ length: rows.length }, (_, i) => `A${i + 1}`));
    expect(rows.length).toBeGreaterThanOrEqual(17);
  });

  it('points every rule at test files that exist and test titles they contain', () => {
    const broken: string[] = [];
    for (const row of rows) {
      const refs = references(row);
      if (!refs.length) broken.push(`${row.slice(0, 8)}: names no test`);
      for (const { path, title } of refs) {
        if (!existsSync(join(ROOT, path))) {
          broken.push(`${path} does not exist`);
          continue;
        }
        const text = read(path);
        // "…" in a cited title stands for the part elided; each piece must be present.
        const pieces = title.split('…').map((p) => p.trim()).filter(Boolean);
        if (!pieces.every((p) => text.includes(p))) broken.push(`${path}: no test titled "${title}"`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('can actually fail: a renamed title is caught', () => {
    const fake = '| A1 | x | `tests/feature/setup-analytics.test.ts` — *a title nobody wrote* |';
    const [ref] = references(fake);
    expect(read(ref.path)).not.toContain(ref.title);
  });
});
