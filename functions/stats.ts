import { authorizeStats, type GateVerdict } from '../src/lib/stats-gate';
import {
  groupVisitorDays,
  pageCsp,
  parseWindow,
  RECENT_VISITORS_LIMIT,
  renderStatsPage,
  STATS_SQL,
  statsHeaders,
  summarizeSources,
  type LocationStat,
  type NetworkStat,
  type PageStat,
  type SummaryRow,
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
 * — and not a different answer for "not configured" versus "wrong password",
 * which would tell a stranger how close they are. The reason goes to the log
 * (console.warn, readable with `wrangler pages deployment tail`), never to the
 * response.
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
 * Production uses the real gate (the default, exported as onRequest below).
 * Tests pass a stand-in to reach the allowed path while the real gate still
 * refuses everyone — and separately prove the real one refuses.
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
    const q = (sql: string, ...extra: unknown[]) => db.prepare(sql).bind(SITE_KEY, since, ...extra);

    let html: string;
    let csp: string;
    try {
      const [summary, visits, pages, referrers, locations, networks] = (
        await db.batch([
          q(STATS_SQL.summary),
          q(STATS_SQL.visits, RECENT_VISITORS_LIMIT),
          q(STATS_SQL.pages),
          q(STATS_SQL.referrers),
          q(STATS_SQL.locations),
          q(STATS_SQL.networks),
        ])
      ).map((r) => r.results ?? []);

      html = renderStatsPage({
        days,
        generatedAt: now,
        summary: (summary[0] as SummaryRow | undefined) ?? { views: 0, visitors: 0, pages: 0 },
        visitors: groupVisitorDays(visits as unknown as VisitRow[], RECENT_VISITORS_LIMIT),
        pages: pages as PageStat[],
        sources: summarizeSources(referrers as Array<{ referrer: unknown; views: unknown }>),
        locations: locations as LocationStat[],
        networks: networks as NetworkStat[],
      });
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
