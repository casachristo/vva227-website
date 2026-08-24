import { describe, it, expect } from 'vitest';
import { validateNvvvf, buildNvvvfView, type NvvvfData } from '../../src/lib/nvvvf';
import real from '../../src/data/nvvvf.json';

/**
 * FEATURE — the Foundation page's whole decision-making core, run for real.
 *
 * Validation and view construction run together against the actual data file
 * and against fixtures; nothing is mocked. What is asserted is the complete
 * shape the page consumes, not one field of it.
 *
 * TIER JUSTIFICATION: the built site only ever contains ONE value of
 * `url.confirmedLive`. A test against dist/ can prove nvvvf.org is not a link
 * today; it cannot prove the page renders the link correctly once the chapter
 * confirms the site is live, because that branch is not in the artifact. The
 * same goes for every rejection path — a malformed data file never reaches
 * dist/ at all, because it stops the build. Both are only reachable here.
 *
 * The rule these tests exist to hold: a figure the source contradicts itself on
 * has NO single value anywhere in the system. That is enforced structurally, by
 * the validator, and not by anybody remembering it.
 */

/** A deep clone of the real data, so a fixture edit cannot leak between tests. */
function fixture(mutate: (data: any) => void = () => {}): unknown {
  const copy = JSON.parse(JSON.stringify(real));
  mutate(copy);
  return copy;
}

describe('happy path — the real data file', () => {
  const data = validateNvvvf(real);
  const view = buildNvvvfView(data);

  it('validates, and the page gets every field it renders', () => {
    expect(view).toMatchObject({
      fullName: 'Northern Virginia Vietnam Veterans Foundation (NVVVF)',
      taxLine: '501(c)(3) · EIN 33-2320012',
      websiteText: 'nvvvf.org',
      websiteHref: null,
      postal: ['NVVVF', 'PO Box 2111', 'Reston, VA 20195'],
    });
    expect(view.referralSentence).toContain('Virginia Department of Veterans Services');
    expect(view.referralSentence).toContain('and other community partners');
    expect(view.disputed.length).toBeGreaterThanOrEqual(3);
    expect(view.openQuestions.length).toBeGreaterThanOrEqual(7);
    expect(view.withheld.length).toBe((real as { withheld: { items: string[] } }).withheld.items.length);
    expect(view.image?.src).toBe('/images/nvvvf-partnership.jpg');
  });

  it('carries every reading of a contradicted figure, however many sources disagree', () => {
    const people = view.disputed.find((d) => d.id === 'people-helped')!;
    expect(people.readings.map((r) => r.value).sort()).toEqual(['101', '84', '92']);

    const money = view.disputed.find((d) => d.id === 'assistance-paid')!;
    expect(money.readings.map((r) => r.value).sort()).toEqual(['$101,598', '$110,383', '$169,000']);

    // Each reading must say where it came from, or the ReviewNote is an
    // assertion rather than a disclosure.
    for (const item of view.disputed) {
      for (const reading of item.readings) {
        expect(reading.source.length, `${item.id} reading has no source`).toBeGreaterThan(10);
        expect(reading.label.length, `${item.id} reading has no label`).toBeGreaterThan(5);
      }
    }
  });

  it('states the Foundation is unconfirmed, so the page cannot imply otherwise', () => {
    expect(data.source.confirmedByChapter).toBe(false);
    expect(data.governance.namesPublished).toBe(false);
  });

  it('transcribes the words baked into the supplied graphic into its alt text', () => {
    // WCAG 1.4.5. The image is a composite with its headline set into the
    // pixels; a screen reader gets those words only if the alt carries them.
    expect(view.image!.alt).toContain(view.image!.textInImage);
    expect(view.image!.alt.length).toBeGreaterThan(20);
    expect(view.image!.credit).toMatch(/composite|generated/i);
  });
});

describe('the branch the built site cannot show — confirming the website', () => {
  it('renders no link while the chapter has not confirmed the site is live', () => {
    const view = buildNvvvfView(validateNvvvf(fixture((d) => (d.url.confirmedLive = false))) as NvvvfData);
    expect(view.websiteHref).toBeNull();
    // Explicitly not an empty string: an <a href=""> links to the current page,
    // which is worse than no link, and the integration tier bans it.
    expect(view.websiteHref).not.toBe('');
    expect(view.websiteText).toBe('nvvvf.org');
  });

  it('renders the link the moment the chapter confirms it, with no markup change', () => {
    const view = buildNvvvfView(validateNvvvf(fixture((d) => (d.url.confirmedLive = true))) as NvvvfData);
    expect(view.websiteHref).toBe('https://nvvvf.org');
    expect(view.websiteText).toBe('nvvvf.org');
  });

  it('shows the host without www even when the data carries it', () => {
    const view = buildNvvvfView(
      validateNvvvf(
        fixture((d) => {
          d.url.value = 'https://www.nvvvf.org';
          d.url.confirmedLive = true;
        }),
      ) as NvvvfData,
    );
    expect(view.websiteText).toBe('nvvvf.org');
    expect(view.websiteHref).toBe('https://www.nvvvf.org');
  });
});

