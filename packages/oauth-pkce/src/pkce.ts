/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PkceCodeChallenge } from './types.js';

// ============================================================================
// PKCE (RFC 7636) — code_verifier / code_challenge generation, and the CSRF
// `state` nonce. Both use Web Crypto's CSPRNG (`crypto.getRandomValues`),
// never `Math.random()`, which is not cryptographically secure and must
// never back a security token (a `state`/verifier generated from it is
// predictable enough to be guessed or brute-forced).
// ============================================================================

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * RFC 7636 §4.2's "Base64url Encoding": ordinary base64 (RFC 4648 §5) with
 * "the URL- and filename-safe character set ... with all trailing '=' padding
 * characters omitted". Implemented directly against the alphabet (rather than
 * via `btoa`) so no padding is ever produced in the first place, and so the
 * same code runs unchanged in a browser and in Node.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 !== undefined) {
      out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    }
    if (b2 !== undefined) {
      out += BASE64URL_ALPHABET[b2 & 0x3f];
    }
  }
  return out;
}

/**
 * RFC 7636 §4.1: `code_verifier` is a "high-entropy cryptographic random
 * STRING using the unreserved characters [A-Z] / [a-z] / [0-9] / "-" / "."
 * / "_" / "~" ... with a minimum length of 43 characters and a maximum
 * length of 128 characters". `byteLength` random bytes, base64url-encoded,
 * yields `ceil(byteLength * 8 / 6)` characters drawn from a subset of that
 * unreserved set (no padding, since base64url omits it) — 32 bytes (the
 * default) is the smallest input that reaches the 43-character floor; 96
 * bytes reaches the 128-character ceiling.
 */
export function generateCodeVerifier(byteLength = 32): string {
  // `Number.isInteger` is what makes the range check actually cover its
  // range. Comparisons against `NaN` are *both* false, so `NaN` passed a
  // bare `< 32 || > 96` guard — and `new Uint8Array(NaN)` has length 0, so
  // the function returned an empty `code_verifier` and PKCE was defeated
  // without anything failing: the challenge becomes the SHA-256 of the empty
  // string, a constant, and the verifier protects nothing. A fractional
  // length is rejected for the milder reason that `Uint8Array` truncates it,
  // so it would silently mean a different length than the caller asked for.
  if (!Number.isInteger(byteLength) || byteLength < 32 || byteLength > 96) {
    throw new RangeError(
      'generateCodeVerifier: byteLength must be an integer between 32 (43 chars) and 96 (128 chars)',
    );
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * RFC 7636 §4.2, S256 method: `code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))`.
 * `code_verifier` is already restricted to the unreserved-character subset of
 * ASCII, so `TextEncoder` (UTF-8) and `ASCII()` agree byte-for-byte here.
 */
export async function deriveCodeChallengeS256(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Generates a fresh `code_verifier` and its S256 `code_challenge` together. */
export async function createPkcePair(verifierByteLength = 32): Promise<PkceCodeChallenge> {
  const codeVerifier = generateCodeVerifier(verifierByteLength);
  const codeChallenge = await deriveCodeChallengeS256(codeVerifier);
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

/**
 * CSRF `state` (RFC 6749 §10.12): an unguessable per-request nonce, echoed
 * back on the redirect and checked in `parseAuthorizationCallback`. 16 random
 * bytes (128 bits) is standard nonce entropy — there is no RFC-mandated
 * length for `state`, unlike `code_verifier`.
 */
export function generateState(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
