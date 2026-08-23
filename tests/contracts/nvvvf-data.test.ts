import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateNvvvf, buildNvvvfView } from '../../src/lib/nvvvf';
import { SELF_ORIGINS } from '../helpers/dist';
import { classifyLink } from '../../src/lib/links';
import nvvvf from '../../src/data/nvvvf.json';

/**
 * CONTRACT — src/data/nvvvf.json and the page that reads it, checked against
 * each other rather than each against itself.
 *
 * TIER JUSTIFICATION: the feature tier proves the view model behaves correctly
 * on *a* data file. It cannot prove that the data file is the shape the real
 * page demands, because it never looks at the page. And Astro will not tell
 * you: `{nvvvf.founded.dispay}` — one letter wrong — is `undefined`, which
 * renders as nothing at all. The page still builds, every string-level test
 * still passes, and a paragraph is silently missing from a live page.
 *
 * So this suite reads the page's source as text, extracts every accessor it
 * writes, and resolves each one against the parsed data.
 */

const PAGE = join(process.cwd(), 'src/pages/give/nvvvf.astro');
const source = readFileSync(PAGE, 'utf8');

/**
 * The template only. The frontmatter above it holds import paths
 * ("../../data/nvvvf.json") and a doc comment mentioning nvvvf.org, neither of
 * which is an accessor — scanning them would make this suite fail on prose.
 */
const template = source
  .slice(source.indexOf('---', 3) + 3)
  // Optional chaining and bracket notation are the same access written three
  // ways. Normalizing first means the extraction below cannot be defeated by a
  // change of style — which would silently reduce this whole suite to nothing.
  .replace(/\?\./g, '.')
  .replace(/\[['"]([A-Za-z0-9_]+)['"]\]/g, '.$1');

const data = validateNvvvf(nvvvf);
const view = buildNvvvfView(data);

/** Resolve "founded.display" against an object, or return the missing marker. */
const MISSING = Symbol('missing');
function resolve(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === MISSING || acc === null || acc === undefined) return MISSING;
    // `key in Object(acc)` rather than a plain property read, so that a chained
    // array method — view.postal.map — resolves while a typo does not.
    return key in Object(acc) ? (acc as Record<string, unknown>)[key] : MISSING;
  }, root);
}

function accessors(prefix: string): string[] {
  const found = new Set<string>();
  // e.g. {nvvvf.division.creditorRule} — stop at anything that is not a path char.
  for (const match of template.matchAll(new RegExp(`\\b${prefix}\\.([A-Za-z0-9_.]+)`, 'g'))) {
    found.add(match[1].replace(/\.$/, ''));
  }
  return [...found].sort();
}

describe('the data file satisfies its own schema', () => {
  it('validates', () => {
    expect(() => validateNvvvf(nvvvf)).not.toThrow();
  });

  it('is validated by the page too, so bad data fails the build rather than the tests', () => {
    // If this import is ever dropped from the page, a malformed nvvvf.json
    // would ship instead of stopping `astro build`, and only this suite would
    // notice — after the fact.
    expect(source).toMatch(/import \{[^}]*validateNvvvf[^}]*\} from '\.\.\/\.\.\/lib\/nvvvf'/);
    expect(source).toMatch(/validateNvvvf\(raw\)/);
  });
});

