/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';

import { msGraphAuth } from '../src/auth.js';
import { createGraphMockContext } from './msgraph-api-mock.js';
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
  });
});
