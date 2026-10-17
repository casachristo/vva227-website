import { createJwksCache, verifyAccessJwt, type FetchLike, type JwksGetter } from './access';
import { errorMessage } from './runtime';

/**
 * Who may see /stats: whoever Cloudflare Access let through, proven by the
 * token Access signs, checked here as well as at the edge (src/lib/access.ts
 * says why both). The same arrangement guards casachristo.com's /stats.
 *
 * functions/stats.ts calls authorizeStats() before it does anything else and
 * answers its own plain 404 on any refusal, so this file only has to answer
 * one question: is this the owner?
 *
 * It FAILS CLOSED. Until ACCESS_TEAM_DOMAIN and ACCESS_AUD are set in the Pages
 * project's production settings (tools/setup-analytics.mjs sets both, and the
 * next production deploy picks them up), everyone, owner included, is
 * refused. The dangerous default would be a visit log that is public until
 * somebody remembers to protect it.
 *
 * Three properties the handler's tests rely on:
 *   - it never throws on a hostile request (a throw is treated as a refusal
 *     anyway, but a refusal should be an answer, not an accident);
 *   - "not configured" means refused, never allowed;
 *   - the reason is for the log only. The handler never returns it.
 */

export type GateVerdict = { ok: true } | { ok: false; reason: string };

/**
 * The environment the gate reads. Both values are set by the setup script as
 * encrypted Pages variables; neither is a secret in the cryptographic sense,
 * but both must match the Access application exactly.
 */
export interface StatsGateEnv {
  ACCESS_TEAM_DOMAIN?: unknown;
  ACCESS_AUD?: unknown;
  [key: string]: unknown;
}

/** The header Cloudflare Access puts its signed token in, on every request it lets through. */
export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';

export interface AccessGateOptions {
  /** Where the signing keys are fetched with. Defaults to the runtime's fetch. */
  fetchImpl?: FetchLike;
  /** How long a fetched key set is trusted, ms. */
  ttlMs?: number;
  /** The clock, in ms. Defaults to Date.now. */
  now?: () => number;
}

/**
 * A gate with its own key cache.
 *
 * One cache per gate, keyed by team domain: a request for the same team
 * reuses the keys, and a changed team domain (a new deploy with a corrected
 * setting reaches a warm isolate) starts a fresh cache rather than verifying
 * against the old team's keys.
 */
export function createAccessGate(options: AccessGateOptions = {}) {
  let cache: JwksGetter | null = null;
  let cacheTeam = '';

  function jwksFor(teamDomain: string): JwksGetter {
    if (!cache || cacheTeam !== teamDomain) {
      cache = createJwksCache(teamDomain, options);
      cacheTeam = teamDomain;
    }
    return cache;
  }

  return async function authorize(request: Request, env: StatsGateEnv): Promise<GateVerdict> {
    try {
      const teamDomain = typeof env?.ACCESS_TEAM_DOMAIN === 'string' ? env.ACCESS_TEAM_DOMAIN.trim() : '';
      const aud = typeof env?.ACCESS_AUD === 'string' ? env.ACCESS_AUD.trim() : '';
      // Checked here as well as in verifyAccessJwt so an unconfigured gate
      // never builds a cache or reads a header.
      if (!teamDomain || !aud) return { ok: false, reason: 'access not configured' };

      const verdict = await verifyAccessJwt(request.headers.get(ACCESS_JWT_HEADER), {
        teamDomain,
        aud,
        getJwks: jwksFor(teamDomain),
        nowSeconds: Math.floor((options.now ?? Date.now)() / 1000),
      });
      return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
    } catch (err) {
      // verifyAccessJwt does not throw; this is for a request object that
      // does. Still a refusal, and still only a log line.
      return { ok: false, reason: `gate error: ${errorMessage(err)}` };
    }
  };
}

/** The gate production runs: one per isolate, so its key cache lives as long as the isolate. */
export const authorizeStats = createAccessGate();
