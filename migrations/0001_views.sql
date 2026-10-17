-- The visit log.
--
-- One row per PAGEVIEW, not per event. The tracker sends a `view` when the page
-- loads and one or more `end` events as reading time accrues; the collector
-- upserts them onto the same primary key, so a row is created once and then
-- filled in. An append-only event stream reduced at query time is the right
-- shape at scale and the wrong one here, where the thing wanted is a readable
-- list of visits.
--
-- NO IP COLUMN, and that is the load-bearing decision. The visitor hash below
-- is salted with a secret and a window that rolls every 24 hours precisely so
-- two rows from different days cannot be tied to one person. Storing the IP
-- beside it would make that rotation cosmetic. Location and network are
-- already resolved by Cloudflare at the edge, which answers the only questions
-- the IP would have been asked.

CREATE TABLE IF NOT EXISTS views (
  -- The client-generated pageview id. Random, held only in a JS variable for
  -- the life of the page, never written to the device. It is the primary key so
  -- a repeated `end` -- normal, since the tracker flushes on both
  -- visibilitychange and pagehide -- updates the visit instead of duplicating it.
  view       TEXT PRIMARY KEY,

  -- SITE_KEY from src/data/analytics.ts. Server-assigned, never client-supplied.
  site       TEXT    NOT NULL,

  -- Salted one-way hash of IP + user agent (src/lib/beacon.ts, visitorHash).
  -- Not reversible, and not comparable across salt windows.
  visitor    TEXT    NOT NULL,

  -- location.pathname only. Never the query string: campaign tags, session
  -- tokens and the occasional email address live there.
  path       TEXT    NOT NULL,

  -- document.referrer with its query string and fragment removed, on the
  -- client and again on the server. Set only by a `view`.
  referrer   TEXT,

  -- Coarse location from request.cf, resolved by Cloudflare at the edge.
  -- `region` prefers the short code ('VA') and falls back to the long name.
  -- Cloudflare hedges on region and city ("if known"), so expect nulls.
  --
  -- Deliberately NOT stored, though request.cf offers them: postal code,
  -- latitude/longitude, metro code, timezone, colo. Coordinates are city
  -- centroids that look like GPS fixes to anyone auditing this table and are no
  -- more accurate than `city`; a postcode is the same problem in a shorter
  -- string; colo is Cloudflare's datacentre, not the visitor's location.
  -- Collecting a field because it is free is how a privacy page becomes false.
  country    TEXT,
  city       TEXT,
  region     TEXT,

  -- The visitor's network. Both are kept because organisation names drift in
  -- spelling while the number does not: group by asn, display as_org. A row
  -- exists only because a browser ran JavaScript, so a datacentre name here
  -- where a person was expected usually means a crawler that runs JavaScript.
  asn        INTEGER,
  as_org     TEXT,

  viewport_w INTEGER,
  viewport_h INTEGER,

  -- Reading time, milliseconds, accumulated only while the tab was visible.
  -- Upserted as the LARGER of the stored and incoming values, because flushes
  -- can arrive out of order.
  engaged_ms INTEGER NOT NULL DEFAULT 0,

  -- When the visit started, UTC milliseconds. Written by the first request for
  -- this pageview and never updated afterwards: the upsert leaves it alone, so
  -- a late `end` cannot make a visit look like it started when it finished.
  ts         INTEGER NOT NULL
);

-- "What happened recently", which the retention prune also uses.
CREATE INDEX IF NOT EXISTS views_ts         ON views (ts);
-- Every stats query is scoped to one site and one window.
CREATE INDEX IF NOT EXISTS views_site_ts    ON views (site, ts);
-- The recent-visitors query fetches every row for a short list of visitor
-- hashes; this turns each one into an index lookup instead of a table scan.
CREATE INDEX IF NOT EXISTS views_site_visitor_ts ON views (site, visitor, ts);
