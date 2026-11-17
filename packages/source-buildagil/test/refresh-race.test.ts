/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A sign-out racing an in-flight token refresh must not be undone by the
// refresh landing afterwards (#8364 review, partial-state-clear).

import { describe, expect, it } from 'vitest';
import { BuildagilProvider } from '../src/index.js';
import { tokenManager } from '../src/auth.js';
import { createMockApi } from './buildagil-api-mock.js';

const STORAGE_KEY = 'buildagil:tokens';

describe('BuildagilAuth sign-out during a refresh', () => {
  it('a refresh resolving after sign-out writes nothing back and signs nobody in', async () => {
    let release!: () => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const api = createMockApi({ projects: [], documents: {} }, 'client-race', {
      tokenGate: () => { refreshStarted(); return gate; },
    });
    const provider = new BuildagilProvider({ clientId: 'client-race' });
    const ctx = api.createContext();
    // Expired access token with a refresh token: the next use refreshes.
    await tokenManager(ctx, 'client-race').setTokens({ accessToken: 'old', refreshToken: 'rt-1', expiresAt: Date.now() - 1000 });

    const identity = provider.auth.getIdentity(ctx);
    await started;
    await provider.auth.signOut(ctx);
    release();

    expect(await identity).toBeNull();
    expect(await api.storage.get(STORAGE_KEY)).toBeUndefined();
    expect(await provider.auth.getIdentity(ctx)).toBeNull();
    await expect(provider.listProjects(ctx)).rejects.toThrow(/Not signed in|sign/i);
  });
});
