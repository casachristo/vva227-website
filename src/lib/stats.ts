/**
 * The /stats page: its queries, its grouping and its rendering, with no
 * plumbing.
 *
 * functions/stats.ts is a thin shell around this, so what a window means, how
 * a visitor-day is assembled, how a hostile path is escaped and what the page
 * says when there is no data are all testable without a Workers runtime.
 *
 * EVERYTHING RENDERED HERE IS ATTACKER-CONTROLLED. `path` and `referrer` are
 * whatever anyone chose to POST at the collector, which is public by
 * necessity. So this is a page that displays hostile input to the one person
 * allowed to see it, and escaping is a security control, not formatting. The
 * page's CSP (no script source at all) is the second layer — but a page that
 * relies on its CSP to be safe becomes unsafe the day the CSP is relaxed.
 */

import {
  CRAWLER_NETWORKS,
  CRAWLER_WINDOWS,
  NOTHING_READ_COUNTRIES,
  NOTHING_READ_NETWORKS,
  SALT_PERIOD_DAYS,
  SITE_HOSTS,
} from '../data/analytics';
import { stripQuery } from './beacon';
import { easternParts } from './eastern';

/** The windows the page offers, in days. Anything else falls back to the default. */
export const WINDOWS: readonly number[] = [7, 30, 90, 365];
export const DEFAULT_DAYS = 30;

/** Most visitor-days listed in "Recent visitors". */
export const RECENT_VISITORS_LIMIT = 100;

/** Rows shown in each of the smaller tables. */
export const TABLE_LIMIT = 25;

const MS_PER_DAY = 86_400_000;

/**
 * Read the window from the query string.
 *
 * A value that is not on the list falls back to the default rather than
 * erroring — this is a URL a person edits by hand, and a 400 for "?days=45"
 * would be ceremony. But it is an ALLOWLIST, not a clamp: the value becomes a
 * bound timestamp, and accepting any number invites someone to find out what
 * days=999999999999 does to a cold database.
 */
export function parseWindow(
  searchParams: URLSearchParams | null | undefined,
  nowMs: number,
): { days: number; since: number } {
  const raw = Number(searchParams?.get('days'));
  const days = WINDOWS.includes(raw) ? raw : DEFAULT_DAYS;
  return { days, since: nowMs - days * MS_PER_DAY };
}

export function escapeHtml(value: unknown): string {
  // Ampersand first, so the entities produced below are not escaped twice.
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Milliseconds as a human duration. Zero is a real answer, not a missing one. */
export function formatDuration(ms: unknown): string {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  return secs ? `${mins}m ${secs}s` : `${mins}m`;
}

/** A count as a whole number. Anything that is not one renders as 0, never NaN. */
export function formatCount(value: unknown): string {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? String(n) : '0';
}

/** The Eastern calendar day a timestamp falls on, as YYYY-MM-DD. See src/lib/eastern.ts. */
export function etDay(ts: unknown): string {
  const p = easternParts(ts);
  return p ? `${p.year}-${p.month}-${p.day}` : 'unknown';
}

/** A timestamp as "YYYY-MM-DD HH:MM" Eastern time. The page labels it ET. */
export function formatEt(ts: unknown): string {
  const p = easternParts(ts);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : '-';
}

/** Mobile or desktop, from the recorded viewport width. Unknown stays unknown. */
export function deviceOf(width: unknown): string {
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return '-';
  return width < 700 ? 'mobile' : 'desktop';
}

/** "Fairfax, VA, US" from whichever parts are known; "-" if none are. */
export function formatPlace(
  { city, region, country }: { city?: unknown; region?: unknown; country?: unknown } = {},
): string {
  const parts = [city, region, country]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);
  return parts.length ? parts.join(', ') : '-';
}

/**
 * The network's name, else its number, else "-".
 *
 * The number is the stable key for grouping; the name is what a person reads.
 */
export function formatNetwork({ as_org: org, asn }: { as_org?: unknown; asn?: unknown } = {}): string {
  const name = typeof org === 'string' ? org.trim() : '';
  if (name) return name;
  return typeof asn === 'number' && Number.isFinite(asn) && asn > 0 ? `AS${asn}` : '-';
}

/**
 * The network's name and number, "Verizon Business (AS701)", where the
 * set-aside table needs both: the registry's lists go by number, and one
 * network shows up under several names. Falls back as formatNetwork does.
 */
export function formatNetworkWithNumber(net: { as_org?: unknown; asn?: unknown } = {}): string {
  const name = typeof net.as_org === 'string' ? net.as_org.trim() : '';
  const asn = net.asn;
  if (name && typeof asn === 'number' && Number.isFinite(asn) && asn > 0) return `${name} (AS${asn})`;
  return formatNetwork(net);
}

