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
| P2 | Facts recovered from the legacy site and facts supplied later are counted separately, so a growing total cannot disguise a legacy fact that was dropped. | `tests/invariants/migration-coverage.test.ts` — *still carries at least … facts recovered from the legacy site* |
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
| V5 | `/privacy` says what the site publishes about people: while any page prints an email address, it says the leaders listed are shown with the address they use for the chapter, some of them personal, and never claims the site publishes no personal contact details. | `tests/invariants/privacy-disclosure.test.ts` — *says leaders are listed with their email addresses, some of them personal, as the built site shows* |

## Solicitation

| # | Rule | Test |
|---|---|---|
| S1 | Any page that carries a route for giving to the Foundation also carries its exemption, its EIN and its postal address. An unidentified solicitation is the defect; the disclosure is the fix. | `tests/security/output-safety.test.ts` — *identifies the payee whenever it asks for money* |
| S2 | The EIN is printed in the hyphenated form the IRS publishes. | `tests/security/output-safety.test.ts` — *prints the EIN in the form the IRS publishes it* |
| S3 | The Foundation's website is not linked until the chapter confirms it resolves, and becomes a link when it does. | `tests/security/output-safety.test.ts` — *links to the Foundation site now that the chapter has confirmed it resolves*; `tests/feature/nvvvf-section.test.ts` — *renders no link while the chapter has not confirmed the site is live*, *renders the link the moment the chapter confirms it*; `tests/contracts/nvvvf-data.test.ts` P9 proves the page actually renders the branch |
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
| A2 | Nothing is stored on or read from a visitor's device: no cookie, no localStorage, sessionStorage, IndexedDB, Cache Storage or cookieStore, whether reached through `window` or by its bare name, on load or on the way out. The pageview id lives only in memory. | `tests/unit/tracker.test.ts` — *is never written to or read from*, *can fail: storage reached as a bare global, inside a try, on the way out, is seen*; `tests/contracts/beacon-tracker.test.ts` — *names no API that stores anything on the device*; `tests/system/runtime.spec.ts` — *one page load writes exactly one row*, *hiding the page, then leaving it* |
| A3 | No query string or fragment is collected, from the page address or the referrer. The beacon never sends one, and the collector strips any that a hand-built request carries. | `tests/unit/tracker.test.ts` — *never sends a query string or fragment*; `tests/unit/beacon.test.ts` — *strips … from the referrer before it is stored*; `tests/system/runtime.spec.ts` — *arriving from a URL that carries ?token=secret* |
| A4 | The IP address is never stored. Location and network come from Cloudflare's edge; the visitor id is a hash of a secret salt, the Eastern date, the site, the IP and the user agent, which cannot be reversed without the salt and changes daily at midnight Eastern time, where `/stats` starts a new day, so one evening's reader is one visitor. The salt is one fixed secret, so whoever holds it can work an IPv4 visitor's address back out and link their days (see Known gaps), and `/privacy` promises no more than that (A17). With no salt configured the collector refuses rather than falling back, and logs which setting is missing. | `tests/security/collector.test.ts` — *the IP address is never kept*; `tests/feature/collector.test.ts` — *answers 500 "collector not configured" when …, and logs which, never a fallback salt* (the only test that runs the collector with no salt); `tests/unit/beacon.test.ts` — *refuses to run without a secret, by name*, *changes at midnight Eastern time*, *keeps one window across 8pm Eastern*, *can be worked back to an IPv4 address, and linked across days, by whoever holds the secret*; `tests/integration/collector-to-stats.test.ts` — *keeps one evening visit across 8pm Eastern as one visitor*; `tests/system/runtime.spec.ts` — *one page load writes exactly one row* (location and network read from the `request.cf` the runtime attaches, under Cloudflare's own field names) |
| A5 | Every payload the shipped beacon can send is accepted by the collector, and stored without the collector having to change it. A path or limit that one side produces and the other refuses loses visits with no error anywhere. | `tests/contracts/beacon-tracker.test.ts` — *passes validateEvent, and validation changes nothing a browser sent*, *stores one row per pageview, stamped with SITE_KEY* |
| A6 | The beacon is first-party: the Content-Security-Policy names no origin but the site's own, and allows no inline or eval script. Under that policy every page loads it and records its visit with no violation. | `tests/contracts/beacon-tracker.test.ts` — *names no origin but its own*, *opened no inline or eval allowance*; `tests/system/runtime.spec.ts` — *every built page, under the real policy*, *under the site's old policy … the beacon is blocked* |
| A7 | Adding Functions breaks no legacy redirect: `_routes.json` hands the Functions runtime only the collector and `/stats`. | `tests/contracts/analytics-routes.test.ts` — *never claims a wildcard, and never a path a legacy redirect needs*; `tests/system/runtime.spec.ts` — *every legacy redirect in _redirects still answers*. **Partial: see Known gaps.** |
| A8 | Rows older than the retention period are deleted, on every recorded pageview. | `tests/integration/collector-write.test.ts` — *deletes rows past the retention period when a view arrives* |
| A9 | `/stats` is shown only to a request carrying a Cloudflare Access token for this application: RS256 only (never `none`, never HS256), a key id the team has published, a valid signature, the configured team as issuer, this application's AUD among its audiences, and unexpired (60 s of clock skew either way). With either Access setting missing, or the team's signing keys unreachable, everyone is refused. Every refusal is the same plain 404, whatever the reason; the reason goes only to the log. | `tests/security/access-jwt.test.ts` — *signature forgery*, *claims that are valid but not ours*, *failing closed*, *accepts a token whose payload carries both URL-safe characters*, *rejects a genuine token with a segment added or one taken away*, *reads the clock itself when it is given none*; `tests/feature/stats-page.test.ts` — *the Access gate, as the owner and a stranger meet it*; `tests/security/stats-page.test.ts` — *the real gate, before Access is configured*, *every refusal is indistinguishable*, *logs the reason a gate gives, and a gate that throws as a gate error*; `tests/system/runtime.spec.ts` — */stats answers the handler's plain 404* |
| A10 | One pageview is one row. A page the browser prerenders is counted only once it is shown, so a prerender nobody opens records nothing. Reading time counts only while the page is visible, rises on that same row as the visitor hides or leaves the page, and never moves the time the visit started. | `tests/integration/collector-write.test.ts` — *never restamps ts when a late end arrives*; `tests/unit/tracker.test.ts` — *counts only the time the page is visible*, *sends nothing and starts nothing until the page is shown*, *sends exactly one view once shown*, *goes by sendBeacon when the page is hidden too*; `tests/system/runtime.spec.ts` — *hiding the page, then leaving it, raises reading time on that same row* |
| A11 | The setup script (`npm run setup:analytics`) writes only to the Pages project that serves vva227.org in the "Ch 227" account. A missing project, a same-named project that does not serve vva227.org, or a token for another account stops it before any write. | `tests/feature/setup-analytics.test.ts` — *refusing to touch the wrong project*; `tests/unit/setup-analytics-plan.test.ts` — *checkProject* |
| A12 | The setup script changes production settings only. It never sends `preview`, never sends an empty map, never deletes a setting, never replaces an existing salt, and never moves a `BEACON` binding that points at another database. | `tests/feature/setup-analytics.test.ts` — *production settings*; `tests/unit/setup-analytics-plan.test.ts` — *planBindings* |
| A13 | `/stats` admits exactly the addresses given with `--email`, as single-address rules. A policy someone widened to everyone or to a whole domain is put back to the list. The application carries that one policy and no other: any other policy on it is taken off and named, with its decision, in the output (a dry run says it would). Access checks a changed policy only at each person's next sign-in, so when a rerun takes access away from anyone (an address left out, a wider rule put back, another policy taken off) it also ends every sign-in already open, after those changes; a rerun that only adds someone, or changes nothing, ends none, and a dry run says it would. A run that stops after taking access away and before those sign-ins are ended says they were NOT ended and how to end them (`--end-sign-ins`, or the dashboard), because a rerun finds nothing left to change; `--end-sign-ins` ends them on any run where the application already exists. So the closing *Who can open /stats* line is what Access then admits, and it says so when require or exclude rules kept from the dashboard narrow it further, or when a copied sign-in still works at a pages.dev address Access does not cover. No address is built in: the repo is public. | `tests/security/setup-analytics.test.ts` — *who the policy admits*, *arguments cannot reach into a request*, *is decided by that policy alone*, *takes away the open sign-in of someone removed*, *never reports a removal as done when the open sign-in of someone removed is still good*; `tests/unit/setup-analytics-plan.test.ts` — *the policy*, *reads --end-sign-ins anywhere*, *says they were not, that a plain rerun will not end them, and both ways to end them*, *takes access away from someone (or not)*, *matches only when every destination is present and this policy is the only one*, *what the run says about who can open /stats*; `tests/feature/setup-analytics.test.ts` — *what it says about who can open /stats*, *ending sign-ins when someone is taken off the list*, *says the open sign-ins were not ended, and how to end them*, *says the same when the stop comes after the policy change and before the application is updated*, *with --end-sign-ins, ends them even when nothing else changes*, *takes off any other policy*, *says it would remove it*; `tests/contracts/analytics-docs.test.ts` — *says that removing a person ends the sign-ins already open* |
| A14 | The setup script is idempotent and never deploys. A rerun changes nothing but rewriting `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`; a run stopped because Zero Trust is off is finished by the next one; `--dry-run` sends only GETs. Its last words say the settings wait for a production deploy from a tree holding both the volunteer's latest work and this branch, and give that deploy with the setup's own API token and the "Ch 227" account id (as docs step 5 and the README's Deploying section do), in PowerShell and the Command Prompt too, so neither the computer's own Cloudflare login nor an account wrangler remembers can send it elsewhere. The token is made under a login that belongs to "Ch 227". Neither the script nor step 5 offers deleting part of wrangler's remembered account as the way round it, and the docs' log commands carry the same token and id. | `tests/feature/setup-analytics.test.ts` — *running it again*, *Zero Trust not turned on yet*, *--dry-run*, *a fresh account*, *what the owner reads, word for word*, *answers from Cloudflare the script does not take on trust*; `tests/security/setup-analytics.test.ts` — *it never deploys*; `tests/contracts/analytics-docs.test.ts` — *deploys with the setup token and the "Ch 227" account id*, *gives that command for Windows too, in PowerShell and in the Command Prompt*, *has the token created under a login that belongs to the "Ch 227" account*, *never has the owner delete only pages.json*, *gives every log command the setup token and the "Ch 227" account id*, *gives the deploy under Deploying with the setup token and the "Ch 227" account id* |
| A15 | The Cloudflare API token is never printed (even when an error repeats it), goes only to `https://api.cloudflare.com` in the Authorization header, and its file is gitignored. A token file that other accounts on the computer can read is refused before any request, with the `chmod 600` that fixes it and, for a drive where chmod has no effect (a Windows drive under WSL), `CF_API_TOKEN` as the way round it (Windows itself has no such permission bits and is not checked); `CF_API_TOKEN` is used as before. | `tests/security/setup-analytics.test.ts` — *the token*, *is refused before any request, with the command that fixes it, and is not echoed*, *is used once only its owner can read it*, *does not stop a run that takes its token from CF_API_TOKEN*, *is not checked for other readers on Windows, which has no such permission bits*; `tests/unit/setup-analytics-plan.test.ts` — *tokenFileOpenToOthers*, *offers CF_API_TOKEN where chmod has no effect*; `tests/contracts/analytics-docs.test.ts` — *has the owner make the token file private* |
| A16 | The binding, salt, Access settings and path the setup script writes are the names the Functions read, proven by running the real handlers on the env it produces. | `tests/contracts/setup-analytics.test.ts` — *the names the script writes are the names the Functions read* |
| A17 | The privacy page follows the feature. It names, in plain words, every column every table in the visit log stores (a column added without a disclosure fails), and says the referrer is the address of the page that sent the visitor, as the collector keeps it, not only that page's website, states the retention period the collector enforces (derived from `RETENTION_DAYS`, never typed), says the visitor code changes daily only while the salt period is one day, promises the code cannot be undone or linked across days only as far as one fixed salt allows (no unqualified "cannot be reversed", no "the chapter included") unless a per-day key is stored and deleted, says the rest of a record is kept as it is and can still make a frequent visitor recognizable, describes the opt-out the shipped `/b.js` honours, and no longer claims the site collects nothing. No column could hold an IP address, a browser string or a precise place. | `tests/invariants/privacy-disclosure.test.ts` — *discloses every column the visit log stores*, *says the record keeps the address of the page that sent a visitor, as the collector stores it*, *keeps no column that could hold an IP address*, *states the retention period the collector enforces*, *promises the visitor code cannot be undone or linked only as far as one fixed secret allows*, *can actually fail: the old promise is caught*, *says the rest of a record is kept as it is*, *describes the opt-out the shipped beacon honours*, *no longer claims the site collects nothing* |
| A18 | The collector writes only for vva227.org and www.vva227.org (and the loopback names local runs use). Every other hostname this Function answers on, the project's pages.dev address and every preview among them, is refused before the body is read, so a rate-limiting rule on the vva227.org zone cannot be got round. The optional rule is documented with the free plan's settings, on the collector's real path, and with what it costs readers who share one address. | `tests/security/collector.test.ts` — *refuses a valid view sent to …, and writes nothing*, *refuses the host BEFORE reading the body*; `tests/contracts/analytics-docs.test.ts` — *gives the optional rate-limiting rule for the collector*, *says the rule counts per address, so people sharing one network share its limit* |
| A19 | When the setup script updates the Access application or its policy, it keeps every setting on them it does not own: the session length, cookie and other hardening on the application; the session length, require and exclude rules, approval, purpose justification, MFA and isolation on the policy; and any setting Cloudflare adds later. It changes only the destinations it adds, the policy list (A13), the include list and the decision, and sends back none of the fields Cloudflare keeps itself. | `tests/feature/setup-analytics.test.ts` — *keeps every setting the owner made on the application and the policy*; `tests/unit/setup-analytics-plan.test.ts` — *on update, keeps every setting the policy already has*, *on update, keeps every setting the application already has*, *keeps a session length the policy has* |
| A20 | `/stats` lists, under *Recent visitors*, the `RECENT_VISITORS_LIMIT` visitor-days with the latest activity, newest arrival first, and the query that picks which visitors to fetch agrees with that cut; the summary above it still counts every person in the window (A22). *Pages* ranks by views, *Locations* and *Networks* by visitors and then views, and each keeps its top `TABLE_LIMIT`, so past the limit the least seen row is the one dropped. | `tests/integration/collector-to-stats.test.ts` — *fetches only the most recently active, in the query as in the grouping*, *lists exactly … leaving out the least recently active*; `tests/feature/stats-page.test.ts` — *shows the … most recently active, the earliest arrival among them if still active, while the summary counts all*, *ranks pages by views, and places and networks by visitors before views*; `tests/integration/collector-to-stats.test.ts` — *keep the … most viewed pages, dropping the least viewed though it sorts first by name*; `tests/unit/stats.test.ts` — *breaks ties the same way whatever order the rows arrive in* |
| A21 | The setup script reads the Zero Trust team's login methods and, when One-time PIN is not among them, warns in step 4 and again before its last words, with the dashboard path that turns it on: without it the people on the list cannot sign in to `/stats` with their own address, and Access answers "That account does not have access". It is a warning, never a stop, and sends only a GET (dry runs too); a list it cannot read is noted in one line and the run carries on. Docs step 1 turns One-time PIN on, and the troubleshooting table explains the Access page. | `tests/unit/setup-analytics-plan.test.ts` — *the login methods the team offers*; `tests/feature/setup-analytics.test.ts` — *the login methods the team offers*, *on a dry run where the team has no One-time PIN*; `tests/contracts/analytics-docs.test.ts` — *makes turning on One-time PIN part of step 1*, *has a troubleshooting row for the Access page that says the account does not have access* |
| A22 | `/stats` counts people, not crawlers. A visitor-day is set aside as likely automated when its network is one that has sent the site only crawlers (`CRAWLER_NETWORKS`); when every view it made had a window size only crawlers have used (`CRAWLER_WINDOWS`); or when no view recorded any reading time and it came from a big company's data centre (`NOTHING_READ_NETWORKS`) or a country the crawlers come from and readers do not (`NOTHING_READ_COUNTRIES`). The rule is one SQL condition built from those lists and applied in every query, before *Recent visitors* picks its `RECENT_VISITORS_LIMIT`, so crawlers can never push a person off the list. Nothing is deleted: what was set aside is listed at the end of the page with its reason and network. The evidence is what Cloudflare supplies or what every view carries, so a hand-built post can set aside only its own visits. No network that carries private-relay users (Cloudflare, Akamai, Fastly) is ever on a list. | `tests/integration/collector-to-stats.test.ts` — *keeps a person on Recent visitors however many crawlers came after them*, *sets aside each kind of crawler, through the real collector, and keeps the people beside them*; `tests/feature/stats-page.test.ts` — *counts only people above, and lists what it set aside, with the reason and network, at the end*; `tests/security/stats-page.test.ts` — *a forged crawler-sized view does not set aside the person whose network and browser it copies*; `tests/invariants/stats-partition.test.ts` — *counts every visitor once, as a person or as set aside, whatever the traffic*, *never lists a network that carries private-relay users*; `tests/unit/stats.test.ts` — *refuses a list entry that is not a positive whole number*, *explains every rule from the lists themselves* |

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
- **A9's allowed path has never run in workerd.** Every token test runs the
  verifier in Node. The `runtime` project has no Access settings and no
  reachable certs endpoint, so it proves only the refusal there. The verifier
  is casachristo.com's, ported unchanged in its WebCrypto calls, and that one
  runs in Pages production; the first allowed request on vva227.org is still
  this code's first in workerd.
- **A4's visitor code is only as private as `BEACON_SALT`.** The salt is one
  secret, written once by the setup script and never changed; only the date
  in the hash moves. Cloudflare does not show a secret, but anyone who can
  deploy to the Pages project can read it with a Function that returns it.
  With it they can try every IPv4 address against a stored code (the stored
  network number narrows the search to that network's addresses), then
  recompute that visitor's code for every other day kept and link their
  visits across the whole retention period. An IPv6 address is too large a
  space to search this way. A random salt per day, deleted once its day is
  over, would close this; the owner chose the lighter design. `/privacy` and
  `docs/analytics.md` say only what holds, and A17 keeps them to it. Even
  without the salt, the place, network and window size kept in each row can
  make a frequent visitor recognizable; `/privacy` says so.
- **A11-A14 and A19 are proven against a fake Cloudflare, not the real API.**
  The fake follows the documented shapes, and is pessimistic where they are
  silent (it wipes on an empty map; it answers "Zero Trust off" with a 404; a
  `PUT` to an Access application or policy replaces it whole). The script
  has never been run against the chapter's account, by design: only the owner
  runs it.
- **A13 cannot end a sign-in where Access does not stand.** When vva227.org
  is in another Cloudflare account, the pages.dev hostnames have no Access
  application, and the Function checks only that a token is genuine, for this
  application and unexpired. Ending sign-ins works at the Access edge, so a
  removed person who kept a copy of their token can still send it to `/stats`
  at the pages.dev address until it expires: at most the session length (24
  hours unless changed). The setup script says so when it happens; only a
  shorter session narrows it.
- **A18 slows a flood; nothing stops one.** The collector has to accept posts
  from anyone. The optional rate-limiting rule (`docs/analytics.md`, step 7)
  holds one address to about ten posts every ten seconds, the slowest the free
  plan allows. One address can be many readers: a group on one network, such
  as a meeting hall's Wi-Fi, shares the limit, and some of their views go
  uncounted for ten seconds when many open the site at once. And the limit is
  still enough, from one address over a day or from many addresses at once,
  to use up D1's free 100,000 rows written a day
  (a new visit writes about five, counting its indexes). Until 00:00 UTC no
  visit is recorded and the retention prune fails; the flood also spends the
  account's free daily Function requests, which `/stats` shares. Junk rows
  stay until the retention period or a manual delete. The static site is
  unaffected: only `/api/e` and `/stats` run as Functions. No test can show
  the rule works; it lives in the dashboard, not in this repository.
- **A22's lists were fitted to four and a half days of traffic.** From
  2026-10-18 to 22, 336 visitor-days were recorded. The lists set aside 324
  of them and none of the seven that look like people (several of those
  are the site's own checks); five crawlers still count as people, among
  them two security scanners on a transit network that also carries homes
  and offices, so it cannot be listed. Whether a real person on a listed
  network, or in a crawler-sized window, would be set aside has never been
  seen, so a false positive is untested against real people. The crawlers
  also move: overnight on 2026-10-21 the Chinese-network visits dropped the
  1800 x 1125 window for random desktop sizes. The page shows every network
  it set aside so a mistake can be noticed; re-check the lists against
  `/stats` monthly.
- **The privacy page's wording is not yet the chapter's.** `/privacy` now
  describes the visit log and is tied to it by A17, but the chapter has not
  approved either the counting or the words; its review note says so.
