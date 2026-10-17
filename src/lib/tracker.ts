/**
 * The visit beacon that runs in the browser, written as an ordinary function
 * so it can be read, type-checked and tested like the rest of src/lib.
 *
 * It is not shipped as a module. src/pages/b.js.ts emits
 * `(<this function's source>)(<config as JSON>);` and Astro writes that to
 * /b.js, because the tracker has to agree with src/data/analytics.ts about the
 * endpoint and the limits, and a hand-written file in public/ cannot import
 * anything: public/ is copied verbatim, so an `import` there would still be an
 * import at runtime, and it would 404. Copying the constants into such a file
 * would put the quietest failure in this codebase behind a manual sync.
 *
 * THE ONE RULE THIS FUNCTION MUST OBEY: it references nothing outside its own
 * body except its `cfg` argument and browser globals. Function.prototype
 * .toString() captures the body and nothing else, so a helper or constant
 * imported into this module would ship as a bare identifier and be undefined
 * the moment /b.js ran. Because every failure below is swallowed, the page
 * would look perfect while collecting nothing. tests/unit/tracker.test.ts runs
 * the emitted text in a context holding ONLY browser stubs, so a stray
 * reference fails a test rather than the site. It is also why this module
 * imports nothing, not even types: an import here is the first step towards
 * using one.
 *
 * NOTHING HERE MAY THROW INTO THE PAGE. Analytics is the least important code
 * on the site; an exception from it must never be why a veteran looking for
 * the crisis line sees a broken page. Every listener body and every transport
 * call is wrapped. The price is that a broken tracker is silent, which is why
 * the system tier asserts that a real row lands in a real database rather
 * than that a <script> tag exists.
 *
 * Written in the ES5 subset (var, function, no arrows, no optional chaining)
 * so the TypeScript compile step only removes annotations and has nothing to
 * lower: a transpiler helper such as `__name(` or `__spreadValues(` is defined
 * at module scope, outside this function, and would break the rule above.
 * tests/contracts/beacon-tracker.test.ts checks the built dist/b.js for them.
 */

/** What /b.js is called with. Built from the registry by src/pages/b.js.ts. */
export interface TrackerConfig {
  endpoint: string;
  heartbeatMs: number;
  maxPathChars: number;
  maxReferrerChars: number;
}

/** The two privacy signals, as the browser exposes them. Neither is in lib.dom on every engine. */
interface PrivacySignals {
  globalPrivacyControl?: unknown;
  doNotTrack?: unknown;
}

