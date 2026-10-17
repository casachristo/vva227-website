/**
 * A scripted Cloudflare API for the setup script's tests: the endpoints
 * tools/setup-analytics.mjs calls, with state, and a record of every request.
 *
 * It behaves the way the real API is documented to (docs/analytics.md has the
 * shapes), including the parts the script must cope with:
 *   - a PATCH to a Pages project MERGES: keys it names are replaced, keys it
 *     omits are untouched, and a key set to null is deleted;
 *   - a secret reads back as { type: 'secret_text', value: '' };
 *   - name filters on lists are loose, so callers must match names exactly;
 *   - an Access application may only name hostnames in a zone of its own
 *     account, or that account's own pages.dev project;
 *   - a token works only in the accounts it was made for.
 *
 * D1 queries run against a real in-memory SQLite database per D1 database, so
 * the migration file and wrangler's bookkeeping table are executed for real.
 */
import { DatabaseSync } from 'node:sqlite';

export const CH227 = 'd4afcdf7502fa80e6443dbb67ecd1d5f';
/** A second account, for the zone living somewhere other than the Pages project. */
export const OTHER_ACCOUNT = 'b'.repeat(32);
export const PAGES_SUBDOMAIN = 'vva227-refresh-12g.pages.dev';
export const TEAM_DOMAIN = 'vva227-test.cloudflareaccess.com';

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | null;
}

type EnvVar = { type: string; value: string };
type Config = { d1_databases?: Record<string, { id: string }>; env_vars?: Record<string, EnvVar>; compatibility_date?: string };

export interface ProjectState {
  name: string;
  subdomain: string;
  domains: string[];
  production_branch: string;
  deployment_configs: { production: Config; preview: Config };
}

interface Policy {
  id: string;
  name: string;
  decision: string;
  include: unknown[];
  exclude?: unknown[];
  require?: unknown[];
  session_duration?: string;
}

interface App {
  id: string;
  aud: string;
  name: string;
  type: string;
  domain: string;
  destinations: Array<{ type: string; uri: string }>;
  session_duration?: string;
  app_launcher_visible?: boolean;
  policies: Array<{ id: string; precedence: number }>;
  [key: string]: unknown;
}

export interface FakeOptions {
  token?: string;
  /** Accounts the token may act in. */
  tokenAccounts?: string[];
  /** Which account owns vva227.org. */
  zoneAccount?: string;
  /** Whether the token can read the zone. Defaults to whether it covers the zone's account. */
  zoneVisible?: boolean;
  /** The project as it exists in CH227; null when there is none. */
  project?: ProjectState | null;
  /** Zero Trust team domain per account. An account missing here has not enabled Zero Trust. */
  teams?: Record<string, string>;
}

export interface Failure {
  method: string;
  path: RegExp;
  status: number;
  body?: unknown;
  text?: string;
}

const PAGE_LIMIT = 2; // small, so paging is exercised

export function freshProject(over: Partial<ProjectState> = {}): ProjectState {
  return {
    name: 'vva227-refresh',
    subdomain: PAGES_SUBDOMAIN,
    domains: [PAGES_SUBDOMAIN, 'vva227.org', 'www.vva227.org'],
    production_branch: 'main',
    deployment_configs: {
      production: { compatibility_date: '2025-09-01' },
      preview: { compatibility_date: '2025-09-01', env_vars: { PREVIEW_ONLY: { type: 'plain_text', value: 'keep me' } } },
    },
    ...over,
  };
}

const ok = (result: unknown, extra: Record<string, unknown> = {}) => ({ success: true, errors: [], messages: [], result, ...extra });
const fail = (code: number, message: string) => ({ success: false, errors: [{ code, message }], messages: [], result: null });

