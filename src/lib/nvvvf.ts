/**
 * The Foundation page's core, as pure functions.
 *
 * Two jobs, both deliberately kept out of the .astro component:
 *
 *   validateNvvvf()  — a malformed src/data/nvvvf.json must fail `astro build`
 *                      with a message naming the key, the same contract
 *                      src/content.config.ts gives Markdown frontmatter. The
 *                      page is the only consumer, so the check runs there.
 *
 *   buildNvvvfView() — every decision the page makes about what to render:
 *                      whether the Foundation's URL is a link yet, what the
 *                      open questions are, how a disputed figure is presented.
 *
 * The reason this is a module and not JSX-with-conditionals is that a built
 * site only ever shows ONE value of `url.confirmedLive`. A test against dist/
 * can prove the link is absent today; it cannot prove the page would render it
 * correctly once the chapter confirms the site is live. A pure function can be
 * driven through both branches.
 *
 * INVARIANT, enforced below rather than by convention: a disputed figure has no
 * single value anywhere. `disputed[]` carries two or more `readings`, and the
 * validator REJECTS a `value` or `resolved` key on the entry itself. There is
 * therefore no expression a page could write that renders one reading as fact —
 * which is the whole reason none of the Foundation's numbers ship as figures.
 */
import { classifyLink, SELF_ORIGINS } from './links';

export interface NvvvfReading {
  value: string;
  label: string;
  source: string;
}

export interface NvvvfDisputed {
  id: string;
  question: string;
  readings: NvvvfReading[];
  note: string;
}

export interface NvvvfImage {
  src: string;
  width: number;
  height: number;
  textInImage: string;
  alt: string;
  credit: string;
  source: string;
  review: string;
}

export interface NvvvfData {
  name: string;
  abbr: string;
  createdBy: string;
  source: { document: string; kind: string; supplied: string; confirmedByChapter: boolean };
  founded: { display: string; detail: string; review: string };
  taxStatus: { designation: string; ein: string; deductibleClaim: string; review: string };
  url: { value: string; confirmedLive: boolean; review?: string };
  mailingAddress: { payee: string; line1: string; city: string; state: string; zip: string };
  purpose: { summary: string; crisisFrame: string };
  division: {
    foundation: string;
    chapter: string;
    committee: string;
    creditorRule: string;
    review: string;
  };
  referralPartners: { list: string[]; andOthers: string; review: string };
  operating: { volunteerOnly: string; model: string; candidSeal: string; review: string };
  succession: { summary: string; townHall: string; townHallSource: string };
  governance: { overlapStatement: string; namesPublished: boolean; review: string };
  disputed: NvvvfDisputed[];
  image?: NvvvfImage;
  withheld: { items: string[] };
}

export interface NvvvfView {
  /** "Northern Virginia Vietnam Veterans Foundation (NVVVF)" */
  fullName: string;
  /** "501(c)(3) · EIN 33-2520012" */
  taxLine: string;
  /** Always the bare host, for display: "nvvvf.org". */
  websiteText: string;
  /** null until the chapter confirms the site is live. Never an empty string. */
  websiteHref: string | null;
  /** ["NVVVF", "PO Box 2111", "Reston, VA 20195"] */
  postal: string[];
  /** "the Virginia Department of Veterans Services, county veterans offices, … and other community partners" */
  referralSentence: string;
  disputed: NvvvfDisputed[];
  /** Every unresolved question this data file records, in page order. */
  openQuestions: string[];
  image: NvvvfImage | null;
  withheld: string[];
}

/** How long a `review` or `note` must be before it counts as an actual explanation. */
const MIN_EXPLANATION = 40;

class NvvvfDataError extends Error {
  constructor(path: string, problem: string) {
    super(`src/data/nvvvf.json: ${path} ${problem}`);
    this.name = 'NvvvfDataError';
  }
}

