import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCESS_REFUSAL_REASONS } from '../../src/lib/access';
import { RETENTION_DAYS, RETENTION_MONTHS } from '../../src/data/analytics';
import { TOKEN_PERMISSIONS } from '../../tools/lib/setup-analytics-plan.mjs';
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

/** First-column cells of every markdown table row in a text. */
function tableKeys(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('| '))
    .map((l) => l.split('|')[1].trim());
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

  it('explains the handler\'s own log lines, exactly as the handler writes them', () => {
    const handler = read('functions/stats.ts');
    for (const line of ['stats: BEACON binding missing', 'stats query failed']) {
      expect(handler).toContain(`'${line}'`);
      expect(explainedReasons(doc)).toContain(line);
    }
  });

  it('lists exactly the token permissions the setup script asks for', () => {
    const rows = TOKEN_PERMISSIONS.map((p: string) => `| ${p.split(' › ').join(' | ')} |`);
    for (const row of rows) expect(doc).toContain(row);
  });

  it('describes every column of the visit log', () => {
    const described = tableKeys(doc).join(' ');
    expect(VIEW_COLUMNS.filter((c) => !described.includes(`\`${c}\``))).toEqual([]);
  });

  it('states the retention period the collector enforces', () => {
    expect(doc).toContain(`Kept for ${RETENTION_DAYS} days** (${RETENTION_MONTHS} months)`);
  });
});

describe('README.md', () => {
  const readme = read('README.md');

  it('no longer says the site ships no JavaScript, and links the analytics document', () => {
    expect(readme).not.toMatch(/zero JavaScript/i);
    expect(readme).toContain('](./docs/analytics.md)');
    expect(existsSync(join(ROOT, 'docs', 'analytics.md'))).toBe(true);
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
