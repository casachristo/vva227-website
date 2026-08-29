import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPages, corpusText } from '../helpers/dist';

/**
 * INVARIANT — unresolved content is shown, never resolved.
 *
 * The README states the rule this whole project turns on: "Facts the chapter
 * has not confirmed render a visible <ReviewNote> box rather than a guess."
 * Every data file records its own disagreements — two founding dates, two
 * membership figures for 2021, two emails for one treasurer, a roster nobody
 * has dated, and now a Foundation newsletter that contradicts itself on every
 * number it publishes.
 *
 * Nothing enforced any of that. A `review` string could be added to a JSON file
 * and rendered by no page at all, and the whole suite would stay green while
 * the site quietly presented a guess as fact.
 *
 * TIER JUSTIFICATION: no other tier can see this. The unit tier tests pure
 * functions. The feature tier proves the view model carries the conflict
 * through. The contract tier proves each page has a valid shape. The security
 * tier proves specific strings are ABSENT. This is the only assertion in the
 * suite that a value recorded in one file must be VISIBLE somewhere in the
 * built site — a property of the whole build, not of any page in it.
 */

const DATA = join(process.cwd(), 'src/data');
const pages = loadPages();
const text = normalize(corpusText());

/** Keys the data files use to mark something the chapter has not settled. */
const MARKER_KEYS = ['review', 'reviewRequired'];
const MARKER_ARRAYS = ['conflicts'];

/** Below this a "note" is a placeholder, not an explanation the chapter can act on. */
const MIN_NOTE = 40;

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

interface Marker {
  file: string;
  path: string;
  text: string;
}

/** Every unresolved-content marker across every data file. */
function collectMarkers(): Marker[] {
  const out: Marker[] = [];

  for (const file of readdirSync(DATA).filter((f) => f.endsWith('.json'))) {
    const data = JSON.parse(readFileSync(join(DATA, file), 'utf8'));

    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${path}[${i}]`));
        return;
      }
      if (node === null || typeof node !== 'object') return;

      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const here = path ? `${path}.${key}` : key;

        if (MARKER_KEYS.includes(key) && typeof value === 'string') {
          out.push({ file, path: here, text: value });
        } else if (MARKER_ARRAYS.includes(key) && Array.isArray(value)) {
          value.forEach((entry, i) => {
            if (typeof entry === 'string') out.push({ file, path: `${here}[${i}]`, text: entry });
          });
        } else {
          walk(value, here);
        }
      }
    };

    walk(data, '');
  }

  return out;
}

const markers = collectMarkers();

describe('every recorded disagreement reaches the page', () => {
  it('found markers to check (the walk is not vacuous)', () => {
    // A renamed key would silently reduce this to zero and make every
    // assertion below pass against nothing.
    expect(markers.length, 'no review markers found — has a key been renamed?').toBeGreaterThanOrEqual(9);
    const files = new Set(markers.map((m) => m.file));
    expect([...files].sort()).toContain('nvvvf.json');
    expect([...files].sort()).toContain('impact.json');
  });

  it('renders every one of them somewhere in the built site', () => {
    const unshown = markers.filter((m) => !text.includes(normalize(m.text)));
    expect(
      unshown.map((m) => `${m.file} → ${m.path}: "${m.text.slice(0, 70)}…"`),
      `these disagreements are recorded but shown to nobody:\n${unshown.map((m) => `${m.file} ${m.path}`).join('\n')}`,
    ).toEqual([]);
  });

  it('writes markers a human can act on, not placeholders', () => {
    const thin = markers.filter((m) => normalize(m.text).length < MIN_NOTE);
    expect(thin.map((m) => `${m.file} ${m.path}: "${m.text}"`), 'markers too short to be a question').toEqual([]);
  });
});

describe('the review boxes themselves', () => {
  const notes = pages.flatMap((page) =>
    page
      .$('aside.review')
      .toArray()
      .map((el) => ({ route: page.route, body: normalize(page.$(el).find('.review__body').text()) })),
  );

  it('are present on the pages that carry unconfirmed content', () => {
    const routes = new Set(notes.map((n) => n.route));
    // /about carried a note on its founding date until the chapter confirmed
    // it (2026-08-29); it's off this list now because the page has no other
    // unconfirmed content, not because the list stopped mattering.
    for (const route of ['/give', '/give/impact', '/get-help', '/give/nvvvf']) {
      expect(routes.has(route), `${route} has no visible review note`).toBe(true);
    }
  });

  it('are never empty or near-empty', () => {
    const thin = notes.filter((n) => n.body.length < MIN_NOTE);
    expect(thin.map((n) => `${n.route}: "${n.body}"`), 'review boxes with no usable content').toEqual([]);
  });

  it('announce themselves as unconfirmed rather than reading as fact', () => {
    for (const page of pages) {
      page.$('aside.review').each((_, el) => {
        expect(normalize(page.$(el).text()), `${page.route} review note is unlabeled`).toMatch(
          /Needs the chapter.s confirmation/,
        );
      });
    }
  });
});

describe('the Foundation figures are shown, not resolved', () => {
  const page = pages.find((p) => p.route === '/give/nvvvf')!;
  const review = normalize(page.$('aside.review').text());

  it('has the page at all', () => {
    expect(page, 'no /give/nvvvf page was built').toBeDefined();
    expect(review.length).toBeGreaterThan(MIN_NOTE);
  });

  it('prints both readings of how many people were helped', () => {
    expect(review).toContain('92');
    expect(review).toContain('84');
  });

  it('prints both readings of how much was paid out', () => {
    expect(review).toContain('$101,598');
    expect(review).toContain('$169,000');
  });

  it('keeps every one of those figures inside the review note and nowhere else', () => {
    // This is the difference between disclosing a contradiction and picking a
    // winner. The section this page was drafted from published 92 and $101,598
    // as headline statistics with no mention that its own source disagreed.
    const outside = normalize(page.text).replace(review, '');
    for (const figure of ['92', '84', '$101,598', '$169,000']) {
      expect(outside, `${figure} is published outside the review note`).not.toContain(figure);
    }
  });

  it('says the source is unconfirmed, in the note itself', () => {
    expect(review).toMatch(/has not been confirmed by the chapter board/i);
  });
});
