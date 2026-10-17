import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as registry from '../../src/data/analytics';
import { UPSERT_SQL } from '../../src/lib/beacon';
import { schemaSql } from '../helpers/d1';
import { VIEW_COLUMNS } from '../helpers/analytics';
import { DIST } from '../helpers/dist';

/**
 * CONTRACT — the files that must agree for the Functions to run at all.
 *
 * public/_routes.json decides which requests reach functions/; functions/
 * decides which handlers exist; src/data/analytics.ts names the paths everyone
 * else uses. Nothing but this file forces the three to agree, and every way
 * they can disagree is silent: a handler not listed in _routes.json is a 404
 * with no error anywhere, and a path listed with no handler pulls a request
 * away from public/_redirects for nothing.
 *
 * TIER JUSTIFICATION: every handler test calls onRequest directly, so all of
 * them pass whether or not Cloudflare would ever route a request to it. Only a
 * check of the routing file against the handler files catches that.
 */

const ROOT = process.cwd();
const FUNCTIONS = join(ROOT, 'functions');

const publicRoutes = () => JSON.parse(readFileSync(join(ROOT, 'public', '_routes.json'), 'utf8'));

/** Every handler file under functions/, as the route Pages derives from its path. */
function handlerRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|js)$/.test(entry)) {
        const route = '/' + relative(FUNCTIONS, full).split(sep).join('/').replace(/\.(ts|js)$/, '').replace(/(^|\/)index$/, '');
        out.push(route === '/' ? '/' : route.replace(/\/$/, ''));
      }
    }
  };
  walk(FUNCTIONS);
  return out.sort();
}

/** Source sides of public/_redirects. */
function redirectSources(): string[] {
  return readFileSync(join(ROOT, 'public', '_redirects'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)[0]);
}

describe('public/_routes.json and functions/', () => {
  it('routes exactly the registered Function paths', () => {
    expect(publicRoutes()).toEqual({
      version: 1,
      include: [registry.BEACON_ENDPOINT],
      exclude: [],
    });
  });

  it('has a handler for every included path, and includes every handler', () => {
    // Derived from the directory rather than listed, so a new handler cannot
    // be added without routing it, nor a route without a handler.
    expect(handlerRoutes()).toEqual([...publicRoutes().include].sort());
    for (const path of publicRoutes().include) {
      const file = join(FUNCTIONS, `${path.slice(1)}.ts`);
      expect(readFileSync(file, 'utf8'), `${file} exports no onRequest`).toMatch(/export (async function|const) onRequest\b/);
    }
  });

  it('leaves exclude empty, because exclude outranks include', () => {
    // The intuitive-looking `exclude: ["/*"]` — "everything else is static" —
    // disables every Function, since Pages gives exclude priority.
    expect(publicRoutes().exclude).toEqual([]);
  });

  it('never claims a wildcard, and never a path a legacy redirect needs', () => {
    // Pages generates include ["/*"] by itself once functions/ exists, and
    // _redirects is not applied to a request the Functions runtime claims.
    // This file is what keeps all 50 legacy redirects working.
    const { include } = publicRoutes();
    const sources = redirectSources();
    expect(sources.length).toBeGreaterThan(40);
    expect(include.some((p: string) => p.includes('*'))).toBe(false);
    for (const from of sources) expect(include, `${from} must not be routed into Functions`).not.toContain(from);
  });

  it('can actually fail — a wildcard include would be caught', () => {
    const wild = { include: ['/*'] };
    expect(wild.include.some((p) => p.includes('*'))).toBe(true);
  });

  it('is copied into the build unchanged', () => {
    // Pages reads _routes.json from the deployed directory, not from public/.
    expect(existsSync(join(DIST, '_routes.json')), 'run the build first').toBe(true);
    expect(readFileSync(join(DIST, '_routes.json'), 'utf8')).toBe(readFileSync(join(ROOT, 'public', '_routes.json'), 'utf8'));
  });
});

describe('the registry is the only place these values are written', () => {
  const LITERALS: Array<[string, string]> = [
    ['BEACON_ENDPOINT', registry.BEACON_ENDPOINT],
    ['BEACON_SCRIPT', registry.BEACON_SCRIPT],
    ['STATS_PATH', registry.STATS_PATH],
    ['SITE_KEY', registry.SITE_KEY],
    ['DISPLAY_TIME_ZONE', registry.DISPLAY_TIME_ZONE],
  ];

  function sourceFiles(dir: string): Array<{ path: string; text: string }> {
    const out: Array<{ path: string; text: string }> = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|js|mjs|astro)$/.test(entry)) out.push({ path: relative(ROOT, full), text: readFileSync(full, 'utf8') });
      }
    };
    walk(dir);
    return out;
  }

  const quoted = (value: string) => new RegExp(`(['"\`])${value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\1`);

  it.each(LITERALS)('no file in src/ or functions/ restates %s', (_name, value) => {
    const offenders = [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(FUNCTIONS)]
      .filter((f) => !f.path.endsWith(join('src', 'data', 'analytics.ts')))
      .filter((f) => quoted(value).test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('can actually fail — the pattern finds a restated value', () => {
    expect(quoted(registry.BEACON_ENDPOINT).test(`fetch('${registry.BEACON_ENDPOINT}')`)).toBe(true);
    expect(quoted(registry.BEACON_ENDPOINT).test(`fetch('${registry.BEACON_ENDPOINT}x')`)).toBe(false);
  });
});

describe('deploy configuration', () => {
  it('commits no wrangler config, so the dashboard binding is never overridden', () => {
    // The live site is deployed by direct upload from another tree, and the
    // D1 binding and salt live in the Pages project's production settings. A
    // committed wrangler config would need a database id, and one WITHOUT the
    // binding would silently replace the dashboard's — the collector would
    // then answer 500 on production with nothing changed in its code.
    for (const name of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']) {
      expect(existsSync(join(ROOT, name)), `${name} must not be committed`).toBe(false);
    }
  });
});

describe('the schema, the write and the validators', () => {
  it('declare the same columns', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(schemaSql());
    const schema = db.prepare('PRAGMA table_info(views)').all().map((c) => String((c as { name: string }).name));
    db.close();

    const written = UPSERT_SQL.match(/\(([^)]*)\)\s*VALUES/)![1].split(',').map((c) => c.trim());
    expect(schema).toEqual([...VIEW_COLUMNS]);
    expect(written).toEqual([...VIEW_COLUMNS]);
  });

  it('has exactly one migration, numbered from the start', () => {
    const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'));
    expect(files).toEqual(['0001_views.sql']);
  });
});
