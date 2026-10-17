# Business rules

Rules this site must hold, and the test that holds each one. A rule with no test
is a known risk and says so. If a behaviour exists in the code without an entry
here, it is undocumented and may be wrong.

This site handles no money and runs no server of its own. What it can still get
wrong is publish something untrue, publish something private, or send a visitor
somewhere they did not mean to go — so that is what the rules are about. The
one thing it stores is a visit log, and the rules for that are under *Visit
analytics*.

---

## Provenance and unresolved content

| # | Rule | Test |
|---|---|---|
| P1 | Every atomic fact recovered from the legacy site is present in the built output. The count never falls. | `tests/invariants/migration-coverage.test.ts` — *carries every registered legacy fact* |
| P2 | Facts recovered from the legacy site and facts supplied later are counted separately, so a growing total cannot disguise a legacy fact that was dropped. | `tests/invariants/migration-coverage.test.ts` — *still carries at least 79 facts recovered from the legacy site* |
| P3 | Every disagreement recorded in a data file is rendered visibly somewhere on the site. Recording a conflict and showing it to nobody is the failure this site exists to prevent. | `tests/invariants/review-notes.test.ts` — *renders every one of them somewhere in the built site* |
| P4 | Every review box announces itself as unconfirmed and carries usable content. | `tests/invariants/review-notes.test.ts` — *announce themselves as unconfirmed* |
| P5 | No figure from the Foundation newsletter is published as fact. Where its own source contradicts itself, both readings appear, inside the review box and nowhere else. | `tests/invariants/review-notes.test.ts` — *keeps every one of those figures inside the review note*; `tests/security/output-safety.test.ts` — *publishes no figure from that source outside its review note* |
| P6 | A disputed figure cannot carry a winner in the data model, so no page can render one as fact. | `tests/feature/nvvvf-section.test.ts` — *the structural rule*; `src/lib/nvvvf.ts` rejects `value`, `resolved`, `correct`, `actual` |
| P7 | A malformed data file fails the build, naming the key, rather than rendering an empty paragraph. | `tests/feature/nvvvf-section.test.ts` — *a malformed data file must stop the build*; enforced at build by `validateNvvvf()` in the page frontmatter |
| P8 | Every key a page reads out of a data file exists in it — including keys written on a loop variable inside the review note. A one-letter typo renders as nothing and would otherwise ship silently. | `tests/contracts/nvvvf-data.test.ts` — *every accessor the page writes resolves in the data*, *resolves the accessors written on loop variables* |
| P9 | Every field the view model produces is read by the page. A field the model produces and no template reads can be fully unit-tested, documented as the page's behaviour, and still have no effect on the built site. | `tests/contracts/nvvvf-data.test.ts` — *reads every field the view model produces* |

## Privacy

| # | Rule | Test |
|---|---|---|
| V1 | Personal contact details published on the legacy site are not republished until the chapter approves. | `tests/security/output-safety.test.ts` — *personal data withheld pending chapter approval* |
| V2 | No assistance recipient's story or identifying detail reaches the build — including inside a note explaining that it is withheld. | `tests/security/output-safety.test.ts` — same suite; the testimonial phrases are listed there |
| V3 | Nobody is named on this site who does not already appear in the chapter's own records. | `tests/security/output-safety.test.ts` — *Foundation roster name* |
| V4 | Where the legacy site published two values for one person, neither is published. | `tests/security/output-safety.test.ts` — *conflicting contact details are not guessed at* |

## Solicitation

| # | Rule | Test |
|---|---|---|
| S1 | Any page that carries a route for giving to the Foundation also carries its exemption, its EIN and its postal address. An unidentified solicitation is the defect; the disclosure is the fix. | `tests/security/output-safety.test.ts` — *identifies the payee whenever it asks for money* |
| S2 | The EIN is printed in the hyphenated form the IRS publishes. | `tests/security/output-safety.test.ts` — *prints the EIN in the form the IRS publishes it* |
| S3 | The Foundation's website is not linked until the chapter confirms it resolves, and becomes a link when it does. | `tests/security/output-safety.test.ts` — *does not link to the Foundation site*; `tests/feature/nvvvf-section.test.ts` covers both sides of the flag; `tests/contracts/nvvvf-data.test.ts` P9 proves the page actually renders the branch |
| S4 | The chapter's figures and the Foundation's figures never appear in one block, and are never summed. | `/give/impact` renders no Foundation figure — `tests/security/output-safety.test.ts` — *publishes no figure from that source outside its review note*. **Partial: the "never summed" half is held by review, not by a test.** |

## Links and assets

| # | Rule | Test |
|---|---|---|
| L1 | No page links to this site by absolute URL, at the staging origin or at the real domain. | `tests/unit/links.test.ts`; `tests/integration/build-output.test.ts` — *never links to this site by absolute URL* |
| L2 | Every internal link resolves to a page or asset that was actually built. | `tests/integration/build-output.test.ts` — *every internal link resolves* |
| L3 | Every cross-origin link is https and carries `rel="noopener"`. | `tests/security/output-safety.test.ts` — *outbound links* |
| L4 | No image ships that no page references, except those listed with a reason. The list can only shrink. | `tests/integration/build-output.test.ts` — *ships no image that no page references* |
| L5 | No source file carries a build-generated scope attribute — the fingerprint of markup pasted out of a deployed page. | `tests/integration/build-output.test.ts` — *authors no build-generated scope attributes by hand* |
| L6 | Words set into an image are transcribed into its alt text. | `tests/feature/nvvvf-section.test.ts`; `tests/system/nvvvf.spec.ts` |
| L7 | Pages that belong together link to each other from their content, not only from the global footer. A page reachable solely through site furniture is a page nobody reads. | `tests/integration/build-output.test.ts` — *links each page to the other from inside its content*; `tests/system/nvvvf.spec.ts` — *from the body of the page a donor is actually reading* |
| L8 | Every page ships exactly one `<script>`: the first-party visit beacon, `<script defer src=BEACON_SCRIPT>`, with no inline body. Nothing else. Asserted against raw HTML, because the test helper strips script elements from its parsed document — the version of this rule that used the parsed document could not fail. | `tests/security/output-safety.test.ts` — *ships exactly one script on every page*, *can actually fail* |

