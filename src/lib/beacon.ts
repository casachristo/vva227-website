/**
 * The collector's logic, with none of its plumbing.
 *
 * functions/api/e.ts is a thin shell around these functions. The thing most
 * worth testing about the collector — what a public, unauthenticated endpoint
 * is willing to store from a stranger — is pure, so it lives here, where it
 * runs the same in Node and in Workers (WebCrypto and standard JS only) and
 * needs no runtime to test.
 */

import {
  EVENT_END,
  EVENT_KINDS,
  EVENT_VIEW,
  MAX_PATH_CHARS,
  MAX_REFERRER_CHARS,
  RETENTION_DAYS,
  SALT_PERIOD_DAYS,
} from '../data/analytics';
import { easternDayNumber } from './eastern';
import type { CfProperties } from './runtime';

const MS_PER_DAY = 86_400_000;

/**
 * Longest reading time recorded for one pageview, ms.
 *
 * A tab left open over a weekend legitimately produces a multi-day total, and
 * a hostile caller can claim any number at all. Neither is a reading session.
 * Capping rather than rejecting keeps the row — the visit happened, only the
 * duration is untrustworthy — and stops one value dominating an average.
 */
export const MAX_ENGAGED_MS = 4 * 60 * 60 * 1000;

/** Largest plausible viewport edge, px. Guards against nonsense, not attack. */
export const MAX_VIEWPORT_PX = 20_000;

/**
 * The write. One statement, executed as-is by the integration tier against
 * real SQLite and the real migration, so the upsert is tested rather than
 * mirrored.
 *
 * A pageview arrives as several requests — a `view` on load, then `end`
 * flushes — and this is where they become one row:
 *
 *   engaged_ms  the LARGER of stored and incoming. Flushes can arrive out of
 *               order, and taking the latest would let a stale in-flight flush
 *               erase the real reading time.
 *   referrer,   stored value wins, incoming fills a gap. An `end` carries none
 *   viewport    of these, and must not null out what the `view` recorded.
 *   ts          ABSENT from the update list, on purpose. Only the first request
 *               for a pageview says when the visit happened; a late `end` must
 *               not restamp the row, or every visit would appear to start when
 *               it finished. Do not add ts to the list below.
 *
 * Parameter order is fixed by upsertBindings() directly underneath.
 */
export const UPSERT_SQL = `INSERT INTO views
  (view, site, visitor, path, referrer, country, city, region, asn, as_org,
   viewport_w, viewport_h, engaged_ms, ts)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
ON CONFLICT(view) DO UPDATE SET
  engaged_ms = max(views.engaged_ms, excluded.engaged_ms),
  referrer   = coalesce(views.referrer, excluded.referrer),
  viewport_w = coalesce(views.viewport_w, excluded.viewport_w),
  viewport_h = coalesce(views.viewport_h, excluded.viewport_h)`;

/**
 * The retention prune. Kept beside the write so both statements sit next to
 * the schema they act on, and so a test can execute the real text.
 */
export const PRUNE_SQL = 'DELETE FROM views WHERE ts < ?1';

/** The timestamp before which rows are past the stated retention period. */
export function pruneCutoff(nowMs: number, days: number = RETENTION_DAYS): number {
  return nowMs - days * MS_PER_DAY;
}

/**
 * Field separator for the hash preimage: ASCII Unit Separator (0x1F).
 *
 * Built with String.fromCharCode rather than typed, and the control-character
 * class below is built from an escaped string for the same reason: a literal
 * control byte in a source file survives an editor round trip only by luck,
 * and can turn the file into one grep calls binary.
 *
 * It has to be a control character because one input is an attacker-controlled
 * user agent. With a printable separator, a crafted UA could shift the field
 * boundaries so two different visitors produce the same preimage. 0x1F cannot
 * occur in an IP, a UA header or a site key.
 */
const SEP = String.fromCharCode(0x1f);

/**
 * Control characters, which never reach a stored field: C0 (0x00-0x1F) and
 * DEL. Covers SEP, and the CR/LF that would let a stored value forge extra
 * lines in any log or report built from this table.
 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

/**
 * Which salt window a timestamp falls in: a whole number of periods of
 * consecutive Eastern calendar days, counted from 1 January 1970.
 *
 * It changes at midnight Eastern time because that is where /stats starts a
 * new day. Changing at UTC midnight, 8pm Eastern (7pm in winter), split one
 * evening's reader into two visitors on the same day of the log, the second
 * with no source and a mid-visit entry page. A day number rather than a
 * 'YYYY-MM-DD' string, so a period of N days is N days at every month end.
 */
