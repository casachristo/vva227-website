/**
 * Serves dist/ through `wrangler pages dev` — workerd, the runtime Cloudflare
 * Pages itself runs — with a local D1 database bound as BEACON, the real
 * migration applied to it, and a BEACON_SALT. Started by playwright.config.ts
 * for tests/system/runtime.spec.ts; run as `node` on this file directly.
 *
 * WHY THE REAL RUNTIME. astro preview serves files; it applies no _headers, no
 * _redirects and no _routes.json, and runs no Functions. Every failure this
 * feature is afraid of lives in exactly those: a CSP that blocks the beacon, a
 * Functions route that swallows a legacy redirect, a collector that 500s on a
 * binding. workerd applies all three files the way Pages does, and runs
 * functions/ as it is compiled for deployment.
 *
 * WHY NO COMMITTED WRANGLER CONFIG. The D1 binding lives in the Pages
 * project's production settings, and a committed wrangler config would
 * override it (see tests/contracts/analytics-routes.test.ts). The migration is
 * applied through a throwaway config written into RUNTIME_STATE, and
 * `pages dev` gets the binding as a flag; both name the same database id, so
 * both reach the same local SQLite file.
 *
 * Nothing here can reach Cloudflare: every wrangler call is --local, and the
 * database id is a placeholder that exists nowhere else.
 *
 * State is wiped before the run, so a crashed earlier run cannot leak rows
 * into this one, and removed after it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUNTIME_COMPATIBILITY_DATE,
  RUNTIME_DB,
  RUNTIME_PORT,
  RUNTIME_SALT,
  RUNTIME_STATE,
} from './pages-runtime.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(ROOT, 'dist');
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler');
const PERSIST = join(RUNTIME_STATE, 'persist');
const CONFIG_DIR = join(RUNTIME_STATE, 'migrate');

const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };

function fail(message: string): never {
  console.error(`[pages-runtime] ${message}`);
  process.exit(1);
}

if (!existsSync(join(DIST, 'index.html'))) fail(`no build at ${DIST}; run "npm run build" first`);

rmSync(RUNTIME_STATE, { recursive: true, force: true });
mkdirSync(CONFIG_DIR, { recursive: true });

// The config exists only to point `d1 migrations apply` at the migrations
// directory. It sits in a subdirectory so `pages dev`, which looks for a
// config in its own working directory, never sees it.
writeFileSync(
  join(CONFIG_DIR, 'wrangler.toml'),
  [
    'name = "vva227-system-test"',
    `compatibility_date = "${RUNTIME_COMPATIBILITY_DATE}"`,
    '[[d1_databases]]',
    'binding = "BEACON"',
    `database_name = "${RUNTIME_DB}"`,
    `database_id = "${RUNTIME_DB}"`,
    `migrations_dir = ${JSON.stringify(join(ROOT, 'migrations'))}`,
    '',
  ].join('\n'),
);

// Applied with wrangler's own migration runner, the one the production setup
// will use, rather than by executing the SQL by hand.
const migrate = spawnSync(
  WRANGLER,
  ['d1', 'migrations', 'apply', RUNTIME_DB, '--local', '--config', join(CONFIG_DIR, 'wrangler.toml'), '--persist-to', PERSIST],
  { cwd: CONFIG_DIR, env, stdio: ['ignore', 'ignore', 'inherit'] },
);
if (migrate.status !== 0) fail(`applying the migration failed (exit ${migrate.status})`);

const server = spawn(
  WRANGLER,
  [
    'pages',
    'dev',
    DIST,
    '--ip',
    '127.0.0.1',
    '--port',
    String(RUNTIME_PORT),
    '--d1',
    `BEACON=${RUNTIME_DB}`,
    '--binding',
    `BEACON_SALT=${RUNTIME_SALT}`,
    '--persist-to',
    PERSIST,
    '--compatibility-date',
    RUNTIME_COMPATIBILITY_DATE,
    '--show-interactive-dev-session=false',
    // Errors only. The collector's console.error lines still come through;
    // the gate's expected "stats denied" warning on every /stats probe does not.
    '--log-level',
    'error',
  ],
  { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] },
);

function cleanUp(): void {
  rmSync(RUNTIME_STATE, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.kill(signal);
  });
}

server.on('exit', (code, signal) => {
  cleanUp();
  process.exit(code ?? (signal ? 0 : 1));
});
