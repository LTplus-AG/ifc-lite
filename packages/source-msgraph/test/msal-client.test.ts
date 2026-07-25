/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { KeyValueStore, Logger, PluginContext } from '@ifc-lite/plugin-api';

// ---------------------------------------------------------------------------
// A structural double for the slice of `@azure/msal-browser` msal-client.ts
// drives, mocked at the module boundary (`vi.mock`, hoisted above the imports
// below) so no real MSAL code ever runs and no popup or network call is ever
// attempted. Mirrors the doubles graph-mock.ts already uses for Graph itself.
// ---------------------------------------------------------------------------

const mockClient = {
  initialize: vi.fn(),
  getAllAccounts: vi.fn(),
  getActiveAccount: vi.fn(),
  setActiveAccount: vi.fn(),
  loginPopup: vi.fn(),
  acquireTokenSilent: vi.fn(),
  acquireTokenPopup: vi.fn(),
  logoutPopup: vi.fn(),
};

/** Mirrors the real `InteractionRequiredAuthError`'s `name` — the only thing
 * `isInteractionRequiredError`'s belt-and-braces fallback checks. */
class FakeInteractionRequiredAuthError extends Error {
  constructor(message = 'interaction required') {
    super(message);
    this.name = 'InteractionRequiredAuthError';
  }
}

/** Mirrors the real `BrowserAuthError` shape (`name` + `errorCode`) MSAL throws
 * when `window.open` is blocked — see `isPopupBlockedError` in msal-client.ts. */
class FakeBrowserAuthError extends Error {
  readonly errorCode: string;
  constructor(errorCode: string) {
    super(`browser auth error: ${errorCode}`);
    this.name = 'BrowserAuthError';
    this.errorCode = errorCode;
  }
}

vi.mock('@azure/msal-browser', () => ({
  // A plain arrow function isn't constructible (`new (() => x)` throws), so
  // this needs a real function expression — one that returns `mockClient`,
  // which is exactly what `new SomeCtor() -> object literal return` yields
  // per normal JS constructor semantics.
  PublicClientApplication: vi.fn(function PublicClientApplicationMock() {
    return mockClient;
  }),
  InteractionRequiredAuthError: FakeInteractionRequiredAuthError,
}));

import { MsGraphAuth, GraphAuthExpiredError, GraphPopupBlockedError } from '../src/msal-client.js';

function createMockStorage(): KeyValueStore {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key))),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve([...store.keys()])),
  };
}

function createMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockCtx(preferences: Record<string, string> = {}): PluginContext {
  return {
    fetch: vi.fn() as unknown as typeof fetch,
    fetchPublic: vi.fn(),
    getPreference: vi.fn((name: string) => Promise.resolve(preferences[name])),
    storage: createMockStorage(),
    log: createMockLogger(),
  };
}

