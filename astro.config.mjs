// @ts-check
import { defineConfig } from 'astro/config';

// Static output. No adapter, no server runtime — every page is an HTML file on
// Cloudflare's edge. This is deliberate: the chapter should never have to patch
// a server, and the old ColdFusion site's worst failures were runtime failures.
export default defineConfig({
  // The production domain. Every page's canonical, og:url and og:image are
  // built from this, so it tells search engines and Facebook which address to
  // credit. It named the staging copy until 2026-10-22; see "the address pages
  // advertise" in tests/integration/build-output.test.ts.
  site: 'https://vva227.org',
  output: 'static',
  trailingSlash: 'never',
  build: {
    // One .html file per route rather than /route/index.html, so Cloudflare's
    // trailing-slash handling stays predictable.
    format: 'file',
    inlineStylesheets: 'auto',
  },
  devToolbar: { enabled: false },
});
