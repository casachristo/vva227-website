# Questions for the chapter

Almost everything on the rebuilt site comes from the current vva227.org, its
PDFs, or the chapter's own bronze plaque at Fort Meade. Where the source was
contradictory, missing, or a privacy decision that is not ours to make, nothing
was invented — it was flagged instead. Those flags appear on the pages
themselves in a yellow box, and they are all listed here.

One page is the exception. **[The Foundation](/give/nvvvf)** is built from a
single Foundation newsletter, *"One Year Later"*, that a chapter member
forwarded to the site in 2026, together with a ready-made HTML section drafted
from it by that member's own AI assistant. None of it has been confirmed by the
board, it contradicts itself on every figure it publishes, and it describes the
chapter's own assistance program differently from the way this site currently
describes it. It is on the site because it is genuinely valuable — it is the
first thing anywhere here that explains how emergency aid reaches a veteran —
and every unverified part of it is flagged rather than presented as fact. See
**1.5**, **1.6** and **1.7**.

Anything marked **BLOCKER** should be answered before the site goes public.

---

## 1. Blockers

### 1.1 How does a veteran actually ask for help? — **BLOCKER**

The current website describes what the chapter pays for and how much it spent,
but never says how to request assistance. There is no form, no assistance phone
number, and no named person. This is the most consequential gap found in the
whole audit: the site's primary purpose has no working entry point.

*Needed: who takes these requests, and how.* → shown on `/get-help`

**Amended, 2026.** The Foundation newsletter narrows this question without
closing it, and contradicts the page while doing so. It says requests arrive as
**referrals** from partner agencies — the Virginia Department of Veterans
Services, county veterans offices, Veterans Treatment Docket mentors, the VFW
and the American Legion; that a **Financial Assistance Committee** documents and
verifies each one; and that payment goes to the landlord, utility company or
repair shop, **never to the veteran in cash**. `/get-help` currently says the
chapter gives money *directly to veterans and their families* and that it is
*not a grant program with forms and a review board*. Both cannot be right.

That page has **not** been rewritten around the newsletter, because a fundraising
appeal is not an intake policy and this is the page a veteran in difficulty
reads first. Still needed, on top of the original question:

- Which description is correct?
- **May a veteran with no caseworker approach the chapter directly, or is a
  partner referral required?** If a referral is required the page must say so
  and name the first door to knock on; if it is not, the referral list must
  never be presented as the way in.
- Who chairs the Financial Assistance Committee? It appears on no roster.

### 1.2 Who are the current officers and directors? — **RESOLVED, 2026-08-17**

The roster page used to carry no date, with cross-references suggesting it was
last revised around 2022–23.

**Resolved.** The chapter supplied a dated *Directory of Board & POCs*
(2026-08-17), and `officers.json` now reflects it — names and roles only; the
source document's addresses, personal phone numbers, emails, spouse details
and member numbers are not reproduced anywhere on this site. This also
settles two items the Foundation newsletter had left open:

- **Bruce Waxman is Immediate Past President**, not a plain director as the
  newsletter said — the chapter's own directory confirms `officers.json` had
  it right. See **1.8**.
- **Don Drunsic is still a chapter director** — his absence from the
  Foundation newsletter's chapter-role column was an omission there, not a
  change here.

Three items remain open:

- **A Financial Assistance Committee exists and is on no roster.** It decides
  who receives emergency aid. It needs a chair in `officers.json`.
- **James (Jim) Ellett** appears in the 2026-08-17 directory with no title
  filled in (every other entry says "Director" or "Contact"). He is left off
  the published roster until the chapter says what his role is, rather than
  guessing.
- **Three people on the previous roster are gone**, confirmed directly by the
  chapter rather than inferred from their absence: **Stan Derr** (web
  manager) and **Dennis Stephens** have died; **Tom Stryer** (school speakers
  panel) has resigned. The two committee chairs are now marked vacant in
  `officers.json` and need successors — see also **2.4**, which was already
  tracking Tom Stryer's broken contact link before this.

### 1.3 What is the exact meeting schedule? — **BLOCKER**

The current site contradicts itself:

| Source | Says |
|---|---|
| `Monthly-Meetings` | "9 general meetings every Thursday evening except July, August and Christmas" |
| `VVA-227-Chapter-membership` | "the 3rd Thursday of almost every month" |

