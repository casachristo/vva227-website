import { describe, it, expect } from 'vitest';
import { NAV, CONTACT_ITEM, SERVICE_LINKS, allNavHrefs, isActive, normalizePath } from '../../src/lib/nav';

describe('normalizePath', () => {
  // ---- The bug this function exists to fix ----
  it('strips the .html suffix that build.format "file" adds to pathnames', () => {
    // Astro.url.pathname is "/join.html" at render time. Without stripping it,
    // aria-current matched nothing and canonical URLs shipped with ".html".
    expect(normalizePath('/join.html')).toBe('/join');
    expect(normalizePath('/about/reports/2024.html')).toBe('/about/reports/2024');
  });

  it('maps index.html to its directory root', () => {
    expect(normalizePath('/index.html')).toBe('/');
    expect(normalizePath('/about/index.html')).toBe('/about');
  });

  // ---- Happy path ----
  it('leaves an already-clean path alone', () => {
    expect(normalizePath('/get-help/vet-center')).toBe('/get-help/vet-center');
  });

  // ---- Edge cases ----
  it('strips trailing slashes', () => {
    expect(normalizePath('/join/')).toBe('/join');
    expect(normalizePath('/join///')).toBe('/join');
  });

  it('returns "/" for root in every form', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('//')).toBe('/');
  });

  it('does not strip .html from the middle of a path segment', () => {
    expect(normalizePath('/about/x.html.foo')).toBe('/about/x.html.foo');
  });
});

describe('NAV structure', () => {
  it('has exactly seven top-level sections', () => {
    // The legacy site had nine, five of which were internal bookkeeping or
    // jargon. Six was the ceiling until The Foundation was promoted out of
    // Ways to Give to its own top-level entry — a deliberate content call,
    // not scope creep, so the ceiling moved rather than being enforced blindly.
    expect(NAV).toHaveLength(7);
  });

  it('puts Get Help first, ahead of recruitment and donation', () => {
    expect(NAV[0].label).toBe('Get Help');
    expect(NAV[0].href).toBe('/get-help');
  });

  it('gives every item a label and a root-relative href', () => {
    for (const href of allNavHrefs()) {
      expect(href.startsWith('/')).toBe(true);
      expect(href).not.toMatch(/\/$/); // trailingSlash: 'never'
    }
    for (const item of [...NAV, CONTACT_ITEM]) {
      expect(item.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('contains no duplicate hrefs', () => {
    const hrefs = allNavHrefs();
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('nests at most one level deep', () => {
    for (const item of NAV) {
      for (const child of item.children ?? []) {
        expect(child.children).toBeUndefined();
      }
    }
  });

  it('files each child under its parent path', () => {
    // A child at /join/avva belongs to /join. The legacy site filed a
    // membership invitation under "Fairfax Court".
    for (const item of NAV) {
      for (const child of item.children ?? []) {
        expect(child.href.startsWith(`${item.href}/`)).toBe(true);
      }
    }
  });
});

describe('allNavHrefs', () => {
  it('flattens parents and children, including Contact', () => {
    const hrefs = allNavHrefs();
    expect(hrefs).toContain('/get-help');
    expect(hrefs).toContain('/get-help/vet-center');
    expect(hrefs).toContain('/contact');
  });

  it('returns an empty array for empty input', () => {
    expect(allNavHrefs([])).toEqual([]);
  });

  it('handles an item with no children', () => {
    expect(allNavHrefs([{ label: 'X', href: '/x' }])).toEqual(['/x']);
  });
});

describe('isActive', () => {
  it('matches the exact path', () => {
    expect(isActive('/join', '/join')).toBe(true);
  });

  it('matches an ancestor of the current path', () => {
    expect(isActive('/join', '/join/avva')).toBe(true);
    expect(isActive('/about', '/about/reports/2024')).toBe(true);
  });

  it('does not match a sibling with a shared prefix', () => {
    // "/give" must not light up on "/giveaway".
    expect(isActive('/give', '/giveaway')).toBe(false);
  });

  it('does not match unrelated paths', () => {
    expect(isActive('/join', '/give')).toBe(false);
  });

  it('tolerates a trailing slash on the current path', () => {
    expect(isActive('/join', '/join/')).toBe(true);
  });

  it('treats root as active only for root itself', () => {
    expect(isActive('/', '/')).toBe(true);
    expect(isActive('/', '/join')).toBe(false);
  });
});

describe('SERVICE_LINKS', () => {
  it('keeps all eight uniformed services', () => {
    expect(SERVICE_LINKS).toHaveLength(8);
  });

  it('uses https for every branch link', () => {
    // The legacy site linked five of these over plain http.
    for (const link of SERVICE_LINKS) {
      expect(link.href.startsWith('https://')).toBe(true);
    }
  });
});
