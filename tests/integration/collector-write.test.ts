import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { onRequest } from '../../functions/api/e';
import { beaconRequest, createD1, createEnv, D1_MAX_COMPOUND_TERMS, D1_MAX_PARAMS, type TestD1 } from '../helpers/d1';
import { expectAccepted, expectViewRow } from '../helpers/analytics';
import { EVENT_END, EVENT_VIEW, RETENTION_DAYS, SITE_KEY } from '../../src/data/analytics';
import { PRUNE_SQL, pruneCutoff, UPSERT_SQL } from '../../src/lib/beacon';

/**
 * INTEGRATION — the collector and the database, across several requests.
 *
 * A pageview is assembled from separate requests: a `view` on load and one or
 * more `end` flushes, in whatever order the network delivers them. Whether a
 * later request updates the earlier row correctly is decided by one
 * INSERT ... ON CONFLICT statement, so it can only be answered by executing
 * that statement against the real schema — which is what happens here, on
 * real SQLite through tests/helpers/d1.ts.
 *
 * TIER JUSTIFICATION: the unit tier can read UPSERT_SQL and check that ts is
 * missing from its update list; it cannot prove SQLite then leaves ts alone,
 * that max() and coalesce() are applied the right way round, or that the prune
 * deletes the row a millisecond past the boundary and keeps the one on it.
 */

const VIEW = 'aaaaaaaabbbbbbbb';
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 17, 16, 0);

let d1: TestD1;
let clock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  d1 = createD1();
  clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  clock.mockRestore();
  d1.close();
});

const post = (body: unknown) => onRequest({ request: beaconRequest(body), env: createEnv(d1.binding) });
const view = (over: Record<string, unknown> = {}) => ({ k: EVENT_VIEW, v: VIEW, p: '/about', ...over });
const end = (over: Record<string, unknown> = {}) => ({ k: EVENT_END, v: VIEW, p: '/about', e: 5_000, ...over });

describe('the upsert — where a pageview is assembled', () => {
  it('keeps the LARGER reading time when flushes arrive out of order', async () => {
    await post(view());
    await expectAccepted(await post(end({ e: 47_000 })));
    await expectAccepted(await post(end({ e: 12_000 }))); // a stale flush, delivered late
    expect(d1.rows()).toHaveLength(1);
    expect(expectViewRow(d1.one(VIEW)).engaged_ms).toBe(47_000);
  });

  it('never restamps ts when a late end arrives', async () => {
    await post(view());
    clock.mockReturnValue(NOW + 10 * 60_000);
    await post(end({ e: 600_000 }));
    clock.mockReturnValue(NOW + 20 * 60_000);
    await post(end({ e: 1_200_000 }));
    expect(d1.one(VIEW)).toMatchObject({ ts: NOW, engaged_ms: 1_200_000 });
  });

  it('does not let an end erase what the view recorded', async () => {
    await post(view({ r: 'https://www.google.com/', w: 1280, h: 720 }));
    await post(end());
    expect(d1.one(VIEW)).toMatchObject({ referrer: 'https://www.google.com/', viewport_w: 1280, viewport_h: 720 });
  });

  it('does not let a second view replace the first view’s referrer', async () => {
    // First writer wins on the referrer: a replayed view cannot rewrite where
    // the visit came from.
    await post(view({ r: 'https://www.google.com/' }));
    await post(view({ r: 'https://evil.example/' }));
    expect(d1.one(VIEW)?.referrer).toBe('https://www.google.com/');
  });

  it('is idempotent under an identical repeated flush', async () => {
    for (let i = 0; i < 3; i++) await post(end({ e: 5_000 }));
    expect(d1.rows()).toHaveLength(1);
    expect(d1.one(VIEW)?.engaged_ms).toBe(5_000);
  });

  it('keeps pageviews with different ids as separate rows', async () => {
    await post(view());
    await post(view({ v: 'ccccccccdddddddd', p: '/give' }));
    expect(d1.rows().map((r) => r.path).sort()).toEqual(['/about', '/give']);
  });

  it('runs the exact statement exported from src/lib/beacon.ts', async () => {
    await post(view());
    expect(d1.statements[0].sql).toBe(UPSERT_SQL);
    expect(d1.statements[0].args).toHaveLength(14);
  });
});