The rebuilt site shows **third Thursday**, nine meetings a year, because that is
the only reading consistent with both. The venue and times come from a 2024
anniversary-dinner announcement — the only place they were ever published.

*Needed: the recurring day, the start time, whether December has a meeting or
only the party, and confirmation that American Legion Post 177, 3939 Oak Street,
Fairfax is still the venue.* → shown on `/events`, `/join`, and the home page

### 1.4 Two email addresses are published for the same people — **BLOCKER**

| Role | Address A | Address B |
|---|---|---|
| Treasurer (Chuck Harris) | `caharris4@aol.com` | `csharris4@aol.com` |
| Newsletter editor (Len Ignatowski) | `grunt69@gmail.com` | `grunt60@gmail.com` |

One of each is wrong. **Neither is published on the rebuilt site** — the contact
page routes those roles to the chapter phone number until this is settled.

*Needed: the correct address for each.* → shown on `/contact`

### 1.5 The Foundation — what it is, and how the money moves — **BLOCKER**

Everything the site now says about the Northern Virginia Vietnam Veterans
Foundation comes from one member-forwarded newsletter. Before `/give/nvvvf` goes
live:

1. **What is the exact founding date, and what does it mark** — incorporation in
   Virginia, the IRS determination letter, or the board vote? The effective date
   of exemption governs which gifts were deductible.
2. **Confirm the exemption and the EIN.** 501(c)(3) status and **EIN
   33-2320012** are checkable in the IRS Tax Exempt Organization Search. So is
   the Candid Platinum Seal, on Candid. All three are on a page asking for
   money and none has been verified by anyone here.
3. **Does the money flow as reimbursement to Chapter 227, or as payment to
   creditors, or both?** The newsletter says the Foundation *raises and stewards*
   funds and the chapter *pays*. The section drafted to accompany it says instead
   that the Foundation *reimburses the chapter* for grants already approved and
   paid — a word that appears nowhere in the newsletter. *"Your gift pays a
   veteran's landlord"* and *"your gift reimburses another organization"* are
   different statements to a donor. The site uses neither until you say which.
4. **Is the Foundation's remit only emergency assistance?** The drafted section
   says it is *not connected* to the chapter's other programs; the newsletter
   describes something broader. Does it fund, or intend to fund, scholarships,
   VASH or the school speakers program?
5. **Is the chapter itself tax-exempt, and are gifts to Chapter 227
   deductible?** The site has never said. Now that the Foundation's
   deductibility appears on a chapter page, the chapter's silence beside it is
   ambiguous to a donor writing a cheque.
6. **Is nvvvf.org live, and what is the canonical address?** The newsletter
   writes it two ways in one document — `https://nvvvf.org` in the body,
   `www.nvvvf.org` in the appeal and the footer — and says the site would go live
   in September. It is printed on the page as **plain text, not a link**, and
   becomes a link the moment you confirm it resolves.

→ shown on `/give/nvvvf`

### 1.6 Which Foundation figures are right? — **BLOCKER**

The newsletter contradicts itself on every number it publishes, so **not one of
them appears anywhere on this site** except inside the review box that records
the disagreement.

| | One reading | The other |
|---|---|---|
| People helped | **92** veterans and families, since June 2025 *(figure block)* | **84** this year *(the paragraph immediately above it)* |
| Assistance paid | **$101,598**, since June 2025 *(figure block)* | **$169,000** already distributed since the Foundation's founding *(The Challenge Ahead)* |

The Foundation was founded in June 2025, so both money figures describe the same
window and differ by **$67,402**. The two people figures sit inches apart and
read as the same claim.

Two more:

- **What does "under 48 hours average response" measure?** Acknowledgement of
  the referral, a funding decision, or a cheque in the creditor's hands? Over
  what sample, and since when? A service-level promise on a page somebody in
  crisis is reading has to mean something specific.
- **Do the Foundation's totals overlap the chapter's own?** Will the chapter's
  2025 and 2026 annual letters include grants the Foundation funded? Do the 92
  households overlap the VASH families already counted on `/give/impact`? Until
  this is answered the two sets of figures cannot appear on one page, and must
  never be added together.

