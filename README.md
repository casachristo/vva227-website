# vva227-refresh

A rebuild of [vva227.org](https://vva227.org) — the website of Vietnam Veterans
of America **Chapter 227, the Dean K. Phillips Memorial Chapter** of Northern
Virginia.

Built with [Astro](https://astro.build), deployed static to Cloudflare Pages.
Ships **one small script of its own**: a first-party visit counter, no cookies,
no third parties (see [Visit analytics](#visit-analytics)).

> **Status: mock for client review.** See [REVIEW.md](./REVIEW.md) for the
> questions the chapter needs to answer before this can go live.

---

## What changed

| | Before | After |
|---|---|---|
| Pages | 50 | 16 |
| Empty / stub pages in the nav | 20 | 0 |
| Nav depth | 4 levels, hover dropdowns | 1 level, flat |
| JavaScript | jQuery 1.4.3, FancyBox 1.3.4, a slider, a reload loop | one first-party visit counter |
| Mobile support | none (fixed 1047px tables, no viewport tag) | responsive from 320px |
| Unique page titles | 1 (shared by all 50) | 16 |
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

The tests need Node 22.18 or newer (`.nvmrc` says so for nvm): the database
tests use Node's built-in SQLite, and the Pages-runtime server is a `.ts` file
Node runs directly.

```bash
npm test             # builds, then runs vitest (about 1,100 tests)
npm run test:system  # Playwright: desktop and mobile (about 80 tests)
npm run test:runtime # the real Pages runtime: the beacon, collector and /stats in workerd, with a local database
```

| Tier | Location | What it protects |
|---|---|---|
| unit | `tests/unit` | pure functions — date parsing, ordinals, currency, nav matching, link classification, the beacon, the collector's validation, the stats page, the setup script's decisions |
| feature | `tests/feature` | the Foundation page's core run for real — validation and view construction together, including branches the built site cannot contain; the collector, `/stats` behind a really signed Access token, and the setup script against a scripted Cloudflare, each run whole |
| contracts | `tests/contracts` | the shape every rendered page must have: one h1, unique title, real OG tags, alt text, no meta refresh; that every key a page reads out of a data file exists; and that the visit counter's pieces agree: the routing file and the Functions, the beacon and the collector, the setup script's settings and the names the Functions read, the documents and the code; and that its code type-checks strictly |
| integration | `tests/integration` | the build as a whole — every nav route exists, every internal link resolves, every legacy redirect lands somewhere real; and what the collector writes, read back by the real `/stats` queries in SQLite |
| invariants | `tests/invariants` | **migration coverage**, that every recorded disagreement actually renders — see below — and that `/privacy` describes what the visit log keeps |
| security | `tests/security` | no personal data, no third-party scripts, no insecure links, CSP headers; the collector, the `/stats` lock (forged and misdirected Access tokens), the setup script's token handling |
| system | `tests/system` | real browser at desktop and 375px — no console errors, no horizontal scroll, menu opens, images load; and, with `npm run test:runtime`, the built site in `wrangler pages dev` with a local D1, asserting what the database received |

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
    analytics.ts         the visit counter's shared values (endpoint, limits, retention)
    newsletter.json      The Journey archive
    facts-registry.json  migration coverage registry
  components/          one job each
  layouts/             BaseLayout (document shell) → PageLayout (interior page)
  lib/                 format.ts, nav.ts, and the visit counter — pure, unit-tested
  pages/               routes
  styles/tokens.css    every color, size and space
public/
  _headers             CSP and caching
  _redirects           legacy URLs → their replacements
  _routes.json         the only two paths Pages Functions handle
functions/             the visit collector (/api/e) and the visit log (/stats)
migrations/            the visit log's D1 schema
tools/                 setup-analytics.mjs — the one-time Cloudflare setup
docs/analytics.md      the visit counter: what it records, setup, troubleshooting
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

## Visit analytics

Every page loads `/b.js`, a small script of this site's own, which reports
each page view to `/api/e` on this same site: the page, the page that linked
to it (without its `?…`), the window size and how long the page was read. Cloudflare adds an approximate city and the visitor's internet provider.
Nothing is stored on the visitor's device, the IP address is never kept, and a
browser sending Global Privacy Control or Do Not Track is not counted at all.
Only visits to vva227.org are recorded, not to the `pages.dev` addresses.
`/privacy` describes it for visitors, and a test keeps that page in step with
the database.

The log is at **`/stats`**, behind Cloudflare Access, for the addresses the
owner names. Everyone else is stopped at Cloudflare's sign-in page, or gets a
plain `Not found` on an address Access does not cover.

Setting it up is one command, run once by the owner, followed by a deploy
with the account id that step 5 of the analytics document gives:

```bash
npm run setup:analytics -- --email you@example.com
```

[docs/analytics.md](./docs/analytics.md) has what is collected, the token to
create, the setup, how to read the logs, and what each refusal in them means.

---

## Deploying

```bash
npm run deploy     # builds and pushes to Cloudflare Pages
```

That deploys to whatever account the computer's Cloudflare login (or
wrangler's memory) picks. To deploy to the chapter's "Ch 227" account from any
computer, use the analytics setup's API token:
`CLOUDFLARE_API_TOKEN="$(cat .cf-api-token)" CLOUDFLARE_ACCOUNT_ID=d4afcdf7502fa80e6443dbb67ecd1d5f npm run deploy`
(see step 5 of [docs/analytics.md](./docs/analytics.md), which also gives the
Windows forms).

Target project: `vva227-refresh` in the chapter's "Ch 227" Cloudflare account. It serves
https://vva227.org (and answers on https://vva227-refresh-12g.pages.dev). The
production address is `site` in `astro.config.mjs`: every page's canonical URL and
social preview are built from it, so it must stay `https://vva227.org`.
https://vva227-refresh.pages.dev is the retired review mock, in another account:
never use it as an address.

`public/_redirects` maps every legacy URL. It is written for the real domain,
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
