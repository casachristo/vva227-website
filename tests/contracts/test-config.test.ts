import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import defaultConfig from '../../playwright.config';
import runtimeConfig from '../../playwright.runtime.config';

/**
 * CONTRACT — how the test commands are wired, for whoever runs them next.
 *
 * Playwright starts every webServer in a config whatever --project is chosen.
 * So a wrangler server listed in playwright.config.ts would start on every
 * `npm run test:system`, the desktop and mobile smoke run the chapter
 * volunteer already uses, and a machine that cannot run it would lose that
 * whole run. The Pages runtime lives in its own config for that reason, and
 * only `npm run test:runtime` starts it.
 *
 * The suites also need a recent Node: node:sqlite (unflagged from 22.13) for
 * the database tiers, and running a .ts file directly (22.18) for the runtime
 * server. package.json, .nvmrc and the README say so in one voice.
 *
 * TIER JUSTIFICATION: no test run can see which servers a DIFFERENT command
 * would start, or which Node a different machine has. Only reading the
 * configuration itself catches a runtime server creeping back into the
 * default run.
 */

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const pkg = JSON.parse(read('package.json'));

/** The commands of a config's webServer entry or entries. */
const serverCommands = (config: { webServer?: unknown }): string[] =>
  [config.webServer ?? []].flat().map((s) => String((s as { command?: string }).command));

/** Whether a config's testMatch / testIgnore patterns match a file. */
const matches = (pattern: unknown, file: string): boolean =>
  [pattern ?? []].flat().some((p) => (p instanceof RegExp ? p.test(file) : typeof p === 'string' && file.endsWith(p)));

const RUNTIME_SPEC = 'tests/system/runtime.spec.ts';
const RUNTIME_CONFIG = 'playwright.runtime.config.ts';

describe('the default Playwright run (npm run test:system)', () => {
  const config = defaultConfig;

  it('starts the preview server and nothing else: no wrangler, no Pages runtime', () => {
    const commands = serverCommands(config);
    expect(commands).toEqual(['npm run preview']);
    expect(commands.filter((c) => /wrangler|pages-runtime/.test(c))).toEqual([]);
  });

  it('runs the desktop and mobile projects only, and leaves the runtime spec out', () => {
    expect((config.projects ?? []).map((p) => p.name)).toEqual(['desktop', 'mobile']);
    expect(matches(config.testIgnore, RUNTIME_SPEC)).toBe(true);
    expect(matches(config.testIgnore, 'tests/system/smoke.spec.ts')).toBe(false);
  });

  it('is what test:system runs', () => {
    expect(pkg.scripts['test:system']).toBe('playwright test');
  });

  it('can fail: a runtime server added back to this config is seen', () => {
    const crept = { webServer: [{ command: 'npm run preview' }, { command: 'node tests/helpers/pages-runtime-server.ts' }] };
    expect(serverCommands(crept)).not.toEqual(['npm run preview']);
    expect(matches(undefined, RUNTIME_SPEC)).toBe(false);
  });
});

describe('the runtime run (npm run test:runtime)', () => {
  const config = runtimeConfig;

  it('is what test:runtime runs, by its own config file', () => {
    expect(pkg.scripts['test:runtime']).toBe(`playwright test -c ${RUNTIME_CONFIG}`);
    expect(existsSync(join(ROOT, RUNTIME_CONFIG))).toBe(true);
  });

  it('starts the Pages runtime server, and runs only the runtime spec', () => {
    expect(serverCommands(config)).toEqual(['node tests/helpers/pages-runtime-server.ts']);
    expect((config.projects ?? []).map((p) => p.name)).toEqual(['runtime']);
    expect(matches(config.testMatch, RUNTIME_SPEC)).toBe(true);
    expect(matches(config.testMatch, 'tests/system/smoke.spec.ts')).toBe(false);
  });
});

describe('the Node version', () => {
  const MIN = '22.18';

  it('is stated in package.json, .nvmrc and the README, and they agree', () => {
    expect(pkg.engines).toEqual({ node: `>=${MIN}` });
    expect(read('.nvmrc').trim()).toBe(MIN);
    const testing = read('README.md').split('## Testing')[1]?.split('\n## ')[0] ?? '';
    expect(testing).toContain(`Node ${MIN}`);
  });

  it('is met by the Node running these tests', () => {
    const [major, minor] = process.versions.node.split('.').map(Number);
    const [minMajor, minMinor] = MIN.split('.').map(Number);
    expect(major > minMajor || (major === minMajor && minor >= minMinor)).toBe(true);
  });
});
