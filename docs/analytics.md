# Visit analytics

A small, free, first-party visit log for vva227.org, built the same way as
casachristo.com's. It answers "who looked at what, from roughly where, and
how did they get here" without cookies, without a third-party service, and
without storing anyone's IP address.

Everything runs on Cloudflare's free tier, inside the chapter's own account:
one script on every page, one Pages Function that records visits into a D1
database, and one private page, `/stats`, locked with Cloudflare Access.

---

## What is collected

One row per page view, in the `views` table of the D1 database
`vva227-beacon` (schema: [`migrations/0001_views.sql`](../migrations/0001_views.sql)).

| Column | What it holds | Where it comes from |
| --- | --- | --- |
| `path` | The page, e.g. `/get-help`. Never the query string. | The visitor's browser |
| `referrer` | The page that linked here, with `?…` and `#…` removed | The browser, stripped again on the server |
| `country`, `region`, `city` | Approximate location, e.g. `Fairfax, VA, US` | Cloudflare's edge (`request.cf`) |
| `as_org`, `asn` | Internet provider, e.g. `Comcast Cable Communications, LLC` / `7922` | Cloudflare's edge |
| `viewport_w`, `viewport_h` | Browser window size, for phone vs. computer | The browser |
| `engaged_ms` | How long the page was open **and visible** | The browser, updated as the visitor reads |
| `ts` | When the visit started (UTC; `/stats` shows Eastern time) | The server |
| `visitor` | A code: SHA-256 of a secret salt, today's date in Eastern time, the IP and the browser's user-agent string. It changes every day at midnight Eastern time, where `/stats` starts a new day, and cannot be reversed. | The server |
| `view` | A random id for this one page view, held only in the page's memory | The browser |
| `site` | Always `vva227` | The server |

**Not kept:** the IP address (used for the visitor code, then discarded),
cookies, anything in the browser's storage, postcode or coordinates.

**Kept for 730 days** (24 months), then deleted: the collector removes expired
rows every time a new visit arrives. The number lives once, as `RETENTION_DAYS`
in [`src/data/analytics.ts`](../src/data/analytics.ts), and `/privacy` derives
its wording from it.

**Opt-out:** a browser sending Global Privacy Control or Do Not Track gets a
script that does nothing at all: no request, no listener, no timer.

**Pages loaded ahead of time:** Chrome sometimes loads a page it expects you
to open (one you type often, or a bookmark you hover) before you open it. The
script waits until such a page is actually shown, so one you never open is
not counted.

**Only on vva227.org:** visits are recorded on `vva227.org` and
`www.vva227.org` only. The same site at `vva227-refresh-12g.pages.dev`, or
at a preview address, records nothing: the collector refuses those names, so
that nobody can get round the rate limit in step 7 by posting there.

**The public description** is [`/privacy`](../src/pages/privacy.astro).
`tests/invariants/privacy-disclosure.test.ts` fails if a column is added
without a sentence there, so the page cannot quietly fall behind the code.

---

## Where to see it

**https://vva227.org/stats**, after the one-time setup below.

Cloudflare Access asks for your email address and sends a one-time code (if
the sign-in page offers no way in, add the *One-time PIN* login method under
Zero Trust → Settings → Authentication). A sign-in lasts 24 hours.

The page shows the last 30 days by default; links switch to 7, 90 or 365.
It lists recent visitors (one row per visitor per day: when, where, which
provider, phone or computer, where they came from, the first page, how many
pages, how long), then pages, sources, locations and networks. Times are
Eastern.

To everyone else, on every hostname, `/stats` is a plain `Not found`.

### Why there are two locks

Access is applied to a hostname and path. This site also answers on
`vva227-refresh-12g.pages.dev` and on a fresh `<hash>.vva227-refresh-12g.pages.dev`
for every preview. A policy that covers only vva227.org is bypassed by typing
another hostname. So the Function **also** verifies the token Access attaches
(`Cf-Access-Jwt-Assertion`): RS256 only, signed by a key the team publishes,
issued by `ACCESS_TEAM_DOMAIN`, carrying `ACCESS_AUD`, unexpired. On a host
with no Access application there is no token, so `/stats` is a 404 there.
Edge policy = the lock. The Function's check = the deadbolt.

---

## One-time setup (the owner)

Nothing here changes the live site until step 5.