export function tracker(cfg: TrackerConfig): void {
  var doc = document;
  var nav = navigator as Navigator & PrivacySignals;
  var win = window as Window & PrivacySignals;

  // THE OPT-OUT, honoured before anything else runs: no listener is attached,
  // no timer is started and no request is made. Global Privacy Control is the
  // signal with legal standing; Do-Not-Track is the older one, '1' in current
  // engines and 'yes' in old Firefox, and costs nothing to keep. window
  // .doNotTrack is where old Safari and Edge put it. Wrapped because a browser
  // that throws on an unknown property must not take the page with it, and a
  // throw here fails safe: it collects nothing.
  try {
    if (
      nav.globalPrivacyControl === true ||
      nav.doNotTrack === '1' ||
      nav.doNotTrack === 'yes' ||
      win.doNotTrack === '1'
    ) {
      return;
    }
  } catch (e) {
    return;
  }

  // The pageview id. Held in this closure and NOWHERE else: no cookie, no
  // localStorage, no sessionStorage. That is what lets the site say it stores
  // nothing on a visitor's device. The server groups a visitor's pageviews by
  // its daily hash instead, at no cost to the visitor.
  var viewId = (function () {
    var hex = '';
    try {
      var bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      for (var i = 0; i < bytes.length; i++) hex += (bytes[i] + 256).toString(16).slice(1);
      return hex;
    } catch (e) {
      // A non-secure context or an old engine. The collector accepts only hex
      // ids, so this is built digit by digit; String(Math.random()) can come
      // out as '1e-7' and would be refused.
      for (var j = 0; j < 16; j++) hex += Math.floor(Math.random() * 16).toString(16);
      return hex;
    }
  })();

  var engagedMs = 0;
  var activeSince = 0;
  var lastSent = -1;

  function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) : s;
  }

  // The page's path, as the collector will accept it. A pathname can begin
  // with '//' (https://vva227.org//x is a real URL, and open-redirect probes
  // ask for exactly that), and the collector refuses such a path because a
  // browser would read it as a link to another site. Sent as-is, that visit
  // would be lost with no error anywhere; collapsed to one slash, it is
  // recorded as the path this site actually served.
  function currentPath(): string {
    return truncate(location.pathname.replace(/^\/+/, '/'), cfg.maxPathChars);
  }

  function engagedTotal(): number {
    return Math.round(engagedMs + (activeSince ? Date.now() - activeSince : 0));
  }

  function send(body: Record<string, unknown>, useBeacon: boolean): void {
    try {
      var json = JSON.stringify(body);
      // sendBeacon survives the page being torn down, which fetch only does
      // with keepalive and not on every engine. The Blob type matters: a bare
      // string goes out as text/plain, the collector parses JSON regardless,
      // but a future content-type check would turn every exit event into a
      // 400 that nothing on the page could ever surface.
      if (useBeacon && nav.sendBeacon) {
        try {
          if (nav.sendBeacon(cfg.endpoint, new Blob([json], { type: 'application/json' }))) return;
        } catch (e) {
          // A browser that refuses the call still gets the fetch below.
        }
      }
      // false from sendBeacon means the browser declined to queue it (its
      // quota is shared by every beacon on the page). Fall through to fetch.
      fetch(cfg.endpoint, {
        method: 'POST',
        body: json,
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        // This site sets no cookies. Asking for none makes that a property of
        // the request rather than of today's cookie jar.
        credentials: 'omit',
        mode: 'same-origin',
      }).catch(function () {});
    } catch (e) {
      // Never surfaces to the page.
    }
  }

  function flush(useBeacon: boolean): void {
    var total = engagedTotal();
    // The collector keeps the LARGER reading time per pageview, so a repeat
    // is harmless; skipping it saves a row write that says nothing.
    if (total === lastSent) return;
    lastSent = total;
    send(
      {
        k: 'end',
        v: viewId,
        // Sent again so an `end` whose `view` was lost still makes a row with
        // a real path rather than a pageview of nowhere.
        p: currentPath(),
        e: total,
      },
      useBeacon,
    );
  }

  function resume(): void {
    if (!activeSince && doc.visibilityState === 'visible') activeSince = Date.now();
  }

  function pause(): void {
    if (activeSince) {
      engagedMs += Date.now() - activeSince;
      activeSince = 0;
    }
  }

  function guard(fn: () => void): () => void {
    return function () {
      try {
        fn();
      } catch (e) {
        // Never surfaces to the page.
      }
    };
  }

  doc.addEventListener(
    'visibilitychange',
    guard(function () {
      if (doc.visibilityState === 'visible') {
        resume();
      } else {
        // Flushing on hide, not only on pagehide, is what makes the numbers
        // survive a phone: iOS Safari routinely freezes a backgrounded tab
        // and never fires pagehide at all.
        pause();
        flush(true);
      }
    }),
  );

  window.addEventListener(
    'pagehide',
    guard(function () {
      pause();
      flush(true);
    }),
  );

  // A page restored from the back/forward cache resumes counting. There is
  // deliberately no `unload` listener: one makes the page ineligible for that
  // cache in Safari and Firefox, so every Back press would reload the page,
  // and it buys nothing, since a restored page keeps its one timer rather
  // than starting another.
  window.addEventListener('pageshow', guard(resume));

  setInterval(
    guard(function () {
      if (doc.visibilityState === 'visible') flush(false);
    }),
    cfg.heartbeatMs,
  );

  resume();

  send(
    {
      k: 'view',
      v: viewId,
      // The pathname only, never the full URL or its query string. Query
      // strings are where campaign tags, session tokens and the occasional
      // email address end up. A fragment never reaches a server anyway.
      p: currentPath(),
      // Query string and fragment removed before this leaves the browser. A
      // Referer is written under the SENDING site's policy, so it can carry
      // their tokens, and a move between two of our own pages carries OUR
      // query string. src/lib/beacon.ts strips it again server-side and is
      // the authority; this copy means it is never sent at all.
      r: truncate(doc.referrer.split(/[?#]/)[0], cfg.maxReferrerChars) || null,
      w: window.innerWidth || null,
      h: window.innerHeight || null,
    },
    false,
  );
}
