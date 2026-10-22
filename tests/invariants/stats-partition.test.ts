import { describe, it, expect, afterEach } from 'vitest';
import { createD1, type TestD1 } from '../helpers/d1';
import { CRAWLER_NETWORKS, CRAWLER_WINDOWS, NOTHING_READ_COUNTRIES, NOTHING_READ_NETWORKS, SITE_KEY } from '../../src/data/analytics';
import { automatedCte, STATS_SQL } from '../../src/lib/stats';

/**
 * INVARIANT — /stats sorts every visitor into exactly one of two piles.
 *
 * The page counts people above and lists what it set aside as likely automated
 * at the end (tests/BUSINESS_RULES.md, A22). Each half is its own query, built
 * from one shared condition. If the two ever disagreed, a visitor could be
 * counted twice, or vanish from both: the second is the failure that matters,
 * a reader the chapter never sees. So for ANY traffic, not just the shapes the
 * other tiers hand-build:
 *
 *   people + set aside = everyone in the window, for visitors and for views,
 *   and no visitor is in both piles.
 *
 * The traffic is generated, deliberately inconsistent where real traffic is
 * consistent (a visitor whose network or window changes between views, an
 * `end` with no `view`, every column null), because that is where a condition
 * written with `max` in one place and `min` in another would split.
 *
 * TIER JUSTIFICATION: the integration and feature tiers check that named rows
 * land where they should. Only a check over every combination can show the
 * two queries never lose a visitor between them.
 */

const NOW = Date.UTC(2026, 9, 17, 16, 0);
const DAY = 86_400_000;
const SINCE = NOW - 30 * DAY;

/** A small deterministic generator, so a failure names a seed that reproduces it. */
function lcg(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0;
    return x / 2 ** 32;
  };
}

const pick = <T,>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

/** Every value the rule looks at, crawler and person alike, and null. */
const ASNS = [null, 7922, 701, 812, 13335, ...CRAWLER_NETWORKS.map((n) => n.asn), ...NOTHING_READ_NETWORKS.map((n) => n.asn)];
const COUNTRIES = [null, 'US', 'CA', ...NOTHING_READ_COUNTRIES.map((c) => c.code)];
const WINDOWS: ReadonlyArray<[number | null, number | null]> = [
  [null, null],
  [390, 844],
  [1440, 900],
  [1800, null],
  ...CRAWLER_WINDOWS.map((w): [number, number] => [w.width, w.height]),
];
const READING = [0, 0, 1, 5_000, 60_000];

let d1: TestD1 | undefined;

afterEach(() => {
  d1?.close();
  d1 = undefined;
});

function seedTraffic(seed: number): TestD1 {
  const db = createD1();
  const rand = lcg(seed);
  const visitors = 5 + Math.floor(rand() * 40);
  let n = 0;
  for (let v = 0; v < visitors; v++) {
    const visitor = v.toString(16).padStart(32, '0');
    const views = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < views; i++) {
      const [w, h] = pick(rand, WINDOWS);
      db.seed({
        view: (n++).toString(16).padStart(16, '0'),
        visitor,
        // Some visits fall outside the window, so the window has to agree too.
        ts: NOW - Math.floor(rand() * 40 * DAY),
        path: `/p-${Math.floor(rand() * 6)}`,
        asn: pick(rand, ASNS),
        country: pick(rand, COUNTRIES),
        viewport_w: w,
        viewport_h: h,
        engaged_ms: pick(rand, READING),
      });
    }
  }
  // Another site's rows share the table and must stay out of both piles.
  db.seed({ view: 'ffffffffffffffff', site: 'another-site', visitor: 'e'.repeat(32), ts: NOW, path: '/theirs', asn: CRAWLER_NETWORKS[0].asn });
  return db;
}

