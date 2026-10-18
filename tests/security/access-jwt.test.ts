/**
 * SECURITY — Cloudflare Access token verification, the lock on /stats.
 *
 * This is the only thing standing between the internet and the visit log on
 * any hostname where an Access application is not applied, which includes
 * vva227-refresh-12g.pages.dev whenever the vva227.org zone lives in another
 * Cloudflare account, and every preview deployment always. Edge enforcement
 * covers the hostnames someone configured; this covers the rest.
 *
 * Every test signs a REAL token with a REAL key. A stubbed verifier would make
 * the whole file pass against code that checks nothing. Ported from
 * casachristo.com's tests/security/access-jwt.test.js, plus the hostile key
 * sets and generated garbage that "never throws" has to survive.
 *
 * TIER JUSTIFICATION: the unit tier checks the gate's plumbing (which header,
 * which settings, which cache). Only here is each attack on the token itself
 * run against the real WebCrypto verification, with a key the attacker does
 * and does not hold.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  ACCESS_REFUSAL_REASONS,
  certsUrlFor,
  createJwksCache,
  issuerFor,
  verifyAccessJwt,
  type VerifyOptions,
} from '../../src/lib/access';
import { AUD, b64urlJson, claimsFor, createSigner, OWNER_EMAIL, TEAM, type Signer } from '../helpers/access-jwt';

const NOW = 1_800_000_000;
let signer: Signer;
let opts: VerifyOptions;

beforeAll(async () => {
  signer = await createSigner();
  opts = { teamDomain: TEAM, aud: AUD, getJwks: signer.getJwks, nowSeconds: NOW };
});

describe('a legitimate token', () => {
  it('is accepted and returns the verified claims', async () => {
    const token = await signer.sign(claimsFor(NOW));
    const result = await verifyAccessJwt(token, opts);
    expect(result).toEqual({ ok: true, claims: claimsFor(NOW) });
    expect(result.ok && result.claims.email).toBe(OWNER_EMAIL);
  });

  it('is accepted within the clock-skew window on either side', async () => {
    // Boundary: a token that expired 30s ago still works, one that expired 5
    // minutes ago does not. Without skew tolerance, a slightly fast clock logs
    // the owner out of their own page.
    const justExpired = await signer.sign(claimsFor(NOW, { exp: NOW - 30 }));
    expect((await verifyAccessJwt(justExpired, opts)).ok).toBe(true);

    const notYet = await signer.sign(claimsFor(NOW, { nbf: NOW + 30, iat: NOW + 30 }));
    expect((await verifyAccessJwt(notYet, opts)).ok).toBe(true);
  });

  it.each([
    ['exp exactly 60s ago', { exp: NOW - 60 }, true],
    ['exp 61s ago', { exp: NOW - 61 }, false],
    ['nbf exactly 60s ahead', { nbf: NOW + 60 }, true],
    ['nbf 61s ahead', { nbf: NOW + 61 }, false],
    ['iat exactly 60s ahead', { iat: NOW + 60 }, true],
    ['iat 61s ahead', { iat: NOW + 61 }, false],
  ])('treats %s as %s at the edge of the skew window', async (_label, over, ok) => {
    const token = await signer.sign(claimsFor(NOW, over));
    expect((await verifyAccessJwt(token, opts)).ok).toBe(ok);
  });

  it('accepts a token with no nbf or iat, which are optional', async () => {
    const token = await signer.sign(claimsFor(NOW, { nbf: undefined, iat: undefined }));
    expect((await verifyAccessJwt(token, opts)).ok).toBe(true);
  });

  it('reads nbf and iat only as numbers: text there is no time, and counts as absent', async () => {
    const token = await signer.sign(claimsFor(NOW, { nbf: String(NOW + 3600), iat: String(NOW + 3600) }));
    expect((await verifyAccessJwt(token, opts)).ok).toBe(true);
  });

  it('reads the clock itself when it is given none', async () => {
    // The gate always passes its own clock; called bare, the verifier must
    // still judge expiry against the real time, not against nothing.
    const { nowSeconds: _, ...noClock } = opts;
    const now = Math.floor(Date.now() / 1000);
    expect((await verifyAccessJwt(await signer.sign(claimsFor(now)), noClock)).ok).toBe(true);
    const expired = await signer.sign(claimsFor(now - 7200, { exp: now - 3600 }));
    expect(await verifyAccessJwt(expired, noClock)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('signature forgery', () => {
  it('rejects alg:none, which asks us to skip the signature entirely', async () => {
    // The oldest JWT break there is. Anyone can craft this token; it is only
    // dangerous against a verifier that reads `alg` from the token.
    const token = signer.signNone(claimsFor(NOW));
    expect(await verifyAccessJwt(token, opts)).toEqual({ ok: false, reason: 'unsupported algorithm' });
  });

  it('rejects HS256 signed with the public key as the HMAC secret', async () => {
    // Algorithm confusion. The public key is public, so if the verifier honours
    // a header saying "this is HMAC", the attacker can mint any claims they
    // like, including a valid-looking aud and email.
    const token = await signer.signHs256(claimsFor(NOW));
    expect(await verifyAccessJwt(token, opts)).toEqual({ ok: false, reason: 'unsupported algorithm' });
  });

  it.each([['RS512'], ['rs256'], ['ES256'], ['PS256'], [''], [null], [['RS256']]])(
    'rejects alg %j, even with a genuine RS256 signature underneath',
    async (alg) => {
      // The allowlist is exact: no case-folding, no family match, no array.
      const token = await signer.sign(claimsFor(NOW), { header: { alg } });
      expect(await verifyAccessJwt(token, opts)).toEqual({ ok: false, reason: 'unsupported algorithm' });
    },
  );

  it('rejects a token whose signature has been tampered with', async () => {
    const token = await signer.sign(claimsFor(NOW), { corrupt: true });
    expect(await verifyAccessJwt(token, opts)).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('rejects a token whose payload was edited after signing', async () => {
    // The realistic attack on a token you were legitimately given: keep the
    // signature, swap the claims.
    const token = await signer.sign(claimsFor(NOW));
    const [h, , s] = token.split('.');
    const forged = b64urlJson(claimsFor(NOW, { email: 'attacker@evil.example' }));
    expect(await verifyAccessJwt(`${h}.${forged}.${s}`, opts)).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('rejects a token with the signature stripped', async () => {
    const token = await signer.sign(claimsFor(NOW));
    const [h, p] = token.split('.');
    expect(await verifyAccessJwt(`${h}.${p}.`, opts)).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('rejects a token signed by a key we do not know', async () => {
    const other = await createSigner('someone-elses-key');
    const token = await other.sign(claimsFor(NOW));
    expect(await verifyAccessJwt(token, opts)).toEqual({ ok: false, reason: 'unknown key id' });
  });

  it('rejects a token signed by another key that claims our key id', async () => {
    // The attacker can read our kid from any real token. Claiming it gets them
    // OUR public key, which their signature does not verify against.
    const impostor = await createSigner(signer.kid);
    const token = await impostor.sign(claimsFor(NOW));
    expect(await verifyAccessJwt(token, opts)).toEqual({ ok: false, reason: 'bad signature' });
  });
});

describe('claims that are valid but not ours', () => {
  it('rejects a token minted for a different Access application', async () => {
    // THE one that matters most in a Cloudflare account with more than one
    // application. The signature is genuinely Cloudflare's, the issuer is
    // right, and the token is completely valid, for something else. If only
    // the signature were checked, any Access app in the account (including one
    // with a deliberately open policy) would unlock this page.
    const token = await signer.sign(claimsFor(NOW, { aud: ['b'.repeat(64)] }));
    expect(await verifyAccessJwt(token, opts)).toEqual({ ok: false, reason: 'wrong audience' });
  });

  it('rejects a token from a different Access team', async () => {
    const token = await signer.sign(claimsFor(NOW, { iss: 'https://someone-else.cloudflareaccess.com' }));
    expect(await verifyAccessJwt(token, opts)).toEqual({ ok: false, reason: 'wrong issuer' });
  });

  it.each([
    ['with no scheme', TEAM],
    ['over http', `http://${TEAM}`],
    ['with a trailing slash', `https://${TEAM}/`],
    ['missing', undefined],
  ])('rejects an issuer %s, which is not what Cloudflare stamps', async (_label, iss) => {
    const token = await signer.sign(claimsFor(NOW, { iss }));
    expect(await verifyAccessJwt(token, opts)).toEqual({ ok: false, reason: 'wrong issuer' });
  });

  it('accepts an aud array containing ours alongside others', async () => {
    // Positive case for the membership check, so it cannot be "fixed" into an
    // equality check that happens to pass the negative test above.
    const token = await signer.sign(claimsFor(NOW, { aud: ['other', AUD] }));
    expect((await verifyAccessJwt(token, opts)).ok).toBe(true);
  });

  it('accepts aud as a bare string equal to ours', async () => {
    const token = await signer.sign(claimsFor(NOW, { aud: AUD }));
    expect((await verifyAccessJwt(token, opts)).ok).toBe(true);
  });

  it.each([
    ['empty', []],
    ['a prefix of ours', [AUD.slice(0, 63)]],
    ['ours with a newline', [`${AUD}\n`]],
    ['missing', undefined],
  ])('rejects an aud that is %s', async (_label, aud) => {
    const token = await signer.sign(claimsFor(NOW, { aud }));
    expect(await verifyAccessJwt(token, opts)).toEqual({ ok: false, reason: 'wrong audience' });
  });

  it.each([
    ['expired well beyond skew', { exp: NOW - 3600 }, 'expired'],
    ['carrying no exp at all', { exp: undefined }, 'expired'],
    ['carrying exp as a string', { exp: String(NOW + 3600) }, 'expired'],
    ['not valid until later', { nbf: NOW + 3600 }, 'not yet valid'],
    ['issued in the future', { iat: NOW + 3600, nbf: NOW - 10 }, 'issued in the future'],
  ])('rejects a token %s', async (_label, over, reason) => {
    const token = await signer.sign(claimsFor(NOW, over));
    expect(await verifyAccessJwt(token, opts)).toEqual({ ok: false, reason });
  });
});

describe('malformed and missing input', () => {
  it.each([
    ['absent', undefined, 'no token'],
    ['null, as headers.get returns', null, 'no token'],
    ['empty', '', 'no token'],
    ['not a string', 12345, 'no token'],
    ['one segment', 'abc', 'malformed token'],
    ['two segments', 'abc.def', 'malformed token'],
    ['four segments', 'a.b.c.d', 'malformed token'],
    ['not base64', '!!!.???.***', 'malformed token'],
    ['base64 but not JSON', 'aGVsbG8.aGVsbG8.aGVsbG8', 'malformed token'],
    ['JSON null segments', `${b64urlJson(null)}.${b64urlJson(null)}.x`, 'malformed token'],
    ['JSON array segments', `${b64urlJson([])}.${b64urlJson([])}.x`, 'malformed token'],
    ['a JSON string header', `${b64urlJson('RS256')}.${b64urlJson({})}.x`, 'malformed token'],
  ])('rejects a token that is %s, naming why', async (_label, token, reason) => {
    expect(await verifyAccessJwt(token, opts)).toEqual({ ok: false, reason });
  });

  it.each([
    ['no key id', { kid: undefined }],
    ['an empty key id', { kid: '' }],
    ['a numeric key id', { kid: 1 }],
  ])('rejects a header with %s', async (_label, header) => {
    const token = await signer.sign(claimsFor(NOW), { header });
    expect(await verifyAccessJwt(token, opts)).toEqual({ ok: false, reason: 'no key id' });
  });

  it('rejects a genuine token with a segment added or one taken away', async () => {
    // A real header, payload and signature, rearranged. Counting the dots is
    // what refuses these: with a segment added, the signature still verifies.
    const genuine = await signer.sign(claimsFor(NOW));
    const [header, payload, signature] = genuine.split('.');
    for (const token of [`${genuine}.x`, `${genuine}.${signature}`, `${header}.${payload}`]) {
      expect(await verifyAccessJwt(token, opts), token).toEqual({ ok: false, reason: 'malformed token' });
    }
  });

  it('never throws, and only ever answers with a listed reason, on generated garbage', async () => {
    // A property over inputs nobody would write by hand: random lengths, random
    // segment counts, random characters in each segment, base64url and not,
    // sometimes behind a genuine header and payload. Never a genuine signature
    // segment, so no generated token can be the real thing.
    let seed = 227;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.=+/ \n\u0000é';
    const genuine = (await signer.sign(claimsFor(NOW))).split('.');
    for (let i = 0; i < 400; i++) {
      const pieces = Math.floor(rand() * 5);
      const token = Array.from({ length: pieces }, (_, j) =>
        rand() < 0.3 && j < 2 ? genuine[j] : Array.from({ length: Math.floor(rand() * 40) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join(''),
      ).join('.');
      const result = await verifyAccessJwt(token, opts);
      expect(result.ok, token).toBe(false);
      expect(ACCESS_REFUSAL_REASONS, token).toContain((result as { reason: string }).reason);
    }
  });
});

describe('failing closed', () => {
  it.each([
    ['the team domain is missing', { teamDomain: undefined }],
    ['the audience tag is missing', { aud: undefined }],
    ['both are missing', { teamDomain: undefined, aud: undefined }],
    ['the team domain is empty', { teamDomain: '' }],
    ['the team domain is only whitespace', { teamDomain: ' \n' }],
    ['the audience tag is only a newline', { aud: '\n' }],
    ['the team domain is not a string', { teamDomain: ['vva227-test.cloudflareaccess.com'] }],
  ])('denies a perfectly valid token when %s', async (_label, over) => {
    // The dangerous default this guards against: a stats page that is public
    // until someone remembers to configure Access. There must be no path from
    // "unconfigured" to "allowed", so this is asserted with a token that is
    // otherwise completely valid.
    const token = await signer.sign(claimsFor(NOW));
    expect(await verifyAccessJwt(token, { ...opts, ...over })).toEqual({ ok: false, reason: 'access not configured' });
  });

  it('denies, without throwing, when called with no options or no key source', async () => {
    const token = await signer.sign(claimsFor(NOW));
    expect(await verifyAccessJwt(token)).toEqual({ ok: false, reason: 'access not configured' });
    expect(await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD, nowSeconds: NOW })).toEqual({ ok: false, reason: 'cannot fetch signing keys' });
  });

  it('denies when the signing keys cannot be fetched', async () => {
    // An outage at the key endpoint must lock the door, not open it. Written
    // the other way round this is a total bypass triggered by someone else's
    // bad day.
    const token = await signer.sign(claimsFor(NOW));
    const failing = { ...opts, getJwks: async () => { throw new Error('network down'); } };
    expect(await verifyAccessJwt(token, failing)).toEqual({ ok: false, reason: 'cannot fetch signing keys' });
  });

  it('denies when the key set is empty', async () => {
    const token = await signer.sign(claimsFor(NOW));
    expect(await verifyAccessJwt(token, { ...opts, getJwks: async () => ({ keys: [] }) })).toEqual({ ok: false, reason: 'unknown key id' });
  });

  it.each([
    ['null', null],
    ['keys as a string', { keys: 'test-key-1' }],
    ['keys holding null and a number', { keys: [null, 7] }],
    ['a bare array of keys', [{ kid: 'test-key-1' }]],
  ])('denies, without throwing, when the key set is %s', async (_label, jwks) => {
    const token = await signer.sign(claimsFor(NOW));
    const odd = { ...opts, getJwks: async () => jwks as never };
    expect(await verifyAccessJwt(token, odd)).toEqual({ ok: false, reason: 'unknown key id' });
  });

  it('denies, without throwing, when the matching key is not an RSA key', async () => {
    const token = await signer.sign(claimsFor(NOW));
    const ec = { ...opts, getJwks: async () => ({ keys: [{ kid: signer.kid, kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' }] }) };
    expect(await verifyAccessJwt(token, ec)).toEqual({ ok: false, reason: 'bad signature' });
  });
});

describe('issuer and certs URLs', () => {
  it('derives both from the team domain', () => {
    expect(issuerFor(TEAM)).toBe(`https://${TEAM}`);
    expect(certsUrlFor(TEAM)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
  });

  it('tolerates a team domain given with a scheme or trailing slash', () => {
    // Sad path for the one value a human may type into a setting by hand.
    expect(issuerFor(`https://${TEAM}/`)).toBe(`https://${TEAM}`);
    expect(issuerFor(`http://${TEAM}`)).toBe(`https://${TEAM}`);
  });

  it('removes a scheme only from the front and slashes only from the end, and keeps the rest as typed', () => {
    expect(issuerFor(`${TEAM}//`)).toBe(`https://${TEAM}`);
    expect(issuerFor(`${TEAM}/x/`)).toBe(`https://${TEAM}/x`);
    expect(issuerFor(`${TEAM}/https://x`)).toBe(`https://${TEAM}/https://x`);
  });

  it.each([
    ['a trailing newline', `${TEAM}\n`],
    ['a trailing CRLF', `${TEAM}\r\n`],
    ['surrounding spaces', `  ${TEAM}  `],
  ])('tolerates %s, which a shell pipe adds', (_label, value) => {
    // `echo <domain> | wrangler pages secret put ...` stores the newline. The
    // resulting failure is `wrong issuer` comparing two strings that print
    // identically in every log, the worst kind of configuration bug.
    expect(issuerFor(value)).toBe(`https://${TEAM}`);
  });

  it('accepts a valid token when the team domain was stored with a trailing newline', async () => {
    const token = await signer.sign(claimsFor(NOW));
    expect((await verifyAccessJwt(token, { ...opts, teamDomain: `${TEAM}\n` })).ok).toBe(true);
  });
});

describe('whitespace in the audience tag', () => {
  it('accepts a valid token when AUD was stored with a trailing newline', async () => {
    // Same shell-pipe hazard as the team domain, and the same invisible
    // failure: `wrong audience` on a tag that looks correct.
    const token = await signer.sign(claimsFor(NOW));
    expect((await verifyAccessJwt(token, { ...opts, aud: `${AUD}\n` })).ok).toBe(true);
  });

  it('still rejects an audience that differs by more than whitespace', async () => {
    // Negative case: trimming must not become "close enough".
    const token = await signer.sign(claimsFor(NOW));
    expect(await verifyAccessJwt(token, { ...opts, aud: `${AUD}x` })).toEqual({ ok: false, reason: 'wrong audience' });
  });
});

describe('the JWKS cache', () => {
  const jwksResponse = (keys: unknown[]) => ({ ok: true, status: 200, json: async () => ({ keys }) });

  it('asks the team certs URL, and nothing else', async () => {
    const asked: string[] = [];
    const getJwks = createJwksCache(`${TEAM}\n`, {
      fetchImpl: async (url) => { asked.push(url); return jwksResponse([{ kid: 'k' }]); },
    });
    await getJwks();
    expect(asked).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  it('fetches once and reuses within the TTL', async () => {
    let calls = 0;
    const getJwks = createJwksCache(TEAM, {
      fetchImpl: async () => { calls++; return jwksResponse([{ kid: 'k' }]); },
      now: () => 1000,
    });
    await getJwks();
    await getJwks();
    await getJwks();
    expect(calls).toBe(1);
  });

  it('caches by the real clock when it is given none, as the production gate gives none', async () => {
    let calls = 0;
    const getJwks = createJwksCache(TEAM, { fetchImpl: async () => { calls++; return jwksResponse([{ kid: 'k' }]); } });
    await getJwks();
    await getJwks();
    expect(calls).toBe(1);
  });

  it('refetches once the TTL has passed, so key rotation is picked up', async () => {
    let calls = 0;
    let clock = 1000;
    const getJwks = createJwksCache(TEAM, {
      fetchImpl: async () => { calls++; return jwksResponse([{ kid: `k${calls}` }]); },
      ttlMs: 600_000,
      now: () => clock,
    });
    await getJwks();
    clock += 599_999;
    expect((await getJwks()).keys[0].kid).toBe('k1');
    // At exactly the TTL, the keys are old enough to fetch again.
    clock += 1;
    const second = await getJwks();
    expect(calls).toBe(2);
    expect(second.keys[0].kid).toBe('k2');
  });

  it('keeps serving the last good key set if a refresh returns nothing usable', async () => {
    // Access briefly returning an empty or broken key set must not lock the
    // owner out of their own page. Stale keys still verify real tokens.
    let clock = 1000;
    let calls = 0;
    const getJwks = createJwksCache(TEAM, {
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return jwksResponse([{ kid: 'good' }]);
        return calls === 2 ? jwksResponse([]) : { ok: true, status: 200, json: async () => ({ keys: 'nope' }) };
      },
      ttlMs: 1000,
      now: () => clock,
    });
    await getJwks();
    clock += 5000;
    expect((await getJwks()).keys[0].kid).toBe('good');
    clock += 5000;
    expect((await getJwks()).keys[0].kid).toBe('good');
    expect(calls).toBe(3);
  });

  it('throws rather than returning nothing when the first fetch fails', async () => {
    // verifyAccessJwt turns a throw into a denial. Returning undefined here
    // would instead reach the "unknown key id" path, which is the same answer
    // by luck rather than by design.
    const getJwks = createJwksCache(TEAM, { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    await expect(getJwks()).rejects.toThrow(/certs fetch failed: 503/);
  });

  it('throws when the first response has no keys, or is not JSON', async () => {
    await expect(createJwksCache(TEAM, { fetchImpl: async () => jwksResponse([]) })()).rejects.toThrow(/no keys/);
    const notJson = { ok: true, status: 200, json: async () => JSON.parse('<html>') };
    await expect(createJwksCache(TEAM, { fetchImpl: async () => notJson })()).rejects.toThrow();
  });

  it('feeds a real verification end to end: a fetched key set verifies a real token', async () => {
    const getJwks = createJwksCache(TEAM, { fetchImpl: async () => jwksResponse(signer.jwks.keys) });
    const token = await signer.sign(claimsFor(NOW));
    expect((await verifyAccessJwt(token, { ...opts, getJwks })).ok).toBe(true);
  });
});

describe('the base64url decoding the verifier relies on', () => {
  it('accepts a token whose payload carries both URL-safe characters, - and _, and reads its claims exactly', async () => {
    // A byte of ">" in the third place of a group of three encodes to "-",
    // and one of "?" to "_" (base64's "+" and "/"); three of each in a row
    // put one in that place whatever the offset. A decoder that missed
    // either substitution would refuse this token, or read other claims.
    // Real signatures carry both characters too, but only by chance.
    const note = '>>>???';
    const token = await signer.sign(claimsFor(NOW, { note }));
    const payload = token.split('.')[1];
    expect(payload).toContain('-');
    expect(payload).toContain('_');
    expect(await verifyAccessJwt(token, opts)).toEqual({ ok: true, claims: claimsFor(NOW, { note }) });
  });
});
