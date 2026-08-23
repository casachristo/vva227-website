import { describe, it, expect } from 'vitest';
import { loadPages, corpusHtml, readPublicFile } from '../helpers/dist';

/**
 * SECURITY & PRIVACY — what must never reach the public build.
 *
 * A static marketing site has a small attack surface, which is the point: the
 * legacy stack was IIS + ColdFusion serving a 500 whose reason phrase leaked an
 * internal runtime error, and an unauthenticated file-upload endpoint gated
 * only by an email-existence check.
 *
 * These tests defend the two things that can still go wrong here: shipping
 * personal data that was never cleared for republication, and reintroducing
 * third-party script execution.
 */

const pages = loadPages();
const html = corpusHtml();

describe('personal data withheld pending chapter approval', () => {
  // Each of these IS published on the current public site. None may appear here
  // until the chapter says so. See REVIEW.md.
  const withheld: Array<[string, string]> = [
    ['personal mobile (anniversary RSVP)', '703-819-1480'],
    ['personal mobile (AVVA enquiries)', '703-772-5303'],
    ['board member home address', 'Taney'],
    ['donor name', 'Ruhnke'],
    ['donor name', 'Ausley'],
    // From the Foundation newsletter forwarded to the site in 2026. The
    // testimonial is unnamed, but a Gulf War veteran with nine years' service,
    // a family of six and service-connected disabilities is a small enough set
    // inside one chapter's catchment to be re-identifying — and it was written
    // for a members' appeal, not for a permanent public URL. The chapter's own
    // /give/impact page says it never contacts recipient families, precisely to
    // keep the help private for the people receiving it.
    ['assistance recipient testimonial', 'family of six'],
    ['assistance recipient testimonial', 'keep the lights on'],
    ['assistance recipient testimonial', 'nine years in the Army'],
    // Named only in that newsletter's Foundation roster, and nowhere in the
    // chapter's own data. Naming her here would be a fresh disclosure about a
    // private individual, not a republication.
    ['Foundation roster name', 'Melissa Kalner'],
  ];

  for (const [what, needle] of withheld) {
    it(`does not publish the ${what}`, () => {
      const hits = pages.filter((p) => p.html.includes(needle)).map((p) => p.route);
      expect(hits, `"${needle}" (${what}) appears on: ${hits.join(', ')}`).toEqual([]);
    });
  }
});

describe('conflicting contact details are not guessed at', () => {
  // Two addresses are published for the treasurer and two for the newsletter
  // editor. One of each is wrong, so NEITHER may be published.
  const contested = ['caharris4@aol.com', 'csharris4@aol.com', 'grunt69@gmail.com', 'grunt60@gmail.com'];

  for (const email of contested) {
    it(`does not publish the contested address ${email}`, () => {
      expect(html).not.toContain(email);
    });
  }

  it('still offers a working route for those roles', () => {
    // Suppressing the address must not leave a dead end — the contact page has
    // to fall back to the chapter phone number.
    const contact = pages.find((p) => p.route === '/contact');
    expect(contact, 'no /contact page').toBeDefined();
    expect(contact!.text).toContain('703-850-3498');
  });
});

describe('the Foundation material, which came from one unverified source', () => {
  const nvvvfPages = pages.filter((p) => p.text.includes('PO Box 2111') || /nvvvf\.org/i.test(p.html));

  it('is on the site at all — otherwise every rule below is vacuous', () => {
    expect(nvvvfPages.map((p) => p.route)).toContain('/give/nvvvf');
  });

  it('identifies the payee whenever it asks for money', () => {
    // An unidentified solicitation is the compliance defect here; the
    // disclosure is the fix. A donor must be able to look the organization up.
    for (const page of nvvvfPages) {
      expect(page.text, `${page.route} solicits for NVVVF without its exemption`).toContain('501(c)(3)');
      expect(page.text, `${page.route} solicits for NVVVF without an EIN`).toMatch(/\b\d{2}-\d{7}\b/);
      expect(page.text, `${page.route} solicits for NVVVF without an address`).toMatch(/PO Box 2111/);
      expect(page.text).toMatch(/Reston/);
    }
  });

  it('prints the EIN in the form the IRS publishes it, not as bare digits', () => {
    expect(html).toMatch(/\b33-2320012\b/);
    expect(html, 'an unhyphenated EIN is not the published identifier').not.toMatch(/\b332320012\b/);
  });

  it('does not link to the Foundation site until the chapter confirms it resolves', () => {
    // The newsletter says nvvvf.org would go live in September and writes the
    // address two ways in one document. src/data/nvvvf.json holds the flag; this
    // is the built-output check that the flag is actually obeyed.
    const anchors: string[] = [];
    for (const page of pages) {
      page.$('a[href]').each((_, el) => {
        const href = page.$(el).attr('href') ?? '';
        if (/nvvvf\.org/i.test(href)) anchors.push(`${page.route} -> ${href}`);
      });
    }
    expect(anchors, `nvvvf.org is linked before it was confirmed live:\n${anchors.join('\n')}`).toEqual([]);
  });

  it('will still be safe once that link is turned on', () => {
    // Vacuous today by design, and armed the moment `confirmedLive` flips: the
    // Content-Security-Policy below is default-src 'self', so a link is fine but
    // a hotlinked asset would be blocked in production and nowhere in this suite.
    for (const page of pages) {
      page.$('a[href*="nvvvf.org"]').each((_, el) => {
        const href = page.$(el).attr('href') ?? '';
        const rel = page.$(el).attr('rel') ?? '';
        expect(href.startsWith('https://'), `${href} is not https`).toBe(true);
        expect(rel, `${href} has no rel=noopener`).toContain('noopener');
      });
    }

    const assets = [...html.matchAll(/(?:src|srcset)="([^"]*nvvvf\.org[^"]*)"/gi)].map((m) => m[1]);
    expect(assets, `assets loaded from nvvvf.org would be blocked by the CSP: ${assets.join(', ')}`).toEqual([]);
  });

  it('uses the chapter roster spelling of a name the newsletter spells differently', () => {
    // The newsletter writes "Ignatkowski". Three independent legacy records —
    // the officer roster, the contact list, and the Fort Meade plaque
    // inscription — write "Ignatowski". The migration test checks that facts are
    // PRESENT and would stay green with both spellings shipping at once, so the
    // wrong one has to be excluded here.
    expect(html, 'the newsletter spelling of a chapter officer reached the build').not.toContain('Ignatkowski');
    expect(html).toContain('Ignatowski');
  });

  it('publishes no figure from that source outside its review note', () => {
    // Belt and braces with tests/invariants/review-notes.test.ts, at the level
    // that matters most: these numbers must never reach a donor as fact.
    for (const page of pages) {
      const review = page.$('aside.review').text();
      const outside = page.text.replace(review.replace(/\s+/g, ' ').trim(), '');
      for (const figure of ['$101,598', '$169,000', '$58,500']) {
        expect(outside, `${page.route} publishes ${figure} as fact`).not.toContain(figure);
      }
    }
  });
});

