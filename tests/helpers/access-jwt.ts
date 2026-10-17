/**
 * Mint Access-shaped JWTs for tests, including deliberately malicious ones,
 * and serve their key set the way Cloudflare does. Ported from casachristo.com's
 * tests/helpers/access-jwt.js.
 *
 * Real RSA keys and real signatures, so the verifier is exercised rather than
 * mocked: a stubbed "signature is valid" would make every test pass against a
 * verifier that checked nothing.
 */
import { certsUrlFor, type FetchLike, type Jwks } from '../../src/lib/access';

const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const b64urlJson = (obj: unknown) => b64url(enc.encode(JSON.stringify(obj)));

export interface SignOptions {
  /** Merged over the default header; a key set to undefined drops it. */
  header?: Record<string, unknown>;
  /** Flip the first signature byte. */
  corrupt?: boolean;
}

export interface Signer {
  kid: string;
  jwks: Jwks;
  sign(claims: Record<string, unknown>, options?: SignOptions): Promise<string>;
  /** A token whose header claims no signature is needed. */
  signNone(claims: Record<string, unknown>): string;
  /** Algorithm confusion: HMAC, keyed with the PUBLIC key. */
  signHs256(claims: Record<string, unknown>): Promise<string>;
  getJwks(): Promise<Jwks>;
}

export async function createSigner(kid = 'test-key-1'): Promise<Signer> {
  const { privateKey, publicKey } = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const pub = await crypto.subtle.exportKey('jwk', publicKey);
  const jwks: Jwks = { keys: [{ kid, kty: pub.kty, n: pub.n, e: pub.e, alg: 'RS256', use: 'sig' }] };

  async function sign(claims: Record<string, unknown>, { header = {}, corrupt = false }: SignOptions = {}) {
    const h = b64urlJson({ alg: 'RS256', kid, typ: 'JWT', ...header });
    const p = b64urlJson(claims);
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, enc.encode(`${h}.${p}`)));
    if (corrupt) sig[0] ^= 0xff;
    return `${h}.${p}.${b64url(sig)}`;
  }

  function signNone(claims: Record<string, unknown>) {
    return `${b64urlJson({ alg: 'none', kid, typ: 'JWT' })}.${b64urlJson(claims)}.`;
  }

  /**
   * Sign with HMAC, using the PUBLIC key material as the shared secret. The
   * attacker has the public key, so if a verifier honours the header's `alg`
   * they can mint any token they like.
   */
  async function signHs256(claims: Record<string, unknown>) {
    const key = await crypto.subtle.importKey('raw', enc.encode(pub.n), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const h = b64urlJson({ alg: 'HS256', kid, typ: 'JWT' });
    const p = b64urlJson(claims);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  }

  return { kid, jwks, sign, signNone, signHs256, getJwks: async () => jwks };
}

/** A test team domain. No such Access team exists. */
export const TEAM = 'vva227-test.cloudflareaccess.com';
/** A test Audience tag: 64 hex characters, like a real one. */
export const AUD = 'a'.repeat(64);
/** Who the minted tokens say signed in. A reserved example domain, never a real person. */
export const OWNER_EMAIL = 'owner@example.org';

/** A well-formed set of claims, which each test then spoils in one way. */
export function claimsFor(nowSeconds: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `https://${TEAM}`,
    aud: [AUD],
    email: OWNER_EMAIL,
    exp: nowSeconds + 3600,
    iat: nowSeconds,
    nbf: nowSeconds,
    ...over,
  };
}

/** The env the real gate reads, configured for TEAM and AUD. */
export const accessEnv = (over: Record<string, unknown> = {}) => ({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...over });

export interface CertsServer {
  fetch: FetchLike & ((url: string | URL | Request) => Promise<Response>);
  /** Every URL requested, in order. */
  calls: string[];
}

/**
 * A stand-in for Cloudflare's certs endpoint: answers the team's certs URL
 * with the key set, and refuses anything else with a 404, so a gate that
 * fetches the wrong URL fails rather than being handed keys anyway.
 */
export function certsServer(jwks: Jwks | (() => Jwks | Promise<Jwks>), team = TEAM): CertsServer {
  const calls: string[] = [];
  const url = certsUrlFor(team);
  const fetchImpl = async (input: string | URL | Request) => {
    const asked = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(asked);
    if (asked !== url) return new Response('not found', { status: 404 });
    const body = typeof jwks === 'function' ? await jwks() : jwks;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch: fetchImpl as CertsServer['fetch'], calls };
}
