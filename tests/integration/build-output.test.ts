import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadPages,
  builtRoutes,
  readPublicFile,
  publicImages,
  srcFiles,
  DIST,
  SITE_ORIGIN,
  SELF_ORIGINS,
  SELF_ORIGIN_ALLOWLIST,
} from '../helpers/dist';
import { allNavHrefs } from '../../src/lib/nav';
import { classifyLink } from '../../src/lib/links';

/**
 * INTEGRATION — does the built site hang together as a whole?
 *
 * TIER JUSTIFICATION: a component test can prove <SiteHeader> renders a link to
 * /join. Only a whole-build test can prove /join was actually generated. The
 * legacy site failed exactly here — it shipped a navigation whose entries
 * pointed at empty pages, a carousel slide with an empty href, and a footer
 * "Contact" link that resolved to a soft-404.
 */

const pages = loadPages();
const routes = builtRoutes();

/** Does this root-relative link resolve to a built page or a real asset? */
function resolves(href: string): boolean {
  const path = href.split('#')[0].split('?')[0].replace(/\/+$/, '') || '/';
  if (routes.has(path)) return true;
  // Static assets copied from public/
  return existsSync(join(DIST, path.replace(/^\//, '')));
}

describe('routes', () => {
  it('emits a page for every navigation entry', () => {
    const missing = allNavHrefs().filter((href) => !routes.has(href));
    expect(missing, `navigation points at routes that were never built: ${missing.join(', ')}`).toEqual([]);
  });

  it('built a meaningful number of pages', () => {
    expect(pages.length).toBeGreaterThanOrEqual(18);
  });

  it('emits a 404 page for Cloudflare to serve', () => {
    expect(routes.has('/404')).toBe(true);
  });
});

describe('internal links', () => {
  it('every internal link resolves to a built page or a real asset', () => {
    const broken: string[] = [];

    for (const page of pages) {
      page.$('a[href]').each((_, el) => {
        const href = page.$(el).attr('href') ?? '';
        // External, protocol and in-page links are out of scope here.
        if (!href.startsWith('/')) return;
        if (!resolves(href)) broken.push(`${page.route} -> ${href}`);
      });
    }

    expect(broken, `broken internal links:\n${broken.join('\n')}`).toEqual([]);
  });

  it('has no empty or placeholder hrefs', () => {
    // The legacy home page carousel had a slide with href="" that went nowhere.
    const bad: string[] = [];
    for (const page of pages) {
      page.$('a').each((_, el) => {
        const href = page.$(el).attr('href');
        if (href === undefined || href.trim() === '' || href === '#') {
          bad.push(`${page.route}: ${page.$(el).text().trim().slice(0, 40)}`);
        }
      });
    }
    expect(bad, `empty or placeholder links:\n${bad.join('\n')}`).toEqual([]);
  });

  it('references only images that exist', () => {
    const missing: string[] = [];
    for (const page of pages) {
      page.$('img[src]').each((_, el) => {
        const src = page.$(el).attr('src') ?? '';
        if (src.startsWith('/') && !resolves(src)) missing.push(`${page.route} -> ${src}`);
      });
    }
    expect(missing, `missing images:\n${missing.join('\n')}`).toEqual([]);
  });
});

describe('legacy redirects', () => {
  const redirects = readPublicFile('_redirects');
  const rules = redirects
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [from, to, status] = line.split(/\s+/);
      return { from, to, status };
    });

  it('defines a rule for every legacy page', () => {
    // 50 pages were crawled on the legacy site; each needs a destination.
    expect(rules.length).toBeGreaterThanOrEqual(50);
  });

  it('sends every rule to a page that exists', () => {
    const dangling = rules.filter((r) => !resolves(r.to));
    expect(dangling, `redirects point at non-existent pages: ${dangling.map((r) => `${r.from} -> ${r.to}`).join(', ')}`)
      .toEqual([]);
  });

  it('uses permanent 301 redirects so link equity transfers', () => {
    const wrong = rules.filter((r) => r.status !== '301');
    expect(wrong, `non-301 redirects: ${wrong.map((r) => r.from).join(', ')}`).toEqual([]);
  });

  it('never redirects a page to itself', () => {
    const loops = rules.filter((r) => r.from === r.to);
    expect(loops, `self-redirects: ${loops.map((r) => r.from).join(', ')}`).toEqual([]);
  });

  it('covers the specific legacy URLs most likely to be bookmarked', () => {
    const froms = new Set(rules.map((r) => r.from));
    for (const legacy of ['/Donation', '/Membership', '/Newsletter', '/Chapter-Officers', '/email-form']) {
      expect(froms.has(legacy), `no redirect for ${legacy}`).toBe(true);
    }
  });
});

describe('static assets', () => {
  it('copies the security headers file into the build', () => {
    expect(readPublicFile('_headers')).toContain('Content-Security-Policy');
  });

  it('ships the membership application PDF the legacy site buried', () => {
    expect(existsSync(join(DIST, 'docs/vva227-membership-application.pdf'))).toBe(true);
  });

  it('keeps the photographs the audit specifically recovered', () => {
    // Named individually because each was a finding: the fall-festival photo is
    // the home hero, and the plaque photographs are the only record of the
    // chapter's namesake the old site never explained. The student-awards
    // photo (Internet Archive, school-speakers program) was on this list until
    // the chapter retired Tour of Duty/school speakers entirely (2026-08-29,
    // What We Do rebuild) — the program it depicted no longer exists on the
    // site to hang a photo of it from, and there was nowhere else to place it
    // without touching a page outside that rebuild's scope.
    const html = pages.map((p) => p.html).join('\n');
    const orphans = ['fall-festival.jpg', 'pow-chair-dedication.jpg', 'phillips-plaque.jpg'].filter(
      (file) => !html.includes(file),
    );
    expect(orphans, `images shipped but never used: ${orphans.join(', ')}`).toEqual([]);
  });

  // Astro copies public/ wholesale, so an unreferenced photograph is downloaded
  // by nobody and paid for by everybody — it sits in the deploy, in the repo and
  // in every clone. The test this replaced iterated four hardcoded filenames and
  // asserted those four WERE used, which meant it could not fail when a new
  // unused image was added. Six were already shipping unreferenced when this was
  // written; they are listed so the number can only go down.
  const KNOWN_UNREFERENCED: ReadonlyArray<{ file: string; why: string }> = [
    { file: 'pow-chair.jpg', why: 'alternate POW/MIA chair shot' },
    { file: 'pow-flag.jpg', why: 'POW/MIA flag — no page places it yet' },
    { file: 'pow-plaque.jpg', why: 'POW/MIA plaque — no page places it yet' },
    { file: 'versace-memorial.jpg', why: 'Captain Rocky Versace memorial, funded by the chapter' },
  ];

  it('ships no image that no page references', () => {
    const html = pages.map((p) => p.html).join('\n');
    const exempt = new Set(KNOWN_UNREFERENCED.map((entry) => entry.file));
    const orphans = publicImages().filter((file) => !exempt.has(file) && !html.includes(file));

    expect(
      orphans,
      `unreferenced images. Place them on a page, delete them, or add them to KNOWN_UNREFERENCED with a reason:\n${orphans.join('\n')}`,
    ).toEqual([]);
  });

  it('carries no stale exception — every listed image is on disk and still unused', () => {
    // A ratchet only ratchets if entries leave it. Once one of these is placed
    // on a page or deleted, its line has to go.
    const html = pages.map((p) => p.html).join('\n');
    const onDisk = new Set(publicImages());
    const stale: string[] = [];

    for (const { file } of KNOWN_UNREFERENCED) {
      if (!onDisk.has(file)) stale.push(`${file} is no longer in public/images`);
      else if (html.includes(file)) stale.push(`${file} is now used — remove its exception`);
    }

    expect(stale, `stale exceptions:\n${stale.join('\n')}`).toEqual([]);
  });
});

/**
 * Links that point at this site by absolute URL.
 *
 * A section drafted for this site off-repo linked to the site's own /give page
 * as an absolute staging URL. It resolves, so nothing looks broken — and after
 * the cutover to vva227.org it sends visitors from the real site back onto the
 * staging copy. The internal-link test above cannot see it, because it only
 * inspects hrefs that start with "/".
 *
 * Scoped to references a visitor or a browser actually follows. canonical,
 * og:url and og:image are REQUIRED to carry the absolute origin, so the
 * selector deliberately cannot see them.
 */
describe('self-referential links', () => {
  const REFS = 'a[href], img[src], form[action], iframe[src], link[rel="stylesheet"]';
  const ATTR: Record<string, string> = { a: 'href', img: 'src', form: 'action', iframe: 'src', link: 'href' };

  function selfAbsolute(): string[] {
    const found: string[] = [];
    for (const page of pages) {
      page.$(REFS).each((_, el) => {
        const tag = (el as { tagName: string }).tagName.toLowerCase();
        const href = page.$(el).attr(ATTR[tag]) ?? '';
        if (classifyLink(href, SELF_ORIGINS) !== 'self-absolute') return;
        if (SELF_ORIGIN_ALLOWLIST.some((entry) => href.startsWith(entry.prefix))) return;
        found.push(`${page.route} -> ${href}`);
      });
    }
    return found;
  }

  it('never links to this site by absolute URL', () => {
    expect(
      selfAbsolute(),
      `links naming this site absolutely — use a root-relative path:\n${selfAbsolute().join('\n')}`,
    ).toEqual([]);
  });

  it('can actually fail — the rule recognizes a synthetic self-absolute link', () => {
    // Anti-vacuity. An empty SELF_ORIGINS, or a selector matching nothing, would
    // make the assertion above pass forever.
    expect(SELF_ORIGINS.length).toBeGreaterThanOrEqual(3);
    expect(SELF_ORIGINS).toContain(SITE_ORIGIN);
    expect(classifyLink(`${SITE_ORIGIN}/give`, SELF_ORIGINS)).toBe('self-absolute');
    expect(classifyLink('https://vva227.org/give', SELF_ORIGINS)).toBe('self-absolute');

    const anchors = pages.reduce((total, page) => total + page.$('a[href]').length, 0);
    expect(anchors, 'no anchors inspected — the selector matched nothing').toBeGreaterThan(100);
  });

  it('leaves canonical and og:url absolute, as they must be', () => {
    // Proves the exclusion above is a deliberate scoping choice rather than an
    // oversight: every page still advertises its absolute canonical URL.
    for (const page of pages) {
      const canonical = page.$('link[rel="canonical"]').attr('href') ?? '';
      expect(canonical.startsWith(SITE_ORIGIN), `${page.route} canonical is not absolute`).toBe(true);
    }
  });

  it('does not mistake a chapter email address for a link to this site', () => {
    // don_sutherland@vva227.org is published on /contact. A substring rule
    // rather than a host rule would flag it and get itself weakened.
    const contact = pages.find((p) => p.route === '/contact');
    expect(contact!.html).toContain('@vva227.org');
    expect(selfAbsolute().join('\n')).not.toContain('mailto:');
  });

  it('keeps the legacy-host exception to newsletter PDFs only', () => {
    // The Journey back-issues are still served from the old host. That is the
    // one allowed absolute reference, and it is allowed only for those files.
    for (const entry of SELF_ORIGIN_ALLOWLIST) {
      const uses = pages.filter((p) => p.html.includes(entry.prefix)).length;
      expect(uses, `allowlist entry "${entry.prefix}" is unused — delete it`).toBeGreaterThan(0);
    }

    const outside: string[] = [];
    for (const page of pages) {
      page.$('a[href]').each((_, el) => {
        const href = page.$(el).attr('href') ?? '';
        if (!href.startsWith('https://vva227.org/')) return;
        if (SELF_ORIGIN_ALLOWLIST.some((entry) => href.startsWith(entry.prefix))) return;
        outside.push(`${page.route} -> ${href}`);
      });
    }
    expect(outside, `legacy-host links outside the allowlist:\n${outside.join('\n')}`).toEqual([]);
  });
});

describe('cross-references between pages', () => {
  // A page nothing links to is a page nobody reads. The global footer carries a
  // link to every nav route on all 25 pages, so any test that only asks "is
  // /give/nvvvf linked from somewhere" passes from site furniture alone and
  // proves nothing — hence `main`.
  const IN_BODY: ReadonlyArray<{ from: string; to: string; why: string }> = [
    { from: '/give', to: '/give/nvvvf', why: 'a donor choosing between two payees' },
    { from: '/give/impact', to: '/give/nvvvf', why: 'the Foundation partnership behind emergency assistance' },
    { from: '/programs', to: '/give/nvvvf', why: 'how emergency aid is funded' },
    { from: '/give/nvvvf', to: '/get-help', why: 'a veteran who lands on the donor page' },
    { from: '/give/nvvvf', to: '/give', why: 'giving to the chapter rather than the Foundation' },
    { from: '/get-help', to: '/give/nvvvf', why: 'the review note recording the contradiction' },
  ];

  it('links each page to the other from inside its content, not from the footer', () => {
    const missing: string[] = [];

    for (const { from, to, why } of IN_BODY) {
      const page = pages.find((p) => p.route === from);
      if (!page) {
        missing.push(`${from} was not built`);
        continue;
      }
      if (page.$(`main a[href="${to}"]`).length === 0) missing.push(`${from} -> ${to} (${why})`);
    }

    expect(missing, `cross-references missing from page content:\n${missing.join('\n')}`).toEqual([]);
  });

  it('can actually fail — the selector excludes the footer that links everything', () => {
    // Anti-vacuity, and the specific reason this test is written against main:
    // every page's header and footer link /join (it's a top-level nav item),
    // so a document-wide selector would be green even with all seven in-body
    // references deleted. /about no longer serves this role since the home
    // page's own hero now links there (2026-08-28) — /join, still in NAV and
    // not linked from home's rebuilt body, plays the same role instead.
    const home = pages.find((p) => p.route === '/')!;
    expect(home.$(`a[href="/join"]`).length, 'the header/footer should link it everywhere').toBeGreaterThan(0);
    expect(home.$(`main a[href="/join"]`).length, 'the home page deliberately does not').toBe(0);
  });
});

describe('source hygiene', () => {
  it('authors no build-generated scope attributes by hand', () => {
    // data-astro-cid-* is emitted by the compiler and is meaningless in source.
    // A hand-written one is the fingerprint of markup copied out of a deployed
    // page: it carries another component's style hash, so the block renders
    // completely unstyled while every string-level test in this suite passes.
    // The section drafted off-repo for this site carried exactly that.
    const offenders = srcFiles().filter((file) => file.text.includes('data-astro-cid'));
    expect(
      offenders.map((f) => f.path),
      'scope hashes written by hand — this markup was pasted out of a build',
    ).toEqual([]);
  });
});
