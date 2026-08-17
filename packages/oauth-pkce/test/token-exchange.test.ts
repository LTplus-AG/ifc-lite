/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { exchangeAuthorizationCode, refreshAccessToken } from '../src/token-exchange.js';
import { TokenExchangeError } from '../src/errors.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('exchangeAuthorizationCode', () => {
  it('POSTs the authorization_code grant with the PKCE verifier, no client secret', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body as string);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('auth-code');
      expect(body.get('code_verifier')).toBe('verifier-value');
      expect(body.get('redirect_uri')).toBe('https://app.example.com/callback');
      expect(body.get('client_id')).toBe('client-1');
      expect(body.has('client_secret')).toBe(false);
      return jsonResponse({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
    });

    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      redirectUri: 'https://app.example.com/callback',
      code: 'auth-code',
      codeVerifier: 'verifier-value',
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 1_000_000,
    });

    expect(tokens).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 1_000_000 + 3600 * 1000,
      scope: undefined,
      tokenType: undefined,
    });
  });

  it('throws TokenExchangeError with the status and safe OAuth error fields on a non-OK response', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'invalid_grant', error_description: 'expired code' }, 400));

    await expect(
      exchangeAuthorizationCode({
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'client-1',
        redirectUri: 'https://app.example.com/callback',
        code: 'auth-code',
        codeVerifier: 'verifier-value',
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('invalid_grant') });
  });

  it('never includes the code or verifier in a thrown error message', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400));
    try {
      await exchangeAuthorizationCode({
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'client-1',
        redirectUri: 'https://app.example.com/callback',
        code: 'super-secret-code',
        codeVerifier: 'super-secret-verifier',
        fetch: fetchMock as unknown as typeof fetch,
      });
      expect.unreachable('exchangeAuthorizationCode should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('super-secret-code');
      expect(message).not.toContain('super-secret-verifier');
    }
  });

  it('accepts a numeric-string expires_in (some providers send it as a string, not a JSON number)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: 'access-1', expires_in: '60' }));

    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      redirectUri: 'https://app.example.com/callback',
      code: 'auth-code',
      codeVerifier: 'verifier-value',
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 1_000_000,
    });

    // Must honor the real 60s lifetime, not silently fall back to the 3600s
    // default — the fallback would make an already-rejected token look fresh.
    expect(tokens.expiresAt).toBe(1_000_000 + 60 * 1000);
  });

  it('falls back to the 3600s default when expires_in is absent, non-numeric, or non-positive', async () => {
    for (const badValue of [undefined, 'not-a-number', -5, 0]) {
      const fetchMock = vi.fn(async () => jsonResponse({ access_token: 'access-1', expires_in: badValue }));
      const tokens = await exchangeAuthorizationCode({
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'client-1',
        redirectUri: 'https://app.example.com/callback',
        code: 'auth-code',
        codeVerifier: 'verifier-value',
        fetch: fetchMock as unknown as typeof fetch,
        now: () => 1_000_000,
      });
      expect(tokens.expiresAt).toBe(1_000_000 + 3600 * 1000);
    }
  });

  it('rejects a response missing access_token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ token_type: 'Bearer' }, 200));
    await expect(
      exchangeAuthorizationCode({
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'client-1',
        redirectUri: 'https://app.example.com/callback',
        code: 'auth-code',
        codeVerifier: 'verifier-value',
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(TokenExchangeError);
  });

  it('rejects a whitespace-only access_token, not just an empty one', async () => {
    // The check here was `.length === 0`, which passes `"   "`. That is
    // unusable as a bearer credential — it produces the header
    // `Authorization: Bearer    ` and a 401 nothing can attribute — and it
    // is also rejected by `TokenManager`'s `isTokenSet` on the way back out
    // of storage, so accepting it here meant a sign-in that succeeded and a
    // session that was gone by the next read. See the cross-file agreement
    // suite in `token-manager.test.ts`.
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: '   \t\n ', expires_in: 3600 }));
    await expect(
      exchangeAuthorizationCode({
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'client-1',
        redirectUri: 'https://app.example.com/callback',
        code: 'auth-code',
        codeVerifier: 'verifier-value',
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(TokenExchangeError);
  });

  it('keeps a non-blank access token exactly as sent, surrounding whitespace included', async () => {
    // The blank check must not turn into a trim of the credential itself:
    // whitespace is only grounds for rejecting a token that is *nothing but*
    // whitespace, never grounds for rewriting one that has content. A
    // silently trimmed token would be a different credential from the one
    // the provider issued.
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: ' padded ', expires_in: 3600 }));
    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      redirectUri: 'https://app.example.com/callback',
      code: 'auth-code',
      codeVerifier: 'verifier-value',
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(tokens.accessToken).toBe(' padded ');
  });
});

