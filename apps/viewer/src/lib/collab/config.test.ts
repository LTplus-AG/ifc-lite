/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `collabServerUrl()` resolution order (#4446): the per-browser
 * `localStorage` override wins over the build-time `VITE_COLLAB_SERVER_URL`,
 * an EMPTY override means "no server" (local-only), and an unset override
 * falls through to the env. The relay acceptance spec points an ordinary
 * `vite preview` build at a disposable relay through this override, so a
 * regression here would make that spec silently run local-only.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
}

const g = globalThis as { localStorage?: unknown; __VITE_ENV__?: Record<string, unknown> };
const KEY = 'ifc-lite:collab:server-url';
const env = (g.__VITE_ENV__ ??= {});

describe('collabServerUrl(): localStorage override vs build env (#4446)', () => {
  let ls: MemoryStorage;
  let savedEnv: unknown;
  let savedStorage: unknown;

  beforeEach(() => {
    savedEnv = env.VITE_COLLAB_SERVER_URL;
    savedStorage = g.localStorage;
    ls = new MemoryStorage();
    g.localStorage = ls;
  });
  afterEach(() => {
    env.VITE_COLLAB_SERVER_URL = savedEnv;
    g.localStorage = savedStorage;
  });

  it('falls through to VITE_COLLAB_SERVER_URL when no override is set', async () => {
    const { collabServerUrl } = await import('./config.js');
    env.VITE_COLLAB_SERVER_URL = 'wss://relay.example/';
    assert.equal(collabServerUrl(), 'wss://relay.example', 'trailing slash trimmed');
    delete env.VITE_COLLAB_SERVER_URL;
    assert.equal(collabServerUrl(), null, 'no env, no override → local-only');
  });

  it('the override wins over the env and is normalized the same way', async () => {
    const { collabServerUrl } = await import('./config.js');
    env.VITE_COLLAB_SERVER_URL = 'wss://relay.example';
    ls.setItem(KEY, ' ws://127.0.0.1:4321/ ');
    assert.equal(collabServerUrl(), 'ws://127.0.0.1:4321');
  });

  it('an empty override means local-only even with a configured env', async () => {
    const { collabServerUrl } = await import('./config.js');
    env.VITE_COLLAB_SERVER_URL = 'wss://relay.example';
    ls.setItem(KEY, '');
    assert.equal(collabServerUrl(), null);
    ls.removeItem(KEY);
    assert.equal(collabServerUrl(), 'wss://relay.example', 'removing the override restores the env');
  });
});
