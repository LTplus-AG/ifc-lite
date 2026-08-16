/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';

import { OAUTH_CALLBACK_CHANNEL } from '@ifc-lite/oauth-pkce';

import { msGraphAuth } from '../src/auth.js';
import { MOCK_ACCESS_TOKEN, createGraphMockContext } from './msgraph-api-mock.js';
import type { GraphMockWorld } from './msgraph-api-mock.js';

const WORLD: GraphMockWorld = {
  driveId: 'drive-1',
  driveName: 'Contoso Drive',
  items: [],
};

describe('msGraphAuth', () => {
  describe('restore', () => {
    it('returns the identity for a still-valid stored token', async () => {
      const ctx = createGraphMockContext(WORLD);
      const identity = await msGraphAuth.restore(ctx);
      expect(identity).toEqual({ id: 'user-1', displayName: 'Mock User', email: 'mock@example.com' });
    });

    it('returns null silently when no clientId preference is configured, never throwing', async () => {
      const ctx = createGraphMockContext(WORLD);
      const noClientCtx = { ...ctx, getPreference: () => Promise.resolve(undefined) };
      await expect(msGraphAuth.restore(noClientCtx)).resolves.toBeNull();
    });

    it('returns null silently when no session is stored, never throwing', async () => {
      const ctx = createGraphMockContext(WORLD);
      await ctx.storage.delete('msgraph:tokens');
      await expect(msGraphAuth.restore(ctx)).resolves.toBeNull();
    });

    it('returns null (not a throw) when the stored access token is rejected and there is no refresh token', async () => {
      const ctx = createGraphMockContext(WORLD);
      await ctx.storage.set(
        'msgraph:tokens',
        // Already-expired, no refreshToken — getValidAccessToken() must reject
        // with NotSignedInError, which restore() is required to swallow.
        JSON.stringify({ accessToken: 'expired', expiresAt: Date.now() - 1000 }),
      );
      await expect(msGraphAuth.restore(ctx)).resolves.toBeNull();
    });
  });

  describe('getIdentity', () => {
    it('mirrors restore() for a signed-in session', async () => {
      const ctx = createGraphMockContext(WORLD);
      const identity = await msGraphAuth.getIdentity(ctx);
      expect(identity?.id).toBe('user-1');
    });
  });

  describe('signOut', () => {
    it('clears the stored token set', async () => {
      const ctx = createGraphMockContext(WORLD);
      expect(await ctx.storage.get('msgraph:tokens')).toBeDefined();
      await msGraphAuth.signOut(ctx);
      expect(await ctx.storage.get('msgraph:tokens')).toBeUndefined();
    });

    it('does not throw even with no clientId preference configured', async () => {
      const ctx = createGraphMockContext(WORLD);
      const noClientCtx = { ...ctx, getPreference: () => Promise.resolve(undefined) };
      await expect(msGraphAuth.signOut(noClientCtx)).resolves.toBeUndefined();
    });
  });

  describe('signIn', () => {
    it('throws a clear error in a non-browser environment rather than crashing on window.open', async () => {
      const ctx = createGraphMockContext(WORLD);
      await expect(msGraphAuth.signIn(ctx)).rejects.toThrow('requires a browser');
    });

    /**
     * The COOP regression, end to end.
     *
     * The viewer serves `Cross-Origin-Opener-Policy: same-origin` (it needs
     * cross-origin isolation for `SharedArrayBuffer`). Under that header,
     * opening a CROSS-ORIGIN popup severs the opener link and the returned
     * `WindowProxy` becomes a stub: `closed` reads `true` while the window is
     * visibly open, and `location` throws `SecurityError`. That was probed
     * live in the running viewer for the sibling Dropbox provider, against
     * both a cross-origin authorization host (severed) and a same-origin
     * control (normal) — the cause is the popup being cross-origin, and
     * `login.microsoftonline.com` is just as cross-origin as any other
     * identity provider.
     *
     * The `popup.closed` stub below is that behaviour verbatim. Against the
     * old poll loop this test fails on the first 250 ms tick with "Microsoft
     * sign-in was cancelled (the popup was closed)" while the popup is still
     * on the consent screen, which is exactly what users hit; the flow only
     * completes if sign-in gets its result from the callback page's broadcast
     * and never touches the popup at all.
     */
    it('completes sign-in from the callback page broadcast, with a popup severed by COOP', async () => {
      const base = createGraphMockContext(WORLD);
      await base.storage.delete('msgraph:tokens');

      const tokenRequestBodies: string[] = [];
      const ctx = {
        ...base,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          const href = typeof input === 'string' ? input : input.toString();
          if (href.includes('/oauth2/v2.0/token')) {
            tokenRequestBodies.push(String(init?.body ?? ''));
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  access_token: MOCK_ACCESS_TOKEN,
                  refresh_token: 'mock-refresh-token',
                  expires_in: 3600,
                  token_type: 'Bearer',
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              ),
            );
          }
          return base.fetch(input, init);
        }) as typeof fetch,
      };

      let locationReads = 0;
      const severedPopup = {
        // What COOP actually reports for a live cross-origin popup.
        closed: true,
        close: () => {},
        get location(): never {
          locationReads += 1;
          throw new Error('SecurityError: Blocked a frame with origin from accessing a cross-origin frame.');
        },
      };

      const fakeWindow = {
        location: { origin: 'https://app.example.com' },
        open: (authorizeUrl: string) => {
          const state = new URL(authorizeUrl).searchParams.get('state');
          // Stands in for the user consenting and the identity provider
          // redirecting the popup to REDIRECT_PATH, where the static callback
          // page posts.
          setTimeout(() => {
            const channel = new BroadcastChannel(OAUTH_CALLBACK_CHANNEL);
            channel.postMessage({
              type: OAUTH_CALLBACK_CHANNEL,
              state,
              url: `https://app.example.com/oauth/msgraph/callback?code=auth-code-1&state=${state}`,
            });
            channel.close();
          }, 0);
          return severedPopup;
        },
      };

      (globalThis as { window?: unknown }).window = fakeWindow;
      let identity;
      try {
        identity = await msGraphAuth.signIn(ctx);
      } finally {
        delete (globalThis as { window?: unknown }).window;
      }

      expect(identity).toEqual({ id: 'user-1', displayName: 'Mock User', email: 'mock@example.com' });
      expect(tokenRequestBodies).toHaveLength(1);
      const exchange = new URLSearchParams(tokenRequestBodies[0]);
      expect(exchange.get('grant_type')).toBe('authorization_code');
      expect(exchange.get('code')).toBe('auth-code-1');
      expect(exchange.get('code_verifier')).toBeTruthy();
      // The session really was persisted. This is the entry that stayed
      // missing while the poll loop rejected every sign-in.
      expect(await ctx.storage.get('msgraph:tokens')).toBeDefined();
      // Nothing read the inoperable API on the way through.
      expect(locationReads).toBe(0);
    });

    // Cross-attempt routing (a broadcast carrying someone else's `state` must
    // be ignored, not consumed) is covered by `waitForOAuthCallback`'s own
    // tests in `@ifc-lite/oauth-pkce`. Asserting it through `signIn` would
    // mean leaving its real 5-minute timeout pending in the test worker.
  });
});
