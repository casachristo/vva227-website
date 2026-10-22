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
 * 1 is the strongest privacy posture: the salt window changes every day, at
 * midnight Eastern time (where /stats starts a new day; see saltWindow in
 * src/lib/beacon.ts), so the identifiers alone do not link yesterday's
 * visitors to today's, even for whoever holds the database. Whoever also
 * holds BEACON_SALT can link an IPv4 visitor's days: see Known gaps in
 * tests/BUSINESS_RULES.md. Nothing is stored on the visitor's device, and no
 * long-lived identifier is stored anywhere.
 *
 * The cost is that a reader who comes back next week counts as a new visitor.
 * At this site's traffic the useful artifact is the visit log, where each row
 * is legible on its own, not a monthly unique-visitor total. Raising this
 * number creates a longer-lived identifier, which the privacy page would then
 * have to describe: it says the code "changes every day", and
 * tests/invariants/privacy-disclosure.test.ts fails if this is raised without
 * changing that page.
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
 * This caps what ONE request can make the collector read and store. It does
 * nothing about how many requests arrive: a stranger with curl can still post
 * as fast as they like. What slows that down is the optional rate-limiting
 * rule in docs/analytics.md; what it cannot stop is under Known gaps in
 * tests/BUSINESS_RULES.md.
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
 * The privacy page states this period, as RETENTION_MONTHS below, so changing
 * it changes that page's promise by itself. tests/invariants/privacy-
 * disclosure.test.ts fails on a period that is not a whole number of months.
 */
export const RETENTION_DAYS = 730;

/** RETENTION_DAYS as the privacy page states it: in months, of 365/12 days. */
export const RETENTION_MONTHS = (RETENTION_DAYS * 12) / 365;

/** Event kinds the collector accepts. Anything else is refused with a 400. */
export const EVENT_VIEW = 'view';
export const EVENT_END = 'end';
export const EVENT_KINDS: readonly string[] = [EVENT_VIEW, EVENT_END];

/** The chapter's own domain: the names its links and search results use. */
const PRODUCTION_HOSTS = ['vva227.org', 'www.vva227.org'];

/** Local runs (astro preview, wrangler pages dev). Compared on hostname, so any port matches. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

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
 */
export const SITE_HOSTS: readonly string[] = [
  ...PRODUCTION_HOSTS,
  'vva227-refresh-12g.pages.dev',
  '*.vva227-refresh-12g.pages.dev',
  'vva227-refresh.pages.dev',
  '*.vva227-refresh.pages.dev',
  ...LOCAL_HOSTS,
];

/**
 * Hostnames the collector writes for. Every other name that reaches it is
 * refused before the body is read.
 *
 * Narrower than SITE_HOSTS on purpose. Pages runs the same Function, with the
 * same production database and salt, on vva227-refresh-12g.pages.dev, and a
 * rate-limiting rule on the vva227.org zone does not cover that name. Left
 * open, it would be a way round the rule. Visits to the pages.dev addresses
 * and to previews are therefore not recorded; previews have no database
 * anyway.
 *
 * The loopback names are what the runtime tests serve the site on.
 */
export const COLLECT_HOSTS: readonly string[] = [...PRODUCTION_HOSTS, ...LOCAL_HOSTS];

/**
 * Visits /stats sets aside as likely automated, rather than counting as people.
 *
 * Measured, not guessed. In the log's first four and a half days (2026-10-18
 * to 22), 336 visitor-days were recorded and about seven looked like people.
 * The rest were crawlers that run JavaScript, so they set off the beacon as a
 * reader would. Counted as people, they pushed the one visitor who arrived
 * from Google off Recent visitors and made every total meaningless.
 *
 * Nothing is deleted and nothing new is stored: /stats sorts the rows it
 * already has, and lists what it set aside, with the reason and the network,
 * at the end of the page, where a misjudged visit can be seen. A visit is set
 * aside only on evidence Cloudflare supplies (the network, the country) or
 * that EVERY view of the day carries (the window, no reading time), so a
 * hand-built post can set aside nobody's visits but its own.
 *
 * NEVER list a network that carries private-relay users: Cloudflare (13335),
 * Akamai (36183) and Fastly (54113) carry iCloud Private Relay and WARP, which
 * is to say ordinary readers. tests/invariants/stats-partition.test.ts holds it.
 *
 * Group and match by network NUMBER. The name Cloudflare reports is whoever
 * registered that block of addresses, so one network shows up under several
 * names (Tencent's as "Aceville Pte Ltd" and "16 Collyer Quay").
 */

/** Networks that have sent this site nothing but crawlers. Any visit from one is set aside. Owners from bgp.he.net and ipinfo.io, 2026-10-21. */
export const CRAWLER_NETWORKS: ReadonlyArray<{ asn: number; owner: string }> = [
  { asn: 132203, owner: 'Tencent Cloud' },
  { asn: 45090, owner: 'Tencent Cloud' },
  { asn: 136907, owner: 'Huawei Cloud' },
  { asn: 55990, owner: 'Huawei Cloud' },
  { asn: 134756, owner: 'China Telecom’s Nanjing data centre' },
];

/**
 * Browser window sizes only crawlers have used here. A visitor-day is set aside
 * when EVERY view it made had one of them, so a reader who resized a window to
 * one of these by chance is still counted.
 */
export const CRAWLER_WINDOWS: ReadonlyArray<{ width: number; height: number; seenFrom: string }> = [
  { width: 1800, height: 1125, seenFrom: 'Tencent Cloud, Amazon and Chinese home and mobile networks; one view in about two hundred recorded any reading time' },
  { width: 1024, height: 569, seenFrom: 'Microsoft data centres only (Bing’s page renderer)' },
];

/**
 * Big companies' data-centre networks. Their staff browse from some of them
 * too, so a visit from one is set aside only when no view recorded any
 * reading time: a crawler or link checker that loaded the page and left.
 */
export const NOTHING_READ_NETWORKS: ReadonlyArray<{ asn: number; owner: string }> = [
  { asn: 15169, owner: 'Google' },
  { asn: 396982, owner: 'Google' },
  { asn: 8075, owner: 'Microsoft' },
  { asn: 16509, owner: 'Amazon' },
  { asn: 14618, owner: 'Amazon' },
  { asn: 32934, owner: 'Meta' },
];

/**
 * Countries the crawlers come from and the chapter's readers do not. A visit
 * from one is set aside only when no view recorded any reading time. Cloudflare's
 * two-letter codes.
 */
export const NOTHING_READ_COUNTRIES: ReadonlyArray<{ code: string; name: string }> = [{ code: 'CN', name: 'mainland China' }];

/**
 * The time zone the stats page shows times and calendar days in.
 *
 * The chapter is in Northern Virginia. Stored timestamps stay UTC
 * milliseconds; only the display moves, and the page labels every time ET.
 */
export const DISPLAY_TIME_ZONE = 'America/New_York';