## Rendering

| # | Rule | Test |
|---|---|---|
| R1 | The review box on the Foundation page renders styled, not as plain text. This is the one failure that every string-level test in this repo is blind to. | `tests/system/nvvvf.spec.ts` — *the review note is visibly a review note* |
| R2 | The two payee cards are a row on desktop and a stack at 375px, and never overlap. | `tests/system/nvvvf.spec.ts` — *sit side by side on desktop and stack on a phone* |
| R3 | Clicking the page's primary call to action does not leave this origin. | `tests/system/nvvvf.spec.ts` — *stays on this origin* |
| R4 | No page scrolls sideways at 375px, and none produces a console error. | `tests/system/smoke.spec.ts` |

## Visit analytics

| # | Rule | Test |
|---|---|---|
| A1 | A visitor who sends Global Privacy Control or Do-Not-Track is not counted: the beacon makes no request and attaches no listener or timer. | `tests/unit/tracker.test.ts` — *does nothing at all when … is set*, *still collects when …*; `tests/system/runtime.spec.ts` — *with Global Privacy Control on, no request reaches the collector* |
| A2 | Nothing is stored on or read from a visitor's device: no cookie, no localStorage or sessionStorage. The pageview id lives only in memory. | `tests/unit/tracker.test.ts` — *is never written to or read from*; `tests/system/runtime.spec.ts` — *one page load writes exactly one row* |
| A3 | No query string or fragment is collected, from the page address or the referrer. The beacon never sends one, and the collector strips any that a hand-built request carries. | `tests/unit/tracker.test.ts` — *never sends a query string or fragment*; `tests/unit/beacon.test.ts` — *strips … from the referrer before it is stored*; `tests/system/runtime.spec.ts` — *arriving from a URL that carries ?token=secret* |
| A4 | The IP address is never stored. Location and network come from Cloudflare's edge; the visitor id is a salted hash that rotates daily, and with no salt configured the collector refuses rather than falling back. | `tests/security/collector.test.ts` — *the IP address is never kept*; `tests/unit/beacon.test.ts` — *refuses to run without a secret, by name* |
| A5 | Every payload the shipped beacon can send is accepted by the collector, and stored without the collector having to change it. A path or limit that one side produces and the other refuses loses visits with no error anywhere. | `tests/contracts/beacon-tracker.test.ts` — *passes validateEvent, and validation changes nothing a browser sent*, *stores one row per pageview, stamped with SITE_KEY* |
| A6 | The beacon is first-party: the Content-Security-Policy names no origin but the site's own, and allows no inline or eval script. Under that policy every page loads it and records its visit with no violation. | `tests/contracts/beacon-tracker.test.ts` — *names no origin but its own*, *opened no inline or eval allowance*; `tests/system/runtime.spec.ts` — *every built page, under the real policy*, *under the site's old policy … the beacon is blocked* |
| A7 | Adding Functions breaks no legacy redirect: `_routes.json` hands the Functions runtime only the collector and `/stats`. | `tests/contracts/analytics-routes.test.ts` — *never claims a wildcard, and never a path a legacy redirect needs*; `tests/system/runtime.spec.ts` — *every legacy redirect in _redirects still answers*. **Partial: see Known gaps.** |
| A8 | Rows older than the retention period are deleted, on every recorded pageview. | `tests/integration/collector-write.test.ts` — *deletes rows past the retention period when a view arrives* |
| A9 | `/stats` refuses everyone until its gate is chosen, and every refusal is the same plain 404, whatever the reason. | `tests/security/stats-page.test.ts` — *the real gate, as it ships today*, *every refusal is indistinguishable*; `tests/system/runtime.spec.ts` — */stats answers the handler's plain 404* |
| A10 | One pageview is one row. Reading time counts only while the page is visible, rises on that same row as the visitor hides or leaves the page, and never moves the time the visit started. | `tests/integration/collector-write.test.ts` — *never restamps ts when a late end arrives*; `tests/unit/tracker.test.ts` — *counts only the time the page is visible*; `tests/system/runtime.spec.ts` — *hiding the page, then leaving it, raises reading time on that same row* |

---

## Known gaps

- **S4** is only half tested. Nothing prevents a future editor writing a
  sentence that adds a chapter figure to a Foundation figure; only the absence of
  Foundation figures outside the review box is enforced.
- **Needle breadth** in the coverage registry is enforced only for
  chapter-supplied facts. Several legacy assertions are too broad to be evidence
  — `"349"`, `"$50"`, `"April"`, `"Arlington"` each match most of the site — and
  would keep passing if the fact itself were deleted. Tightening them is its own
  piece of work; see `tests/invariants/migration-coverage.test.ts`.
- **A7 is only half provable locally.** The `runtime` Playwright project serves
  the build through `wrangler pages dev`, and every legacy redirect works there.
  But swapping `_routes.json` for `include: ["/*"]` still passes: the local
  runtime hands a request no Function matches to its asset server, which still
  applies `_redirects`. Whether production does the same was not measured. The
  contract test is what holds the pin.
- **The privacy page predates the visit log.** `/privacy` still says the site
  runs no analytics and loads no scripts. No test ties that page to what the
  beacon and collector actually do, and the wording needs the chapter's
  approval before it changes.
