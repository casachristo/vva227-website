import { expect } from 'vitest';
import { SITE_KEY } from '../../src/data/analytics';

/**
 * Shared shape validators for the analytics tiers.
 *
 * A test that checks one field of a response or one column of a row passes
 * while the others are wrong. These assert the WHOLE shape, once, so every
 * feature, integration and security test that produces a response or a row
 * can check all of it without restating the list.
 */

/** Every column of `views`, in schema order. */
export const VIEW_COLUMNS = [
  'view',
  'site',
  'visitor',
  'path',
  'referrer',
  'country',
  'city',
  'region',
  'asn',
  'as_org',
  'viewport_w',
  'viewport_h',
  'engaged_ms',
  'ts',
] as const;

const nullableString = (v: unknown) => v === null || typeof v === 'string';
const nullableInt = (v: unknown) => v === null || Number.isInteger(v);

/** A stored row has every column, each of the right type, and nothing else. */
export function expectViewRow(row: Record<string, unknown> | undefined): Record<string, unknown> {
  expect(row, 'row is missing').toBeDefined();
  const r = row!;
  expect(Object.keys(r).sort()).toEqual([...VIEW_COLUMNS].sort());
  expect(r.view).toMatch(/^[0-9a-f]{8,64}$/);
  expect(r.site).toBe(SITE_KEY);
  expect(r.visitor).toMatch(/^[0-9a-f]{32}$/);
  expect(typeof r.path).toBe('string');
  expect((r.path as string).startsWith('/')).toBe(true);
  for (const col of ['referrer', 'country', 'city', 'region', 'as_org'] as const) {
    expect(nullableString(r[col]), `${col} is ${typeof r[col]}`).toBe(true);
  }
  for (const col of ['asn', 'viewport_w', 'viewport_h'] as const) {
    expect(nullableInt(r[col]), `${col} is ${String(r[col])}`).toBe(true);
  }
  expect(Number.isInteger(r.engaged_ms) && (r.engaged_ms as number) >= 0).toBe(true);
  expect(Number.isInteger(r.ts) && (r.ts as number) > 0).toBe(true);
  return r;
}

/** The collector's success: 204, empty, uncached, unsniffable, same-origin only. */
export async function expectAccepted(res: Response): Promise<void> {
  expect(res.status).toBe(204);
  expect(Object.fromEntries(res.headers)).toEqual({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': 'null',
  });
  await expect(res.text()).resolves.toBe('');
}

/**
 * The collector's refusal: the status, a JSON body naming exactly the rule
 * broken, and the same protective headers as a success. Returns nothing a
 * caller could mistake for a database error.
 */
export async function expectRefused(
  res: Response,
  status: number,
  reason: string,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  expect(res.status).toBe(status);
  expect(Object.fromEntries(res.headers)).toEqual({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-type': 'application/json',
    ...extraHeaders,
  });
  await expect(res.json()).resolves.toEqual({ error: reason });
}
