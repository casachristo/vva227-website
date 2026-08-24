# vva227-refresh

A rebuild of [vva227.org](https://vva227.org) — the website of Vietnam Veterans
of America **Chapter 227, the Dean K. Phillips Memorial Chapter** of Northern
Virginia.

Built with [Astro](https://astro.build), deployed static to Cloudflare Pages.
Ships **zero JavaScript**.

> **Status: mock for client review.** See [REVIEW.md](./REVIEW.md) for the
> questions the chapter needs to answer before this can go live.

---

## What changed

| | Before | After |
|---|---|---|
| Pages | 50 | 20 |
| Empty / stub pages in the nav | 20 | 0 |
| Nav depth | 4 levels, hover dropdowns | 1 level, flat |
| JavaScript | jQuery 1.4.3, FancyBox 1.3.4, a slider, a reload loop | none |
| Mobile support | none (fixed 1047px tables, no viewport tag) | responsive from 320px |
| Unique page titles | 1 (shared by all 50) | 20 |
| Working contact route | 0 | phone, post, per-role, Facebook |

The old site's content was not deleted — it was consolidated. A test suite
enforces that (see *Migration coverage* below).

---

## Running it

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # → dist/
npm run preview    # serve the built site
```

## Testing

```bash
npm test           # builds, then runs vitest (228 tests)
npm run test:system  # Playwright, desktop + mobile (82 tests)
```

| Tier | Location | What it protects |
|---|---|---|
| unit | `tests/unit` | pure functions — date parsing, ordinals, currency, nav matching, link classification |
| feature | `tests/feature` | the Foundation page's core run for real — validation and view construction together, including branches the built site cannot contain |
| contracts | `tests/contracts` | the shape every rendered page must have: one h1, unique title, real OG tags, alt text, no meta refresh; and that every key a page reads out of a data file exists |
| integration | `tests/integration` | the build as a whole — every nav route exists, every internal link resolves, every legacy redirect lands somewhere real |
| invariants | `tests/invariants` | **migration coverage**, and that every recorded disagreement actually renders — see below |
| security | `tests/security` | no personal data, no scripts, no insecure links, CSP headers |
| system | `tests/system` | real browser at desktop and 375px — no console errors, no horizontal scroll, menu opens, images load |

### Migration coverage

`src/data/facts-registry.json` holds every atomic fact extracted from the legacy
site — phone numbers, meeting times, dollar figures, officer names, program
descriptions — each with the literal strings that prove it survived.
`tests/invariants/migration-coverage.test.ts` fails if any of them disappears
from `dist/`.

```
[migration] 87/87 facts present in dist/
[migration] legacy 79/79, chapter-supplied 8
```

Two numbers, not one. The legacy count is the promise this project made —
nothing from the old site was lost. Facts the chapter supplied afterwards are
covered too, but reported separately, so a growing total can never disguise a
legacy fact that was dropped.

This exists because "consolidate" and "delete" look identical in a diff. Add a
fact to the registry whenever you add one to the site; never lower the ratchet
to make a build pass.

---

## Layout

```
src/
  content/reports/     the president's annual letters, migrated verbatim
  content.config.ts    Zod schemas — bad frontmatter fails the BUILD
  data/                structured facts, one source per fact
    site.json            identity, address, crisis line
    contacts.json        role-based contacts + what is deliberately withheld
    impact.json          aid figures by year, with recorded conflicts
    events.json          meeting details and the annual rhythm
    officers.json        leadership roster
    nvvvf.json           the Foundation — a separate 501(c)(3), separately sourced
    newsletter.json      The Journey archive
    facts-registry.json  migration coverage registry
  components/          one job each
  layouts/             BaseLayout (document shell) → PageLayout (interior page)
  lib/                 format.ts, nav.ts — pure, unit-tested
  pages/               routes
  styles/tokens.css    every color, size and space
public/
  _headers             CSP and caching
  _redirects           50 legacy URLs → their replacements
```

### Editing content

- **Copy** lives in `src/content/` (Markdown) and in the page components.
- **Facts** live in `src/data/*.json`. Each fact exists exactly once. Changing
  the treasurer's email is a one-line edit that updates every page referencing it.
- **Design** lives in `src/styles/tokens.css`. Change the palette there and the
  whole site follows.

The separation is deliberate: you can rewrite every word without touching a
component, and restyle everything without touching a fact.

### Unresolved content

Facts the chapter has not confirmed render a visible `<ReviewNote>` box rather
than a guess. Those boxes are review furniture — they come out before launch,
once [REVIEW.md](./REVIEW.md) is answered.

---

## Deploying

```bash
npm run deploy     # builds and pushes to Cloudflare Pages
```

Target project: `vva227-refresh` → https://vva227-refresh.pages.dev -- url deprecated

`public/_redirects` maps all 50 legacy URLs. It is written for the real domain,
so it becomes active the moment the site is pointed at `vva227.org`; no existing
link, bookmark or search result breaks.

---

## Notes on the source material

Content was recovered from the live site, from its PDFs (*The Journey*, the
accomplishments sheet, the membership application), and from the Internet
Archive where the live site had broken. Two things came from primary sources the
website itself never surfaced:

- **Captain Dean K. Phillips's biography** is transcribed from the bronze plaque
  the chapter commissioned at Fort Meade. The old page named for him told the
  story of restoring the plaque and never said who he was.
- **The student awards photograph** — chapter members presenting awards to
  Northern Virginia high-schoolers — appears on no live page and was recovered
  from the Internet Archive.

Photographs are the chapter's own, used at their natural size. They are candid
snapshots, and they look better that way than stretched. The one exception is
labelled as one: the partnership graphic on `/give/nvvvf` came with the
Foundation material, is a computer-generated composite rather than a photograph,
and says so in its own credit line and in REVIEW.md 2.9.

### The Foundation page

`/give/nvvvf` is the only page here whose source is not the legacy site. It is
built from *"One Year Later"* — a Foundation newsletter a chapter member
forwarded in 2026 — together with a ready-made HTML section drafted from it by
that member's own AI assistant.

Three things were done differently from that draft, and `src/pages/give/nvvvf.astro`
explains each at the top of the file:

- **None of the Foundation's figures are published.** Every quantitative claim in
  the newsletter is contradicted by another claim in the same newsletter. The
  draft picked one side of each and printed it as a headline statistic; both
  readings go in the review box instead. `src/lib/nvvvf.ts` rejects a data file
  that carries a winner, so this is structural rather than a convention.
- **The word "reimburse" is not used**, because the newsletter the draft
  summarizes does not say it.
- **Both calls to action point at the chapter.** The draft made "Donate at
  nvvvf.org" the primary button on the chapter's own site.

The draft also linked to this site's own `/give` page as an absolute staging URL
(`https://vva227-refresh.pages.dev/give`). That resolves, so nothing looks
broken — and after the cutover to vva227.org it would send visitors off the real
domain and back onto the preview, permanently. `src/lib/links.ts` and the
`self-referential links` suite in `tests/integration` now make that class of
link a build failure.
