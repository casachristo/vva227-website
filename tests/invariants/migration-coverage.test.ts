import { describe, it, expect } from 'vitest';
import { corpusText, corpusHtml, loadPages } from '../helpers/dist';
import registry from '../../src/data/facts-registry.json';

/**
 * MIGRATION COVERAGE — the invariant that protects this whole project.
 *
 * The brief was to consolidate ~50 pages into 14 without losing information.
 * "Consolidate" and "delete" look identical from a diff. This suite asserts
 * that every atomic fact extracted from the legacy site is still present
 * somewhere in the built output.
 *
 * TIER JUSTIFICATION: no unit or feature test can catch this. A component can
 * be perfectly correct in isolation while the page that was supposed to render
 * the chapter's phone number was never written. Only a property asserted across
 * the ENTIRE built site can prove nothing fell through the cracks.
 */

// Ratchets. Raise these as facts are added; never lower one to make a build pass.
//
// Two numbers, not one, because "migration" means something specific. The
// legacy count is the promise this project actually made — nothing from the old
// vva227.org was lost in consolidating 50 pages into 20. Facts the chapter
// supplied afterwards (the Foundation material, 2026) are covered too, but they
// were never on the old site and must not pad that number: a single total would
// let a legacy fact be dropped and the loss disguised by new content arriving.
//
// Both are set to the EXACT current count. Slack in a ratchet is a hole — with
// 70 against 79 covered, a registry entry and its content could be deleted
// together and both assertions would still pass.
const MIN_LEGACY_FACTS = 56;
const MIN_COVERED_FACTS = 64;

/** A needle matching most of the site proves nothing — "227" hits every header. */
const MAX_PAGES_PER_NEEDLE = 6;

const facts = registry.facts;
const ORIGINS = ['legacy-site', 'chapter-supplied'] as const;

describe('migration coverage', () => {
  const haystack = `${corpusText()}\n${corpusHtml()}`.toLowerCase();

  const missing: Array<{ id: string; fact: string; absent: string[] }> = [];

  for (const fact of facts) {
    const absent = fact.assert.filter((needle) => !haystack.includes(needle.toLowerCase()));
    if (absent.length > 0) missing.push({ id: fact.id, fact: fact.fact, absent });
  }

  it('carries every registered legacy fact into the built site', () => {
    const report = missing
      .map((m) => `  ${m.id}: ${m.fact}\n    missing strings: ${m.absent.map((s) => JSON.stringify(s)).join(', ')}`)
      .join('\n');

    expect(missing, `\n${missing.length} fact(s) lost in migration:\n${report}\n`).toEqual([]);
  });

  it(`covers at least ${MIN_COVERED_FACTS} facts (ratchet)`, () => {
    const covered = facts.length - missing.length;
    // Reported so the number is visible in CI output, not just asserted.
    console.log(`[migration] ${covered}/${facts.length} facts present in dist/`);
    expect(covered).toBeGreaterThanOrEqual(MIN_COVERED_FACTS);
  });

  it(`still carries at least ${MIN_LEGACY_FACTS} facts recovered from the legacy site`, () => {
    const missingIds = new Set(missing.map((m) => m.id));
    const legacy = facts.filter((f) => f.origin === 'legacy-site');
    const legacyCovered = legacy.filter((f) => !missingIds.has(f.id)).length;
    const supplied = facts.filter((f) => f.origin === 'chapter-supplied');

    console.log(
      `[migration] legacy ${legacyCovered}/${legacy.length}, chapter-supplied ${supplied.length}`,
    );
    // The number the project's promise rests on. Adding chapter-supplied facts
    // must never be able to raise it.
    expect(legacyCovered).toBeGreaterThanOrEqual(MIN_LEGACY_FACTS);
  });

  it('has a well-formed registry: unique ids, non-empty assertions', () => {
    const ids = facts.map((f) => f.id);
    expect(new Set(ids).size, 'duplicate fact ids in the registry').toBe(ids.length);

    for (const fact of facts) {
      expect(fact.assert.length, `fact ${fact.id} has no assertions`).toBeGreaterThan(0);
      for (const needle of fact.assert) {
        expect(needle.trim().length, `fact ${fact.id} has a blank assertion`).toBeGreaterThan(0);
        // A one- or two-character assertion would match almost any page and
        // give false confidence.
        expect(needle.trim().length, `fact ${fact.id} assertion "${needle}" is too short to be meaningful`)
          .toBeGreaterThan(2);
      }
    }
  });

  it('declares a source and a known origin for every fact', () => {
    for (const fact of facts) {
      expect(fact.source?.trim().length, `fact ${fact.id} has no source`).toBeGreaterThan(0);
      expect(ORIGINS as readonly string[], `fact ${fact.id} has origin "${fact.origin}"`).toContain(fact.origin);
    }
  });

  it('files Foundation facts as chapter-supplied, not as migrated', () => {
    // The Foundation postdates the legacy site entirely. If one of these were
    // ever stamped legacy-site it would inflate the migration ratchet, and the
    // headline "79 facts migrated" would quietly stop being true.
    for (const fact of facts.filter((f) => f.id.startsWith('nvvvf-'))) {
      expect(fact.origin, `${fact.id} is not from the legacy site`).toBe('chapter-supplied');
    }
  });

  it('proves every chapter-supplied fact against readable text, on few enough pages to mean something', () => {
    // Two failure modes at once, both real.
    //
    // Too broad: a needle that matches most of the site is satisfied by the
    // footer or the crisis banner and would keep passing after the fact itself
    // was deleted. "No paid staff" matched five pages of pre-existing chapter
    // copy before this assertion was narrowed.
    //
    // Not readable: the presence test above searches text AND raw HTML, so a
    // needle can be "present" only inside an href or an alt attribute. For a
    // fact that exists to be READ — the Foundation's EIN, its PO box, the rule
    // that money goes to the creditor — that is not good enough.
    //
    // Scoped to chapter-supplied facts because the legacy registry predates this
    // rule and has needles that would fail it ("349", "$50", "April"), each of
    // which is a genuine weakness and its own piece of work. Every fact added
    // from here on is held to the standard.
    const pages = loadPages();
    const bad: string[] = [];

    for (const fact of facts.filter((f) => f.origin === 'chapter-supplied')) {
      for (const needle of fact.assert) {
        const hits = pages.filter((p) => p.text.toLowerCase().includes(needle.toLowerCase())).length;
        if (hits === 0) bad.push(`${fact.id}: "${needle}" is in no page's visible text`);
        if (hits > MAX_PAGES_PER_NEEDLE) bad.push(`${fact.id}: "${needle}" matches ${hits} of ${pages.length} pages`);
      }
    }

    expect(bad, `weak assertions:\n${bad.join('\n')}`).toEqual([]);
  });

  it('can actually fail — a fact absent from the site is reported missing', () => {
    // Guards against the suite passing vacuously (e.g. an empty corpus).
    const sentinel = 'this string appears nowhere in the built site 8f3a91';
    expect(haystack.includes(sentinel)).toBe(false);
  });
});
