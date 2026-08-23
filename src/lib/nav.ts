/**
 * Site navigation — the single source of truth for structure.
 *
 * Header, footer and the sitemap all read from here, so the three can never
 * disagree. On the legacy site the global menu, the in-page "Click for More
 * Details" lists and the footer each carried a different set of links; the
 * Activities hub listed two of its four children, and the home page had a
 * carousel slide whose href was empty.
 *
 * Ordering is deliberate and reflects audience urgency:
 *   1. a veteran who needs help now
 *   2. a veteran considering joining
 *   3. someone who wants to give
 *
 * The Foundation (NVVVF) sits under Ways to Give rather than under Get Help,
 * because it is where the money for emergency assistance comes FROM. The
 * program itself — what a veteran actually receives — stays under Get Help.
 * The header nav is flat, so children surface only in the footer and the
 * mobile disclosure; adding one costs no header space.
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
    label: 'Get Help',
    href: '/get-help',
    blurb: 'Financial assistance, counseling and referrals for veterans and their families.',
    children: [
      {
        label: 'Alexandria Vet Center',
        href: '/get-help/vet-center',
        blurb: 'Free counseling for combat veterans and their families.',
      },
      {
        label: 'Veterans Treatment Court',
        href: '/get-help/treatment-court',
        blurb: 'Mentoring for veterans facing charges in Fairfax County.',
      },
    ],
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
  {
    label: 'Ways to Give',
    href: '/give',
    blurb: 'Checks, cash at meetings, vehicles, clothing and household goods.',
    children: [
      {
        label: 'Where Your Money Goes',
        href: '/give/impact',
        blurb: 'Every dollar the chapter paid out, itemized.',
      },
      {
        label: 'The Foundation',
        href: '/give/nvvvf',
        blurb: 'The 501(c)(3) the chapter created in 2025 to fund emergency assistance.',
      },
    ],
  },
  {
    label: 'What We Do',
    href: '/programs',
    blurb: 'VASH support, scholarships, school speakers and community partnerships.',
  },
  {
    label: 'Events & News',
    href: '/events',
    blurb: 'When and where we meet, and the chapter’s annual rhythm.',
    children: [
      {
        label: 'The Journey',
        href: '/events/news',
        blurb: 'The chapter newsletter archive, 2017 to 2024.',
      },
    ],
  },
  {
    label: 'About',
    href: '/about',
    blurb: 'Who we are, where we came from, and who we are named for.',
    children: [
      {
        label: 'Dean K. Phillips',
        href: '/about/dean-k-phillips',
        blurb: 'The chapter’s namesake.',
      },
      { label: 'Leadership', href: '/about/leadership', blurb: 'Officers, directors and committees.' },
      { label: 'Annual Reports', href: '/about/reports', blurb: 'The president’s letters, 2020 to 2024.' },
      {
        label: 'Chapter Documents',
        href: '/about/documents',
        blurb: 'By-laws, board minutes and the publication policy.',
      },
    ],
  },
];

export const CONTACT_ITEM: NavItem = {
  label: 'Contact',
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
