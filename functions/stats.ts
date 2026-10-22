import { authorizeStats, type GateVerdict } from '../src/lib/stats-gate';
import {
  buildStatsPageData,
  pageCsp,
  parseWindow,
  renderStatsPage,
  STATS_SQL,
  statsHeaders,
  type AutomatedStat,
  type VisitRow,
} from '../src/lib/stats';
import { SITE_KEY } from '../src/data/analytics';
import { errorMessage, type AnalyticsEnv, type PagesContext } from '../src/lib/runtime';

/**
 * /stats — the visit log, for the owner only.
 *
 * THE GATE RUNS FIRST, before the method is looked at and before D1 is
 * touched. The gate itself lives in src/lib/stats-gate.ts; this handler's job
 * is to make it impossible to reach the data without passing it. A route that
 * forgets its check is what real auth bypasses are made of, far more often
 * than broken crypto.
 *
 * EVERY REFUSAL IS THE SAME 404: same status, same headers, same body, whatever
 * the reason. Not 401 — that confirms there is something here worth attacking
 * — and not a different answer for "not configured" versus "expired token",
 * which would tell a stranger how close they are. The reason goes to the log
 * (console.warn, readable with `wrangler pages deployment tail`), never to the
 * response. On a hostname the Access application covers, a stranger never
 * gets this far: Access shows its sign-in page first. This 404 is what every
 * other hostname answers.
 *
 * On a preview deployment there is no D1 binding, so even a request the gate
 * allowed gets the same 404.
 */

type Authorize = (request: Request, env: AnalyticsEnv) => Promise<GateVerdict>;

const TEXT_HEADERS: Record<string, string> = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function plain(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...TEXT_HEADERS, ...extra } });
}

/** The one refusal. Built fresh each time; identical every time. */
const notFound = () => plain(404, 'Not found');

/**
 * The handler, with its gate as a parameter.
 *
 * Production uses the real gate (the default, exported as onRequest below):
 * Cloudflare Access, verified in src/lib/stats-gate.ts. Tests pass a stand-in
 * where the question is the handler's own behaviour, and drive the real gate
 * with really signed tokens where the question is who gets in.
 */
export function createStatsHandler(authorize: Authorize = authorizeStats) {
  return async function onRequest(context: PagesContext<AnalyticsEnv>): Promise<Response> {
    const { request, env } = context;

    let verdict: GateVerdict | undefined;
    try {
      verdict = await authorize(request, env);
    } catch (err) {
      // A gate that throws has not said yes.
      verdict = { ok: false, reason: `gate error: ${errorMessage(err)}` };
    }
    // Strictly `ok === true`. A gate returning anything else — undefined, a
    // truthy string, a malformed object — has not said yes either.
    if (verdict?.ok !== true) {
      // Read defensively: the refusal path must not itself throw on a verdict
      // that is not even an object.
      const reason = (verdict as { reason?: unknown } | null | undefined)?.reason;
      console.warn('stats denied:', typeof reason === 'string' ? reason : 'no verdict');
      return notFound();
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plain(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }

    const db = env.BEACON;
    if (!db) {
      console.error('stats: BEACON binding missing');
      return notFound();
    }

    const now = Date.now();
    const { days, since } = parseWindow(new URL(request.url).searchParams, now);
    // Every value is bound. SITE_KEY and the window are the only inputs, and
    // the window is an allowlisted number by the time it gets here.
    const q = (sql: string) => db.prepare(sql).bind(SITE_KEY, since);

    let html: string;
    let csp: string;
    try {
      // Two queries: the people's rows, which every table but the last is
      // tallied from, and the set-aside table. See buildStatsSql for why.
      const [people, automated] = (await db.batch([q(STATS_SQL.people), q(STATS_SQL.automated)])).map((r) => r.results ?? []);

      html = renderStatsPage(
        buildStatsPageData({
          days,
          generatedAt: now,
          people: people as unknown as VisitRow[],
          automated: automated as AutomatedStat[],
        }),
      );
      csp = await pageCsp();
    } catch (err) {
      // The owner is past the gate, so an honest 500 is useful to them. The
      // body still says nothing about the schema.
      console.error('stats query failed', errorMessage(err));
      return plain(500, 'Stats unavailable');
    }

    return new Response(request.method === 'HEAD' ? null : html, { status: 200, headers: statsHeaders(csp) });
  };
}

export const onRequest = createStatsHandler();
