import { tracker, type TrackerConfig } from '../lib/tracker';
import { BEACON_ENDPOINT, HEARTBEAT_MS, MAX_PATH_CHARS, MAX_REFERRER_CHARS } from '../data/analytics';

/**
 * /b.js — the visit beacon, generated at build time from src/lib/tracker.ts.
 *
 * Generated rather than hand-written because a beacon that disagrees with the
 * registry fails with NO symptom: no console error, no failed request in
 * devtools, no server log, because nothing reaches a server. See the header of
 * src/lib/tracker.ts for the rule this places on that function.
 *
 * Emitted as a classic script, `(function tracker(cfg){...})(cfg);`, not as a
 * module. A module script is fetched in CORS mode; a classic one with `defer`
 * runs at the same point without that. The function wrapper also gives it its
 * own scope, so the tracker leaks no global for anything else to collide with.
 *
 * 'use strict' comes first because the function was written, type-checked
 * and unit-tested as module code, which is always strict. A classic script is
 * not, and without the directive the same text would run under different
 * rules in the browser than it did in its tests.
 *
 * The site field is deliberately absent: the collector stamps every row with
 * SITE_KEY itself and ignores any site a client sends, so no page can write
 * into another site's rows.
 *
 * The Content-Type below is dropped by a static build, where Cloudflare types
 * the file by its extension; it is stated so `astro dev` serves it the same
 * way.
 */

/** The values the shipped tracker runs with, straight from the registry. */
export function beaconConfig(): TrackerConfig {
  return {
    endpoint: BEACON_ENDPOINT,
    heartbeatMs: HEARTBEAT_MS,
    maxPathChars: MAX_PATH_CHARS,
    maxReferrerChars: MAX_REFERRER_CHARS,
  };
}

/** The exact text served at BEACON_SCRIPT. */
export function beaconScript(): string {
  // Function.prototype.toString() returns the tracker's real source text, so
  // what ships is the code the tests ran, not a re-serialisation of it.
  return `'use strict';\n(${tracker.toString()})(${JSON.stringify(beaconConfig())});\n`;
}

export function GET(): Response {
  return new Response(beaconScript(), {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
  });
}
