import {
  geoFromCf,
  PRUNE_SQL,
  pruneCutoff,
  readBodyCapped,
  saltWindow,
  UPSERT_SQL,
  upsertBindings,
  validateEvent,
  visitorHash,
} from '../../src/lib/beacon';
import { COLLECT_HOSTS, EVENT_VIEW, MAX_BODY_BYTES, SITE_KEY } from '../../src/data/analytics';
import { errorMessage, type AnalyticsEnv, type PagesContext } from '../../src/lib/runtime';
import { isSiteHost } from '../../src/lib/stats';

/**
 * The collector, at BEACON_ENDPOINT. One append-only endpoint that anyone who
 * reads the page source can post to, so its input handling and its host and
 * origin checks are the whole of its defence — a beacon cannot carry a
 * credential, because the credential would ship in the page.
 *
 * A thin shell: what it accepts is decided by src/lib/beacon.ts.
 *
 * ROUTING. public/_routes.json pins the Functions runtime to this path and
 * /stats. That is not tidiness: Pages generates `include: ["/*"]` by itself the
 * moment a functions/ directory exists, and public/_redirects is NOT applied
 * to a request the Functions runtime claims. Without the pin, adding this file
 * would put all 50 legacy redirects at risk.
 *
 * THE WRITE IS AWAITED rather than handed to waitUntil(). Returning 204 first
 * and writing in the background would be marginally kinder to the visitor and
 * would make a failing write invisible to every test that can reach this
 * endpoint — on a feature whose entire failure mode is silence. At this
 * traffic the latency is irrelevant and the observability is not.
 */

/**
 * Headers on EVERY response from this handler.
 *
 * public/_headers governs static asset responses only. A Function's response
 * inherits none of it, so anything this endpoint should carry, it states.
 */
const BASE_HEADERS: Record<string, string> = {
  // A cached 204 would let a browser skip the request on the next pageview.
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function noContent(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...BASE_HEADERS,
      // Same-origin by design. Stated explicitly so this can never become a
      // service other sites post to, whatever a future platform default is.
      'Access-Control-Allow-Origin': 'null',
    },
  });
}

/** A refusal. The body names the rule broken and never echoes a database error. */
function refuse(status: number, reason: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json', ...extra },
  });
}

export async function onRequest(context: PagesContext<AnalyticsEnv>): Promise<Response> {
  const { request, env } = context;

  // 1. Method. onRequest rather than onRequestPost, so every verb gets a
  //    deterministic answer from this handler rather than a platform default.
  if (request.method !== 'POST') {
    return refuse(405, 'method not allowed', { Allow: 'POST' });
  }

  // 2. Host. Only the domain itself writes (COLLECT_HOSTS). Pages runs this
  //    same Function, with the production database and salt, on the
  //    project's pages.dev address, which a rate-limiting rule on the
  //    vva227.org zone does not cover; left open, it would be the way round
  //    that rule. Checked before the body is read, like the origin below.
  if (!isSiteHost(new URL(request.url).hostname, COLLECT_HOSTS)) {
    return refuse(403, 'wrong host');
  }

  // 3. Origin, checked BEFORE the body is read: another site's page cannot use
  //    this endpoint at all, and cannot map the request contract by probing it
  //    with malformed bodies.
  //
  //    A MISSING Origin is allowed; a MISMATCHED one is refused. Every browser
  //    sends Origin on a cross-origin POST, so the mismatch catches what is
  //    worth catching. Requiring the header would risk silently dropping our
  //    own traffic from any transport that omits it.
  //
  //    Compared against THIS REQUEST's origin, so the rule moves with the
  //    host: vva227.org and www.vva227.org each accept their own pages and
  //    neither accepts the other's.
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return refuse(403, 'cross-origin');
  }

  // 4. Size: the declared length first, so an obviously oversized body is
  //    refused before a byte of it is read; then the real length while reading.
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return refuse(413, 'body too large');
  }

  let raw: unknown;
  try {
    const text = await readBodyCapped(request.body, MAX_BODY_BYTES);
    if (text === null) return refuse(413, 'body too large');
    raw = JSON.parse(text);
  } catch {
    return refuse(400, 'invalid JSON');
  }

  // 5. Fields. Everything past this point is bound into a prepared statement;
  //    nothing is interpolated into SQL.
  const result = validateEvent(raw);
  if (!result.ok) return refuse(400, result.reason);
  const { event } = result;

  const db = env.BEACON;
  const secret = env.BEACON_SALT;
  if (!db || !secret) {
    // Loud on purpose. A missing binding or salt is a deploy mistake, and the
    // alternatives — a constant fallback salt, or quietly not writing — would
    // leave the site looking healthy while collecting nothing, or while
    // producing identifiers anyone could recompute. The tracker ignores this
    // answer, so the log line is what makes it loud: it is the only place
    // the owner can read that the site has stopped counting, and which
    // setting is to blame. (Previews, which get no binding and no salt, never
    // reach this: their hostnames are refused above.)
    const missing = [!db && 'BEACON binding', !secret && 'BEACON_SALT'].filter(Boolean).join(' and ');
    console.error('collector not configured:', `${missing} missing`);
    return refuse(500, 'collector not configured');
  }

  const now = Date.now();
  const visitor = await visitorHash({
    secret,
    window: saltWindow(now),
    site: SITE_KEY,
    // Hash inputs only. Neither is stored, logged or returned — this line is
    // the only place the IP is read at all.
    ip: request.headers.get('CF-Connecting-IP'),
    ua: request.headers.get('User-Agent'),
  });

  try {
    await db
      .prepare(UPSERT_SQL)
      .bind(...upsertBindings({ event, site: SITE_KEY, visitor, geo: geoFromCf(request.cf), now }))
      .run();
  } catch (err) {
    // Never surfaced to the page: the tracker ignores the response anyway, and
    // an error body is a free description of the schema.
    console.error('beacon write failed', errorMessage(err));
    return refuse(500, 'write failed');
  }

  // Retention. Only on a `view`, so it runs once per pageview rather than on
  // every flush, and inside waitUntil() so a slow or failed prune can never
  // cost a visit — the row this request came for is already committed.
  //
  // The inline fallback is not a test affordance: a runtime that offers no
  // waitUntil would DROP the promise, and silently skipping retention is the
  // one outcome that turns the stated retention period into a false statement.
  if (event.kind === EVENT_VIEW) {
    const prune = (async () => {
      try {
        await db.prepare(PRUNE_SQL).bind(pruneCutoff(now)).run();
      } catch (err) {
        console.error('beacon prune failed', errorMessage(err));
      }
    })();
    if (typeof context.waitUntil === 'function') context.waitUntil(prune);
    else await prune;
  }

  return noContent();
}