*Needed: one table — period start, period end, households helped, dollars
disbursed, dollars raised, as of a stated date.* → shown on `/give/nvvvf` and
`/give/impact`

### 1.7 Is it Ignatowski or Ignatkowski? — **RESOLVED, 2026-08-17**

The Foundation newsletter spelled the vice president's surname **Ignat*k*owski**.
The site had three independent legacy attestations of **Ignatowski**: the officer
roster (twice — vice president and newsletter editor), the contact list, and the
inscription record for the Fort Meade plaque, *"installed 26 August 2006 by Len
Ignatowski and Joe Celesnik"*.

**Resolved.** The chapter's 2026-08-17 board & POC directory confirms
**Ignatowski** — the newsletter had the typo. No data files needed to change.
Note this is the same man whose email address is still contested in **1.4**.

### 1.8 Two new documents, and they raise the stakes rather than settle them — **BLOCKER**

As of August 2026, the chapter supplied two more Foundation source documents: a
newer version of the newsletter (*"One Year Later v11"*) and a **2026 PenFed
Foundation grant proposal** dated roughly August 22, 2026. Confirmed directly
with the chapter at the same time: **NVVVF has a development website, not yet
public** — `url.confirmedLive` stays `false` on `/foundation` and
`/give/nvvvf` until that changes, regardless of what any newsletter draft says
about launch dates.

These documents do not resolve **1.6** — they add a third, disagreeing reading:

- **People helped**, since June 2025: 92 or 84 (the newsletter, against itself)
  and now **101** (the PenFed proposal).
- **Assistance paid**, since June 2025: $101,598 or $169,000 (the newsletter,
  against itself) and now **$110,383** (the PenFed proposal) — lower than the
  newsletter's own higher figure, despite the PenFed document being dated
  later. A running total should not go down.
- One Year Later v11 labels its own headline numbers "editable statistics —
  update with the latest figures before publication," so even the newsletter's
  own authors do not treat them as final.

Two new problems, not previously flagged:

- **The EIN does not match.** One Year Later gives `33-2320012`; the PenFed
  proposal gives `33-2520012`. These must be checked against the IRS Tax
  Exempt Organization Search and the Foundation's own determination letter —
  this is not a typo either document's reader could safely guess at, and it sits
  on a page asking for tax-deductible gifts.
- **A chapter title conflicted with the chapter's own roster — resolved.** The
  newsletter's "Foundation and Chapter 227 Team" list gave Bruce Waxman the
  chapter title "Director"; `officers.json` had him as "Immediate Past
  President." The chapter's 2026-08-17 board & POC directory confirms
  `officers.json` was right. The roster itself stays withheld per **4.5**.

→ shown on `/foundation`, `/give/nvvvf`

---

## 2. Missing information

| # | What is missing | Where it shows |
|---|---|---|
| 2.1 | **The Venmo handle.** It exists only as pixels inside a QR image with empty alt text, so screen-reader users and desktop visitors cannot donate by Venmo at all. It must be published as text. | `/give` |
| 2.2 | **Vehicle donation contact.** The site describes Vehicles for Veterans in detail and gives no phone number or URL to start one. | `/give` |
| 2.3 | **Household goods pickup contact.** Same problem — VVA Pickup is described, with no way to schedule. | `/give` |
| 2.4 | **Tom Stryer's contact details.** The Community Outreach page ends the sentence "Contact Tom Stryer at" with nothing after it. The school speakers program is one of the chapter's best stories and its only call to action is broken. | `/programs` |
| 2.5 | **A court contact for the Treatment Docket.** The site describes the program but never links to Fairfax County's own information or gives a court contact. | `/get-help/treatment-court` |
| 2.6 | **How the chapter took Dean K. Phillips's name.** Captain Phillips died 22 August 1985, about four weeks after the founders met. Nobody has written down how or why the chapter chose to carry his name. This would be the single most compelling piece of writing on the site. | `/about/dean-k-phillips` |
| 2.7 | **Which community programs are still running.** The current page hedges in its own opening sentence: "is currently involved in multiple community oriented programs *(or was in the past)*". | `/programs` |
| 2.8 | **Upcoming meetings and speakers.** The current calendar renders an empty grid. | `/events` |
| 2.9 | **A chapter photograph for the Foundation page.** The only image supplied with the Foundation material is a computer-generated composite: it sets its headline into the pixels rather than into text, and it renders approximations of the Vietnam Veterans of America **registered mark** and of the Foundation's own seal. It is on the page for now, captioned as what it is. The chapter should either replace it with a real photograph or confirm — with the Foundation, and with VVA over its mark — that publishing it is acceptable. | `/give/nvvvf` |
| 2.10 | **Six photographs ship but appear on no page** — `nationals-ceremony.jpg`, `phillips-plaque-flag.jpg`, `pow-chair.jpg`, `pow-flag.jpg`, `pow-plaque.jpg`, `versace-memorial.jpg` (about 435 KB). Place them or delete them. A test now lists them explicitly so the number can only go down. | `public/images` |
| 2.11 | **The social preview card is the fall-festival photograph.** `og-default.jpg` is byte-identical to `fall-festival.jpg`, so every link shared to Facebook shows the same picture as the home page hero. Does the chapter want a purpose-made card? | site-wide |

