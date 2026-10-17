/**
 * The slice of the Cloudflare Pages runtime the two Functions use, as types,
 * plus the one helper both handlers share.
 *
 * Declared here rather than taken from @cloudflare/workers-types so the repo
 * gains no dependency for a handful of shapes, and so the D1 surface the code
 * relies on is written down in one place. tests/helpers/d1.ts implements
 * exactly this surface over real SQLite; a method used here and missing there
 * fails a test rather than a deploy.
 */

export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta?: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface D1Like {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

/**
 * Edge metadata Cloudflare attaches to every request as `request.cf`.
 *
 * Every field is optional and typed loosely on purpose: Cloudflare documents
 * several as "if known", and the collector must treat whatever arrives as
 * untrusted until it has been cleaned.
 */
export interface CfProperties {
  country?: unknown;
  city?: unknown;
  region?: unknown;
  regionCode?: unknown;
  asn?: unknown;
  asOrganization?: unknown;
}

/** What a Pages Function receives. Only the fields these handlers read. */
export interface PagesContext<Env> {
  request: Request & { cf?: CfProperties };
  env: Env;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** Bindings and secrets, set in the Pages project's production settings. */
export interface AnalyticsEnv {
  BEACON?: D1Like;
  BEACON_SALT?: string;
  [key: string]: unknown;
}

/**
 * An error's message for a log line, without its stack or any properties a
 * driver may have attached. Shared by both handlers so neither logs more than
 * this.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
