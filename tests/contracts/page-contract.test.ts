import { describe, it, expect } from 'vitest';
import { loadPages } from '../helpers/dist';

/**
 * PAGE CONTRACT — the shape every rendered page must satisfy.
 *
 * This is the registry-and-gate pattern applied to page structure: BaseLayout
 * is the single source of the document shell, and this suite is the gate that
 * proves every page actually went through it.
 *
 * Each rule below corresponds to a specific defect measured on the legacy site.
 */

const pages = loadPages();

describe('document head', () => {
  it('gives every page a non-empty, unique title', () => {
    // All 50 legacy pages shared the title "VVA Dean K Phillips Memorial
    // Chapter 227", making them indistinguishable in search results, browser
    // tabs and bookmarks.
    const titles = new Map<string, string[]>();

    for (const page of pages) {
      const title = page.$('title').text().trim();
      expect(title.length, `${page.route} has an empty <title>`).toBeGreaterThan(0);
      expect(title, `${page.route} title should be scoped to the chapter`).toContain('VVA Chapter 227');
      const list = titles.get(title) ?? [];
      list.push(page.route);
      titles.set(title, list);
    }

    const dupes = [...titles.entries()].filter(([, routes]) => routes.length > 1);
    expect(dupes, `duplicate titles: ${dupes.map(([t, r]) => `${t} (${r.join(', ')})`).join('; ')}`).toEqual([]);
  });

  it('gives every page a meta description of useful length', () => {
    for (const page of pages) {
      const desc = page.$('meta[name="description"]').attr('content') ?? '';
      expect(desc.length, `${page.route} has no meta description`).toBeGreaterThan(40);
      expect(desc.length, `${page.route} meta description is too long to render in full`).toBeLessThan(320);
    }
  });

  it('declares exactly one canonical URL per page', () => {
    for (const page of pages) {
      expect(page.$('link[rel="canonical"]').length, `${page.route} canonical count`).toBe(1);
    }
  });

  it('emits canonical and og:url without a .html suffix', () => {
    // build.format: 'file' makes Astro.url.pathname end in ".html". Left
    // unnormalized, every page advertised a canonical URL that differs from the
    // URL visitors and search engines actually use.
    for (const page of pages) {
      const canonical = page.$('link[rel="canonical"]').attr('href') ?? '';
      const ogUrl = page.$('meta[property="og:url"]').attr('content') ?? '';
      expect(canonical, `${page.route} canonical leaks .html`).not.toMatch(/\.html$/);
      expect(ogUrl, `${page.route} og:url leaks .html`).not.toMatch(/\.html$/);
      expect(canonical, `${page.route} canonical should match its route`).toMatch(
        new RegExp(`${page.route === '/' ? '/' : page.route}$`),
      );
    }
  });

  it('uses real Open Graph property names', () => {
    // The legacy site emitted <meta name="og:street-address"> and friends,
    // which are not Open Graph properties and are ignored by every consumer.
    for (const page of pages) {
      for (const prop of ['og:title', 'og:description', 'og:url', 'og:image', 'og:type']) {
        expect(page.$(`meta[property="${prop}"]`).length, `${page.route} missing ${prop}`).toBe(1);
      }
      expect(page.$('meta[name^="og:"]').length, `${page.route} uses name= instead of property= for OG`).toBe(0);
    }
  });

  it('sets a viewport so the site is usable on a phone', () => {
    // The legacy site had no viewport tag and a fixed 1047px table layout.
    for (const page of pages) {
      expect(page.$('meta[name="viewport"]').attr('content')).toContain('width=device-width');
    }
  });

  it('declares the document language', () => {
    for (const page of pages) {
      expect(page.$('html').attr('lang'), `${page.route} missing lang`).toBe('en');
    }
  });
});