export function saltWindow(nowMs: number, periodDays: number = SALT_PERIOD_DAYS): number {
  return Math.floor(easternDayNumber(nowMs) / periodDays);
}

export interface VisitorHashInput {
  secret: string | undefined | null;
  window: number;
  site: string;
  ip: string | null | undefined;
  ua: string | null | undefined;
}

/**
 * The pseudonymous visitor identifier: SHA-256 of a secret salt, the salt
 * window, the site, the IP and the user agent, as 32 hex characters.
 *
 * The IP and user agent go in and never come out. Nothing stored can be
 * reversed into either, and once the window rolls the same visitor hashes
 * differently, so rows cannot be linked across days even by us.
 *
 * The secret is REQUIRED. A missing one must be a loud failure rather than an
 * empty-string default: with a known salt, anyone can hash an IP + user agent
 * pair and the identifier stops being pseudonymous at all.
 */
export async function visitorHash({ secret, window, site, ip, ua }: VisitorHashInput): Promise<string> {
  if (!secret) throw new Error('visitorHash: secret is required');
  const material = [secret, String(window), site, ip ?? '', ua ?? ''].join(SEP);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] + 256).toString(16).slice(1);
  // 128 bits is far beyond any collision risk at this traffic, and a shorter
  // row is a cheaper row.
  return hex.slice(0, 32);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * A URL with its query string and fragment removed.
 *
 * WHY. An incoming Referer is written by the SENDING site, under ITS
 * Referrer-Policy, not ours. A site with a lax policy hands over the full URL
 * it was on — which routinely carries session tokens, password-reset links,
 * campaign identifiers and now and then an email address. Storing that would
 * put other people's secrets in this database.
 *
 * It also closes a leak in our own house: this site's policy,
 * strict-origin-when-cross-origin, sends the FULL URL on same-origin
 * navigations, so a query string on one page would reach the next page's
 * beacon. The /stats page sends no-referrer for the same reason; this is the
 * half that does not depend on remembering.
 *
 * Applied here because the client cannot be trusted, and in the tracker so the
 * value never leaves the browser in the first place. The tracker cannot import
 * this (it ships as self-contained source text), so it has its own one-line
 * copy; this one is the authority.
 */