async function piles(db: TestD1) {
  const all = db.db
    .prepare('SELECT visitor, COUNT(*) AS views FROM views WHERE site = ?1 AND ts >= ?2 GROUP BY visitor')
    .all(SITE_KEY, SINCE) as Array<{ visitor: string; views: number }>;
  const summary = (await db.binding.prepare(STATS_SQL.summary).bind(SITE_KEY, SINCE).first<Record<string, number>>())!;
  // Recent visitors with a limit no window reaches, so it returns every person.
  const people = (await db.binding.prepare(STATS_SQL.visits).bind(SITE_KEY, SINCE, 100_000).all<{ visitor: string }>()).results;
  // The set-aside table, ungrouped, with no row limit: the same condition the
  // page's table uses, asked which visitors it set aside.
  const setAside = db.db
    .prepare(`WITH ${automatedCte()} SELECT visitor FROM automated`)
    .all(SITE_KEY, SINCE) as Array<{ visitor: string }>;
  return { all, summary, people: new Set(people.map((r) => r.visitor)), setAside: new Set(setAside.map((r) => r.visitor)) };
}

describe('every visitor in the window is counted once', () => {
  it('counts every visitor once, as a person or as set aside, whatever the traffic', async () => {
    let seenBoth = 0;
    for (let seed = 1; seed <= 60; seed++) {
      d1 = seedTraffic(seed);
      const { all, summary, people, setAside } = await piles(d1);

      for (const visitor of people) expect(setAside.has(visitor), `seed ${seed}: ${visitor} in both piles`).toBe(false);
      expect(new Set([...people, ...setAside]), `seed ${seed}: a visitor in neither pile`).toEqual(new Set(all.map((r) => r.visitor)));

      const totalViews = all.reduce((sum, r) => sum + r.views, 0);
      expect(summary.visitors + summary.automated_visitors, `seed ${seed}: visitors`).toBe(all.length);
      expect(summary.views + summary.automated_views, `seed ${seed}: views`).toBe(totalViews);
      expect(summary.visitors, `seed ${seed}: summary and Recent visitors disagree`).toBe(people.size);
      expect(summary.automated_visitors, `seed ${seed}: summary and the set-aside table disagree`).toBe(setAside.size);

      if (people.size && setAside.size) seenBoth++;
      d1.close();
      d1 = undefined;
    }
    // Anti-vacuity: most generated windows hold both people and crawlers.
    expect(seenBoth).toBeGreaterThan(40);
  });

  it('can actually fail — a condition that drops a visitor is caught', async () => {
    d1 = seedTraffic(7);
    const { all } = await piles(d1);
    const leaky = new Set(all.slice(1).map((r) => r.visitor));
    expect(leaky).not.toEqual(new Set(all.map((r) => r.visitor)));
  });
});

describe('the lists themselves', () => {
  it('never lists a network that carries private-relay users', () => {
    // iCloud Private Relay leaves through Cloudflare, Akamai and Fastly, and
    // Cloudflare's WARP through its own network: every one an ordinary reader.
    const PRIVATE_RELAY = [13335, 36183, 54113];
    for (const { asn } of [...CRAWLER_NETWORKS, ...NOTHING_READ_NETWORKS]) expect(PRIVATE_RELAY).not.toContain(asn);
  });

  it('lists no network twice, and none on both lists', () => {
    const asns = [...CRAWLER_NETWORKS, ...NOTHING_READ_NETWORKS].map((n) => n.asn);
    expect(new Set(asns).size).toBe(asns.length);
  });

  it('names an owner for every network, and where every window size was seen', () => {
    for (const n of [...CRAWLER_NETWORKS, ...NOTHING_READ_NETWORKS]) expect(n.owner.trim(), String(n.asn)).not.toBe('');
    for (const w of CRAWLER_WINDOWS) expect(w.seenFrom.trim(), `${w.width}x${w.height}`).not.toBe('');
    for (const c of NOTHING_READ_COUNTRIES) expect(c.name.trim(), c.code).not.toBe('');
  });
});