---

## 3. Figures that disagree

The chapter's annual letters do not agree with each other. These need resolving
before the numbers go in front of donors or grant-makers.

- **2023 donations received.** The 2023 letter says members donated some
  **$37,500**. The 2024 letter says 2023 donations were **over $46,000**.
- **2021 year-end membership.** The 2021 letter ends the year at **349**.
  The 2022 letter says 2021 ran **"348 to 359"**.
- **No 2025 or 2026 figures exist.** Every donor-facing page on the current site
  still reports 2023. The newest annual letter is 2024, and it closes with
  commitments for 2025 that were never reported on. It is now 2026 and the
  site's headline figure is two years old — the Foundation material makes that
  gap conspicuous rather than causing it.
- **The Foundation's figures and the chapter's own.** See **1.6**. Nobody has
  said whether the two overlap, so they are not shown together anywhere.

→ shown on `/give/impact` and `/give/nvvvf`

### The founding date

| Source | Says |
|---|---|
| Home page meta description and `chapter-history` | Formed **24 July 1985** at the Fort Myer NCO Club |
| *The Journey* masthead | "Since **October 11, 1985**" |

The rebuilt site uses 24 July 1985 because it appears in the narrative history,
and flags the discrepancy. → shown on `/about`

### AVVA: auxiliary or not?

The AVVA page states flatly **"It is not an auxiliary."** The Membership page
calls it **"an auxiliary membership for spouses and others."** The AVVA wording
is used, because it appears on the page AVVA members wrote themselves.
→ shown on `/join/avva`

---

## 4. Privacy decisions for the board

These are published on the **current public site**. They are **not** reproduced
on the rebuilt site, because putting them on a new public URL is the chapter's
call, not ours. A test enforces their absence until you say otherwise.

1. **Two personal mobile numbers** — one for anniversary dinner RSVPs, one for
   AVVA and Lamb Center enquiries.
2. **A board member's home street address**, currently the public mail-to for
   membership applications. (The current site also prints a malformed ZIP+4.)
   Consider routing applications to the P.O. box instead.
