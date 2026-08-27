/**
 * Site navigation — the single source of truth for structure.
 *
 * Header, footer and the sitemap all read from here, so the three can never
 * disagree. On the legacy site the global menu, the in-page "Click for More
 * Details" lists and the footer each carried a different set of links; the
 * Activities hub listed two of its four children, and the home page had a
 * carousel slide whose href was empty.
 *
 * This is a low-maintenance informational site aimed at donors to Chapter 227
 * and NVVVF, not a member-services hub — Get Help and Ways to Give were
 * deliberately dropped as top-level tabs (2026-08-27). Both pages still exist
 * and are reachable from in-page calls to action throughout the site; they are
 * simply no longer advertised as primary nav destinations.
 */

export interface NavItem {
  label: string;
  href: string;
  /** Short description used by the footer and section landing pages. */
  blurb?: string;
  children?: NavItem[];
}

export const NAV: NavItem[] = [
  {
    label: 'Home',
    href: '/',
    blurb: 'Who we are and what we do.',
  },
  {
    label: 'About Us',
    href: '/about',
    blurb: 'Who we are, where we came from, and who we are named for.',
    children: [
      {
        label: 'Dean K. Phillips',
        href: '/about/dean-k-phillips',
        blurb: 'The chapter’s namesake.',
      },
      {
        label: 'Chapter Documents',
        href: '/about/documents',
        blurb: 'By-laws, board minutes and the publication policy.',
      },
    ],
  },
  {
    label: 'What We Do',
    href: '/programs',
    blurb: 'VASH support, scholarships, school speakers and community partnerships.',
  },
  {
    label: 'Impact',
    href: '/give/impact',
    blurb: 'Every dollar the chapter paid out, itemized.',
  },
  {
    label: 'Foundation',
    href: '/foundation',
    blurb: 'A separate 501(c)(3) the chapter created in 2025 — and how the two organizations work together.',
  },
  {
    label: 'Join Us',
    href: '/join',
    blurb: 'Membership is open to anyone who served during the Vietnam era. Life membership is $50.',
    children: [
      {
        label: 'AVVA',
        href: '/join/avva',
        blurb: 'Associates of Vietnam Veterans of America — open to spouses, family and non-veterans.',
      },
    ],
  },
];

export const CONTACT_ITEM: NavItem = {
  label: 'Contact Us',
  href: '/contact',
  blurb: 'Reach the chapter.',
};

/** Every route in the navigation, flattened. Used by tests and the sitemap. */
export function allNavHrefs(items: readonly NavItem[] = [...NAV, CONTACT_ITEM]): string[] {
  const out: string[] = [];
  for (const item of items) {
    out.push(item.href);
    if (item.children) out.push(...allNavHrefs(item.children));
  }
  return out;
}

/**
 * Reduce a raw pathname to its canonical route.
 *
 * Necessary because `build.format: 'file'` emits `join.html`, so at render time
 * `Astro.url.pathname` is `/join.html` rather than `/join`. Without this,
 * aria-current never matched anything and canonical URLs shipped with a `.html`
 * suffix that does not match the URL visitors actually see.
 */
export function normalizePath(pathname: string): string {
  const withoutFile = pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  return withoutFile.replace(/\/+$/, '') || '/';
}

/**
 * Is `href` the current page, or an ancestor of it?
 * Drives aria-current on the header without any client-side JavaScript.
 */
export function isActive(href: string, pathname: string): boolean {
  const path = normalizePath(pathname);
  if (href === path) return true;
  return href !== '/' && path.startsWith(`${href}/`);
}

/**
 * The uniformed services. On the legacy site these eight external links were
 * the most prominent thing on every page — every one of them sent a visitor to
 * a different organization before they had read a word about Chapter 227.
 * Kept, but demoted to the footer.
 */
export const SERVICE_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'Army', href: 'https://www.army.mil' },
  { label: 'Marine Corps', href: 'https://www.marines.mil' },
  { label: 'Navy', href: 'https://www.navy.mil' },
  { label: 'Air Force', href: 'https://www.af.mil' },
  { label: 'Space Force', href: 'https://www.spaceforce.mil' },
  { label: 'Coast Guard', href: 'https://www.uscg.mil' },
  { label: 'NOAA Corps', href: 'https://www.omao.noaa.gov/learn/noaa-commissioned-officer-corps' },
  { label: 'Public Health Service', href: 'https://www.usphs.gov' },
];