**1. Turn on Cloudflare Zero Trust, once.** Open
https://one.dash.cloudflare.com and pick the account that owns the
vva227.org zone (the setup script tells you which; usually "Ch 227"). Choose a
team name (it becomes `<team>.cloudflareaccess.com`) and the **Free** plan.
Cloudflare asks for card details even on the Free plan; it does not charge
them. If you skip this, the script stops and says so.

**2. Create an API token.** https://dash.cloudflare.com/profile/api-tokens →
*Create Token* → *Create Custom Token*, with exactly these permissions:

| Scope | Permission | Access |
| --- | --- | --- |
| Account | Cloudflare Pages | Edit |
| Account | D1 | Edit |
| Account | Access: Apps and Policies | Edit |
| Account | Access: Organizations, Identity Providers, and Groups | Read |
| Zone | Zone | Read |

*Account Resources:* include the **Ch 227** account. If vva227.org lives in a
different Cloudflare account, include that account too.
*Zone Resources:* include the specific zone **vva227.org**.

**3. Hand the token to the script.** Save it in a file named `.cf-api-token`
at the top of this repository (it is gitignored), then make the file readable
by you alone:

```sh
chmod 600 .cf-api-token
```

The script refuses the file while other accounts on the computer can read it.
Or set `CF_API_TOKEN` instead. The script never prints the token.

**4. Run the setup.** Repeat `--email` for each person who may open `/stats`.
The list is the whole list every time: running again with a shorter list
removes the missing addresses.

```sh
npm run setup:analytics -- --email you@example.com --dry-run   # look first; changes nothing
npm run setup:analytics -- --email you@example.com
```

It checks it is talking to the project that serves vva227.org, creates the
`vva227-beacon` database and applies `migrations/`, binds it to production as
`BEACON`, creates the `BEACON_SALT` secret if there is none, sets up the
Access policy and application, and writes `ACCESS_TEAM_DOMAIN` and
`ACCESS_AUD`. Only production settings are touched, never preview ones. It
is safe to run again: what is already done is skipped (the two Access
settings are rewritten every time, so a rerun repairs them).

**5. Deploy from a merged tree.** The settings take effect on the **next
production deploy**, and the script does not deploy. The live site is deployed
by a chapter volunteer and is ahead of this repository, so that deploy must
come from a copy of the code holding **both** the volunteer's latest commits
**and** this analytics work. Deploying either one alone undoes the other.
From that merged copy:

```sh
CLOUDFLARE_ACCOUNT_ID=d4afcdf7502fa80e6443dbb67ecd1d5f npm run deploy   # builds, then publishes with --branch=main (production)
```

That id is the "Ch 227" account's. Wrangler remembers the account of the
first `pages` command run in a copy of the code, in
`node_modules/.cache/wrangler/pages.json`, and uses it ahead of your login,
even when you are logged into several accounts. This once created a project
in the wrong account. `CLOUDFLARE_ACCOUNT_ID` overrides what it remembers.
If your shell cannot set a variable in front of a command (Windows), run
`npx wrangler whoami` to check your login holds "Ch 227", delete
`node_modules/.cache/wrangler/pages.json`, then run `npm run deploy` and
pick "Ch 227" if it asks.

The folder you deploy from must contain no `wrangler.toml`, `wrangler.json`
or `wrangler.jsonc`, committed or not: one would replace the database and
settings the setup wrote.

If the setup script warned that the project's production branch is not
`main`, resolve that first: a deploy to any other branch is a preview, with
none of these settings.

