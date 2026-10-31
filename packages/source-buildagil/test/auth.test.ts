/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { OAUTH_CALLBACK_CHANNEL } from '@ifc-lite/oauth-pkce';
import { BuildagilProvider } from '../src/index.js';
import { identityFromAccessToken } from '../src/identity.js';
import { createMockApi } from './buildagil-api-mock.js';

const jwt = (claims: Record<string, unknown>) =>
  `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.sig`;

describe('identityFromAccessToken', () => {
  it('reads the Entra claims for display', () => {
    expect(identityFromAccessToken(jwt({ oid: 'o-1', name: 'Ana Muster', preferred_username: 'ana@example.ch' })))
      .toEqual({ id: 'o-1', displayName: 'Ana Muster', email: 'ana@example.ch' });
  });
  it('signs an opaque token in under a generic identity', () => {
    expect(identityFromAccessToken('opaque').id).toBe('buildagil-account');
  });
});

describe('BuildagilAuth', () => {
  it('without a client id, is signed out and says sign-in is not configured', async () => {
    const api = createMockApi({ projects: [], documents: {} });
    const provider = new BuildagilProvider({ clientId: '' });
    const ctx = api.createContext();
    expect(await provider.auth.restore(ctx)).toBeNull();
    (globalThis as { window?: unknown }).window = { location: { origin: 'https://app.example' }, open: () => null };
    try {
      await expect(provider.auth.signIn(ctx)).rejects.toThrow(/not configured/);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it('signs in with PKCE through the popup and the token URL the host relays', async () => {
    const api = createMockApi({ projects: [], documents: {} }, 'client-7');
    const provider = new BuildagilProvider({ clientId: 'client-7' });
    const ctx = api.createContext();
    let authorizeUrl = '';
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'https://app.example' },
      open: (url: string) => {
        authorizeUrl = url;
        const state = new URL(url).searchParams.get('state');
        // Stands in for the user consenting and the callback page posting.
        setTimeout(() => {
          const channel = new BroadcastChannel(OAUTH_CALLBACK_CHANNEL);
          channel.postMessage({ type: OAUTH_CALLBACK_CHANNEL, state, url: `https://app.example/oauth/bcf/callback?code=code-1&state=${state}` });
          channel.close();
        }, 0);
        return { closed: true, close() {} };
      },
    };
    try {
      expect((await provider.auth.signIn(ctx)).id).toBe('buildagil-account');
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
    const authorize = new URL(authorizeUrl);
    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://openapi.buildagil.com/oauth2/authorize');
    expect(authorize.searchParams.get('scope')).toBe('openid offline_access api');
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://app.example/oauth/bcf/callback');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const exchange = api.calls.find((call) => call.url.pathname === '/oauth2/token')!;
    const form = new URLSearchParams(exchange.body);
    expect([...form.keys()].sort()).toEqual(['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
    expect(form.get('client_id')).toBe('client-7');
    // No secret leaves the browser; the relay adds it.
    expect(form.has('client_secret')).toBe(false);
    expect(await provider.auth.getIdentity(ctx)).not.toBeNull();
  }, 2000);
});
