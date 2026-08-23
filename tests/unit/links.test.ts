import { describe, it, expect } from 'vitest';
import { classifyLink } from '../../src/lib/links';
import { SELF_ORIGINS, SITE_ORIGIN } from '../helpers/dist';

/**
 * UNIT — the self-origin rule as a pure string property.
 *
 * The bug this guards was imported, not invented: a section drafted for this
 * site off-repo linked to the site's own /give page as
 * "https://vva227-refresh.pages.dev/give". It renders, it resolves, it returns
 * 200 — and after the cutover to vva227.org it quietly sends every visitor from
 * the real site back onto the staging copy, forever. No link checker sees it,
 * because to a crawler it is just an external link.
 *
 * TIER JUSTIFICATION: the integration tier can only test the hrefs that happen
 * to exist in today's build. The interesting cases are the ones that do not
 * exist yet — vva227.org before the cutover, a suffix lookalike, a
 * protocol-relative URL, an uppercase host. Only a pure predicate can be driven
 * through all of them, which is what lets the integration tier stay a thin loop
 * instead of a second copy of the same regex.
 */

const SELF = SELF_ORIGINS;

describe('happy path', () => {
  it('treats a root-relative path as internal', () => {
    expect(classifyLink('/give', SELF)).toBe('internal');
    expect(classifyLink('/', SELF)).toBe('internal');
    expect(classifyLink('/about/reports/2024', SELF)).toBe('internal');
    expect(classifyLink('/docs/vva227-membership-application.pdf', SELF)).toBe('internal');
  });

  it('treats another organization as external', () => {
    expect(classifyLink('https://nvvvf.org', SELF)).toBe('external');
    expect(classifyLink('https://www.veteranscrisisline.net/', SELF)).toBe('external');
    expect(classifyLink('https://paypal.me/VVA227', SELF)).toBe('external');
  });
});

describe('the bug this exists for', () => {
  it('flags the staging origin, which is what the drafted section linked to', () => {
    expect(classifyLink(`${SITE_ORIGIN}/give`, SELF)).toBe('self-absolute');
    expect(classifyLink('https://vva227-refresh.pages.dev/give', SELF)).toBe('self-absolute');
  });

  it('flags the real domain too, so the rule survives the cutover', () => {
    // After the site is pointed at vva227.org these become the same defect,
    // and nothing else in the suite would notice the change of direction.
    expect(classifyLink('https://vva227.org/give', SELF)).toBe('self-absolute');
    expect(classifyLink('https://www.vva227.org/give', SELF)).toBe('self-absolute');
  });

  it('flags a protocol-relative reference to this site', () => {
    expect(classifyLink('//vva227.org/give', SELF)).toBe('self-absolute');
  });

  it('is case-insensitive about the host, as DNS is', () => {
    expect(classifyLink('HTTPS://VVA227.ORG/give', SELF)).toBe('self-absolute');
    expect(classifyLink('https://VVA227.org/give', SELF)).toBe('self-absolute');
  });

  it('flags the bare origin with no path', () => {
    expect(classifyLink('https://vva227.org', SELF)).toBe('self-absolute');
  });

  it('flags the fully-qualified form with a trailing dot', () => {
    // "vva227.org." resolves to the same server. Compared as a literal string
    // it is a different host, so one dot would have walked a self-absolute link
    // straight past the rule.
    expect(classifyLink('https://vva227.org./give', SELF)).toBe('self-absolute');
    expect(classifyLink('https://www.vva227.org./', SELF)).toBe('self-absolute');
  });
});

describe('sad path — schemes that are not page links', () => {
  it('leaves mailto, tel and sms alone', () => {
    // vva227.org appears inside a real mailto on /contact. Matching on substring
    // rather than on host would flag it and force the rule to be weakened.
    expect(classifyLink('mailto:don_sutherland@vva227.org', SELF)).toBe('non-http');
    expect(classifyLink('tel:7038503498', SELF)).toBe('non-http');
    expect(classifyLink('sms:838255', SELF)).toBe('non-http');
  });

  it('leaves in-page fragments alone', () => {
    expect(classifyLink('#main', SELF)).toBe('non-http');
  });

  it('never throws on malformed input', () => {
    for (const junk of ['', '   ', 'ht!tp://[', '://nowhere', 'https://', '\n\t']) {
      expect(() => classifyLink(junk, SELF)).not.toThrow();
      expect(classifyLink(junk, SELF)).toBe('non-http');
    }
  });

  it('classifies a bare relative path as non-http rather than guessing', () => {
    // Astro never emits these, but a hand-written one must not silently be
    // treated as internal — it resolves differently per page depth.
    expect(classifyLink('give/nvvvf', SELF)).toBe('non-http');
  });

  it('survives a malformed entry in the self-origin list', () => {
    expect(classifyLink('https://vva227.org/give', ['not a url', 'https://vva227.org'])).toBe('self-absolute');
    expect(classifyLink('https://vva227.org/give', ['not a url'])).toBe('external');
  });
});

describe('edge cases — hosts that only look like this site', () => {
  it('strips only one trailing dot, so a lookalike stays external', () => {
    expect(classifyLink('https://vva227.org.evil.com/give', SELF)).toBe('external');
    expect(classifyLink('https://vva227.org..evil.com/', SELF)).toBe('external');
  });

  it('does not flag a domain that merely ends with ours', () => {
    // The classic phishing shape. A naive endsWith() check calls this ours.
    expect(classifyLink('https://vva227.org.evil.com/give', SELF)).toBe('external');
  });

  it('does not flag a domain that merely starts with ours', () => {
    expect(classifyLink('https://vva227.orgx/give', SELF)).toBe('external');
  });

  it('does not flag a domain that merely contains ours', () => {
    expect(classifyLink('https://notvva227.org', SELF)).toBe('external');
    expect(classifyLink('https://staging.vva227.org.cdn.net', SELF)).toBe('external');
  });

  it('does flag a subdomain only when it is listed', () => {
    // www.vva227.org is listed; blog.vva227.org is not, and inventing a rule
    // that all subdomains are ours would be a guess about DNS we cannot make.
    expect(classifyLink('https://www.vva227.org/', SELF)).toBe('self-absolute');
    expect(classifyLink('https://blog.vva227.org/', SELF)).toBe('external');
  });

  it('classifies http as sharply as https', () => {
    // Downgrading the scheme must not launder a self-absolute link into an
    // external one; a separate security test bans plain http outright.
    expect(classifyLink('http://vva227.org/give', SELF)).toBe('self-absolute');
    expect(classifyLink('http://example.com', SELF)).toBe('external');
  });

  it('tolerates surrounding whitespace, which HTML attributes may carry', () => {
    expect(classifyLink('  /give  ', SELF)).toBe('internal');
    expect(classifyLink('  https://vva227.org/give ', SELF)).toBe('self-absolute');
  });

  it('reads an empty self-origin list as "nothing is ours" rather than throwing', () => {
    // The integration tier separately asserts the list is not empty; this only
    // fixes the behaviour so that bug shows up there, loudly, not here silently.
    expect(classifyLink('https://vva227.org/give', [])).toBe('external');
  });
});