beforeEach(() => {
  for (const fn of Object.values(mockClient)) fn.mockClear();
  mockClient.initialize.mockResolvedValue(undefined);
  mockClient.getAllAccounts.mockReturnValue([]);
  mockClient.getActiveAccount.mockReturnValue(null);
  mockClient.logoutPopup.mockResolvedValue(undefined);
  // `getClient` builds a redirect URI from `window.location.origin`; this
  // package runs in a browser at runtime, but the test environment here is
  // plain Node, so the global needs a minimal stand-in.
  vi.stubGlobal('window', { location: { origin: 'https://app.test' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MsGraphAuth.restore', () => {
  it('returns null instead of throwing when no clientId preference is configured', async () => {
    const auth = new MsGraphAuth();
    const ctx = createMockCtx({}); // no clientId

    await expect(auth.restore(ctx)).resolves.toBeNull();
    // Must never even attempt to construct an MSAL client — this path is hit
    // at registration for every provider the host knows about, including
    // ones the user has never configured.
    expect(mockClient.initialize).not.toHaveBeenCalled();
  });

  it('still surfaces a genuine getClient failure rather than swallowing every error as "not signed in"', async () => {
    mockClient.initialize.mockRejectedValueOnce(new Error('network unreachable'));
    const auth = new MsGraphAuth();
    const ctx = createMockCtx({ clientId: 'client-1' });

    await expect(auth.restore(ctx)).rejects.toThrow('network unreachable');
  });

  it('returns the cached active account identity when MSAL already has one', async () => {
    mockClient.getActiveAccount.mockReturnValue({
      homeAccountId: 'acct-1',
      name: 'Ada Lovelace',
      username: 'ada@contoso.com',
      tenantId: 'tenant-1',
    });
    const auth = new MsGraphAuth();
    const ctx = createMockCtx({ clientId: 'client-1' });

    const identity = await auth.restore(ctx);
    expect(identity).toEqual({
      id: 'acct-1',
      displayName: 'Ada Lovelace',
      email: 'ada@contoso.com',
      organization: 'tenant-1',
    });
  });
});

describe('MsGraphAuth.getAccessToken', () => {
  it('returns the token from acquireTokenSilent when it succeeds, without ever trying a popup', async () => {
    mockClient.getActiveAccount.mockReturnValue({ homeAccountId: 'acct-1' });
    mockClient.acquireTokenSilent.mockResolvedValue({ account: null, accessToken: 'tok-silent' });
    const auth = new MsGraphAuth();
    const ctx = createMockCtx({ clientId: 'client-1' });

    await expect(auth.getAccessToken(ctx)).resolves.toBe('tok-silent');
    expect(mockClient.acquireTokenPopup).not.toHaveBeenCalled();
  });

  it('falls back to acquireTokenPopup on InteractionRequiredAuthError and returns its token', async () => {
    mockClient.getActiveAccount.mockReturnValue({ homeAccountId: 'acct-1' });
    mockClient.acquireTokenSilent.mockRejectedValue(new FakeInteractionRequiredAuthError());
    mockClient.acquireTokenPopup.mockResolvedValue({ account: null, accessToken: 'tok-popup' });
    const auth = new MsGraphAuth();
    const ctx = createMockCtx({ clientId: 'client-1' });

    await expect(auth.getAccessToken(ctx)).resolves.toBe('tok-popup');
  });

  it('throws GraphPopupBlockedError, not GraphAuthExpiredError, when the browser blocks the popup fallback', async () => {
    mockClient.getActiveAccount.mockReturnValue({ homeAccountId: 'acct-1' });
    mockClient.acquireTokenSilent.mockRejectedValue(new FakeInteractionRequiredAuthError());
    mockClient.acquireTokenPopup.mockRejectedValue(new FakeBrowserAuthError('popup_window_error'));
    const auth = new MsGraphAuth();
    const ctx = createMockCtx({ clientId: 'client-1' });

    await expect(auth.getAccessToken(ctx)).rejects.toBeInstanceOf(GraphPopupBlockedError);
  });

  it('throws GraphAuthExpiredError for a popup fallback failure that is not popup-blocked', async () => {
    mockClient.getActiveAccount.mockReturnValue({ homeAccountId: 'acct-1' });
    mockClient.acquireTokenSilent.mockRejectedValue(new FakeInteractionRequiredAuthError());
    mockClient.acquireTokenPopup.mockRejectedValue(new Error('user cancelled the flow'));
    const auth = new MsGraphAuth();
    const ctx = createMockCtx({ clientId: 'client-1' });

    await expect(auth.getAccessToken(ctx)).rejects.toBeInstanceOf(GraphAuthExpiredError);
  });

  it('rethrows a silent-acquire failure unrelated to interaction-required as-is', async () => {
    mockClient.getActiveAccount.mockReturnValue({ homeAccountId: 'acct-1' });
    mockClient.acquireTokenSilent.mockRejectedValue(new Error('offline'));
    const auth = new MsGraphAuth();
    const ctx = createMockCtx({ clientId: 'client-1' });

    await expect(auth.getAccessToken(ctx)).rejects.toThrow('offline');
    expect(mockClient.acquireTokenPopup).not.toHaveBeenCalled();
  });
});