describe('every accessor the page writes resolves in the data', () => {
  it('finds accessors at all (the extraction is not vacuous)', () => {
    expect(accessors('nvvvf').length).toBeGreaterThan(8);
    expect(accessors('view').length).toBeGreaterThan(5);
  });

  it('resolves every nvvvf.* path the page reads', () => {
    const broken = accessors('nvvvf').filter((path) => resolve(data, path) === MISSING);
    expect(broken, `page reads keys that nvvvf.json does not have: ${broken.join(', ')}`).toEqual([]);
  });

  it('resolves every view.* path the page reads', () => {
    const broken = accessors('view').filter((path) => resolve(view, path) === MISSING);
    expect(broken, `page reads view fields that buildNvvvfView does not produce: ${broken.join(', ')}`).toEqual([]);
  });

  it('resolves the accessors written on loop variables, not just on the roots', () => {
    // The disputed figures — the whole reason this page exists — are rendered
    // through {view.disputed.map((item) => …)} and a nested readings map. Those
    // accessors are written on `item` and `reading`, so a scan that only knows
    // about `nvvvf.` and `view.` never sees them: {item.notes} for {item.note}
    // silently deletes every explanation of why the figures cannot be published,
    // and the build, the contract tier and the browser tier all stay green.
    const broken: string[] = [];

    for (const path of accessors('item')) {
      if (data.disputed.some((entry) => resolve(entry, path) === MISSING)) broken.push(`item.${path}`);
    }
    for (const path of accessors('reading')) {
      const readings = data.disputed.flatMap((entry) => entry.readings);
      if (readings.some((reading) => resolve(reading, path) === MISSING)) broken.push(`reading.${path}`);
    }

    expect(accessors('item').length, 'no item.* accessors found — has the loop been rewritten?').toBeGreaterThan(2);
    expect(accessors('reading').length, 'no reading.* accessors found').toBeGreaterThan(2);
    expect(broken, `loop accessors that do not resolve: ${broken.join(', ')}`).toEqual([]);
  });

  it('reads every field the view model produces, so none is quietly dead', () => {
    // The other direction, and it is not symmetric. A field the page reads but
    // the model does not produce renders as nothing — bad, and caught above. A
    // field the model produces but the page never reads is worse in one specific
    // way: it can be fully unit-tested, documented as the page's behaviour, and
    // still have no effect on the built site. `websiteHref` was exactly that —
    // three tiers guarding a link no code path could emit.
    const read = new Set(accessors('view').map((path) => path.split('.')[0]));
    const unread = Object.keys(view).filter((key) => !read.has(key));
    expect(
      unread,
      `buildNvvvfView produces fields no template reads — render them or delete them: ${unread.join(', ')}`,
    ).toEqual([]);
  });

  it('reads nothing that renders as an empty string', () => {
    // `undefined` is caught above; `""` and `null` render as nothing just as
    // quietly, and are the shape a half-finished edit leaves behind.
    const empty: string[] = [];
    for (const path of accessors('nvvvf')) {
      const value = resolve(data, path);
      if (typeof value === 'string' && value.trim() === '') empty.push(`nvvvf.${path}`);
      if (value === null) empty.push(`nvvvf.${path} (null)`);
    }
    expect(empty, `page reads values that render as nothing: ${empty.join(', ')}`).toEqual([]);
  });
});

describe('the values the page will put in front of a donor', () => {
  it('publishes the EIN in the form the IRS uses', () => {
    expect(data.taxStatus.ein).toMatch(/^\d{2}-\d{7}$/);
    expect(view.taxLine).toContain('501(c)(3)');
    expect(view.taxLine).toContain(data.taxStatus.ein);
  });

  it('gives the Foundation a complete postal address, payee first', () => {
    expect(view.postal[0]).toBe(data.mailingAddress.payee);
    expect(view.postal).toHaveLength(3);
    for (const line of view.postal) expect(line.trim().length).toBeGreaterThan(0);
    expect(view.postal.at(-1)).toMatch(/^[A-Za-z .]+, [A-Z]{2} \d{5}$/);
  });

  it('never names this site as the Foundation website', () => {
    expect(classifyLink(data.url.value, SELF_ORIGINS)).toBe('external');
  });

  it('sources every claim the page repeats as fact', () => {
    for (const key of ['founded', 'taxStatus', 'url', 'mailingAddress', 'purpose', 'division'] as const) {
      const section = data[key] as unknown as { source?: string };
      expect(section.source?.trim().length, `${key} has no source`).toBeGreaterThan(10);
    }
  });
});

describe('what the page must NOT be able to say', () => {
  it('keeps every contradicted figure out of the page except inside the review note', () => {
    // The figures are read from `view.disputed` inside <ReviewNote> and nowhere
    // else. A literal 92 or $101,598 typed into the markup would defeat the
    // whole arrangement, so the source is checked for them directly.
    const literals = ['92', '84', '101,598', '169,000', '58,500', '150,000', '48 hrs', '48 hours'];
    const leaked = literals.filter((needle) => template.includes(needle));
    expect(leaked, `figures hardcoded into the page markup: ${leaked.join(', ')}`).toEqual([]);
  });

  it('does not hardcode a count of the things it withholds', () => {
    // "Two things ... are deliberately not reproduced here" introduced a list of
    // three, in the paragraph whose entire job is to be exact about what was
    // held back.
    expect(template).not.toMatch(/\b(One|Two|Three|Four|Five)\b[^<]{0,40}(not reproduced|withheld)/i);
  });

  it('does not use the word the source does not support', () => {
    // The drafted section said the Foundation "reimburses" the chapter. The
    // newsletter it summarizes says the Foundation raises and stewards, and the
    // chapter pays. Until the chapter says which is true, the site says neither.
    const body = template.toLowerCase();
    expect(body).not.toMatch(/\breimburs/);
    expect(body).not.toMatch(/\bearmarked\b/);
  });

  it('carries no roster names or recipient details from the newsletter', () => {
    const forbidden = ['Drunsic', 'Ignatkowski', 'Melissa', 'family of six', 'keep the lights on'];
    const present = forbidden.filter((name) => source.includes(name));
    expect(present, `withheld material reached the page source: ${present.join(', ')}`).toEqual([]);
  });
});
