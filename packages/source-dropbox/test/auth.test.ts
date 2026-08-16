/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';

import { dropboxAuth } from '../src/auth.js';
import { DROPBOX_MOCK_ACCESS_TOKEN, createDropboxMockContext } from './dropbox-api-mock.js';
import type { DropboxMockWorld } from './dropbox-api-mock.js';

const WORLD: DropboxMockWorld = {
  accountId: 'account-1',
  displayName: 'Mock User',
  email: 'mock@example.com',
  items: [],
};

describe('dropboxAuth', () => {
  describe('restore', () => {
    it('returns the identity for a still-valid stored token', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const identity = await dropboxAuth.restore(ctx);
      expect(identity).toEqual({ id: 'account-1', displayName: 'Mock User', email: 'mock@example.com' });
    });

    it('returns null silently when no clientId preference is configured, never throwing', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const noClientCtx = { ...ctx, getPreference: () => Promise.resolve(undefined) };
      await expect(dropboxAuth.restore(noClientCtx)).resolves.toBeNull();
    });

    it('returns null silently when no session is stored, never throwing', async () => {
      const ctx = createDropboxMockContext(WORLD);
      await ctx.storage.delete('dropbox:tokens');
      await expect(dropboxAuth.restore(ctx)).resolves.toBeNull();
    });

    it('returns null (not a throw) when the stored access token is rejected and there is no refresh token', async () => {
      const ctx = createDropboxMockContext(WORLD);
      await ctx.storage.set(
        'dropbox:tokens',
        // Already-expired, no refreshToken — getValidAccessToken() must reject
        // with NotSignedInError, which restore() is required to swallow.
        JSON.stringify({ accessToken: 'expired', expiresAt: Date.now() - 1000 }),
      );
      await expect(dropboxAuth.restore(ctx)).resolves.toBeNull();
    });
  });

  describe('getIdentity', () => {
    it('mirrors restore() for a signed-in session', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const identity = await dropboxAuth.getIdentity(ctx);
      expect(identity?.id).toBe('account-1');
    });
  });

  describe('signOut', () => {
    it('clears the stored token set', async () => {
      const ctx = createDropboxMockContext(WORLD);
      expect(await ctx.storage.get('dropbox:tokens')).toBeDefined();
      await dropboxAuth.signOut(ctx);
      expect(await ctx.storage.get('dropbox:tokens')).toBeUndefined();
    });

    it('does not throw even with no clientId preference configured', async () => {
      const ctx = createDropboxMockContext(WORLD);
      const noClientCtx = { ...ctx, getPreference: () => Promise.resolve(undefined) };
      await expect(dropboxAuth.signOut(noClientCtx)).resolves.toBeUndefined();
    });
  });

  describe('signIn', () => {
    it('throws a clear error in a non-browser environment rather than crashing on window.open', async () => {
      const ctx = createDropboxMockContext(WORLD);
      await expect(dropboxAuth.signIn(ctx)).rejects.toThrow('requires a browser');
    });

    /**
     * Proves the one line in this whole package that, if silently dropped,
     * would fail *quietly*: without `token_access_type=offline` on the
     * authorization request, Dropbox's token endpoint issues an access
     * token with no `refresh_token` at all — sign-in still "succeeds", and
     * the session just stops working again the moment the short-lived
     * access token expires, with no error anywhere near the code that broke
     * it. There is no `window` in this test environment (vitest runs under
     * Node, not jsdom — see the `signIn requires a browser` test above), so
     * this stubs the minimum of `window` sign-in actually touches
     * (`location.origin`, `open`) rather than pulling in a browser
     * environment for one assertion, and inspects the URL `signIn` handed
     * to `window.open` before it fails on the (deliberately non-functional)
     * stub popup.
     */
    it('requests offline access (a refresh token) via token_access_type on the authorization URL', async () => {
      const ctx = createDropboxMockContext(WORLD);
      let openedUrl: string | undefined;
      const fakeWindow = {
        location: { origin: 'https://app.example.com' },
        open: (url: string) => {
          openedUrl = url;
          return null; // simulates a blocked popup — signIn() is expected to throw right after this
        },
      };
      (globalThis as { window?: unknown }).window = fakeWindow;
      try {
        await expect(dropboxAuth.signIn(ctx)).rejects.toThrow('popup was blocked');
      } finally {
        delete (globalThis as { window?: unknown }).window;
      }

      expect(openedUrl).toBeDefined();
      const url = new URL(openedUrl!);
      expect(url.origin).toBe('https://www.dropbox.com');
      expect(url.pathname).toBe('/oauth2/authorize');
      expect(url.searchParams.get('token_access_type')).toBe('offline');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/oauth/dropbox/callback');
      expect(url.searchParams.get('scope')).toBe('account_info.read files.metadata.read files.content.read');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    });
  });

  describe('token endpoint', () => {
    /**
     * Dropbox splits the two OAuth endpoints across two hosts: the
     * authorization page is on `www.dropbox.com`, the token endpoint is on
     * `api.dropboxapi.com`. Posting a well-formed exchange to
     * `www.dropbox.com/oauth2/token` does not fail loudly — the www front end
     * answers 400 with its generic `text/html` error page rather than the
     * RFC 6749 §5.2 `{error, error_description}` JSON, so the only thing the
     * user ever sees is "token endpoint returned 400" with no reason, after a
     * sign-in that otherwise looked like it was working. Nothing else in this
     * suite touches the token endpoint (the API mock only serves the
     * data-plane hosts, and every other test is seeded with a still-valid
     * token), so this is the one place the host is checked.
     */
    it('refreshes against api.dropboxapi.com, not the www front end', async () => {
      const base = createDropboxMockContext(WORLD);
      // Expired access token + a refresh token: the next call must go through
      // a real refresh round trip rather than reusing what is stored.
      await base.storage.set(
        'dropbox:tokens',
        JSON.stringify({
          accessToken: 'expired',
          refreshToken: 'mock-refresh-token',
          expiresAt: Date.now() - 1000,
        }),
      );

      const tokenRequests: string[] = [];
      const ctx = {
        ...base,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          const href = typeof input === 'string' ? input : input.toString();
          if (href.includes('/oauth2/token')) {
            tokenRequests.push(href);
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  access_token: DROPBOX_MOCK_ACCESS_TOKEN,
                  refresh_token: 'mock-refresh-token',
                  expires_in: 3600,
                  token_type: 'bearer',
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              ),
            );
          }
          return base.fetch(input, init);
        }) as typeof fetch,
      };

      const identity = await dropboxAuth.getIdentity(ctx);

      expect(tokenRequests).toEqual(['https://api.dropboxapi.com/oauth2/token']);
      // The refreshed token really is the one the following API call used —
      // otherwise this would be null (the mock 401s any other bearer token).
      expect(identity?.id).toBe('account-1');
    });
  });
});