function get(obj: unknown, key: string): unknown {
  return obj !== null && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

/**
 * `at` prefixes the reported path when `root` is not the whole document — so an
 * error inside the third disputed entry's second reading says
 * `disputed[2].readings[1].source`, not a bare `source` the reader then has to
 * go hunting for.
 */
function str(root: unknown, path: string, { min = 1, at = '' }: { min?: number; at?: string } = {}): string {
  const value = path.split('.').reduce<unknown>((acc, key) => get(acc, key), root);
  const where = at ? `${at}.${path}` : path;
  if (typeof value !== 'string') throw new NvvvfDataError(where, `must be a string, got ${typeof value}`);
  if (value.trim().length < min) {
    throw new NvvvfDataError(where, `must be at least ${min} characters of real text`);
  }
  return value;
}

function bool(root: unknown, path: string): boolean {
  const value = path.split('.').reduce<unknown>((acc, key) => get(acc, key), root);
  if (typeof value !== 'boolean') throw new NvvvfDataError(path, `must be true or false, got ${typeof value}`);
  return value;
}

/**
 * Validate the data file, or throw naming the offending key.
 *
 * Deliberately strict about the things that would let a guess reach a donor:
 * the EIN's shape, the website's origin, and the structure of a disputed figure.
 */
export function validateNvvvf(raw: unknown): NvvvfData {
  if (raw === null || typeof raw !== 'object') {
    throw new NvvvfDataError('(root)', 'must be an object');
  }

  for (const path of ['name', 'abbr', 'createdBy']) str(raw, path);
  for (const path of ['source.document', 'source.kind', 'source.supplied']) str(raw, path);
  bool(raw, 'source.confirmedByChapter');

  str(raw, 'founded.display');
  str(raw, 'founded.detail', { min: MIN_EXPLANATION });
  str(raw, 'purpose.summary', { min: MIN_EXPLANATION });
  str(raw, 'purpose.crisisFrame', { min: MIN_EXPLANATION });
  for (const key of ['foundation', 'chapter', 'committee', 'creditorRule']) {
    str(raw, `division.${key}`, { min: 20 });
  }
  str(raw, 'operating.volunteerOnly', { min: 20 });
  str(raw, 'operating.model');
  str(raw, 'operating.candidSeal');
  str(raw, 'succession.summary', { min: MIN_EXPLANATION });
  str(raw, 'succession.townHall', { min: MIN_EXPLANATION });
  str(raw, 'succession.townHallSource');
  str(raw, 'governance.overlapStatement', { min: MIN_EXPLANATION });
  bool(raw, 'governance.namesPublished');

  // A roster the site says it withholds must not then be carried in the file.
  if (bool(raw, 'governance.namesPublished')) {
    throw new NvvvfDataError('governance.namesPublished', 'must be false — the roster is withheld, see REVIEW.md 4');
  }

  // Every unresolved item must actually explain itself. A one-word "TBC" in a
  // review field renders a ReviewNote that tells the chapter nothing.
  for (const path of [
    'founded.review',
    'taxStatus.review',
    'division.review',
    'referralPartners.review',
    'operating.review',
    'governance.review',
  ]) {
    str(raw, path, { min: MIN_EXPLANATION });
  }

  // url.review is the one exception: optional, because the chapter has fully
  // confirmed this field (canonical host chosen, liveness confirmed
  // 2026-08-30) — there is no remaining open question to explain. If a future
  // edit reopens a question here, add the string back and it's required again.
  if (get(get(raw, 'url'), 'review') !== undefined) {
    str(raw, 'url.review', { min: MIN_EXPLANATION });
  }

  const ein = str(raw, 'taxStatus.ein');
  if (!/^\d{2}-\d{7}$/.test(ein)) {
    throw new NvvvfDataError('taxStatus.ein', `must look like 12-3456789, got "${ein}"`);
  }
  str(raw, 'taxStatus.designation');
  str(raw, 'taxStatus.deductibleClaim', { min: 20 });

  const website = str(raw, 'url.value');
  let websiteUrl: URL;
  try {
    websiteUrl = new URL(website);
  } catch {
    throw new NvvvfDataError('url.value', `is not a URL: "${website}"`);
  }
  if (websiteUrl.protocol !== 'https:') {
    throw new NvvvfDataError('url.value', `must be https, got "${website}"`);
  }
  if (classifyLink(website, SELF_ORIGINS) === 'self-absolute') {
    throw new NvvvfDataError('url.value', `names this site (${websiteUrl.host}), not the Foundation`);
  }
  bool(raw, 'url.confirmedLive');

  str(raw, 'mailingAddress.payee');
  str(raw, 'mailingAddress.line1');
  str(raw, 'mailingAddress.city');
  str(raw, 'mailingAddress.state');
  const zip = str(raw, 'mailingAddress.zip');
  if (!/^\d{5}$/.test(zip)) throw new NvvvfDataError('mailingAddress.zip', `must be five digits, got "${zip}"`);

  const partners = get(raw, 'referralPartners');
  const list = get(partners, 'list');
  if (!Array.isArray(list) || list.length === 0) {
    throw new NvvvfDataError('referralPartners.list', 'must be a non-empty array');
  }
  list.forEach((item, i) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new NvvvfDataError(`referralPartners.list[${i}]`, 'must be a non-empty string');
    }
  });
  str(raw, 'referralPartners.andOthers');

  const disputed = get(raw, 'disputed');
  if (!Array.isArray(disputed) || disputed.length === 0) {
    throw new NvvvfDataError('disputed', 'must be a non-empty array');
  }
  const seenIds = new Set<string>();
  disputed.forEach((entry, i) => {
    const at = `disputed[${i}]`;
    const id = str(entry, 'id', { at });
    if (seenIds.has(id)) throw new NvvvfDataError(`${at}.id`, `is a duplicate: "${id}"`);
    seenIds.add(id);
    str(entry, 'question', { min: 20, at });
    str(entry, 'note', { min: MIN_EXPLANATION, at });

    // THE structural rule. A disputed figure may not carry a winner, in any
    // spelling — otherwise a page could interpolate it and the ReviewNote below
    // becomes decoration rather than the disclosure.
    for (const banned of ['value', 'resolved', 'correct', 'actual']) {
      if (get(entry, banned) !== undefined) {
        throw new NvvvfDataError(`${at}.${banned}`, 'is forbidden — a disputed figure has readings, not an answer');
      }
    }

    const readings = get(entry, 'readings');
    if (!Array.isArray(readings) || readings.length === 0) {
      throw new NvvvfDataError(`${at}.readings`, 'must hold at least one reading');
    }
    readings.forEach((reading, j) => {
      const readingAt = `${at}.readings[${j}]`;
      str(reading, 'value', { at: readingAt });
      str(reading, 'label', { at: readingAt });
      str(reading, 'source', { at: readingAt });
    });
  });

  const image = get(raw, 'image');
  if (image !== undefined) {
    const src = str(raw, 'image.src');
    if (!src.startsWith('/')) throw new NvvvfDataError('image.src', `must be root-relative, got "${src}"`);
    for (const dim of ['width', 'height'] as const) {
      const n = get(image, dim);
      if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
        throw new NvvvfDataError(`image.${dim}`, 'must be a positive integer');
      }
    }
    const alt = str(raw, 'image.alt', { min: 20 });
    const textInImage = str(raw, 'image.textInImage');
    // WCAG 1.4.5: if words are baked into the picture, they belong in the alt.
    if (!alt.includes(textInImage)) {
      throw new NvvvfDataError('image.alt', `must transcribe the text set into the image: "${textInImage}"`);
    }
    str(raw, 'image.credit', { min: 20 });
    str(raw, 'image.source');
    str(raw, 'image.review', { min: MIN_EXPLANATION });
  }

  const withheldItems = get(get(raw, 'withheld'), 'items');
  if (!Array.isArray(withheldItems) || withheldItems.length === 0) {
    throw new NvvvfDataError('withheld.items', 'must be a non-empty array');
  }
  withheldItems.forEach((item, i) => {
    if (typeof item !== 'string' || item.trim().length < MIN_EXPLANATION) {
      throw new NvvvfDataError(`withheld.items[${i}]`, 'must say what is withheld and why');
    }
  });

  return raw as NvvvfData;
}