describe('sad path — a malformed data file must stop the build', () => {
  const cases: Array<[string, (d: any) => void, RegExp]> = [
    ['a missing EIN', (d) => delete d.taxStatus.ein, /taxStatus\.ein/],
    ['an EIN with the wrong shape', (d) => (d.taxStatus.ein = '332320012'), /taxStatus\.ein/],
    ['an EIN one digit short', (d) => (d.taxStatus.ein = '33-232001'), /taxStatus\.ein/],
    ['a padded EIN', (d) => (d.taxStatus.ein = ' 33-2320012 '), /taxStatus\.ein/],
    ['a website served over http', (d) => (d.url.value = 'http://nvvvf.org'), /url\.value.*https/],
    ['a website that is not a URL', (d) => (d.url.value = 'nvvvf.org'), /url\.value/],
    ['a website pointing back at this site', (d) => (d.url.value = 'https://vva227.org'), /names this site/],
    ['a five-plus-four ZIP', (d) => (d.mailingAddress.zip = '20195-1234'), /mailingAddress\.zip/],
    ['an empty referral list', (d) => (d.referralPartners.list = []), /referralPartners\.list/],
    ['a blank referral', (d) => (d.referralPartners.list = ['  ']), /referralPartners\.list\[0\]/],
    ['no disputed figures at all', (d) => (d.disputed = []), /disputed/],
    ['a disputed figure with no readings', (d) => (d.disputed[0].readings = []), /disputed\[0\]\.readings/],
    ['a duplicate disputed id', (d) => (d.disputed[1].id = d.disputed[0].id), /disputed\[1\]\.id/],
    ['a one-word explanation', (d) => (d.division.review = 'TBC'), /division\.review/],
    ['a roster the file claims is withheld', (d) => (d.governance.namesPublished = true), /namesPublished/],
    ['an image alt that drops the words in the picture', (d) => (d.image.alt = 'Two people shaking hands.'), /image\.alt/],
    ['an image with no dimensions', (d) => delete d.image.width, /image\.width/],
    ['an image loaded from another host', (d) => (d.image.src = 'https://nvvvf.org/x.jpg'), /image\.src/],
    ['an empty withheld list', (d) => (d.withheld.items = []), /withheld\.items/],
  ];

  for (const [what, mutate, message] of cases) {
    it(`rejects ${what}, naming the key`, () => {
      expect(() => validateNvvvf(fixture(mutate))).toThrow(message);
      expect(() => validateNvvvf(fixture(mutate))).toThrow(/src\/data\/nvvvf\.json/);
    });
  }

  it('names the entry AND the reading when the fault is nested', () => {
    // A bare "source must be a string" sends the reader hunting through a file
    // with three disputed entries and five readings between them.
    expect(() => validateNvvvf(fixture((d) => delete d.disputed[1].readings[1].source))).toThrow(
      /disputed\[1\]\.readings\[1\]\.source/,
    );
    expect(() => validateNvvvf(fixture((d) => (d.disputed[2].note = 'x')))).toThrow(/disputed\[2\]\.note/);
    expect(() => validateNvvvf(fixture((d) => (d.disputed[0].readings[0].value = '')))).toThrow(
      /disputed\[0\]\.readings\[0\]\.value/,
    );
  });

  it('rejects a non-object outright', () => {
    for (const junk of [null, undefined, 'nvvvf', 42, []]) {
      expect(() => validateNvvvf(junk)).toThrow(/nvvvf\.json/);
    }
  });
});

describe('the structural rule — a disputed figure may not carry an answer', () => {
  // This is what makes "we publish none of the Foundation's numbers" a property
  // of the system rather than a promise. With a winner in the data, a page could
  // interpolate it and the ReviewNote below would become decoration.
  for (const key of ['value', 'resolved', 'correct', 'actual']) {
    it(`rejects a "${key}" key on a disputed entry`, () => {
      expect(() => validateNvvvf(fixture((d) => (d.disputed[0][key] = '92')))).toThrow(
        new RegExp(`disputed\\[0\\]\\.${key}`),
      );
    });
  }

  it('rejects it even when the value is falsy', () => {
    expect(() => validateNvvvf(fixture((d) => (d.disputed[0].resolved = false)))).toThrow(/resolved/);
    expect(() => validateNvvvf(fixture((d) => (d.disputed[0].value = '')))).toThrow(/value/);
  });

  it('accepts an entry that is merely undefined rather than contradicted', () => {
    // The response-time figure is not contradicted — it is unexplained. One
    // reading is legitimate; it is still presented as a question, not a fact.
    const data = validateNvvvf(real);
    const single = data.disputed.find((d) => d.readings.length === 1);
    expect(single, 'expected the undefined-metric case to be modelled').toBeDefined();
    expect(single!.question).toMatch(/\?$/);
    expect(single!.note.length).toBeGreaterThan(40);
  });
});

describe('edge cases', () => {
  it('builds a referral sentence from a single partner', () => {
    const view = buildNvvvfView(
      validateNvvvf(fixture((d) => (d.referralPartners.list = ['the VFW']))) as NvvvfData,
    );
    expect(view.referralSentence).toBe('the VFW and other community partners');
  });

  it('drops the image cleanly when there is none', () => {
    const view = buildNvvvfView(validateNvvvf(fixture((d) => delete d.image)) as NvvvfData);
    expect(view.image).toBeNull();
    // …and the image's own open question leaves the ReviewNote with it, rather
    // than asking the chapter about a picture that is not on the page.
    const withImage = buildNvvvfView(validateNvvvf(real));
    expect(view.openQuestions.length).toBe(withImage.openQuestions.length - 1);
  });

  it('puts the money question first, where a donor will read it', () => {
    const view = buildNvvvfView(validateNvvvf(real));
    expect(view.openQuestions[0]).toMatch(/reimburse/i);
  });

  it('does not mutate the data it is given', () => {
    const before = JSON.stringify(real);
    buildNvvvfView(validateNvvvf(real));
    expect(JSON.stringify(real)).toBe(before);
  });
});
