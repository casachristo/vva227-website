import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the local Cloudflare Pages runtime for tests/system/runtime.spec.ts
 * listens and keeps its state. Shared by playwright.runtime.config.ts, the
 * server script beside this file and the spec, so the three cannot disagree.
 *
 * Imported by Node directly (the server script runs under Node's built-in
 * type stripping), so this file uses only syntax that can be erased and
 * imports nothing but node: built-ins.
 */

export const RUNTIME_PORT = 8799;

/** 127.0.0.1, not localhost: the collector compares Origin to its own URL, and the two must be spelled alike. */
export const RUNTIME_ORIGIN = `http://127.0.0.1:${RUNTIME_PORT}`;

/**
 * The run's whole local state: the throwaway wrangler config the migration
 * is applied with, and the persisted D1 database. Outside the repo, wiped at
 * the start of every run and removed at the end.
 */
export const RUNTIME_STATE = join(tmpdir(), `vva227-pages-runtime-${RUNTIME_PORT}`);

/** The local D1 database's name and id. A placeholder: no such database exists on Cloudflare. */
export const RUNTIME_DB = 'vva227-beacon-system-test';

/** The salt bound as BEACON_SALT for the run. Never a real one. */
export const RUNTIME_SALT = 'system-test-salt-not-the-real-one';

/**
 * Workers compatibility date for the local runtime. Production runs on
 * 2026-09-01 (`npm run setup:analytics` reported it on 2026-10-18), but the
 * workerd that wrangler 4.120.1 installs refuses any date after 2026-08-11, so
 * this is the nearest date it can run. Move it to production's date when
 * wrangler is upgraded.
 */
export const RUNTIME_COMPATIBILITY_DATE = '2026-08-11';

/**
 * Added to the environment of every wrangler call the server makes, so the
 * run touches no network: no usage report, no download of where Cloudflare
 * places this machine (miniflare then attaches its fixed placeholder as
 * request.cf: Austin, TX, US, network 395747), and no banner, which would ask
 * the npm registry for a newer wrangler.
 */
export const RUNTIME_OFFLINE_ENV = {
  WRANGLER_SEND_METRICS: 'false',
  CLOUDFLARE_CF_FETCH_ENABLED: 'false',
  WRANGLER_HIDE_BANNER: 'true',
};

/** Where miniflare keeps the D1 database's SQLite file under RUNTIME_STATE. */
export const RUNTIME_D1_DIR = join(RUNTIME_STATE, 'persist', 'v3', 'd1', 'miniflare-D1DatabaseObject');