/** Join a list into prose: "a, b, c and other community partners". */
function sentenceList(items: readonly string[], tail: string): string {
  if (items.length === 0) return tail;
  return `${items.join(', ')} ${tail}`;
}

/** Everything the page renders, derived once. */
export function buildNvvvfView(data: NvvvfData): NvvvfView {
  const host = new URL(data.url.value).host.replace(/^www\./, '');

  return {
    fullName: `${data.name} (${data.abbr})`,
    taxLine: `${data.taxStatus.designation} · EIN ${data.taxStatus.ein}`,
    websiteText: host,
    // The link only exists once the chapter confirms the site resolves. Until
    // then the address is text — never an <a> to a host that may 404.
    websiteHref: data.url.confirmedLive ? data.url.value : null,
    postal: [
      data.mailingAddress.payee,
      data.mailingAddress.line1,
      `${data.mailingAddress.city}, ${data.mailingAddress.state} ${data.mailingAddress.zip}`,
    ],
    referralSentence: sentenceList(data.referralPartners.list, data.referralPartners.andOthers),
    disputed: data.disputed,
    openQuestions: [
      data.division.review,
      data.founded.review,
      data.taxStatus.review,
      ...(data.url.review ? [data.url.review] : []),
      data.referralPartners.review,
      data.operating.review,
      data.governance.review,
      ...(data.image ? [data.image.review] : []),
    ],
    image: data.image ?? null,
    withheld: data.withheld.items,
  };
}