/** The first six hex characters of a visitor hash — enough to tell rows apart by eye. */
export function shortVisitor(hash: unknown): string {
  return String(hash ?? '').slice(0, 6);
}

/**
 * Is this hostname this site? Matched against SITE_HOSTS, where "*.x" means
 * any subdomain of x. Case-insensitive and tolerant of the fully-qualified
 * trailing dot, as DNS is — the same normalisation src/lib/links.ts applies.
 */
export function isSiteHost(hostname: string, hosts: readonly string[] = SITE_HOSTS): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  return hosts.some((pattern) => {
    if (!pattern.startsWith('*.')) return host === pattern;
    const suffix = pattern.slice(1);
    return host.length > suffix.length && host.endsWith(suffix);
  });
}

export type ReferrerClass =
  /** No referrer: typed in, bookmarked, or a policy that sends none. */
  | { kind: 'direct' }
  /** A page on this site: someone moving between pages, not a source. */
  | { kind: 'internal'; host: string }
  /** Somewhere else: where the visitor actually came from. */
  | { kind: 'external'; host: string };

/**
 * What a stored referrer means, reduced to the host a reader cares about.
 *
 * A value that will not parse as a URL is still somewhere the client claimed
 * to come from, so it is shown — query-stripped and cut short — rather than
 * silently counted as direct. It can only have come from a hand-built post;
 * the escaping in this file is what makes showing it safe.
 */
export function classifyReferrer(referrer: unknown): ReferrerClass {
  if (typeof referrer !== 'string' || !referrer.trim()) return { kind: 'direct' };
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return { kind: 'external', host: stripQuery(referrer.trim()).slice(0, 64) };
  }
  if (!url.host) return { kind: 'external', host: stripQuery(referrer.trim()).slice(0, 64) };
  return isSiteHost(url.hostname) ? { kind: 'internal', host: url.host } : { kind: 'external', host: url.host };
}

/** One row as the recent-visitors query returns it. */
export interface VisitRow {
  view?: string;
  visitor: string;
  ts: number;
  path: string;
  referrer: string | null;
  country: string | null;
  city: string | null;
  region: string | null;
  asn: number | null;
  as_org: string | null;
  viewport_w: number | null;
  engaged_ms: number;
}

/** One visitor on one Eastern calendar day: a row of "Recent visitors". */
export interface VisitorDay {
  visitor: string;
  day: string;
  firstSeen: number;
  lastSeen: number;
  place: string;
  network: string;
  device: string;
  /** Host of the first external referrer that day, or null for direct. */
  source: string | null;
  /** Path of that day's earliest view. */
  entry: string;
  views: number;
  engagedMs: number;
}

const byTimeThenId = (a: VisitRow, b: VisitRow) =>
  a.ts - b.ts || String(a.view ?? '').localeCompare(String(b.view ?? '')) || a.path.localeCompare(b.path);

/**
 * Group visit rows into visitor-days: one per visitor hash per Eastern
 * calendar day.
 *
 * WHY THE DAY IS PART OF THE KEY when the hash already changes at midnight
 * Eastern time: that holds only while SALT_PERIOD_DAYS is 1. With a longer
 * period one hash spans several of the owner's days, and keyed on the hash
 * alone it would be one row covering all of them.
 *
 * Which visitor-days are kept: the `limit` most recently ACTIVE (latest view),
 * cut here from every row of people in the window (STATS_SQL.people). They
 * are then shown newest arrival first, so the "first seen" column reads in
 * order.
 *
 * Within a visitor-day:
 *   entry   — the earliest view's path
 *   source  — the host of the FIRST external referrer; internal referrers are
 *             movement between pages, and a later page does not change where
 *             someone came from
 *   place, network, device — from the earliest row that has them. One hash
 *             is one IP and user agent, so these do not legitimately vary
 *             within a day; taking each from its own earliest row avoids
 *             printing a dash just because the first view lacked one.
 */
