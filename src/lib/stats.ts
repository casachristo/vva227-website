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

import { DISPLAY_TIME_ZONE, SITE_HOSTS } from '../data/analytics';
import { stripQuery } from './beacon';

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

/**
 * Wall-clock parts in the display time zone.
 *
 * Built once at module load. hourCycle h23 rather than hour12:false, which
 * some engines render as "24:05" for five past midnight.
 */
const ET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function etParts(ts: unknown): Record<string, string> | null {
  const n = Number(ts);
  if (ts === null || ts === undefined || !Number.isFinite(n)) return null;
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return null;
  return Object.fromEntries(ET_FORMAT.formatToParts(date).map((p) => [p.type, p.value]));
}

/**
 * The Eastern calendar day a timestamp falls on, as YYYY-MM-DD.
 *
 * Through Intl, not a fixed offset: Eastern time is UTC-5 in winter and UTC-4
 * in summer, and a hard-coded offset would put an hour of visits on the wrong
 * day for half the year.
 */
export function etDay(ts: unknown): string {
  const p = etParts(ts);
  return p ? `${p.year}-${p.month}-${p.day}` : 'unknown';
}

/** A timestamp as "YYYY-MM-DD HH:MM" Eastern time. The page labels it ET. */
export function formatEt(ts: unknown): string {
  const p = etParts(ts);
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
 * WHY THE DAY IS PART OF THE KEY when the hash already rotates daily: the hash
 * rotates at UTC midnight, which is 7 or 8 in the evening Eastern. Someone
 * reading at 11pm and again at 9am shares one hash across two of the owner's
 * days; keyed on the hash alone they would be one row spanning two dates.
 *
 * Which visitor-days are kept: the `limit` most recently ACTIVE (latest view).
 * That matches the query, which fetches every row for the visitor hashes with
 * the latest activity, and it makes the cut exact — any visitor-day that
 * belongs in the list belongs to a hash the query fetched. They are then shown
 * newest arrival first, so the "first seen" column reads in order.
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

/**
 * The page's queries. Bound as (?1 site, ?2 since[, ?3 limit]); nothing is
 * interpolated.
 *
 * Every ORDER BY ends in a tie-breaker, so equal counts do not reshuffle
 * between two loads of the page.
 *
 * Kept deliberately plain because D1 is stricter than the SQLite the tests run
 * on: it refuses a compound SELECT of more than five terms and a statement
 * with more than 100 bound parameters, both of which node:sqlite accepts. The
 * recent-visitors query uses a subquery for its visitor list rather than
 * binding up to a hundred hashes for exactly that reason.
 */
export const STATS_SQL = {
  summary: `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors, COUNT(DISTINCT path) AS pages
    FROM views WHERE site = ?1 AND ts >= ?2`,
  visits: `SELECT view, visitor, ts, path, referrer, country, city, region, asn, as_org, viewport_w, engaged_ms
    FROM views
    WHERE site = ?1 AND ts >= ?2 AND visitor IN (
      SELECT visitor FROM views WHERE site = ?1 AND ts >= ?2
      GROUP BY visitor ORDER BY MAX(ts) DESC LIMIT ?3
    )
    ORDER BY ts DESC`,
  pages: `SELECT path, COUNT(*) AS views, AVG(engaged_ms) AS avg_engaged
    FROM views WHERE site = ?1 AND ts >= ?2
    GROUP BY path ORDER BY views DESC, path LIMIT ${TABLE_LIMIT}`,
  // Per full referrer, not per host: SQLite cannot parse a URL. Generous
  // limit, because internal referrers share this list before
  // summarizeSources() drops them.
  referrers: `SELECT referrer, COUNT(*) AS views
    FROM views WHERE site = ?1 AND ts >= ?2 AND referrer IS NOT NULL
    GROUP BY referrer ORDER BY views DESC, referrer LIMIT 500`,
  locations: `SELECT country, region, city, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS views
    FROM views WHERE site = ?1 AND ts >= ?2
    GROUP BY country, region, city ORDER BY visitors DESC, views DESC, country, region, city LIMIT ${TABLE_LIMIT}`,
  // Grouped by number, not name: names drift in spelling between rows and
  // would split one network across several lines. The name is display only.
  networks: `SELECT asn, max(as_org) AS as_org, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS views
    FROM views WHERE site = ?1 AND ts >= ?2 AND asn IS NOT NULL
    GROUP BY asn ORDER BY visitors DESC, views DESC, asn LIMIT ${TABLE_LIMIT}`,
} as const;

/** Rows as the summary, pages, locations and networks queries return them. */
export type SummaryRow = { views: unknown; visitors: unknown; pages: unknown };
export type PageStat = { path: unknown; views: unknown; avg_engaged: unknown };
export type LocationStat = { country: unknown; region: unknown; city: unknown; visitors: unknown; views: unknown };
export type NetworkStat = { asn: unknown; as_org: unknown; visitors: unknown; views: unknown };

export interface StatsPageData {
  days: number;
  generatedAt: number;
  summary: SummaryRow;
  visitors: VisitorDay[];
  pages: readonly PageStat[];
  sources: SourceRow[];
  locations: readonly LocationStat[];
  networks: readonly NetworkStat[];
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
.meta,.note,.empty{color:#4e463b}
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
function table(caption: string, headers: string[], rows: string[][], emptyNote: string, numeric: number[] = []): string {
  const cls = (i: number) => (numeric.includes(i) ? ' class="n"' : '');
  if (!rows.length) {
    return `<section><h2>${escapeHtml(caption)}</h2><p class="empty">${escapeHtml(emptyNote)}</p></section>`;
  }
  return [
    `<section><h2>${escapeHtml(caption)}</h2><div class="scroll"><table>`,
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
<p class="summary"><strong>${escapeHtml(formatCount(data.summary.views))}</strong> views &middot; <strong>${escapeHtml(formatCount(data.summary.visitors))}</strong> visitors &middot; <strong>${escapeHtml(formatCount(data.summary.pages))}</strong> pages</p>
<p class="note">Visitor ids reset every day, so someone who comes back on another day is counted again. Location and network come from Cloudflare, which works them out from the connection as it arrives; IP addresses are never stored. A company or datacentre name under Network, where you would expect a home or mobile provider, usually means an automated crawler. All times are Eastern (ET).</p>
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
