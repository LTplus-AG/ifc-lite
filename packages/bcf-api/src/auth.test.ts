/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  exchangeAuthorizationCode,
  refreshAccessToken,
  registerBcfClient,
  requestClientCredentialsToken,
  requestPasswordToken,
} from './auth.js';
import { BcfAuthenticationError } from './errors.js';
import type { FetchLike } from './types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('requestPasswordToken', () => {
  it('posts a form-encoded password grant and parses the token set', async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchFn: FetchLike = async (url, init) => {
      captured = { url, init };
      return jsonResponse({
        access_token: 'at-1',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt-1',
      });
    };
    const token = await requestPasswordToken({
      tokenUrl: 'https://host/bcf/oauth2/token',
      username: 'user@example.com',
      password: 'p&ss=word',
      fetchFn,
    });
    expect(token).toEqual({
      access_token: 'at-1',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'rt-1',
    });
    expect(captured?.url).toBe('https://host/bcf/oauth2/token');
    expect(captured?.init?.method).toBe('POST');
    expect(new Headers(captured?.init?.headers).get('Content-Type')).toBe(
      'application/x-www-form-urlencoded',
    );
    const form = new URLSearchParams(String(captured?.init?.body));
    expect(form.get('grant_type')).toBe('password');
    expect(form.get('username')).toBe('user@example.com');
    expect(form.get('password')).toBe('p&ss=word');
    expect(form.has('client_id')).toBe(false);
  });

  it('includes client credentials only when provided', async () => {
    let body = '';
    const fetchFn: FetchLike = async (_url, init) => {
      body = String(init?.body);
      return jsonResponse({ access_token: 'at' });
    };
    await requestPasswordToken({
      tokenUrl: 'https://host/token',
      username: 'u',
      password: 'p',
      clientId: 'cid',
      clientSecret: 'cs',
      fetchFn,
    });
    const form = new URLSearchParams(body);
    expect(form.get('client_id')).toBe('cid');
    expect(form.get('client_secret')).toBe('cs');
  });

  it('throws BcfAuthenticationError with the RFC 6749 error fields', async () => {
    // Exact error shape observed from a live BCF server's token endpoint.
    const fetchFn: FetchLike = async () =>
      jsonResponse(
        { error: 'invalid_request', error_description: 'username and password are required' },
        400,
      );
    const error = await requestPasswordToken({
      tokenUrl: 'https://host/token',
      username: 'u',
      password: 'p',
      fetchFn,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BcfAuthenticationError);
    const authError = error as BcfAuthenticationError;
    expect(authError.errorCode).toBe('invalid_request');
    expect(authError.message).toBe('username and password are required');
    expect(authError.status).toBe(400);
  });

  it('rejects a 200 response that carries no access_token', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ token_type: 'Bearer' });
    const error = await requestPasswordToken({
      tokenUrl: 'https://host/token',
      username: 'u',
      password: 'p',
      fetchFn,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BcfAuthenticationError);
    expect((error as Error).message).toBe('Token response carried no access_token');
  });
});

describe('requestClientCredentialsToken', () => {
  it('posts a client_credentials grant with the app id and secret', async () => {
    let body = '';
    const fetchFn: FetchLike = async (_url, init) => {
      body = String(init?.body);
      return jsonResponse({ access_token: 'at-cc', expires_in: 7200 });
    };
    const token = await requestClientCredentialsToken({
      tokenUrl: 'https://host/token',
      clientId: 'app-id',
      clientSecret: 'app-secret',
      fetchFn,
    });
    const form = new URLSearchParams(body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('app-id');
    expect(form.get('client_secret')).toBe('app-secret');
    expect(token.access_token).toBe('at-cc');
    expect(token.expires_in).toBe(7200);
  });
});

describe('exchangeAuthorizationCode', () => {
  it('posts the code, redirect_uri, PKCE verifier, and client credentials', async () => {
    let body = '';
    const fetchFn: FetchLike = async (_url, init) => {
      body = String(init?.body);
      return jsonResponse({ access_token: 'at-code', refresh_token: 'rt-code' });
    };
    const token = await exchangeAuthorizationCode({
      tokenUrl: 'https://host/token',
      code: 'auth-code-1',
      redirectUri: 'https://viewer.example/oauth/bcf/callback',
      codeVerifier: 'pkce-verifier',
      clientId: 'app-id',
      clientSecret: 'app-secret',
      fetchFn,
    });
    const form = new URLSearchParams(body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('auth-code-1');
    expect(form.get('redirect_uri')).toBe('https://viewer.example/oauth/bcf/callback');
    expect(form.get('code_verifier')).toBe('pkce-verifier');
    expect(form.get('client_id')).toBe('app-id');
    expect(form.get('client_secret')).toBe('app-secret');
    expect(token.access_token).toBe('at-code');
  });

  it('omits the PKCE verifier when none was used', async () => {
    let body = '';
    const fetchFn: FetchLike = async (_url, init) => {
      body = String(init?.body);
      return jsonResponse({ access_token: 'at' });
    };
    await exchangeAuthorizationCode({
      tokenUrl: 'https://host/token',
      code: 'c',
      redirectUri: 'https://viewer.example/cb',
      clientId: 'app-id',
      fetchFn,
    });
    expect(new URLSearchParams(body).has('code_verifier')).toBe(false);
  });
});

describe('registerBcfClient', () => {
  it('posts the JSON registration and returns the minted client', async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchFn: FetchLike = async (url, init) => {
      captured = { url, init };
      return jsonResponse({ client_id: 'minted-id', client_secret: 'minted-secret' });
    };
    const client = await registerBcfClient({
      registrationUrl: 'https://host/bcf/oauth2/register',
      clientName: 'IFClite viewer',
      clientUrl: 'https://viewer.example',
      redirectUrl: 'https://viewer.example/oauth/bcf/callback',
      fetchFn,
    });
    expect(client).toEqual({ client_id: 'minted-id', client_secret: 'minted-secret' });
    expect(new Headers(captured?.init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      client_name: 'IFClite viewer',
      client_url: 'https://viewer.example',
      redirect_url: 'https://viewer.example/oauth/bcf/callback',
    });
  });

  it('surfaces registration rejections and rejects responses without a client_id', async () => {
    const rejecting: FetchLike = async () =>
      jsonResponse({ message: 'registration disabled' }, 403);
    await expect(
      registerBcfClient({ registrationUrl: 'https://host/reg', clientName: 'x', fetchFn: rejecting }),
    ).rejects.toThrow('registration disabled');
    const empty: FetchLike = async () => jsonResponse({});
    await expect(
      registerBcfClient({ registrationUrl: 'https://host/reg', clientName: 'x', fetchFn: empty }),
    ).rejects.toThrow('no client_id');
  });
});

describe('refreshAccessToken', () => {
  it('posts a refresh_token grant', async () => {
    let body = '';
    const fetchFn: FetchLike = async (_url, init) => {
      body = String(init?.body);
      return jsonResponse({ access_token: 'at-2', refresh_token: 'rt-2' });
    };
    const token = await refreshAccessToken({
      tokenUrl: 'https://host/token',
      refreshToken: 'rt-1',
      fetchFn,
    });
    const form = new URLSearchParams(body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('rt-1');
    expect(token.access_token).toBe('at-2');
    expect(token.refresh_token).toBe('rt-2');
  });
});