**6. Check.** Open https://vva227.org/stats and sign in. That shows the lock
works; it does not show that visits are recorded, because `/stats` itself is
never counted. So, in a normal browser window without Global Privacy Control
(Brave, DuckDuckGo and Firefox's private windows send it), open
https://vva227.org/ and one other page, then reload https://vva227.org/stats.
Your visit and your city should be at the top of *Recent visitors*. If they
are not, see *Recent visitors stays empty* under Troubleshooting below.

Then delete `.cf-api-token` and delete (or roll) the token in the dashboard.

**7. Optional: a rate-limiting rule for the collector.**
Anyone can post to the visit collector, `/api/e`; it has to be open, because
every visitor's browser posts to it. A script posting thousands of times a
minute could use up the free database's writes for the day. Cloudflare's free
plan includes one rate-limiting rule per domain, and it can slow such a script
down. This needs no token and changes nothing else. In the Cloudflare
dashboard, open the **vva227.org** domain, go to **Security** → **Security
rules**, and choose **Create rule** → **Rate limiting rules** (on older
dashboards: **Security** → **WAF** → **Rate limiting rules**). Enter:

| Setting | Value |
| --- | --- |
| Rule name | `Limit visit collector` |
| When incoming requests match | Field **URI Path**, operator **equals**, value `/api/e` |
| With the same characteristics | **IP** |
| When rate exceeds | **10** requests per **10 seconds** |
| Then take action | **Block** |
| Duration | **10 seconds** |

Then choose **Deploy**. On the free plan 10 seconds is the only choice for
both times, and the domain gets only this one rule: if it already has one,
leave this step out rather than replace it. A reader sends one or two posts
for each page, far below the limit. If a fast clicker ever goes over it, a
few of their page views go uncounted for ten seconds; the pages themselves
always load.

It slows a flood down; it does not stop one. A script that stays under the
limit, or posts from many addresses, can still use up a day's writes, and
then no visit is recorded until midnight UTC. The site itself keeps working.

---

## Reading the logs

The Function logs why it refused a request; the response never says. Wrangler
must be logged into the account that holds the Pages project.

```sh
npx wrangler pages deployment list --project-name=vva227-refresh
npx wrangler pages deployment tail <deployment-id> --project-name=vva227-refresh
```

Then load `/stats` in another window and read the `stats denied:` line, or
open any page of https://vva227.org/ to see what the collector says. The tail
shows a refused request as `Ok` all the same (it reports whether the code
ran, not the answer it gave), so read the lines beneath it.

> These commands also use the account wrangler remembers (step 5). If they
> say the project does not exist, delete
> `node_modules/.cache/wrangler/pages.json` and run them again.

### Troubleshooting

| Logged reason | What it means | Fix |
| --- | --- | --- |
| `access not configured` | The Function cannot see `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`. Usually the setup ran but nothing has been deployed since, or the deploy went to a preview branch. | Step 5: a production deploy from the merged tree. |
| `no token` | The settings are fine, but no Access application covers the hostname you used, so Access issued no token. | Use https://vva227.org/stats. Rerun the setup script to repair the application. |
| `wrong audience` | `ACCESS_AUD` belongs to another Access application. | Rerun the setup script, then deploy. |
| `wrong issuer` | `ACCESS_TEAM_DOMAIN` is not the team that signed you in. | Rerun the setup script, then deploy. |
| `cannot fetch signing keys` | The Function could not download the team's keys: the team domain is wrong, or Cloudflare was briefly unreachable. | `curl https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` should print keys. Rerun the setup script, then deploy. |
| `unknown key id` | The token was signed by a key the configured team does not publish: a different team, or keys that rotated in the last 10 minutes. | Wait 10 minutes; if it persists, rerun the setup script and deploy. |
| `expired` | The token's time ran out (sessions last 24 hours). | Reload; Access asks you to sign in again. |
| `not yet valid` / `issued in the future` | The token's times are more than 60 seconds ahead of the Function's clock. | Reload. If it persists, it is Cloudflare's clock, not yours. |
| `malformed token` / `unsupported algorithm` / `no key id` / `bad signature` | Someone sent a forged or broken token. Access never produces these. | Nothing: it was refused. |
| `gate error: …` | The request itself could not be read. | Note the message and report it. |
| `stats: BEACON binding missing` (an error, after the gate allowed you) | No D1 binding: a preview deployment, or a deploy made before the setup. | Step 5. |
| `stats query failed` (an error) | The database refused a query, usually because the migration was never applied. | Rerun the setup script; it applies missing migrations. |
| `collector not configured` (an error, when a page is visited) | The collector cannot see its database (`BEACON binding missing`) or its salt (`BEACON_SALT missing`), and records nothing. A deploy made before the setup, or a setting removed in the dashboard. | Rerun the setup script, which adds whichever is missing, then step 5. |
| `beacon write failed` (an error, when a page is visited) | The database refused the visit: the migration was never applied, or the day's free writes are used up (see step 7). | Rerun the setup script; it applies missing migrations. If the message mentions a limit, counting resumes at midnight UTC. |
| `beacon prune failed` (an error) | Deleting rows past the retention period failed. The visit itself was recorded. | Nothing at once; the next visit tries again. If it keeps happening, note the message and report it. |
| *Recent visitors* stays empty, nothing logged | No visit reaches the collector. Your browser sends Global Privacy Control or Do Not Track, which this site honours; or you browsed `vva227-refresh-12g.pages.dev` or a preview, where nothing is recorded; or the pages do not load `/b.js`, usually because a merge kept the old `script-src 'none'` in `public/_headers` or lost the script tag from `src/layouts/BaseLayout.astro`. | Step 6, in a browser without either setting, on https://vva227.org. Then, in the browser's developer tools, *Network* should show `b.js` and a `POST` to `/api/e` answered `204`. If `b.js` is missing or blocked, fix the merge and deploy. |
| nothing logged at all | The request is not reaching the Function: Access is showing its sign-in page, or the deployment does not include `functions/`, or it went to another Cloudflare account. | Sign in; check you deployed with step 5's command, from the repo root. |

---

## Changing things later

- **Add or remove a person:** rerun step 4 with the full new `--email` list,
  then nothing else (Access policies apply immediately, no deploy needed).
- **Add a column:** add a migration, describe the column on `/privacy`, add it
  to the map in `tests/invariants/privacy-disclosure.test.ts`, rerun the setup
  script (it applies new migrations), then deploy.
- **Change the retention period:** change `RETENTION_DAYS`; `/privacy` follows.

## What this does not protect against

- **The sign-in method.** Access is as strong as the login behind it. With
  one-time PIN, whoever controls the mailbox controls the stats.
- **The Cloudflare dashboard.** Anyone with access to the account can read the
  D1 database directly, without passing through Access.
- **A borrowed browser** within its 24-hour session.
- **A flood of fake visits.** The collector must accept posts from anyone.
  Step 7 slows one sender down, but a patient or spread-out sender can still
  use up the free database's writes for the day (counting stops until
  midnight UTC) and leave junk rows behind until they age out. The site
  itself is not affected.