describe('the defects that must never come back', () => {
  it('emits no meta refresh', () => {
    // The legacy site carried <META HTTP-EQUIV="REFRESH" CONTENT="1"> on every
    // page — a reload roughly once per second.
    for (const page of pages) {
      expect(page.$('meta[http-equiv="refresh" i]').length, `${page.route} has a meta refresh`).toBe(0);
    }
  });

  it('emits exactly one doctype and one <html> element per page', () => {
    // Legacy pages concatenated up to four doctypes and multiple <html>/<head>
    // pairs from ColdFusion includes.
    for (const page of pages) {
      const doctypes = page.html.match(/<!doctype/gi) ?? [];
      expect(doctypes.length, `${page.route} has ${doctypes.length} doctypes`).toBe(1);
      const htmlTags = page.html.match(/<html[\s>]/gi) ?? [];
      expect(htmlTags.length, `${page.route} has ${htmlTags.length} <html> tags`).toBe(1);
    }
  });

  it('leaks no unrendered template tags into the output', () => {
    // The legacy home page shipped literal "<!cfset ...>" and "<!cfinclude ...>"
    // strings because of a malformed comment opener.
    for (const page of pages) {
      expect(page.html, `${page.route} leaks ColdFusion tags`).not.toMatch(/<!cf|<cfoutput|cfinclude/i);
      // Checked against visible text, not raw HTML: minified CSS legitimately
      // ends nested at-rules with "}}", which is not a template leak.
      expect(page.text, `${page.route} leaks an unrendered expression`).not.toMatch(/\{\{|\}\}/);
    }
  });
});

describe('document structure and accessibility', () => {
  it('gives every page exactly one h1', () => {
    for (const page of pages) {
      const count = page.$('h1').length;
      expect(count, `${page.route} has ${count} <h1> elements`).toBe(1);
    }
  });

  it('never skips a heading level', () => {
    for (const page of pages) {
      const levels = page
        .$('h1, h2, h3, h4, h5, h6')
        .toArray()
        .map((el) => Number((el as { tagName: string }).tagName.slice(1)));

      for (let i = 1; i < levels.length; i += 1) {
        expect(
          levels[i] - levels[i - 1],
          `${page.route} jumps from h${levels[i - 1]} to h${levels[i]}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('gives every image an alt attribute', () => {
    // Every image on the legacy home page had an empty alt — including the
    // seven carousel slides that were the page's only navigation.
    const bad: string[] = [];
    for (const page of pages) {
      page.$('img').each((_, el) => {
        if (page.$(el).attr('alt') === undefined) bad.push(`${page.route}: ${page.$(el).attr('src')}`);
      });
    }
    expect(bad, `images with no alt attribute:\n${bad.join('\n')}`).toEqual([]);
  });

  it('writes descriptive alt text for content images, not filenames', () => {
    const weak: string[] = [];
    for (const page of pages) {
      page.$('img').each((_, el) => {
        const alt = (page.$(el).attr('alt') ?? '').trim();
        if (alt === '') return; // decorative images are allowed an empty alt
        if (alt.length < 20 || /\.(jpe?g|png|gif)$/i.test(alt)) {
          weak.push(`${page.route}: "${alt}"`);
        }
      });
    }
    expect(weak, `weak alt text:\n${weak.join('\n')}`).toEqual([]);
  });

  it('provides a skip link and a main landmark on every page', () => {
    for (const page of pages) {
      expect(page.$('a[href="#main"]').length, `${page.route} has no skip link`).toBe(1);
      expect(page.$('main#main').length, `${page.route} has no <main id="main">`).toBe(1);
    }
  });

  it('labels every navigation landmark', () => {
    for (const page of pages) {
      page.$('nav').each((_, el) => {
        const label = page.$(el).attr('aria-label') ?? page.$(el).attr('aria-labelledby');
        expect(label, `${page.route} has an unlabeled <nav>`).toBeTruthy();
      });
    }
  });

  it('uses link text that means something out of context', () => {
    const vague = new Set(['click here', 'here', 'read more', 'more', 'link', 'click for more details']);
    const bad: string[] = [];
    for (const page of pages) {
      page.$('a').each((_, el) => {
        const text = page.$(el).text().replace(/\s+/g, ' ').trim().toLowerCase().replace(/[→←>»]/g, '').trim();
        if (vague.has(text)) bad.push(`${page.route}: "${text}"`);
      });
    }
    // "Click for More Details:" was the entire body copy of eight legacy pages.
    expect(bad, `vague link text:\n${bad.join('\n')}`).toEqual([]);
  });
});
