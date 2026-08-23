import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as cheerio from 'cheerio';
import astroConfig from '../../astro.config.mjs';

export const DIST = join(process.cwd(), 'dist');
export const SRC = join(process.cwd(), 'src');
export const PUBLIC_IMAGES = join(process.cwd(), 'public', 'images');

/** The origin the build stamps into canonical and og:url. One source: astro.config.mjs. */
export const SITE_ORIGIN = new URL(astroConfig.site!).origin;

/**
 * Re-exported from the source of truth rather than restated. See src/lib/links.ts
 * for why naming this site absolutely is a defect and not a style preference.
 */
export { SELF_ORIGINS } from '../../src/lib/links';

/**
 * The one documented exception, as a ratchet. Shrink it; never widen it.
 */
export const SELF_ORIGIN_ALLOWLIST: ReadonlyArray<{ prefix: string; why: string }> = [
  {
    prefix: 'https://vva227.org/upload/',
    why: 'The Journey back-issue PDFs are still hosted on the legacy server. Delete this entry when they move into public/docs.',
  },
];

/** Every file shipped in public/images, by filename. */
export function publicImages(): string[] {
  return readdirSync(PUBLIC_IMAGES).filter((name) => !name.startsWith('.'));
}

/** Every authored source file under src/, for rules about what may be written by hand. */
export function srcFiles(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: relative(process.cwd(), full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
    }
  };
  walk(SRC);
  return out;
}

export interface Page {
  /** Absolute path on disk. */
  file: string;
  /** Public route, e.g. "/get-help/vet-center" ("/" for the home page). */
  route: string;
  /** Raw HTML as written to disk. */
  html: string;
  /** Visible text with entities decoded and script/style stripped. */
  text: string;
  $: cheerio.CheerioAPI;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

let cache: Page[] | null = null;

/**
 * Load every built HTML page.
 *
 * Throws with an actionable message rather than silently returning [] when the
 * site has not been built — an empty corpus would make every content assertion
 * below pass vacuously, which is the worst possible failure mode for a
 * migration-coverage suite.
 */
export function loadPages(): Page[] {
  if (cache) return cache;

  if (!existsSync(DIST)) {
    throw new Error(`dist/ not found at ${DIST}. Run "npm run build" before the test suite.`);
  }

  const files = walk(DIST);
  if (files.length === 0) {
    throw new Error(`dist/ contains no HTML files. The build produced nothing.`);
  }

  cache = files.map((file) => {
    const html = readFileSync(file, 'utf8');
    const $ = cheerio.load(html);
    $('script, style').remove();

    const rel = relative(DIST, file).split(sep).join('/');
    const route = rel === 'index.html' ? '/' : `/${rel.replace(/\.html$/, '')}`;

    return { file, route, html, text: $('body').text().replace(/\s+/g, ' ').trim(), $ };
  });

  return cache;
}

/** All visible text across every page, for presence assertions. */
export function corpusText(): string {
  return loadPages()
    .map((p) => p.text)
    .join('\n');
}

/** All raw HTML across every page, for attribute/URL assertions. */
export function corpusHtml(): string {
  return loadPages()
    .map((p) => p.html)
    .join('\n');
}

/** The set of routes the build actually emitted. */
export function builtRoutes(): Set<string> {
  return new Set(loadPages().map((p) => p.route));
}

export function readPublicFile(name: string): string {
  const path = join(DIST, name);
  if (!existsSync(path)) throw new Error(`Expected ${name} to be copied into dist/, but it is missing.`);
  return readFileSync(path, 'utf8');
}
