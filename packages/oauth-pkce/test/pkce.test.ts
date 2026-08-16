/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { base64UrlEncode, deriveCodeChallengeS256, generateCodeVerifier, generateState } from '../src/pkce.js';

describe('deriveCodeChallengeS256', () => {
  // RFC 7636 Appendix B, "Example for the S256 code_challenge_method":
  // https://www.rfc-editor.org/rfc/rfc7636.html#appendix-B
  //
  //   code_verifier:  dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
  //   code_challenge: E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
  //
  // (the RFC also gives the intermediate octet sequences for the verifier and
  // its SHA-256 digest; this test exercises the string-in, string-out shape.)
  it('matches the RFC 7636 Appendix B known-good vector', async () => {
    const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    await expect(deriveCodeChallengeS256(codeVerifier)).resolves.toBe(expectedChallenge);
  });
});

describe('base64UrlEncode', () => {
  it('encodes the RFC 7636 Appendix B octet sequence to the documented code_verifier', () => {
    // The same appendix gives the raw octets that decode to the verifier
    // above, letting the encoder be checked independently of SHA-256.
    const octets = new Uint8Array([
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240,
      91, 88, 5, 88, 83, 132, 141, 121,
    ]);
    expect(base64UrlEncode(octets)).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  });

  it('never emits "+", "/" or "=" (base64url, unpadded)', () => {
    // 33 bytes forces every tail-length case (0, 1, 2 leftover bytes) across
    // a handful of blocks, so a padding or alphabet bug is very likely to
    // land inside this one input rather than needing three separate ones.
    const bytes = new Uint8Array(33).map((_, i) => (i * 37 + 5) % 256);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('=');
  });
});

describe('generateCodeVerifier', () => {
  it('produces a string within the RFC 7636 §4.1 43-128 char range, from the unreserved alphabet', () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a byte length that would fall outside the RFC range', () => {
    expect(() => generateCodeVerifier(31)).toThrow(RangeError);
    expect(() => generateCodeVerifier(97)).toThrow(RangeError);
  });

  it('rejects a byte length that is not an integer', () => {
    // `NaN` is the dangerous one: `NaN < 32` and `NaN > 96` are both false,
    // so the range guard passed it through, and `new Uint8Array(NaN)` has
    // length 0 — an *empty* `code_verifier`, which defeats PKCE silently
    // (the challenge is then the SHA-256 of the empty string, a constant any
    // attacker can precompute, and the verifier is not a secret at all).
    // A fractional length is truncated by `Uint8Array` rather than honoured,
    // so it is rejected too rather than quietly meaning something else.
    expect(() => generateCodeVerifier(Number.NaN)).toThrow(RangeError);
    expect(() => generateCodeVerifier(32.5)).toThrow(RangeError);
    expect(() => generateCodeVerifier(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('never repeats across calls (CSPRNG, not a fixed value)', () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateCodeVerifier()));
    expect(seen.size).toBe(20);
  });
});

describe('generateState', () => {
  it('never repeats across calls', () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateState()));
    expect(seen.size).toBe(20);
  });
});
