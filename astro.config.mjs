// @ts-check
import { defineConfig } from 'astro/config';

// Static output. No adapter, no server runtime — every page is an HTML file on
// Cloudflare's edge. This is deliberate: the chapter should never have to patch
// a server, and the old ColdFusion site's worst failures were runtime failures.
export default defineConfig({
  site: 'https://vva227-refresh.pages.dev',
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