describe('no client-side JavaScript', () => {
  it('ships no script elements at all', () => {
    // The legacy site loaded jQuery 1.4.3, FancyBox 1.3.4, a slider, and an
    // inline reload loop. This build ships none.
    //
    // Asserted against the raw HTML, not the Cheerio document: loadPages() runs
    // $('script, style').remove() before handing the document over, so
    // p.$('script') is empty by construction and the version of this test that
    // used it could never have failed — including on a build that shipped
    // jQuery on every page.
    const withScripts = pages.filter((p) => /<script\b/i.test(p.html)).map((p) => p.route);
    expect(withScripts, `pages with <script>: ${withScripts.join(', ')}`).toEqual([]);
  });

  it('can actually fail — the raw HTML is what is inspected', () => {
    // Guards the fix above from being quietly reverted to the stripped document.
    const home = pages.find((p) => p.route === '/')!;
    expect(home.html, 'the raw HTML is not being retained').toMatch(/<\/html>/i);
    expect(/<script\b/i.test(`${home.html}<script src="x.js"></script>`)).toBe(true);
    expect(home.$('script').length, 'the Cheerio document is stripped, as documented').toBe(0);
  });

  it('uses no inline event handlers', () => {
    // e.g. the legacy <body onload="setPrefs();">
    expect(html).not.toMatch(/\son(load|click|error|mouseover|submit|focus)\s*=/i);
  });

  it('uses no javascript: URLs', () => {
    expect(html.toLowerCase()).not.toContain('javascript:');
  });
});

describe('outbound links', () => {
  it('marks every cross-origin link rel="noopener"', () => {
    const bad: string[] = [];
    for (const page of pages) {
      page.$('a[href^="http"]').each((_, el) => {
        const rel = page.$(el).attr('rel') ?? '';
        if (!rel.includes('noopener')) bad.push(`${page.route} -> ${page.$(el).attr('href')}`);
      });
    }
    expect(bad, `cross-origin links without rel=noopener:\n${bad.join('\n')}`).toEqual([]);
  });

  it('never links out over plain http', () => {
    // The legacy Donation page linked PayPal over http://, and five of the
    // eight service-branch links were http:// too.
    const insecure = [...html.matchAll(/href="(http:\/\/[^"]+)"/gi)].map((m) => m[1]);
    expect(insecure, `insecure links: ${insecure.join(', ')}`).toEqual([]);
  });

  it('loads no assets from a third-party origin', () => {
    // Fonts are self-hosted precisely so this holds.
    const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/gi)]
      .map((m) => m[1])
      .filter((url) => /\.(js|css|woff2?|ttf|png|jpe?g|gif|svg)(\?|$)/i.test(url));
    expect(external, `third-party assets: ${external.join(', ')}`).toEqual([]);
  });
});

describe('response headers', () => {
  const headers = readPublicFile('_headers');

  it('sets a Content-Security-Policy that forbids scripts entirely', () => {
    expect(headers).toContain("script-src 'none'");
    expect(headers).toContain("default-src 'self'");
    expect(headers).toContain("object-src 'none'");
  });

  it('forbids framing and MIME sniffing', () => {
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('X-Frame-Options: DENY');
  });

  it('enables HSTS', () => {
    expect(headers).toMatch(/Strict-Transport-Security:\s*max-age=\d{7,}/);
  });

  it('sets a referrer policy that does not leak full URLs cross-origin', () => {
    expect(headers).toMatch(/Referrer-Policy:\s*(strict-origin-when-cross-origin|no-referrer|same-origin)/);
  });
});

describe('build hygiene', () => {
  it('leaks no environment variables or tokens', () => {
    // Patterns are anchored to how credentials actually appear (assignment or
    // an all-caps env-var name). A bare case-insensitive /secret/ matches the
    // word "Secretary", which is a chapter officer title.
    expect(html).not.toMatch(/process\.env\./);
    expect(html).not.toMatch(/\b[A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|PRIVATE_KEY)\b/);
    expect(html).not.toMatch(/(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["'][^"']{8,}/i);
    expect(html).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it('leaks no absolute filesystem paths from the build machine', () => {
    expect(html).not.toMatch(/[A-Z]:\\Users\\|\/home\/[a-z]+\//);
  });

  it('exposes no server technology fingerprint in the markup', () => {
    // The legacy pages carried <META NAME="Generator" CONTENT="VCilitate Cold Fusion">.
    expect(html).not.toMatch(/name="generator"/i);
  });
});
