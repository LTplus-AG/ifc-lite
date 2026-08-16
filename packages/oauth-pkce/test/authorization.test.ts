/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createAuthorizationRequest, parseAuthorizationCallback } from '../src/authorization.js';
import { OAuthAuthorizationError, OAuthRedirectOriginError, OAuthStateMismatchError } from '../src/errors.js';

const REDIRECT_URI = 'https://app.example.com/oauth/callback';

describe('createAuthorizationRequest', () => {
  it('builds a URL carrying response_type=code, PKCE S256 challenge, and a state param', async () => {
    const request = await createAuthorizationRequest({
      authorizationEndpoint: 'https://auth.example.com/authorize',
      clientId: 'client-123',
      redirectUri: REDIRECT_URI,
      scope: 'files.read',
    });

    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe('https://auth.example.com/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe('files.read');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(request.codeVerifier).toBeTruthy();
    // The verifier must never appear in the URL that gets sent to the server.
    expect(request.url).not.toContain(request.codeVerifier);
  });

  it('does not let extraParams override the protocol parameters', async () => {
    const request = await createAuthorizationRequest({
      authorizationEndpoint: 'https://auth.example.com/authorize',
      clientId: 'client-123',
      redirectUri: REDIRECT_URI,
      extraParams: {
        response_type: 'token', // would be an implicit-grant downgrade if it won
        client_id: 'attacker-client',
        state: 'attacker-chosen-state',
      },
    });
    const url = new URL(request.url);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('state')).not.toBe('attacker-chosen-state');
  });

  it('overwrites — not appends — every protocol parameter an extraParams entry collides with', async () => {
    // Pins the precedence rule documented on `AuthorizationRequestConfig.extraParams`:
    // extras are written into the URL *first*, then each protocol parameter is
    // `set()` over the top, so a colliding extra is replaced outright. Asserting
    // `getAll(...).length === 1` is the half a `get(...)` assertion cannot see:
    // `get()` returns the *first* occurrence, so if the extras were appended after
    // the protocol parameters instead of overwritten by them, `get()` could still
    // report the protocol value while the attacker-supplied duplicate rode along
    // in the query string — and a server that reads the last occurrence would use
    // the attacker's. Every protocol parameter is covered, not just a sample,
    // because the guarantee is about the mechanism, not about a chosen few keys.
    const request = await createAuthorizationRequest({
      authorizationEndpoint: 'https://auth.example.com/authorize',
      clientId: 'client-123',
      redirectUri: REDIRECT_URI,
      scope: 'files.read',
      extraParams: {
        response_type: 'token',
        client_id: 'attacker-client',
        redirect_uri: 'https://attacker.example.com/steal',
        scope: 'files.readwrite',
        code_challenge: 'attacker-challenge',
        code_challenge_method: 'plain', // would defeat PKCE's proof if it won
        state: 'attacker-chosen-state',
        // A non-colliding extra is the control: it must survive untouched, so
        // this test is asserting precedence and not merely "extras are dropped".
        prompt: 'consent',
      },
    });

    const url = new URL(request.url);
    const expected: Readonly<Record<string, string>> = {
      response_type: 'code',
      client_id: 'client-123',
      redirect_uri: REDIRECT_URI,
      scope: 'files.read',
      code_challenge_method: 'S256',
      state: request.state,
    };
    for (const [key, value] of Object.entries(expected)) {
      expect(url.searchParams.getAll(key)).toEqual([value]);
    }
    // `code_challenge` is freshly derived per call, so it is pinned by identity
    // against the attacker's value rather than against a literal.
    expect(url.searchParams.getAll('code_challenge')).toHaveLength(1);
    expect(url.searchParams.get('code_challenge')).not.toBe('attacker-challenge');
    expect(url.searchParams.getAll('prompt')).toEqual(['consent']);
  });

  it('generates a different state and verifier on every call', async () => {
    const a = await createAuthorizationRequest({
      authorizationEndpoint: 'https://auth.example.com/authorize',
      clientId: 'client-123',
      redirectUri: REDIRECT_URI,
    });
    const b = await createAuthorizationRequest({
      authorizationEndpoint: 'https://auth.example.com/authorize',
      clientId: 'client-123',
      redirectUri: REDIRECT_URI,
    });
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe('parseAuthorizationCallback', () => {
  const expectedState = 'expected-state-value';
  const options = { expectedRedirectOrigin: 'https://app.example.com', expectedState };

  it('returns code and state for a valid callback', () => {
    const result = parseAuthorizationCallback(
      `${REDIRECT_URI}?code=auth-code-abc&state=${expectedState}`,
      options,
    );
    expect(result).toEqual({ code: 'auth-code-abc', state: expectedState });
  });

  it('rejects a state that does not match (CSRF)', () => {
    expect(() =>
      parseAuthorizationCallback(`${REDIRECT_URI}?code=auth-code-abc&state=forged-state`, options),
    ).toThrow(OAuthStateMismatchError);
  });

  it('rejects a missing state', () => {
    expect(() => parseAuthorizationCallback(`${REDIRECT_URI}?code=auth-code-abc`, options)).toThrow(
      OAuthStateMismatchError,
    );
  });

  it('rejects a callback from an origin other than the expected redirect origin', () => {
    expect(() =>
      parseAuthorizationCallback(`https://evil.example.com/callback?code=x&state=${expectedState}`, options),
    ).toThrow(OAuthRedirectOriginError);
  });

  it('surfaces a provider-returned error before checking state', () => {
    expect(() =>
      parseAuthorizationCallback(
        `${REDIRECT_URI}?error=access_denied&error_description=user+declined&state=forged-state`,
        options,
      ),
    ).toThrow(OAuthAuthorizationError);
  });

  it('rejects a valid, correctly-stated callback with no code', () => {
    expect(() => parseAuthorizationCallback(`${REDIRECT_URI}?state=${expectedState}`, options)).toThrow(
      OAuthAuthorizationError,
    );
  });
});