---

## Where the code is

| Piece | Files |
| --- | --- |
| Shared values (endpoint, limits, retention, hosts) | `src/data/analytics.ts` |
| The script on every page (`/b.js`) | `src/lib/tracker.ts`, `src/pages/b.js.ts`, `src/layouts/BaseLayout.astro` |
| The collector (`/api/e`) | `functions/api/e.ts`, `src/lib/beacon.ts` |
| The visit log (`/stats`) | `functions/stats.ts`, `src/lib/stats.ts` |
| Eastern dates, shared by both | `src/lib/eastern.ts` |
| The lock | `src/lib/stats-gate.ts`, `src/lib/access.ts` |
| The schema | `migrations/` |
| The setup | `tools/setup-analytics.mjs`, `tools/lib/` |
| Routing and headers | `public/_routes.json`, `public/_headers` |
| The rules and their tests | `tests/BUSINESS_RULES.md`, *Visit analytics* |

### Cloudflare API calls the setup script relies on

Checked against Cloudflare's documentation and wrangler's source, October 2026.

- `GET/PATCH /accounts/{account}/pages/projects/{project}`. A PATCH **merges**:
  keys it omits are untouched, a key set to `null` is deleted. The script never
  sends `preview` and never sends an empty map. A secret reads back as
  `{ "type": "secret_text", "value": "" }`, so an existing secret is detected by
  its type, never compared.
- With no wrangler config in the folder it runs from, `wrangler pages deploy`
  uses the project's own settings. A config there, committed or not, would
  replace them, which is why `tests/contracts/analytics-routes.test.ts` forbids
  committing one and step 5 says to have none.
- `GET /accounts/{account}/d1/database?name=` (matched exactly by the script),
  `POST /accounts/{account}/d1/database`, and
  `POST /accounts/{account}/d1/database/{id}/query`. Migrations are recorded in
  wrangler's own `d1_migrations` table, so `wrangler d1 migrations list` agrees.
- `GET /zones?name=vva227.org` gives the zone's account, which is where Access
  must live: an Access application may only name hostnames in its own account's
  zones, plus that account's own `*.pages.dev` project.
- `GET /accounts/{account}/access/organizations` gives the team domain.
- Reusable policies (`/access/policies`, paged, matched by name) attached to a
  self-hosted application (`/access/apps`) by `destinations`; the application's
  `aud` is the Audience tag.