export function stripQuery(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/**
 * A stored string: control characters removed, trimmed, length-capped — or
 * null if nothing is left. Used for every text column, including the request.cf
 * fields: those are not attacker-controlled, but a column that trusts its input
 * because of where it came from stops being safe the day something else writes
 * to it.
 */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const stripped = value.replace(CONTROL_CHARS, '').trim();
  if (!stripped) return null;
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

/** cleanText, then stripQuery, then null if that left nothing. */
function cleanUrlText(value: unknown, max: number): string | null {
  const cleaned = cleanText(value, max);
  if (cleaned === null) return null;
  return stripQuery(cleaned).trim() || null;
}

export interface BeaconEvent {
  kind: string;
  view: string;
  path: string;
  referrer: string | null;
  viewportW: number | null;
  viewportH: number | null;
  engagedMs: number;
}

export type ValidationResult = { ok: true; event: BeaconEvent } | { ok: false; reason: string };

/**
 * Validate and normalise one posted event.
 *
 * Returns `{ ok: true, event }` or `{ ok: false, reason }`. Never throws, and
 * never returns a field it did not check — the caller binds these values
 * straight into a statement.
 *
 * Rejecting versus clamping is deliberate. A structurally wrong event (unknown
 * kind, bad id, a path that is not a path) is a bug or an attack and is
 * refused, because no later query could interpret the row. A numerically
 * implausible one is clamped, because the visit still happened and dropping
 * it would lose more truth than the bad number costs.
 *
 * Fields a caller sends that are not listed here are ignored — including a
 * `site`, which is assigned by the server and never taken from the client.
 */
export function validateEvent(raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) return { ok: false, reason: 'body must be a JSON object' };

  const kind = raw.k;
  if (typeof kind !== 'string' || !EVENT_KINDS.includes(kind)) {
    return { ok: false, reason: 'unknown event kind' };
  }

  // The view id is the primary key: a bad one would collide with a real row
  // or create one nothing can correlate. No forgiving path.
  const view = typeof raw.v === 'string' && /^[0-9a-f]{8,64}$/.test(raw.v) ? raw.v : null;
  if (!view) return { ok: false, reason: 'invalid view id' };

  // The query string is cut from the path too. location.pathname never
  // carries one, so this costs a real visit nothing, and a hand-crafted post
  // cannot use the path column to smuggle in what the referrer column refuses.
  const path = cleanUrlText(raw.p, MAX_PATH_CHARS);
  // A leading slash is what makes this a path on this site rather than a URL
  // somewhere else — but "starts with a slash" is NOT enough. `//evil.example/x`
  // starts with one and is a PROTOCOL-RELATIVE URL, which a browser resolves
  // to another origin entirely; `/\evil.example` is the same thing, because
  // URL parsing treats a backslash after the first slash as a second slash.
  // Stored, either would invent pages that do not exist and hand an open
  // redirect to anything that ever renders these paths as links.
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) {
    return { ok: false, reason: 'invalid path' };
  }

  const event: BeaconEvent = {
    kind,
    view,
    path,
    referrer: null,
    viewportW: null,
    viewportH: null,
    engagedMs: 0,
  };

  if (kind === EVENT_VIEW) {
    event.referrer = cleanUrlText(raw.r, MAX_REFERRER_CHARS);
    event.viewportW = clampInt(raw.w, 0, MAX_VIEWPORT_PX);
    event.viewportH = clampInt(raw.h, 0, MAX_VIEWPORT_PX);
  }

  if (kind === EVENT_END) {
    // Non-finite means "no information" and becomes 0. Clamping it to the
    // ceiling instead would let a caller write the maximum by sending nonsense.
    event.engagedMs = clampInt(raw.e, 0, MAX_ENGAGED_MS) ?? 0;
  }

  return { ok: true, event };
}

export interface Geo {
  country: string | null;
  city: string | null;
  region: string | null;
  asn: number | null;
  asOrg: string | null;
}

/** A real autonomous system number, or null. ASNs are unsigned 32-bit. */
function asnOf(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d{1,10}$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  return Number.isInteger(n) && n > 0 && n <= 4_294_967_295 ? n : null;
}

/**
 * Coarse location and network, as Cloudflare resolved them at the edge.
 *
 * This is why the IP never needs storing: the only questions we would ask of
 * it — roughly where is this person, and whose network are they on — have been
 * answered before our code runs.
 *
 * regionCode is the short form ('VA'), region the long one ('Virginia'). The
 * short one is preferred so the visitor table stays narrow on a phone; the
 * long one fills in where only it is known.
 */
export function geoFromCf(cf: CfProperties | null | undefined): Geo {
  const c = cf ?? {};
  return {
    country: cleanText(c.country, 8),
    city: cleanText(c.city, 64),
    region: cleanText(c.regionCode, 8) ?? cleanText(c.region, 64),
    asn: asnOf(c.asn),
    asOrg: cleanText(c.asOrganization, 96),
  };
}

/** The values for UPSERT_SQL's ?1..?14, in order. */
export function upsertBindings({
  event,
  site,
  visitor,
  geo,
  now,
}: {
  event: BeaconEvent;
  site: string;
  visitor: string;
  geo: Geo;
  now: number;
}): Array<string | number | null> {
  return [
    event.view,
    site,
    visitor,
    event.path,
    event.referrer,
    geo.country,
    geo.city,
    geo.region,
    geo.asn,
    geo.asOrg,
    event.viewportW,
    event.viewportH,
    event.engagedMs,
    // Discarded on conflict, which is what keeps ts from being restamped —
    // see UPSERT_SQL.
    now,
  ];
}

/**
 * Read a request body, giving up as soon as it passes `maxBytes`.
 *
 * Returns the body as text, or null if it was too large. Content-Length is
 * checked before this, but it can be absent (chunked encoding) or simply lie,
 * so the real byte count is the limit that holds — and counting while reading
 * means an oversized body is refused without first being buffered whole.
 *
 * Throws on bytes that are not valid UTF-8, which the caller answers the same
 * way as invalid JSON.
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
