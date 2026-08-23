/**
 * Link classification.
 *
 * This exists because of a specific, quiet failure mode. A section drafted for
 * this site off-repo linked to the site's OWN /give page as
 * `https://vva227-refresh.pages.dev/give` — the staging origin, hardcoded. That
 * link works in the preview, so nothing looks broken; it keeps working after
 * the cutover to vva227.org, so nothing looks broken then either. It just
 * silently sends every visitor off the real domain and onto the staging copy
 * forever, and no internal-link check sees it, because to a crawler it is an
 * external link like any other.
 *
 * The rule is therefore a property of a URL string, not of a build: a page on
 * this site never names this site by absolute URL. Keeping it as one pure
 * predicate means the unit tier can enumerate the tricky cases (suffix
 * lookalikes, protocol-relative, case) and the integration tier can be a thin
 * loop over the built HTML rather than a second copy of the same regex.
 */

export type LinkKind =
  /** Root-relative: the correct form for a link to this site. */
  | 'internal'
  /** A different site, absolute. Needs rel="noopener" and https. */
  | 'external'
  /** mailto:, tel:, sms:, #fragment, or unparseable. Out of scope for origin rules. */
  | 'non-http'
  /** This site, named absolutely. Always a defect. */
  | 'self-absolute';

/**
 * Every origin that IS this site: the staging origin it is previewed on, and
 * the real domain it is pointed at. One list, imported by the data validator
 * and by the test helpers, so the rule cannot drift between them.
 */
export const SELF_ORIGINS: readonly string[] = [
  'https://vva227-refresh.pages.dev',
  'https://vva227.org',
  'https://www.vva227.org',
];

/** Parsing base. Never surfaces: it only exists so relative inputs parse at all. */
const PARSE_BASE = 'https://parse.invalid';

/**
 * "vva227.org." is the fully-qualified form of "vva227.org" and resolves to the
 * same server, so a literal string comparison would let a single trailing dot
 * walk a self-absolute link straight past the rule. Exactly one trailing dot is
 * stripped, which keeps "vva227.org.evil.com" a different host.
 */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

/**
 * Classify one `href`.
 *
 * @param href        the raw attribute value, exactly as authored
 * @param selfOrigins every origin that IS this site — the staging origin, the
 *                    real domain, and its www form. Compared host-for-host, so
 *                    `vva227.org.evil.com` and `vva227.orgx` stay external.
 */
export function classifyLink(href: string, selfOrigins: readonly string[]): LinkKind {
  if (typeof href !== 'string') return 'non-http';

  const raw = href.trim();
  if (raw === '') return 'non-http';
  if (raw.startsWith('#')) return 'non-http';

  // Root-relative is the shape we want everywhere internal. "//host" looks
  // root-relative but is protocol-relative, i.e. absolute — hence the guard.
  if (raw.startsWith('/') && !raw.startsWith('//')) return 'internal';

  let url: URL;
  try {
    url = new URL(raw, PARSE_BASE);
  } catch {
    return 'non-http';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'non-http';

  // A relative input that parsed against PARSE_BASE is not an absolute link.
  if (url.host === new URL(PARSE_BASE).host && !/^(https?:)?\/\//i.test(raw)) return 'non-http';

  const selfHosts = new Set(
    selfOrigins
      .map((origin) => {
        try {
          return normalizeHost(new URL(origin).host);
        } catch {
          return '';
        }
      })
      .filter(Boolean),
  );

  return selfHosts.has(normalizeHost(url.host)) ? 'self-absolute' : 'external';
}
