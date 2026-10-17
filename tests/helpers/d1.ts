/**
 * A D1 binding backed by real SQLite, plus the request and env scaffolding the
 * two Functions need.
 *
 * WHY REAL SQLITE. The interesting behaviour of the collector is not in its
 * JavaScript, it is in one INSERT ... ON CONFLICT statement: that a repeated
 * `end` keeps the LARGER reading time, that a late `end` does not restamp `ts`,
 * that an `end` does not null out the referrer. A hand-written fake asserting
 * those things would be a fake that implements them — the test would pass
 * because the fake and the expectation came from the same misunderstanding.
 * node:sqlite executes the real statement text against the real migration
 * file, so a wrong coalesce argument order fails here.
 *
 * WHAT IT IS NOT. This is SQLite, not D1. Two D1 limits that SQLite does not
 * share ARE enforced below — more than 100 bound parameters, and a compound
 * SELECT of more than five terms — because both are easy to write and both
 * pass every local test and then fail in production. D1's other differences
 * (replication, statement size caps) are not modelled.
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CfProperties, D1Like, D1PreparedStatement, D1Result } from '../../src/lib/runtime';
import { BEACON_ENDPOINT, SITE_KEY } from '../../src/data/analytics';

const MIGRATIONS = join(process.cwd(), 'migrations');

/** D1's ceiling on bound parameters per statement. */
export const D1_MAX_PARAMS = 100;
/** D1's ceiling on terms in one compound SELECT (SQLITE_MAX_COMPOUND_SELECT). */
export const D1_MAX_COMPOUND_TERMS = 5;

/**
 * Every migration, in filename order, concatenated.
 *
 * Enumerated from the directory rather than named, so a new migration is
 * exercised by every existing test the moment it is added.
 */