describe('retention — the period the privacy page will state', () => {
  const seed = (view: string, ts: number) =>
    d1.seed({ view, visitor: 'f'.repeat(32), path: '/old', ts });

  it('deletes rows past the retention period when a view arrives, and only those', async () => {
    seed('0000000011111111', NOW - 800 * DAY);
    seed('0000000022222222', NOW - 10 * DAY);
    await post(view());
    expect(d1.rows().map((r) => r.view).sort()).toEqual(['0000000022222222', VIEW]);
  });

  it('keeps a row exactly on the boundary and deletes the one a millisecond older', async () => {
    // Off-by-one on a deletion is the expensive direction to get wrong.
    seed('0000000033333333', NOW - RETENTION_DAYS * DAY);
    seed('0000000044444444', NOW - RETENTION_DAYS * DAY - 1);
    await post(view());
    const views = d1.rows().map((r) => r.view);
    expect(views).toContain('0000000033333333');
    expect(views).not.toContain('0000000044444444');
  });

  it('does not prune on an end', async () => {
    seed('0000000055555555', NOW - 800 * DAY);
    await post(end());
    expect(d1.rows().map((r) => r.view)).toContain('0000000055555555');
  });

  it('prunes with the exported statement and cutoff', async () => {
    await post(view());
    expect(d1.statements[1]).toEqual({ sql: PRUNE_SQL, args: [pruneCutoff(NOW)] });
  });

  it('finishes a slow prune before answering when there is no waitUntil to hand it to', async () => {
    // The shim runs statements synchronously, so a prune that was started but
    // never awaited would still look finished. This binding makes every
    // statement genuinely asynchronous; a handler that dropped the promise
    // would answer while the expired row still existed.
    seed('0000000077777777', NOW - 800 * DAY);
    const slow = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            await new Promise((r) => setTimeout(r, 5));
            return d1.binding.prepare(sql).bind(...args).run();
          },
        }),
      }),
    };
    await expectAccepted(await onRequest({ request: beaconRequest(view()), env: createEnv(slow as never) }));
    expect(d1.rows().map((r) => r.view)).toEqual([VIEW]);
  });

  it('prunes on an empty table without complaint', async () => {
    await expectAccepted(await post(view()));
    expect(d1.rows()).toHaveLength(1);
  });
});

describe('the test database refuses what D1 refuses', () => {
  // node:sqlite accepts both of these; D1 does not. If the shim accepted them
  // too, a query could pass every test here and fail on its first production
  // request.
  const placeholders = (n: number) => Array.from({ length: n }, (_, i) => `?${i + 1}`).join(', ');

  it(`allows ${D1_MAX_PARAMS} bound parameters and refuses one more`, async () => {
    const ok = Array.from({ length: D1_MAX_PARAMS }, (_, i) => i);
    await expect(d1.binding.prepare(`SELECT 1 WHERE 1 IN (${placeholders(D1_MAX_PARAMS)})`).bind(...ok).all()).resolves.toMatchObject({ success: true });
    const tooMany = [...ok, 100];
    await expect(
      d1.binding.prepare(`SELECT 1 WHERE 1 IN (${placeholders(D1_MAX_PARAMS + 1)})`).bind(...tooMany).all(),
    ).rejects.toThrow(/too many SQL variables/);
  });

  it(`allows a ${D1_MAX_COMPOUND_TERMS}-term compound SELECT and refuses a longer one`, async () => {
    const compound = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i}`).join(' UNION ALL ');
    await expect(d1.binding.prepare(compound(D1_MAX_COMPOUND_TERMS)).all()).resolves.toMatchObject({ success: true });
    await expect(d1.binding.prepare(compound(D1_MAX_COMPOUND_TERMS + 1)).all()).rejects.toThrow(/compound SELECT/);
  });

  it('refuses an undefined binding, naming its position', async () => {
    await expect(d1.binding.prepare('SELECT ?1, ?2').bind(1, undefined).all()).rejects.toThrow(/\?2/);
  });

  it('returns rows as plain objects, as D1 does', async () => {
    d1.seed({ view: '0000000066666666', visitor: 'f'.repeat(32), path: '/x', ts: NOW });
    const { results } = await d1.binding.prepare('SELECT site FROM views').all();
    expect(Object.getPrototypeOf(results[0])).toBe(Object.prototype);
    expect(results[0]).toEqual({ site: SITE_KEY });
    await expect(d1.binding.prepare('SELECT site FROM views WHERE ts = ?1').bind(0).first()).resolves.toBeNull();
  });
});
