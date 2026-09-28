/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext } from '@ifc-lite/plugin-api';

import { BASE_URL, CLIENT_ID, ISSUER, type MockService } from './mock-service.js';

/**
 * A `PluginContext` wired to the mock service, with a token set already in
 * storage.
 *
 * Pre-seeding the token is deliberate: `signIn` is a popup flow
 * (`window.open`, `BroadcastChannel`), which belongs to `auth.test.ts` and
 * has nothing to do with whether the data-plane client speaks the REST
 * contract. Every test here starts from "signed in", which is the state the
 * conformance suite assumes.
 */
export function createMockContext(service: MockService, overrides?: Record<string, string>): PluginContext {
  const store = new Map<string, string>([
    [
      `commit-http:${ISSUER}|${CLIENT_ID}`,
      JSON.stringify({ accessToken: 'test-access-token', expiresAt: Date.now() + 3_600_000 }),
    ],
  ]);
  const preferences: Record<string, string> = {
    baseUrl: BASE_URL,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    ...overrides,
  };

  return {
    fetch: service.fetch,
    fetchPublic: async () => {
      throw new Error('fetchPublic is not part of the commit REST contract');
    },
    getPreference: async (name) => preferences[name],
    storage: {
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, value);
      },
      delete: async (key) => {
        store.delete(key);
      },
      keys: async () => [...store.keys()],
    },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}