export function schemaSql(): string {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (!files.length) throw new Error(`no migrations found in ${MIGRATIONS}`);
  return files.map((f) => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n');
}

/** Throws the way D1 would for a statement D1 refuses and SQLite accepts. */
function enforceD1Limits(sql: string, args: unknown[]): void {
  if (args.length > D1_MAX_PARAMS) {
    throw new Error(`D1_ERROR: too many SQL variables (${args.length} > ${D1_MAX_PARAMS})`);
  }
  const compoundOperators = sql.match(/\b(UNION(\s+ALL)?|INTERSECT|EXCEPT)\b/gi) ?? [];
  if (compoundOperators.length + 1 > D1_MAX_COMPOUND_TERMS) {
    throw new Error(`D1_ERROR: too many terms in compound SELECT (${compoundOperators.length + 1})`);
  }
  for (const [i, value] of args.entries()) {
    // D1 refuses undefined outright; node:sqlite refuses it with a different
    // message. Either way it means a field was never set, and saying so by
    // position is what makes the failing binding findable.
    if (value === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value ?${i + 1}`);
  }
}

/** node:sqlite returns null-prototype rows; D1 returns plain objects. */
const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;

export interface TestD1 {
  binding: D1Like;
  /** Every statement executed through the binding, in order. */
  statements: Array<{ sql: string; args: unknown[] }>;
  /** Every row in `views`, newest first. */
  rows(): Array<Record<string, unknown>>;
  /** One row by view id, or undefined. */
  one(view: string): Record<string, unknown> | undefined;
  /** Insert a row directly, bypassing the collector. Omitted columns take NULL or their default. */
  seed(row: Record<string, unknown>): void;
  /** The raw database, for queries no binding method covers. */
  db: DatabaseSync;
  close(): void;
}

/**
 * A D1-shaped binding over an in-memory database with the real schema.
 *
 * Implements the surface src/lib/runtime.ts declares — prepare, bind, run,
 * all, first, batch — and no more, so code that starts using a method D1 has
 * and this does not fails a test instead of passing one.
 */
export function createD1(): TestD1 {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql());
  const statements: TestD1['statements'] = [];

  const statement = (sql: string, args: unknown[]): D1PreparedStatement => ({
    bind: (...values: unknown[]) => statement(sql, values),
    async run(): Promise<D1Result> {
      enforceD1Limits(sql, args);
      statements.push({ sql, args });
      // D1 binds ?1..?n by number; node:sqlite binds anonymous arguments by
      // index, which lands on the same numbers. The argument order IS the
      // contract.
      const info = db.prepare(sql).run(...(args as never[]));
      return { success: true, results: [], meta: { changes: Number(info.changes) } };
    },
    async all<T>(): Promise<D1Result<T>> {
      enforceD1Limits(sql, args);
      statements.push({ sql, args });
      return { success: true, results: db.prepare(sql).all(...(args as never[])).map((r) => plain<T>(r)) };
    },
    async first<T>(): Promise<T | null> {
      enforceD1Limits(sql, args);
      statements.push({ sql, args });
      const row = db.prepare(sql).get(...(args as never[]));
      return row ? plain<T>(row) : null;
    },
  });

  const binding: D1Like = {
    prepare: (sql: string) => statement(sql, []),
    /** Runs in order and returns one result per statement, as D1 does. */
    async batch(stmts: D1PreparedStatement[]): Promise<D1Result[]> {
      const out: D1Result[] = [];
      for (const s of stmts) out.push(await s.all());
      return out;
    },
  };

  return {
    binding,
    statements,
    db,
    rows: () => db.prepare('SELECT * FROM views ORDER BY ts DESC, rowid DESC').all().map((r) => plain(r)),
    one: (view) => {
      const row = db.prepare('SELECT * FROM views WHERE view = ?1').get(view);
      return row ? plain(row) : undefined;
    },
    seed: (row) => {
      const full = { engaged_ms: 0, site: SITE_KEY, ...row };
      const cols = Object.keys(full);
      db.prepare(`INSERT INTO views (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`).run(
        ...(Object.values(full) as never[]),
      );
    },
    close: () => db.close(),
  };
}

/** The test salt. Never a real one. */
export const TEST_SALT = 'test-salt-not-the-real-one';

/** The env both Functions expect. Pass overrides to break it on purpose. */
export function createEnv(binding: D1Like | undefined, overrides: Record<string, unknown> = {}) {
  return { BEACON: binding, BEACON_SALT: TEST_SALT, ...overrides } as {
    BEACON?: D1Like;
    BEACON_SALT?: string;
    [key: string]: unknown;
  };
}

export const ORIGIN = 'https://vva227.org';
export const TEST_IP = '203.0.113.7';
export const TEST_UA = 'Mozilla/5.0 (test)';

/** What Cloudflare attaches as request.cf for a visitor in Fairfax. */
export const FAIRFAX_CF: CfProperties = {
  country: 'US',
  city: 'Fairfax',
  regionCode: 'VA',
  region: 'Virginia',
  asn: 7922,
  asOrganization: 'Comcast Cable Communications, LLC',
};

export interface BeaconRequestOptions {
  method?: string;
  origin?: string | null;
  headers?: Record<string, string>;
  /** request.cf. null means the property is absent, as off Cloudflare's edge. */
  cf?: CfProperties | null;
  url?: string;
}

/**
 * A POST the way the tracker sends it.
 *
 * `cf` is attached as a property because that is how the Workers runtime
 * exposes it — it is not a header and cannot be set as one.
 */
export function beaconRequest(
  body: unknown,
  { method = 'POST', origin = ORIGIN, headers = {}, cf = FAIRFAX_CF, url = `${ORIGIN}${BEACON_ENDPOINT}` }: BeaconRequestOptions = {},
): Request & { cf?: CfProperties } {
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': TEST_UA,
      'CF-Connecting-IP': TEST_IP,
      ...(origin ? { Origin: origin } : {}),
      ...headers,
    },
  };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const request = new Request(url, init) as Request & { cf?: CfProperties };
  if (cf !== null) Object.defineProperty(request, 'cf', { value: cf, configurable: true });
  return request;
}
