/**
 * Who may see /stats.
 *
 * NOT DECIDED YET — Cloudflare Access (verifying its JWT here as well as at the
 * edge, as casachristo.com does) or a password. This file is the seam where
 * that decision lands. functions/stats.ts calls authorizeStats() before it
 * does anything else and answers its own plain 404 on any refusal, so whatever
 * replaces the body below inherits the ordering and the indistinguishable
 * refusal for free, and only has to answer one question: is this the owner?
 *
 * Until then it FAILS CLOSED: everyone, owner included, is refused. The page
 * ships before its lock is chosen, and the dangerous default would be a visit
 * log that is public until somebody remembers to protect it.
 *
 * Whatever goes here must keep three properties the handler's tests rely on:
 *   - it never throws on a hostile request (a throw is treated as a refusal
 *     anyway, but a refusal should be an answer, not an accident);
 *   - "not configured" means refused, never allowed;
 *   - the reason is for the log only. The handler never returns it.
 */

export type GateVerdict = { ok: true } | { ok: false; reason: string };

/** The environment the gate may read. Its secrets will be added here. */
export type StatsGateEnv = Record<string, unknown>;

export async function authorizeStats(_request: Request, _env: StatsGateEnv): Promise<GateVerdict> {
  return { ok: false, reason: 'gate not configured' };
}
