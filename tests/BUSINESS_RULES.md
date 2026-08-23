# Business rules

Rules this site must hold, and the test that holds each one. A rule with no test
is a known risk and says so. If a behaviour exists in the code without an entry
here, it is undocumented and may be wrong.

This site handles no money, stores no data and runs no server. What it can still
get wrong is publish something untrue, publish something private, or send a
visitor somewhere they did not mean to go — so that is what the rules are about.

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
| L8 | No page ships a `<script>`. Asserted against raw HTML, because the test helper strips script elements from its parsed document — the version of this rule that used the parsed document could not fail. | `tests/security/output-safety.test.ts` — *ships no script elements at all*, *can actually fail* |

## Rendering

| # | Rule | Test |
|---|---|---|
| R1 | The review box on the Foundation page renders styled, not as plain text. This is the one failure that every string-level test in this repo is blind to. | `tests/system/nvvvf.spec.ts` — *the review note is visibly a review note* |
| R2 | The two payee cards are a row on desktop and a stack at 375px, and never overlap. | `tests/system/nvvvf.spec.ts` — *sit side by side on desktop and stack on a phone* |
| R3 | Clicking the page's primary call to action does not leave this origin. | `tests/system/nvvvf.spec.ts` — *stays on this origin* |
| R4 | No page scrolls sideways at 375px, and none produces a console error. | `tests/system/smoke.spec.ts` |

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
- **`public/_headers` is not exercised by a browser.** `astro preview` does not
  apply it, so the Content-Security-Policy is asserted as a string in a file and
  never as a response header. A `wrangler pages dev` project in
  `playwright.config.ts` would close this.
