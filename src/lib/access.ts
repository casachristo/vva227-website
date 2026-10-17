/**
 * Cloudflare Access JWT verification. Ported from casachristo.com's
 * src/lib/access.js, which guards that site's /stats the same way.
 *
 * WHY THE APPLICATION VERIFIES THIS AT ALL, when Access already enforces at the
 * edge. Access is applied to a HOSTNAME AND PATH. This site answers on
 * vva227.org, www.vva227.org, vva227-refresh-12g.pages.dev, and a fresh
 * <hash>.vva227-refresh-12g.pages.dev for every preview deployment. A policy
 * covering the apex is simply absent on the others, and the bypass is not an
 * exploit, it is typing a different hostname. Cloudflare's own guidance is to
 * validate the token in the application for exactly this reason.
 *
 * So the edge policy is the lock and this is the deadbolt: even on a hostname
 * with no Access application in front of it, a request without a valid,
 * correctly-audienced token gets nothing.
 *
 * FAILS CLOSED BY CONSTRUCTION. If the team domain or the audience tag is not
 * configured, verification cannot succeed: there is no "unconfigured means
 * allow" path anywhere below. That matters because the page ships before the
 * Cloudflare side is set up, and the dangerous default would be a stats page
 * that is public until someone remembers to protect it.
 *
 * NEVER THROWS. Every function that answers a question about a token returns a
 * verdict. src/lib/stats-gate.ts and functions/stats.ts turn any refusal into
 * the same plain 404, and log only the reason.
 *
 * Standard JS and WebCrypto only, so it runs the same in Node (the tests) and
 * in workerd (Pages Functions).
 */

/** Clock skew tolerated on exp/nbf/iat, seconds. */
const SKEW_SECONDS = 60;

/**
 * Algorithms we accept. RS256 only, and stated as an allowlist rather than
 * read from the token.
 *
 * The two classic JWT breaks both live here. `alg: "none"` asks the verifier to
 * skip the signature; `alg: "HS256"` on an RS256 key asks it to treat the
 * PUBLIC key as an HMAC secret, which an attacker also has, letting them mint
 * tokens. Both are only possible if the token gets to choose the algorithm.
 * tests/security/access-jwt.test.ts has a case for each.
 */
const ALLOWED_ALGS: readonly string[] = ['RS256'];

/**
 * Every reason a token can be refused, exactly as it is logged.
 *
 * docs/analytics.md has a troubleshooting row for each one, and a contract test
 * holds the two together: a reason added here without a row there fails.
 */
export const ACCESS_REFUSAL_REASONS = [
  'access not configured',
  'no token',
  'malformed token',
  'unsupported algorithm',
  'no key id',
  'cannot fetch signing keys',
  'unknown key id',
  'bad signature',
  'wrong issuer',
  'wrong audience',
  'expired',
  'not yet valid',
  'issued in the future',
] as const;

export type AccessRefusal = (typeof ACCESS_REFUSAL_REASONS)[number];

export type AccessVerdict = { ok: true; claims: Record<string, unknown> } | { ok: false; reason: AccessRefusal };

/** One key of a JSON Web Key Set, as Access publishes it. Read loosely: it arrives over the network. */
export interface Jwk {
  kid?: unknown;
  kty?: unknown;
  n?: unknown;
  e?: unknown;
  [key: string]: unknown;
}

export interface Jwks {
  keys: Jwk[];
}

export type JwksGetter = () => Promise<Jwks>;

