/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext, SourceAuth, SourceIdentity } from '@ifc-lite/plugin-api';

import { FixtureApiError } from './errors.js';

const IDENTITY_STORAGE_KEY = 'fixture:identity';

export const DEFAULT_FIXTURE_IDENTITY: SourceIdentity = {
  id: 'fixture-user-1',
  displayName: 'Fixture User',
  email: 'fixture-user@example.invalid',
  organization: 'Fixture Org',
};

/**
 * A `SourceAuth` that never talks to anything real: `signIn` writes the given
 * identity to `ctx.storage` and returns it, `restore`/`getIdentity` read it
 * back, `signOut` clears it. Lets a host's sign-in flow — and a provider's
 * "reject until signed in" gate — be exercised deterministically, with no
 * IdP, popup, or network involved.
 */
export function createFixtureAuth(identity: SourceIdentity): SourceAuth {
  return {
    async restore(ctx: PluginContext): Promise<SourceIdentity | null> {
      const raw = await ctx.storage.get(IDENTITY_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as SourceIdentity) : null;
    },
    async signIn(ctx: PluginContext): Promise<SourceIdentity> {
      await ctx.storage.set(IDENTITY_STORAGE_KEY, JSON.stringify(identity));
      return identity;
    },
    async signOut(ctx: PluginContext): Promise<void> {
      await ctx.storage.delete(IDENTITY_STORAGE_KEY);
    },
    async getIdentity(ctx: PluginContext): Promise<SourceIdentity | null> {
      const raw = await ctx.storage.get(IDENTITY_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as SourceIdentity) : null;
    },
  };
}

/** Gate every data method behind sign-in when the provider is interactive-only. */
export async function requireSignedIn(ctx: PluginContext, auth: SourceAuth | undefined): Promise<void> {
  if (!auth) return;
  const identity = await auth.getIdentity(ctx);
  if (!identity) {
    throw new FixtureApiError('Sign-in required', 401);
  }
}
