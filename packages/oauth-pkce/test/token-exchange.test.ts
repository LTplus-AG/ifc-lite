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
});