/** The slice of fetch() the key cache uses, so tests can hand it a stand-in. */
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface VerifyOptions {
  /** e.g. 'vva227.cloudflareaccess.com' */
  teamDomain?: unknown;
  /** The Access application's Audience (AUD) tag. */
  aud?: unknown;
  getJwks: JwksGetter;
  /** Defaults to the current time. */
  nowSeconds?: number;
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The issuer Cloudflare stamps for a given team domain.
 *
 * Trims whitespace, and that is not politeness. A value typed or piped into a
 * secret often carries a TRAILING NEWLINE (`echo <domain> | wrangler pages
 * secret put ...` stores it). An untrimmed newline makes the issuer
 * `https://team.cloudflareaccess.com\n`, which matches nothing, so every valid
 * token is denied with `wrong issuer` and the operator is left comparing two
 * strings that look identical in every log.
 */
export function issuerFor(teamDomain: unknown): string {
  const host = String(teamDomain)
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return `https://${host}`;
}

/** Where the signing keys live for a given team domain. */
export function certsUrlFor(teamDomain: unknown): string {
  return `${issuerFor(teamDomain)}/cdn-cgi/access/certs`;
}

/**
 * A team domain or AUD as configured, trimmed, or '' when it is not usable.
 * The one reading of "is this setting present", shared with the gate.
 */
export const accessSetting = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Verify an Access JWT: the Cf-Access-Jwt-Assertion header value.
 *
 * Never throws, and never returns claims it did not verify.
 */
export async function verifyAccessJwt(token: unknown, { teamDomain, aud, getJwks, nowSeconds }: VerifyOptions): Promise<AccessVerdict> {
  // Configuration first. Without either of these there is no correct answer,
  // and "allow" must not be reachable from here.
  const team = accessSetting(teamDomain);
  const wanted = accessSetting(aud);
  if (!team || !wanted) return { ok: false, reason: 'access not configured' };
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'no token' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };

  let header: unknown;
  let claims: unknown;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    return { ok: false, reason: 'malformed token' };
  }
  if (!isRecord(header) || !isRecord(claims)) return { ok: false, reason: 'malformed token' };

  if (typeof header.alg !== 'string' || !ALLOWED_ALGS.includes(header.alg)) {
    return { ok: false, reason: 'unsupported algorithm' };
  }
  if (typeof header.kid !== 'string' || !header.kid) return { ok: false, reason: 'no key id' };

  let jwks: unknown;
  try {
    jwks = await getJwks();
  } catch {
    // A signing-key fetch that fails must deny, not allow. This is the branch
    // where an outage quietly turns into an open door if it is written the
    // other way round.
    return { ok: false, reason: 'cannot fetch signing keys' };
  }

  // Read defensively: the key set came over the network, and "never throws"
  // has to hold for a malformed one too.
  const keys: unknown[] = isRecord(jwks) && Array.isArray(jwks.keys) ? jwks.keys : [];
  const jwk = keys.find((k): k is Jwk => isRecord(k) && k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'unknown key id' };

  let verified = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty as string, n: jwk.n as string, e: jwk.e as string, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64UrlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return { ok: false, reason: 'bad signature' };
  }
  if (!verified) return { ok: false, reason: 'bad signature' };

  // Signature verified. Now the claims: a valid signature only proves
  // Cloudflare minted this token, not that it was minted for US.
  if (claims.iss !== issuerFor(team)) return { ok: false, reason: 'wrong issuer' };

  // aud is an array in Access tokens. Checking membership rather than equality
  // matters: without it, a token issued for ANY Access application in the
  // account (including one with a deliberately permissive policy) would open
  // this one. `wanted` is trimmed for the same reason as issuerFor: an AUD that
  // differs by one invisible character fails with an error naming two strings
  // that print identically.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(wanted)) return { ok: false, reason: 'wrong audience' };

  const now = typeof nowSeconds === 'number' ? nowSeconds : Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < now) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > now) {
    return { ok: false, reason: 'not yet valid' };
  }
  if (typeof claims.iat === 'number' && claims.iat - SKEW_SECONDS > now) {
    return { ok: false, reason: 'issued in the future' };
  }

  return { ok: true, claims };
}

export interface JwksCacheOptions {
  /** Defaults to the runtime's fetch, looked up at call time. */
  fetchImpl?: FetchLike;
  ttlMs?: number;
  now?: () => number;
}

/**
 * A JWKS fetcher that caches per isolate.
 *
 * Access rotates signing keys, so this cannot cache forever; it also must not
 * fetch on every request, since that would put a network round trip in front of
 * every page view. Ten minutes is comfortably shorter than Cloudflare's
 * rotation period and long enough that a burst of requests costs one fetch.
 *
 * Throws when it has no usable keys. verifyAccessJwt turns that into
 * `cannot fetch signing keys`, a denial.
 */
export function createJwksCache(
  teamDomain: unknown,
  { fetchImpl = (url) => fetch(url), ttlMs = 600_000, now = () => Date.now() }: JwksCacheOptions = {},
): JwksGetter {
  let cached: Jwks | null = null;
  let cachedAt = 0;

  return async function getJwks(): Promise<Jwks> {
    if (cached && now() - cachedAt < ttlMs) return cached;
    const res = await fetchImpl(certsUrlFor(teamDomain));
    if (!res.ok) throw new Error(`certs fetch failed: ${res.status}`);
    const body = await res.json();
    // Only replace a good cache with another good one. If Access briefly
    // returns something unusable, keeping the previous keys is better than
    // locking the owner out of their own stats page.
    if (isRecord(body) && Array.isArray(body.keys) && body.keys.length) {
      cached = body as unknown as Jwks;
      cachedAt = now();
    }
    if (!cached) throw new Error('certs response contained no keys');
    return cached;
  };
}