export function groupVisitorDays(rows: readonly VisitRow[], limit: number = RECENT_VISITORS_LIMIT): VisitorDay[] {
  const groups = new Map<string, VisitRow[]>();
  for (const row of rows) {
    const key = `${row.visitor}|${etDay(row.ts)}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const days: VisitorDay[] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort(byTimeThenId);
    const first = sorted[0];
    const withPlace = sorted.find((r) => formatPlace(r) !== '-');
    const withNetwork = sorted.find((r) => formatNetwork(r) !== '-');
    const withDevice = sorted.find((r) => deviceOf(r.viewport_w) !== '-');
    let source: string | null = null;
    for (const r of sorted) {
      const ref = classifyReferrer(r.referrer);
      if (ref.kind === 'external') {
        source = ref.host;
        break;
      }
    }
    days.push({
      visitor: first.visitor,
      day: etDay(first.ts),
      firstSeen: first.ts,
      lastSeen: sorted[sorted.length - 1].ts,
      place: withPlace ? formatPlace(withPlace) : '-',
      network: withNetwork ? formatNetwork(withNetwork) : '-',
      device: withDevice ? deviceOf(withDevice.viewport_w) : '-',
      source,
      entry: first.path,
      views: sorted.length,
      engagedMs: sorted.reduce((sum, r) => sum + (Number(r.engaged_ms) || 0), 0),
    });
  }

  const tie = (a: VisitorDay, b: VisitorDay) => a.visitor.localeCompare(b.visitor) || a.day.localeCompare(b.day);
  return days
    .sort((a, b) => b.lastSeen - a.lastSeen || b.firstSeen - a.firstSeen || tie(a, b))
    .slice(0, Math.max(0, limit))
    .sort((a, b) => b.firstSeen - a.firstSeen || b.lastSeen - a.lastSeen || tie(a, b));
}

export interface SourceRow {
  host: string;
  views: number;
}

/**
 * Arrivals per external host, from per-referrer counts.
 *
 * The query groups by the full stored referrer; several of those share a host
 * (every page of a site that sends full URLs), so they are summed here.
 * Internal referrers and direct arrivals are dropped: Sources answers where
 * people came FROM.
 */
export function summarizeSources(
  rows: ReadonlyArray<{ referrer: unknown; views: unknown }>,
  limit: number = TABLE_LIMIT,
): SourceRow[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const ref = classifyReferrer(row.referrer);
    if (ref.kind !== 'external') continue;
    totals.set(ref.host, (totals.get(ref.host) ?? 0) + (Number(row.views) || 0));
  }
  return [...totals]
    .map(([host, views]) => ({ host, views }))
    .sort((a, b) => b.views - a.views || a.host.localeCompare(b.host))
    .slice(0, Math.max(0, limit));
}

/** Why a visitor-day was set aside, as the automated query names it. */
export type AutomatedReason = 'crawler-network' | 'crawler-window' | 'network-nothing-read' | 'country-nothing-read';

/** The lists the rule is built from. A parameter, so a test can build the rule from other lists. */
export interface AutomatedLists {
  crawlerNetworks: ReadonlyArray<{ asn: number; owner: string }>;
  crawlerWindows: ReadonlyArray<{ width: number; height: number }>;
  nothingReadNetworks: ReadonlyArray<{ asn: number; owner: string }>;
  nothingReadCountries: ReadonlyArray<{ code: string; name: string }>;
}

/** The registry's lists. See CRAWLER_NETWORKS in src/data/analytics.ts for why each exists. */
export const AUTOMATED_LISTS: AutomatedLists = {
  crawlerNetworks: CRAWLER_NETWORKS,
  crawlerWindows: CRAWLER_WINDOWS,
  nothingReadNetworks: NOTHING_READ_NETWORKS,
  nothingReadCountries: NOTHING_READ_COUNTRIES,
};

/** A list value as SQL text. Written into the statement, not bound, so it is checked here. */
function sqlInt(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`automated lists: ${String(value)} is not a positive whole number`);
  }
  return String(value);
}

function sqlCountry(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value)) {
    throw new Error(`automated lists: ${JSON.stringify(value)} is not a two-letter country code`);
  }
  return `'${value}'`;
}

/** "column IN (…)", or a condition that is false for every row when the list is empty. */
function inList(column: string, values: string[]): string {
  return values.length ? `${column} IN (${values.join(', ')})` : '0';
}

/**
 * The reason a visitor-day is set aside, as an SQL expression over one
 * visitor's rows (it runs under GROUP BY visitor), or NULL for a person.
 *
 * max() means "on any view", min() means "on every view". Network and country
 * come from Cloudflare and are the same on every row of one visitor code (one
 * IP), so "any" is safe for them. The window and the reading time are posted
 * by the browser, so anyone sharing a reader's network and browser could post
 * a view under that reader's code: those rules ask for every view (min) or
 * none read (max = 0), which a forged view can only move away from "set aside".
 *
 * A row with no window size counts AGAINST "every view was crawler-sized"
 * (the coalesce): otherwise a reader whose only rows have none, such as an
 * `end` whose `view` was lost, could be set aside by one forged crawler-sized
 * view. For the "any" rules a NULL simply never matches.
 */
export function automatedReasonSql(lists: AutomatedLists = AUTOMATED_LISTS): string {
  const crawlerNetworks = inList('asn', lists.crawlerNetworks.map((n) => sqlInt(n.asn)));
  const windows = lists.crawlerWindows.map((w) => `(viewport_w = ${sqlInt(w.width)} AND viewport_h = ${sqlInt(w.height)})`);
  const crawlerWindow = windows.length ? windows.join(' OR ') : '0';
  const nothingReadNetworks = inList('asn', lists.nothingReadNetworks.map((n) => sqlInt(n.asn)));
  const nothingReadCountries = inList('country', lists.nothingReadCountries.map((c) => sqlCountry(c.code)));
  return `CASE
      WHEN max(${crawlerNetworks}) = 1 THEN 'crawler-network'
      WHEN min(coalesce(${crawlerWindow}, 0)) = 1 THEN 'crawler-window'
      WHEN max(engaged_ms) = 0 AND max(${nothingReadNetworks}) = 1 THEN 'network-nothing-read'
      WHEN max(engaged_ms) = 0 AND max(${nothingReadCountries}) = 1 THEN 'country-nothing-read'
    END`;
}

/**
 * How far before the window's start a visitor's rows are still read when they
 * are judged, ms: one visitor code's whole lifetime (SALT_PERIOD_DAYS) plus an
 * hour for the 25-hour day daylight saving makes once a year. Without it, a
 * code that began before the window would be judged on its in-window rows
 * alone, and the same reader could be set aside in one window and counted in
 * another.
 */
export const JUDGE_LOOKBACK_MS = SALT_PERIOD_DAYS * MS_PER_DAY + 60 * 60 * 1000;

/**
 * Most rows of people one load of the page tallies. Far above this site's
 * readership; reached only if a crawler the lists do not know floods a long
 * window, and then the page says so rather than quietly undercounting.
 */
export const PEOPLE_ROW_LIMIT = 20_000;

/**
 * The visitors set aside, one row each, as a named subquery ("automated"):
 * why, their network (its number and name), and how many of their views fall
 * in the window. Bound as (?1 site, ?2 since).
 *
 * Judged on every row of the visitor code (JUDGE_LOOKBACK_MS), kept only if
 * the code has a view in the window. Judged per code, which is per
 * visitor-day while SALT_PERIOD_DAYS is 1.
 *
 * INDEXED BY views_site_ts keeps the judgment to the window. Left to itself
 * the planner reads the site's whole history through views_site_visitor_ts,
 * which grows with the retention period rather than the window.
 */
export function automatedCte(lists: AutomatedLists = AUTOMATED_LISTS): string {
  return `automated AS (
      SELECT visitor, reason, asn, as_org, views FROM (
        SELECT visitor, ${automatedReasonSql(lists)} AS reason,
          max(asn) AS asn, max(as_org) AS as_org, sum(ts >= ?2) AS views
        FROM views INDEXED BY views_site_ts
        WHERE site = ?1 AND ts >= ?2 - ${JUDGE_LOOKBACK_MS}
        GROUP BY visitor
      ) WHERE reason IS NOT NULL AND views > 0
    )`;
}

/**
 * The page's two queries. Bound as (?1 site, ?2 since). Nothing that comes
 * from a request is interpolated: only the limits and the registry's lists
 * are, and automatedReasonSql checks each list value before writing it.
 *
 * WHY TWO, AND WHY THE TABLES ARE TALLIED IN CODE. Judging visitors means
 * grouping every row in the window by visitor, and D1 bills that at about four
 * rows read per row. Each table as its own query would judge again, seven
 * times a load. Here it is judged twice: once to pick out the people's rows,
 * which tallyPeople() turns into every table but the last, and once for the
 * set-aside table, which needs nothing but the judgment. Measured on the
 * production database (2026-10-22): about 10 rows read per row in the window,
 * against 11 for the six queries before crawlers were set aside, and 45 for
 * seven judging queries.
 *
 * tests/invariants/stats-partition.test.ts proves every visitor lands in
 * exactly one of the two (A22 in tests/BUSINESS_RULES.md).
 *
 * Kept deliberately plain because D1 is stricter than the SQLite the tests run
 * on: it refuses a compound SELECT of more than five terms and a statement
 * with more than 100 bound parameters, both of which node:sqlite accepts. The
 * lists are written into the statement rather than bound for that reason.
 */
export function buildStatsSql(lists: AutomatedLists = AUTOMATED_LISTS, { peopleRowLimit = PEOPLE_ROW_LIMIT } = {}) {
  const withAutomated = `WITH ${automatedCte(lists)}`;
  return {
    // Every view in the window by a visitor not set aside, newest first, so a
    // window past the limit keeps its most recent rows.
    people: `${withAutomated}
    SELECT view, visitor, ts, path, referrer, country, city, region, asn, as_org, viewport_w, engaged_ms
    FROM views
    WHERE site = ?1 AND ts >= ?2 AND visitor NOT IN (SELECT visitor FROM automated)
    ORDER BY ts DESC
    LIMIT ${sqlInt(peopleRowLimit)}`,
    // What was set aside, per reason and network. Every row, never cut short:
    // a misjudged person shows up as a one-visitor row, the first a limit
    // would drop. Its size is bounded by reasons times networks.
    automated: `${withAutomated}
    SELECT reason, asn, max(as_org) AS as_org, COUNT(*) AS visitors, SUM(views) AS views
    FROM automated
    GROUP BY reason, asn
    ORDER BY visitors DESC, views DESC, reason, asn`,
  } as const;
}

export const STATS_SQL = buildStatsSql();

/**
 * SQLite's order for the values these tables sort on: NULL first, numbers by
 * value, text by code point (its default BINARY collation, near enough), so
 * the tables keep the tie-breaks they had when SQL sorted them.
 */
function sqlOrder(a: unknown, b: unknown): number {
  const nullA = a === null || a === undefined;
  const nullB = b === null || b === undefined;
  if (nullA || nullB) return nullA === nullB ? 0 : nullA ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The larger of two names by sqlOrder, skipping NULL, as SQL's max() does. */
function maxText(a: string | null, b: unknown): string | null {
  if (typeof b !== 'string') return a;
  return a === null || sqlOrder(b, a) > 0 ? b : a;
}

/** Every table but the set-aside one, tallied from the people's rows. */
export interface PeopleTally {
  summary: { views: number; visitors: number; pages: number };
  visitors: VisitorDay[];
  pages: PageStat[];
  sources: SourceRow[];
  locations: LocationStat[];
  networks: NetworkStat[];
}

/**
 * Tally the people's rows into the page's tables: what the summary, Pages,
 * Locations and Networks queries used to compute, with the same counts,
 * order and limits (A20).
 *
 *   summary   — views, distinct visitor codes, distinct paths
 *   pages     — views and average reading time per path; by views, then path
 *   sources   — external hosts, via summarizeSources
 *   locations — distinct visitors and views per (country, region, city), the
 *               unknown parts grouped together; by visitors, views, then place
 *   networks  — per network NUMBER, shown by its (largest) name; rows with no
 *               number are left out; by visitors, views, then number
 *   visitors  — groupVisitorDays, which makes the Recent visitors cut itself
 */
export function tallyPeople(
  rows: readonly VisitRow[],
  { tableLimit = TABLE_LIMIT, visitorLimit = RECENT_VISITORS_LIMIT }: { tableLimit?: number; visitorLimit?: number } = {},
): PeopleTally {
  const visitorCodes = new Set<string>();
  const paths = new Map<string, { views: number; engaged: number }>();
  const referrers: Array<{ referrer: unknown; views: number }> = [];
  const places = new Map<string, { country: string | null; region: string | null; city: string | null; visitors: Set<string>; views: number }>();
  const networks = new Map<number, { as_org: string | null; visitors: Set<string>; views: number }>();

  for (const row of rows) {
    visitorCodes.add(row.visitor);

    const page = paths.get(row.path) ?? { views: 0, engaged: 0 };
    page.views += 1;
    page.engaged += Number(row.engaged_ms) || 0;
    paths.set(row.path, page);

    if (row.referrer !== null && row.referrer !== undefined) referrers.push({ referrer: row.referrer, views: 1 });

    const place = { country: row.country ?? null, region: row.region ?? null, city: row.city ?? null };
    const placeKey = JSON.stringify([place.country, place.region, place.city]);
    const where = places.get(placeKey) ?? { ...place, visitors: new Set<string>(), views: 0 };
    where.visitors.add(row.visitor);
    where.views += 1;
    places.set(placeKey, where);

    if (typeof row.asn === 'number') {
      const net = networks.get(row.asn) ?? { as_org: null, visitors: new Set<string>(), views: 0 };
      net.as_org = maxText(net.as_org, row.as_org);
      net.visitors.add(row.visitor);
      net.views += 1;
      networks.set(row.asn, net);
    }
  }

  const limit = (n: number) => Math.max(0, n);
  return {
    summary: { views: rows.length, visitors: visitorCodes.size, pages: paths.size },
    visitors: groupVisitorDays(rows, visitorLimit),
    pages: [...paths]
      .map(([path, p]) => ({ path, views: p.views, avg_engaged: p.engaged / p.views }))
      .sort((a, b) => b.views - a.views || sqlOrder(a.path, b.path))
      .slice(0, limit(tableLimit)),
    sources: summarizeSources(referrers, tableLimit),
    locations: [...places.values()]
      .map((l) => ({ country: l.country, region: l.region, city: l.city, visitors: l.visitors.size, views: l.views }))
      .sort(
        (a, b) =>
          b.visitors - a.visitors ||
          b.views - a.views ||
          sqlOrder(a.country, b.country) ||
          sqlOrder(a.region, b.region) ||
          sqlOrder(a.city, b.city),
      )
      .slice(0, limit(tableLimit)),
    networks: [...networks]
      .map(([asn, n]) => ({ asn, as_org: n.as_org, visitors: n.visitors.size, views: n.views }))
      .sort((a, b) => b.visitors - a.visitors || b.views - a.views || a.asn - b.asn)
      .slice(0, limit(tableLimit)),
  };
}

/** The set-aside totals, from the set-aside table: every visitor is in exactly one of its rows. */
export function setAsideTotals(rows: readonly AutomatedStat[]): { visitors: number; views: number } {
  let visitors = 0;
  let views = 0;
  for (const row of rows) {
    visitors += Number(row.visitors) || 0;
    views += Number(row.views) || 0;
  }
  return { visitors, views };
}

/** Everything the page shows, from what the two queries returned. */
export function buildStatsPageData({
  days,
  generatedAt,
  people,
  automated,
  peopleRowLimit = PEOPLE_ROW_LIMIT,
}: {
  days: number;
  generatedAt: number;
  people: readonly VisitRow[];
  automated: readonly AutomatedStat[];
  peopleRowLimit?: number;
}): StatsPageData {
  const tally = tallyPeople(people);
  const setAside = setAsideTotals(automated);
  return {
    days,
    generatedAt,
    summary: { ...tally.summary, automated_visitors: setAside.visitors, automated_views: setAside.views },
    visitors: tally.visitors,
    pages: tally.pages,
    sources: tally.sources,
    locations: tally.locations,
    networks: tally.networks,
    automated,
    peopleCapped: people.length >= peopleRowLimit,
  };
}

/** "a", "a and b", "a, b and c". */
function joinWords(items: readonly string[], conjunction: string): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`;
}

const owners = (networks: ReadonlyArray<{ owner: string }>) => [...new Set(networks.map((n) => n.owner))];

/** A set-aside reason in plain words. An unknown one is shown as it is (the renderer escapes it). */
export function automatedReasonLabel(reason: unknown, lists: AutomatedLists = AUTOMATED_LISTS): string {
  switch (reason) {
    case 'crawler-network':
      return 'Network that sends only crawlers';
    case 'crawler-window':
      return 'Window size only crawlers use';
    case 'network-nothing-read':
      return 'Company data centre, nothing read';
    case 'country-nothing-read':
      return `From ${joinWords(lists.nothingReadCountries.map((c) => c.name), 'or')}, nothing read`;
    default:
      return typeof reason === 'string' && reason ? reason : '-';
  }
}

/**
 * The rule, in the owner's words, generated from the same lists as the SQL
 * so the explanation on the page cannot fall behind the registry.
 */
export function automatedExplanation(lists: AutomatedLists = AUTOMATED_LISTS): string {
  const windows = lists.crawlerWindows.map((w) => `${w.width} × ${w.height}`);
  const where = [
    ...(lists.nothingReadNetworks.length ? [`a ${joinWords(owners(lists.nothingReadNetworks), 'or')} data centre`] : []),
    ...lists.nothingReadCountries.map((c) => c.name),
  ];
  const rules = [
    ...(lists.crawlerNetworks.length
      ? [`their network has sent this site nothing but crawlers (${joinWords(owners(lists.crawlerNetworks), 'and')})`]
      : []),
    ...(windows.length
      ? [`every page they opened was in a window of exactly ${joinWords(windows, 'or')}, ${windows.length > 1 ? 'sizes' : 'a size'} only crawlers have used here`]
      : []),
    ...(where.length ? [`they read no page for any time at all and came from ${joinWords(where, 'or')}`] : []),
  ];
  const when = !rules.length
    ? 'No visitor is set aside: every list is empty.'
    : rules.length === 1
      ? `A visitor is set aside when ${rules[0]}.`
      : `A visitor is set aside when ${rules.slice(0, -1).join('; when ')}; or when ${rules[rules.length - 1]}.`;
  const expected = lists.nothingReadCountries.length
    ? ` Home and mobile networks in ${joinWords(lists.nothingReadCountries.map((c) => c.name), 'or')} are expected here; one anywhere else may be a person.`
    : ' A home or mobile network here may be a person.';
  return `Not counted in anything above. ${when} Nothing is deleted.${expected} The lists are in src/data/analytics.ts.`;
}

/** The summary line's counts, and the rows of each table. */
export type SummaryRow = { views: unknown; visitors: unknown; pages: unknown; automated_visitors?: unknown; automated_views?: unknown };
export type PageStat = { path: unknown; views: unknown; avg_engaged: unknown };
export type LocationStat = { country: unknown; region: unknown; city: unknown; visitors: unknown; views: unknown };
export type NetworkStat = { asn: unknown; as_org: unknown; visitors: unknown; views: unknown };
export type AutomatedStat = { reason: unknown; asn: unknown; as_org: unknown; visitors: unknown; views: unknown };

export interface StatsPageData {
  days: number;
  generatedAt: number;
  summary: SummaryRow;
  visitors: VisitorDay[];
  pages: readonly PageStat[];
  sources: SourceRow[];
  locations: readonly LocationStat[];
  networks: readonly NetworkStat[];
  automated: readonly AutomatedStat[];
  /** The people's rows reached PEOPLE_ROW_LIMIT, so the tables cover only the most recent. */
  peopleCapped?: boolean;
}

/**
 * The page's only stylesheet, inlined. The site's own CSS is bundled under a
 * hashed /_astro/ name a Function cannot know, and this page needs very
 * little. Its SHA-256 goes into the CSP, so the policy allows exactly this
 * text and no other style — change a character here and the hash follows,
 * because it is computed from this constant (see statsCsp below), and
 * tests/security recomputes it from the rendered page to prove they agree.
 */
export const STATS_STYLE = `
body{margin:0;background:#fbf8f3;color:#211d17;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:72rem;margin:0 auto;padding:1.5rem 1rem 3rem}
h1{margin:0 0 .25rem;font-size:1.75rem}
h2{margin:2rem 0 .5rem;font-size:1.2rem;color:#2b3e30}
p{margin:.5rem 0}
a{color:#3c5541}
.meta,.note,.empty,.setaside{color:#4e463b}
.note{max-width:46rem;font-size:.95rem}
.windows a,.windows strong{margin-right:.75rem}
.summary{font-size:1.1rem}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #e3dacb;vertical-align:top}
th{background:#f2ece1;white-space:nowrap}
td.n,th.n{text-align:right}
code{font-size:.85em;word-break:break-all}
`;

/** One table, with an empty-state sentence instead of an empty grid. */
function table(caption: string, headers: string[], rows: string[][], emptyNote: string, numeric: number[] = [], intro = ''): string {
  const cls = (i: number) => (numeric.includes(i) ? ' class="n"' : '');
  const head = `<section><h2>${escapeHtml(caption)}</h2>${intro ? `<p class="note">${escapeHtml(intro)}</p>` : ''}`;
  if (!rows.length) {
    return `${head}<p class="empty">${escapeHtml(emptyNote)}</p></section>`;
  }
  return [
    `${head}<div class="scroll"><table>`,
    `<thead><tr>${headers.map((h, i) => `<th${cls(i)}>${escapeHtml(h)}</th>`).join('')}</tr></thead>`,
    '<tbody>',
    ...rows.map((cells) => `<tr>${cells.map((c, i) => `<td${cls(i)}>${c}</td>`).join('')}</tr>`),
    '</tbody></table></div></section>',
  ].join('');
}

/**
 * Render the whole page.
 *
 * Server-rendered and zero-JS. That is not consistency for its own sake: the
 * CSP can then forbid scripts outright, and a page whose content is entirely
 * untrusted strings is the last place to want client-side templating.
 *
 * Every value is passed through escapeHtml, numbers included — one rule with
 * no exceptions is easier to keep than a list of which fields are "safe".
 */
export function renderStatsPage(data: StatsPageData): string {
  const windowLinks = WINDOWS.map((d) =>
    d === data.days
      ? `<strong aria-current="page">${escapeHtml(d)} days</strong>`
      : `<a href="?days=${escapeHtml(d)}">${escapeHtml(d)} days</a>`,
  ).join('');

  const visitorRows = data.visitors.map((v) => [
    escapeHtml(formatEt(v.firstSeen)),
    `<code>${escapeHtml(shortVisitor(v.visitor))}</code>`,
    escapeHtml(v.place),
    escapeHtml(v.network),
    escapeHtml(v.device),
    escapeHtml(v.source ?? '(direct)'),
    `<code>${escapeHtml(v.entry)}</code>`,
    escapeHtml(formatCount(v.views)),
    escapeHtml(formatDuration(v.engagedMs)),
  ]);

  const pageRows = data.pages.map((p) => [
    `<code>${escapeHtml(p.path)}</code>`,
    escapeHtml(formatCount(p.views)),
    escapeHtml(formatDuration(p.avg_engaged)),
  ]);

  const sourceRows = data.sources.map((s) => [escapeHtml(s.host), escapeHtml(formatCount(s.views))]);

  const locationRows = data.locations.map((l) => [
    escapeHtml(formatPlace(l)),
    escapeHtml(formatCount(l.visitors)),
    escapeHtml(formatCount(l.views)),
  ]);

  const networkRows = data.networks.map((n) => [
    escapeHtml(formatNetwork(n)),
    escapeHtml(formatCount(n.visitors)),
    escapeHtml(formatCount(n.views)),
  ]);

  const automatedRows = data.automated.map((a) => [
    escapeHtml(automatedReasonLabel(a.reason)),
    escapeHtml(formatNetworkWithNumber(a)),
    escapeHtml(formatCount(a.visitors)),
    escapeHtml(formatCount(a.views)),
  ]);

  // Only when something was set aside, so an empty window reads as it did.
  const setAsideVisitors = Number(data.summary.automated_visitors) || 0;
  const setAside = setAsideVisitors
    ? `\n<p class="setaside">Not counted: <strong>${escapeHtml(formatCount(setAsideVisitors))}</strong> visitors (<strong>${escapeHtml(formatCount(data.summary.automated_views))}</strong> views) that look automated, listed at the end of the page.</p>`
    : '';
  const capped = data.peopleCapped
    ? `\n<p class="setaside">This window holds more than ${escapeHtml(formatCount(PEOPLE_ROW_LIMIT))} views counted as people, so the tables cover only the most recent ${escapeHtml(formatCount(PEOPLE_ROW_LIMIT))}. Choose a shorter window; a crawler may be missing from the lists.</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visits | VVA Chapter 227</title>
<meta name="robots" content="noindex, nofollow">
<!--
  no-referrer is load-bearing. The rest of the site sends the FULL URL as the
  referrer on same-origin navigation, so this page's own query string would
  otherwise reach the next page's beacon and be stored in the log it shows.
-->
<meta name="referrer" content="no-referrer">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${STATS_STYLE}</style>
</head>
<body>
<main>
<h1>Visits</h1>
<p class="meta">Last ${escapeHtml(data.days)} days &middot; generated ${escapeHtml(formatEt(data.generatedAt))} ET</p>
<p class="windows">${windowLinks}</p>
<p class="summary"><strong>${escapeHtml(formatCount(data.summary.views))}</strong> views &middot; <strong>${escapeHtml(formatCount(data.summary.visitors))}</strong> visitors &middot; <strong>${escapeHtml(formatCount(data.summary.pages))}</strong> pages</p>${setAside}${capped}
<p class="note">Visitor ids reset at midnight Eastern time, so someone who comes back on another day is counted again. Location and network come from Cloudflare, which works them out from the connection as it arrives; IP addresses are never stored. Visits that look automated are left out of every table and listed at the end of the page, with the reason. A company or data-centre name under Network may still be a crawler the lists do not know. All times are Eastern (ET).</p>
${table(
  'Recent visitors',
  ['First seen (ET)', 'Visitor', 'Where', 'Network', 'Device', 'Came from', 'Entry page', 'Pages viewed', 'Read time'],
  visitorRows,
  'No visitors in this window yet.',
  [7, 8],
)}
${table('Pages', ['Page', 'Views', 'Average read'], pageRows, 'No pages viewed in this window.', [1, 2])}
${table('Sources', ['Came from', 'Arrivals'], sourceRows, 'No visitors arrived from another site in this window.', [1])}
${table('Locations', ['Where', 'Visitors', 'Views'], locationRows, 'No locations in this window.', [1, 2])}
${table('Networks', ['Network', 'Visitors', 'Views'], networkRows, 'No networks in this window.', [1, 2])}
${table(
  'Set aside as likely automated',
  ['Why', 'Network', 'Visitors', 'Views'],
  automatedRows,
  'Nothing was set aside in this window.',
  [2, 3],
  automatedExplanation(),
)}
<p><a href="/">&larr; VVA Chapter 227</a></p>
</main>
</body>
</html>
`;
}

/** Base64 SHA-256 of a string, as a CSP hash source expects it. WebCrypto only. */
export async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The page's Content-Security-Policy, given the hash of its one <style>.
 *
 * No script source at all — default-src 'none' covers it — so even an escaping
 * failure could not run anything. style-src names the hash rather than
 * 'unsafe-inline', so an injected <style> or style attribute is refused too.
 * img-src 'self' is for the favicon. No form, no framing, no <base>.
 */
export function statsCsp(styleHash: string): string {
  return [
    "default-src 'none'",
    `style-src 'sha256-${styleHash}'`,
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

let cspPromise: Promise<string> | null = null;

/**
 * The CSP for STATS_STYLE, computed once per isolate on first use.
 *
 * Computed rather than pasted in as a constant, so editing the stylesheet can
 * never leave a stale hash that silently unstyles the page. Lazily, inside a
 * request, because the hash is async and a Worker may not await at module
 * load. A failure is not cached, so the next request tries again.
 */
export function pageCsp(): Promise<string> {
  cspPromise ??= sha256Base64(STATS_STYLE)
    .then(statsCsp)
    .catch((err) => {
      cspPromise = null;
      throw err;
    });
  return cspPromise;
}

/**
 * Headers for a rendered page.
 *
 * Stated by the Function because public/_headers does not apply to a
 * Function's response. Without these, the one page on the site that renders
 * attacker-controlled strings would be served with no CSP at all.
 */
export function statsHeaders(csp: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': csp,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  };
}