let counter = 0;
const hexId = (n = 32) => {
  counter += 1;
  return counter.toString(16).padStart(n, '0').slice(-n);
};
const uuid = () => {
  const h = hexId(32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export class FakeCloudflare {
  readonly token: string;
  tokenAccounts: string[];
  zoneAccount: string;
  zoneVisible: boolean;
  project: ProjectState | null;
  teams: Record<string, string>;
  readonly requests: RecordedRequest[] = [];
  readonly databases: Array<{ uuid: string; name: string; db: DatabaseSync }> = [];
  readonly policies = new Map<string, Policy[]>();
  readonly apps = new Map<string, App[]>();
  private failures: Failure[] = [];

  constructor(options: FakeOptions = {}) {
    this.token = options.token ?? 'test-token-0123456789abcdef';
    this.tokenAccounts = options.tokenAccounts ?? [CH227];
    this.zoneAccount = options.zoneAccount ?? CH227;
    this.zoneVisible = options.zoneVisible ?? this.tokenAccounts.includes(this.zoneAccount);
    this.project = options.project === undefined ? freshProject() : options.project;
    this.teams = options.teams ?? { [CH227]: TEAM_DOMAIN };
  }

  /** The next request matching method and path gets this answer instead. */
  failNext(failure: Failure): void {
    this.failures.push(failure);
  }

  /** Requests that change something: everything but GETs and read-only queries. */
  writes(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== 'GET' && !(r.path.endsWith('/query') && /^\s*SELECT\b/i.test(String((r.body as { sql?: string })?.sql))));
  }

  database(name = 'vva227-beacon') {
    return this.databases.find((d) => d.name === name);
  }

  close(): void {
    for (const d of this.databases) d.db.close();
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/client\/v4/, '');
    this.requests.push({ method, url: url.href, path, query: Object.fromEntries(url.searchParams), body, authorization: headers.get('Authorization') });

    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

    if (url.origin !== 'https://api.cloudflare.com' || !url.pathname.startsWith('/client/v4/')) return json(404, fail(7000, 'No route for that URI'));

    const injected = this.failures.findIndex((f) => f.method === method && f.path.test(path));
    if (injected >= 0) {
      const [f] = this.failures.splice(injected, 1);
      return f.text !== undefined ? new Response(f.text, { status: f.status }) : json(f.status, f.body);
    }

    if (headers.get('Authorization') !== `Bearer ${this.token}`) return json(401, fail(10000, 'Authentication error'));

    const account = /^\/accounts\/([^/]+)/.exec(path)?.[1];
    if (account && !this.tokenAccounts.includes(account)) return json(403, fail(10000, 'Authentication error'));

    try {
      return this.route(method, path, url.searchParams, body, json);
    } catch (err) {
      return json(400, fail(7500, (err as Error).message));
    }
  };

  private route(method: string, path: string, q: URLSearchParams, body: any, json: (s: number, p: unknown) => Response): Response {
    let m: RegExpExecArray | null;

    // Pages project
    if ((m = /^\/accounts\/([^/]+)\/pages\/projects\/([^/]+)$/.exec(path))) {
      if (!this.project || m[1] !== CH227 || m[2] !== this.project.name) return json(404, fail(8000007, 'Project not found. The specified project name does not match any of your existing projects.'));
      if (method === 'PATCH') {
        for (const env of ['production', 'preview'] as const) {
          const patch = body?.deployment_configs?.[env];
          if (!patch) continue;
          const target = this.project.deployment_configs[env];
          for (const key of ['d1_databases', 'env_vars'] as const) {
            if (!(key in patch)) continue;
            // Pessimistic on purpose: an EMPTY map is treated as "replace with
            // nothing". Whether the real API does that is not documented, and
            // the terraform provider's history suggests it may; the script must
            // never send one, and if it did, this makes the damage visible.
            const empty = patch[key] && typeof patch[key] === 'object' && !Object.keys(patch[key]).length;
            const map = (empty ? {} : { ...(target[key] ?? {}) }) as Record<string, unknown>;
            for (const [k, v] of Object.entries(patch[key] ?? {})) {
              if (v === null) delete map[k];
              else map[k] = v;
            }
            (target as Record<string, unknown>)[key] = map;
          }
        }
      } else if (method !== 'GET') return json(405, fail(10405, 'Method not allowed'));
      return json(200, ok(this.publicProject()));
    }

    // D1
    if ((m = /^\/accounts\/([^/]+)\/d1\/database$/.exec(path))) {
      if (method === 'GET') {
        const name = q.get('name') ?? '';
        // Loose, as the real filter may be: a prefix match.
        return json(200, ok(this.databases.filter((d) => d.name.startsWith(name)).map(({ uuid: id, name: n }) => ({ uuid: id, name: n, version: 'production' }))));
      }
      if (method === 'POST') {
        if (this.database(body.name)) return json(400, fail(7502, 'A database with that name already exists'));
        const created = { uuid: uuid(), name: body.name, db: new DatabaseSync(':memory:') };
        this.databases.push(created);
        return json(200, ok({ uuid: created.uuid, name: created.name, created_at: '2026-10-17T00:00:00Z' }));
      }
    }
    if ((m = /^\/accounts\/([^/]+)\/d1\/database\/([^/]+)\/query$/.exec(path)) && method === 'POST') {
      const target = this.databases.find((d) => d.uuid === m![2]);
      if (!target) return json(404, fail(7404, 'Database not found'));
      const sql = String(body.sql);
      if (/^\s*SELECT\b/i.test(sql) && !sql.trim().replace(/;$/, '').includes(';')) {
        const rows = target.db.prepare(sql).all().map((r) => ({ ...(r as object) }));
        return json(200, ok([{ results: rows, success: true, meta: {} }]));
      }
      target.db.exec(sql);
      return json(200, ok([{ results: [], success: true, meta: {} }]));
    }

    // Zones: the token sees a zone only in an account it covers.
    if (path === '/zones' && method === 'GET') {
      const visible = this.zoneVisible && q.get('name') === 'vva227.org';
      return json(200, ok(visible ? [{ id: 'zone-1', name: 'vva227.org', status: 'active', account: { id: this.zoneAccount, name: 'zone owner' } }] : []));
    }

    // Zero Trust organisation
    if ((m = /^\/accounts\/([^/]+)\/access\/organizations$/.exec(path)) && method === 'GET') {
      const team = this.teams[m[1]];
      if (!team) return json(404, fail(12106, 'access.api.error.not_found: organization not found'));
      return json(200, ok({ name: 'team', auth_domain: team }));
    }

    // Access policies
    if ((m = /^\/accounts\/([^/]+)\/access\/policies(?:\/([^/]+))?$/.exec(path))) {
      const list = this.policies.get(m[1]) ?? [];
      this.policies.set(m[1], list);
      if (!m[2] && method === 'GET') {
        const page = Number(q.get('page') ?? 1);
        const slice = list.slice((page - 1) * PAGE_LIMIT, page * PAGE_LIMIT).map((p) => ({ id: p.id, name: p.name, decision: p.decision }));
        return json(200, ok(slice, { result_info: { page, per_page: PAGE_LIMIT, count: slice.length, total_count: list.length, total_pages: Math.max(1, Math.ceil(list.length / PAGE_LIMIT)) } }));
      }
      if (!m[2] && method === 'POST') {
        const created = { ...body, id: uuid() };
        list.push(created);
        return json(200, ok(created));
      }
      const found = list.find((p) => p.id === m![2]);
      if (!found) return json(404, fail(12130, 'access.api.error.not_found'));
      if (method === 'GET') return json(200, ok(found));
      if (method === 'PUT') {
        Object.keys(found).forEach((k) => k !== 'id' && delete (found as unknown as Record<string, unknown>)[k]);
        Object.assign(found, body, { id: found.id });
        return json(200, ok(found));
      }
    }

    // Access applications
    if ((m = /^\/accounts\/([^/]+)\/access\/apps(?:\/([^/]+))?$/.exec(path))) {
      const acct = m[1];
      const list = this.apps.get(acct) ?? [];
      this.apps.set(acct, list);
      const expand = (a: App) => ({ ...a, policies: a.policies.map((p) => ({ ...(this.policies.get(acct) ?? []).find((x) => x.id === p.id), ...p })) });
      if (!m[2] && method === 'GET') {
        const name = q.get('name') ?? '';
        const exact = q.get('exact') === 'true';
        return json(200, ok(list.filter((a) => (exact ? a.name === name : a.name.includes(name))).map(expand)));
      }
      if (method === 'POST' || method === 'PUT') {
        const problem = this.destinationProblem(acct, body);
        if (problem) return json(400, fail(12130, problem));
        const known = (this.policies.get(acct) ?? []).map((p) => p.id);
        for (const p of body.policies ?? []) if (!known.includes(p.id)) return json(400, fail(12130, `access.api.error.invalid_request: policy ${p.id} not found`));
      }
      if (!m[2] && method === 'POST') {
        const created = { ...body, id: uuid(), aud: hexId(64) } as App;
        list.push(created);
        return json(201, ok(expand(created)));
      }
      const found = list.find((a) => a.id === m![2]);
      if (!found) return json(404, fail(12130, 'access.api.error.not_found'));
      if (method === 'GET') return json(200, ok(expand(found)));
      if (method === 'PUT') {
        const { id, aud } = found;
        Object.keys(found).forEach((k) => delete (found as Record<string, unknown>)[k]);
        Object.assign(found, body, { id, aud });
        return json(200, ok(expand(found)));
      }
    }

    return json(404, fail(7003, `No route for ${method} ${path}`));
  }

  /** Access refuses a hostname outside the app's own account. */
  private destinationProblem(account: string, body: { destinations?: Array<{ uri: string }> }): string | null {
    for (const d of body.destinations ?? []) {
      const host = d.uri.split('/')[0].replace(/^\*\./, '');
      const inZone = account === this.zoneAccount && (host === 'vva227.org' || host.endsWith('.vva227.org'));
      const ownPages = account === CH227 && this.project && host === this.project.subdomain;
      if (!inZone && !ownPages) return `access.api.error.invalid_request: domain ${d.uri} does not belong to a zone in this account`;
    }
    return null;
  }

  /** The project as GET returns it: secret values blanked. */
  publicProject() {
    const blank = (c: Config): Config => ({
      ...c,
      ...(c.env_vars
        ? { env_vars: Object.fromEntries(Object.entries(c.env_vars).map(([k, v]) => [k, v.type === 'secret_text' ? { type: v.type, value: '' } : v])) }
        : {}),
    });
    const p = this.project!;
    return { ...p, deployment_configs: { production: blank(p.deployment_configs.production), preview: blank(p.deployment_configs.preview) } };
  }
}

/** Every empty object or array anywhere in a request body, by path. */
export function emptyMaps(value: unknown, path = '$'): string[] {
  if (value === null || typeof value !== 'object') return [];
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return [path];
  return entries.flatMap(([k, v]) => emptyMaps(v, `${path}.${k}`));
}