3. **Two donors named** as the chapter's "most generous" in the 2020 annual
   letter. The letter is republished with the names replaced by
   *[names withheld pending the chapter's approval to republish]*.
4. **A quoted testimonial from a veteran the assistance program helped**, in the
   Foundation newsletter. It names nobody, but it gives that household's service
   history, family size and medical and financial circumstances in enough detail
   to be re-identifying within one chapter's catchment. Two things make it worse
   than the usual case: it was written for a **members'** appeal, and consent to
   that is not consent to a permanent, indexed public page; and it is the
   opposite of the chapter's own stated practice on `/give/impact`, which is that
   the chapter never contacts recipient families directly *because that keeps the
   help private for the people receiving it*. **It is not published, and the
   default answer should stay no** unless that veteran gives documented,
   republication-specific consent.
5. **The eight-name Foundation and Chapter 227 roster.** Seven of the eight
   already appear on this site in a chapter capacity. One — **Melissa Kalner** —
   appears nowhere in the chapter's own data, so naming her would be a fresh
   disclosure about a private individual rather than a republication. Publishing
   *Foundation* officer titles on the *chapter's* site also asserts a separate
   corporation's governance on the chapter's behalf, which is the Foundation's
   disclosure to make. Not published.

Also worth a decision: should members' names appear at all, and should the
officer roster carry role-based chapter email addresses rather than personal
ones?

---

## 5. Documents

- **5.1 The by-laws text needs re-issuing.** The published version has
  **ARTICLE IV twice**, **no ARTICLE V**, one clause marked "[OBSOLETE]" in the
  body, and numerous typos. The rebuilt site summarizes the provisions rather
  than reproducing a defective governing document. A clean signed PDF would
  replace the summary. → `/about/documents`
- **5.2 Board minutes.** Only two sets are online (September and November 2024).
  Older minutes are "available upon request" behind a link whose address is
  malformed, so the request cannot be made. Decide whether minutes are public,
  members-only, or off the website.
- **5.3 Is the membership application still current?** The only one on the site
  is titled "revised 2018" and its filename carries a Windows duplicate suffix.
- **5.4 Has *The Journey* stopped?** The archive has **no 2021 issues at all**,
  duplicate entries in 2019 and 2022, and only four issues in 2024 against a
  published policy of ten a year. The newest is November 2024.

---

## 6. Smaller decisions

- **The eight service-branch links** (army.mil, navy.mil, …) were the most
  prominent links on every page of the old site — each one sending a visitor to
  a different organization before they read a word about Chapter 227. They are
  kept, but moved to the footer. Keep, or drop?
- **Member Stories** has been in the navigation long enough to produce zero
  published stories. Do you want the feature at all? *(Note: the old submission
  endpoint accepted file uploads from anyone, gated only by a check that an
  email was already on file — that is both a security risk and a way to test
  whether a given person is a member. It should not be rebuilt as it was.)*
- **"Fairfax Fair and 50th anniversary" committee** — the chapter's own 50th
  falls in 2035, so this is presumably the Vietnam War 50th Commemoration. Which?
- **Which four Mission BBQ locations** does the chapter staff?
- **A contact form** needs a destination inbox before it can be built.
- **VVA National's dissolution.** The 2023 letter records a town hall about the
  chapter's future "after the eventual dissolution of VVA National later in the
  decade". The Foundation is evidently the answer the chapter arrived at, and
  `/about` and `/give/nvvvf` now say so. Please **confirm** that reading rather
  than decide it.
- **Should the chapter's own website solicit for the Foundation, and if so, how
  prominently?** The section drafted by the member's assistant made *"Donate at
  nvvvf.org"* the **primary** button. On the rebuilt page both calls to action
  point at the chapter, and the Foundation's postal address sits beside the
  chapter's own with each payee and tax position labelled — because a donor
  writing a cheque to the wrong one of two similarly-named organizations is the
  failure that matters. Which organization the chapter's site should push is the
  chapter's call, not a drafting decision.
- **Is the 2026 fundraising goal a public target?** The newsletter reports gifts
  received as of 30 June against a goal for the year. Neither figure is
  published here: an unmet goal on a permanent page has a downside if it is
  missed.

---

## 7. Defects fixed in the rebuild

For reference, these were repaired without needing a decision:

- The `<meta http-equiv="refresh" content="1">` and jQuery reload loop that made
  every page reload roughly once per second.
- Four `<!DOCTYPE>` declarations and multiple nested `<html>`/`<head>` pairs per
  page; unrendered ColdFusion tags leaking into the HTML as literal text.
- No viewport tag and a fixed 1047px table layout — unusable on a phone.
- Empty `alt` on every image, including the seven carousel slides that were the
  home page's only navigation.
- The site-wide **Contact** link returning "Sorry, but the page you requested is
  not available."
- The **Photos** page returning HTTP 500.
- Four pages in the global navigation that were completely empty
  (*Vehicles*, *Clothing and Furniture*, *Christmas Party*,
  *Chapter Information to Members*) and one titled *More Details Coming*.
- PayPal linked over insecure `http://`, and five of eight service links too.
- All 50 pages sharing one identical `<title>`.
- A dead VA link (`www1.va.gov/directory/guide/facility.asp`) and
  "Click for Directions with Google Maps" printed as plain text with no link.
- The 2023 donation table's arithmetic, which was correct — and is now
  recomputed from its line items at build time so it cannot drift.
