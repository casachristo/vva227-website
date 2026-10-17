/**
 * The analytics registry — every value the beacon, the collector, the stats
 * page, public/_routes.json and the tests must agree on.
 *
 * The same fact is otherwise stated in places nothing forces to agree: the
 * <script src> in the layout, the fetch target inside the tracker, the
 * `include` list in public/_routes.json, and the route each Pages Function is
 * compiled to. Most of those are strings in files Astro never type-checks, and
 * every disagreement between them fails SILENTLY — navigator.sendBeacon()
 * returns true whether the request went out or was refused, so there is no
 * console error, no failed request in devtools and no server log, because
 * nothing reached a server.
 *
 * So no other file states any of these values literally. The contract tier
 * imports this module and checks the built artifacts against it, and fails if a
 * literal copy turns up anywhere in src/ or functions/.
 */

/** The URL the tracker is served from. Generated at build by src/pages/b.js.ts. */
export const BEACON_SCRIPT = '/b.js';

/**
 * The collector, handled by functions/api/e.ts.
 *
 * Same-origin on purpose. A hosted analytics service would need its host in
 * the CSP and would be blocked outright for a real share of visitors: filtering
 * resolvers and content blockers answer the well-known analytics hosts with
 * 0.0.0.0. A path on this site's own origin is on no filter list, and costs the
 * Content-Security-Policy no third-party origin.
 */
export const BEACON_ENDPOINT = '/api/e';

/**
 * The owner-only visit log, handled by functions/stats.ts.
 *
 * Listed here because public/_routes.json must name every path the Functions
 * runtime handles. A route that exists in functions/ but not in that file is a
 * 404 with no error anywhere.
 */
export const STATS_PATH = '/stats';

/**
 * Which site a row belongs to.
 *
 * The schema carries it from the first migration so this database can be
 * shared with another site later without backfilling rows whose origin is no
 * longer recoverable. It is also a hash input, so one person browsing two sites
 * that share a database gets two unrelated identifiers.
 */
export const SITE_KEY = 'vva227';

/**
 * How long a visitor identifier stays stable, in days.
 *
 * 1 is the strongest privacy posture: the salt window rolls every 24 hours, so
 * yesterday's identifiers cannot be linked to today's, even by whoever holds
 * the database. Nothing is stored on the visitor's device, and no long-lived
 * identifier exists anywhere.
 *
 * The cost is that a reader who comes back next week counts as a new visitor.
 * At this site's traffic the useful artifact is the visit log, where each row
 * is legible on its own, not a monthly unique-visitor total. Raising this
 * number creates a longer-lived identifier, which the privacy page would then
 * have to describe. Do not raise it without changing that page.
 */
export const SALT_PERIOD_DAYS = 1;

/**
 * How often the tracker reports reading time while the page stays visible, ms.
 *
 * pagehide is the main flush and it is not reliable: iOS Safari often freezes a
 * backgrounded tab without firing it. Without a heartbeat, someone who reads a
 * page for ten minutes and closes the tab from the app switcher is recorded as
 * reading it for zero seconds — indistinguishable from a bounce.
 */
export const HEARTBEAT_MS = 60_000;

/**
 * Field length limits, enforced on BOTH sides.
 *
 * The tracker truncates so a legitimate long URL still produces a usable row;
 * the collector truncates because anyone can post to it, and a public endpoint
 * that trusts a client's lengths stores whatever it is handed.
 */
export const MAX_PATH_CHARS = 512;
export const MAX_REFERRER_CHARS = 512;

/**
 * Hard ceiling on a request body, in bytes.
 *
 * The largest thing the tracker sends is a `view` carrying a maximum-length
 * path and referrer: about 1,100 bytes of JSON. 2 KB is that with headroom.
 * The endpoint is reachable by anyone who reads the page source, so this is
 * what stands between the D1 free tier and a stranger with curl.
 */
export const MAX_BODY_BYTES = 2_048;

/**
 * How long a row is kept, in days. 730 days is 24 months.
 *
 * A stated retention period that nothing enforces is just a sentence, so the
 * collector deletes expired rows on every `view`. Pages Functions have no cron
 * trigger, and a separate scheduled Worker to run one DELETE would be a second
 * deployable for a table that gains a few rows a day.
 *
 * Changing this number changes what the privacy page promises. Change both in
 * the same commit.
 */
export const RETENTION_DAYS = 730;

/** Event kinds the collector accepts. Anything else is refused with a 400. */
export const EVENT_VIEW = 'view';
export const EVENT_END = 'end';
export const EVENT_KINDS: readonly string[] = [EVENT_VIEW, EVENT_END];

/**
 * Hostnames that ARE this site, for telling a visitor's source from internal
 * navigation. A referrer on one of these is someone moving between pages, not
 * somewhere they came from.
 *
 * A leading "*." means any subdomain of what follows (and not the name
 * itself). Pages gives every preview deployment its own
 * <hash>.<project>.pages.dev hostname, so previews have to be matched by
 * suffix. Both pages.dev names are here: vva227-refresh-12g.pages.dev is the
 * Pages project that serves the site today, and vva227-refresh.pages.dev is
 * the staging origin src/lib/links.ts still counts as this site.
 *
 * localhost and 127.0.0.1 are here for local runs (astro preview, wrangler
 * pages dev). Compared on hostname, so any port matches.
 */
export const SITE_HOSTS: readonly string[] = [
  'vva227.org',
  'www.vva227.org',
  'vva227-refresh-12g.pages.dev',
  '*.vva227-refresh-12g.pages.dev',
  'vva227-refresh.pages.dev',
  '*.vva227-refresh.pages.dev',
  'localhost',
  '127.0.0.1',
];

/**
 * The time zone the stats page shows times and calendar days in.
 *
 * The chapter is in Northern Virginia. Stored timestamps stay UTC
 * milliseconds; only the display moves, and the page labels every time ET.
 */
export const DISPLAY_TIME_ZONE = 'America/New_York';