describe('provider error text in a token-endpoint failure is bounded and stripped', () => {
  // Same shape as the authorization-callback case: `error`/`error_description`
  // come from the response body and go verbatim into a message that ends up
  // in logs and bug reports.
  const exchangeFailure = (body: unknown) =>
    exchangeAuthorizationCode({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      redirectUri: 'https://app.example.com/callback',
      code: 'auth-code',
      codeVerifier: 'verifier-value',
      fetch: (async () => jsonResponse(body, 400)) as unknown as typeof fetch,
    });

  it('strips control characters and caps the length of both fields', async () => {
    let message = '';
    try {
      await exchangeFailure({
        error: 'invalid_grant',
        error_description: `bad\ncode\r\x1b[31m ${'B'.repeat(50_000)}`,
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('400');
    expect(message).toContain('invalid_grant');
    expect(message.length).toBeLessThan(400);
    expect(message).toMatch(/^[\x20-\x21\x23-\x5B\x5D-\x7E]*$/);
  });
});

describe('a token response whose optional fields are not strings', () => {
  // `access_token` was the only field validated; `refresh_token`, `scope` and
  // `token_type` were copied through untyped straight into the persisted
  // `TokenSet`. That made a *successful* sign-in read back as "never signed
  // in" — `TokenManager.getTokens()` runs `isTokenSet` over the entry it just
  // wrote, and a non-string `refreshToken` fails that guard, which fails
  // closed to "no session". The end-to-end effect is in the TokenManager
  // suite; these pin the exchange itself.

  const exchange = (body: unknown) =>
    exchangeAuthorizationCode({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      redirectUri: 'https://app.example.com/callback',
      code: 'auth-code',
      codeVerifier: 'verifier-value',
      fetch: (async () => jsonResponse(body)) as unknown as typeof fetch,
      now: () => 1_000_000,
    });

  it('rejects a non-string refresh_token rather than persisting it', async () => {
    // `refresh_token` is load-bearing: silently dropping it would downgrade
    // the session to a non-refreshable one, which the caller only discovers
    // an access-token lifetime later and far from the cause. Reject at the
    // exchange, naming the field.
    await expect(exchange({ access_token: 'a1', refresh_token: 12345, expires_in: 3600 })).rejects.toThrow(
      TokenExchangeError,
    );
    await expect(exchange({ access_token: 'a1', refresh_token: 12345, expires_in: 3600 })).rejects.toThrow(
      /refresh_token/,
    );
  });

  it('drops a non-string scope or token_type instead of failing the sign-in over them', async () => {
    // Neither field affects anything this package does — dropping keeps a
    // usable session rather than refusing to sign in over informational
    // metadata, and keeps the `TokenSet` conforming to its declared type.
    const tokens = await exchange({
      access_token: 'a1',
      scope: ['files.read', 'files.write'],
      token_type: 7,
      expires_in: 3600,
    });

    expect(tokens.accessToken).toBe('a1');
    expect(tokens.scope).toBeUndefined();
    expect(tokens.tokenType).toBeUndefined();
  });
});

describe('refreshAccessToken', () => {
  it('POSTs the refresh_token grant', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body as string);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('refresh-1');
      expect(body.get('client_id')).toBe('client-1');
      return jsonResponse({ access_token: 'access-2', expires_in: 60 });
    });

    const tokens = await refreshAccessToken({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-1',
      refreshToken: 'refresh-1',
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 0,
    });

    expect(tokens.accessToken).toBe('access-2');
    expect(tokens.expiresAt).toBe(60_000);
  });

  it('rejects a whitespace-only access_token from the refresh grant too', async () => {
    // `refreshAccessToken` and `exchangeAuthorizationCode` share
    // `requestToken`, so this is the same guard — but the consequence is
    // worse on this path. A refresh result is written back over a working
    // session by `TokenManager.refresh`, so a blank token here signs out a
    // user who was already signed in, mid-session, with no interaction to
    // attribute it to.
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: ' ', expires_in: 60 }));
    await expect(
      refreshAccessToken({
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'client-1',
        refreshToken: 'refresh-1',
        fetch: fetchMock as unknown as typeof fetch,
        now: () => 0,
      }),
    ).rejects.toThrow(TokenExchangeError);
  });
});
